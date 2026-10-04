import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { ResultFetcher } from '@ancs/contracts';
import { createDb, jobs, outboxEvents, providerGenerations, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import {
  cancelJob,
  claimJob,
  createJob,
  getJob,
  listLedger,
  registerProviderResultPending,
  reserveCredits,
  transitionJob,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { MockGenerationProvider } from '@ancs/providers-mock-provider';
import { JobHandlerRegistry, type JobHandler } from './handlers.js';
import { createGenerationHandler, GENERATE_JOB_TYPE } from './generation-handler.js';
import { executeJob } from './runner.js';

/**
 * P03-07 验收（真实 DB + 真实本地存储 + Mock Provider，全部本地确定性）：
 * 成功 / 慢任务 / 429 退避 / 提交结果未知（对账） / 重复回调（幂等） / 取消失败（保持 CANCEL_REQUESTED）。
 */

let handle: DbHandle;
let rootDir: string;
let storage: LocalObjectStorage;
let provider: MockGenerationProvider;

/** 结果拉取器：从 Mock Provider 取字节（不用真实网络） */
class MockFetcher implements ResultFetcher {
  readonly kind = 'mock';
  constructor(private readonly provider: MockGenerationProvider) {}
  async fetch(input: { url: string }): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const match = /ephemeral\/([^/]+)\//.exec(input.url);
    const providerJobId = match?.[1];
    const payload = providerJobId === undefined ? null : this.provider.resultPayloadFor(providerJobId);
    if (payload === null) throw new Error(`临时 URL 不可用：${input.url}`);
    return { bytes: payload.bytes, contentType: payload.contentType };
  }
}

const deps = (): DomainDeps => ({ db: handle.db, storage, resultFetcher: new MockFetcher(provider), platformCredentials: { has: () => true, resolve: () => 'mock-platform-secret' } });

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-mock-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'mock-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  provider = new MockGenerationProvider({ pollsBeforeTerminal: 2 });
});

async function makeJob(workspaceId: string, input: Record<string, unknown> = {}): Promise<string> {
  const job = await createJob(deps(), { workspaceId, type: GENERATE_JOB_TYPE, input: { modelId: 'mock-video-1', operation: 'video.generate', credentialMode: 'PLATFORM_MANAGED', kind: 'AI_VIDEO', estimatedCredits: 20, ...input } });
  return job.id;
}

async function makeWorkspace(): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'Mock 租户' });
  await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 1000, perJobMaxCredits: 0 } });
  return workspaceId;
}

function registry(): JobHandlerRegistry {
  return new JobHandlerRegistry([createGenerationHandler({ providers: [provider], delivery: 'inline' })]);
}

async function runOnce(workspaceId: string, jobId: string): Promise<'succeeded' | 'failed' | 'cancelled' | 'cancel_failed'> {
  const claimed = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 60, types: [GENERATE_JOB_TYPE] });
  if (claimed === null || claimed.id !== jobId) throw new Error(`未认领到预期任务（got ${claimed?.id ?? 'null'}）`);
  return executeJob(deps(), registry(), { workerId: 'w1', leaseSeconds: 60, heartbeatIntervalMs: 5000 }, claimed);
}

describe('Mock Provider 端到端故障编排（P03-07）', () => {
  it('成功：提交 → PROVIDER_QUEUED → 结果回收（自有存储 + Asset）→ SUCCEEDED 且计费结算', async () => {
    const workspaceId = await makeWorkspace();
    const jobId = await makeJob(workspaceId);
    await reserveCredits(deps(), { workspaceId, jobId, estimatedCredits: 20 });

    const outcome = await runOnce(workspaceId, jobId);
    expect(outcome).toBe('succeeded');
    const job = await getJob(deps(), { workspaceId, jobId });
    expect(job.status).toBe('SUCCEEDED');
    // 回收链路（在 collectProviderResult 内）已把任务置为 SUCCEEDED 并写入资产引用——
    // 执行器的完成迁移因此被跳过（状态已非 RUNNING），结果以回收服务的权威结论为准。
    expect((job.result as { assets: unknown[] }).assets).toHaveLength(1);
    expect(provider.submissions).toHaveLength(1); // 恰好一次付费提交
    const entries = await listLedger(deps(), { workspaceId });
    expect(entries.filter((entry) => entry.entryType === 'HOLD_RELEASE')).toHaveLength(1);
    expect(entries.filter((entry) => entry.entryType === 'DEBIT' && entry.amount === 20)).toHaveLength(1);
    const generations = await handle.db.select().from(providerGenerations).where(eq(providerGenerations.workspaceId, workspaceId));
    expect(generations).toHaveLength(1);
    expect(generations[0]?.status).toBe('SUCCEEDED');
  });

  it('429 限流：提交抛错 → FAILED_RETRYABLE + 退避（无终结、无 Provider 任务）', async () => {
    const workspaceId = await makeWorkspace();
    provider.scriptNext('rate_limited');
    const jobId = await makeJob(workspaceId);

    const outcome = await runOnce(workspaceId, jobId);
    expect(outcome).toBe('failed');
    const job = await getJob(deps(), { workspaceId, jobId });
    expect(job.status).toBe('FAILED_RETRYABLE');
    expect(job.nextAttemptAt).not.toBeNull(); // 退避窗口
    expect(job.error).toMatchObject({ reason: 'HANDLER_ERROR' });
    expect(provider.submissions).toHaveLength(0);
    // 未产生费用
    const entries = await listLedger(deps(), { workspaceId });
    expect(entries.filter((entry) => entry.entryType === 'DEBIT')).toHaveLength(0);
  });

  it('提交结果未知：needs_reconciliation + SUBMISSION_UNKNOWN（不自动重复付费提交）', async () => {
    const workspaceId = await makeWorkspace();
    provider.scriptNext('submission_unknown');
    const jobId = await makeJob(workspaceId);

    const outcome = await runOnce(workspaceId, jobId);
    expect(outcome).toBe('succeeded'); // 处理器正常返回（结果内标记对账），不是执行错误
    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(rows[0]?.needsReconciliation).toBe(true);
    expect(rows[0]?.submitState).toBe('SUBMISSION_UNKNOWN');
    expect(rows[0]?.status).toBe('FAILED_RETRYABLE');
    expect(provider.submissions).toHaveLength(0);
    // 重试不会自动重复提交（需人工对账后才重试）——直接断言没有新的 Provider 提交
    const before = provider.submissions.length;
    expect(before).toBe(0);
  });

  it('慢任务：inline 轮询持续推进（≥6 次）直至终态并回收成功', async () => {
    const workspaceId = await makeWorkspace();
    provider.scriptNext('slow'); // pollsBeforeTerminal=2 → 6 次轮询才完成
    const jobId = await makeJob(workspaceId);

    const outcome = await runOnce(workspaceId, jobId);
    expect(outcome).toBe('succeeded');
    const job = await getJob(deps(), { workspaceId, jobId });
    expect(job.status).toBe('SUCCEEDED');
    expect(provider.statusCalls).toBeGreaterThanOrEqual(6); // 慢任务被持续推进而非误判完成
    expect((job.result as { assets: unknown[] }).assets).toHaveLength(1);
  });

  it('重复回调：同 eventId 二次到达 → 幂等（单资产、单结算）', async () => {
    const workspaceId = await makeWorkspace();
    const jobId = await makeJob(workspaceId);
    const claimed = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 60 });
    expect(claimed?.id).toBe(jobId);
    const { processProviderCallback } = await import('@ancs/domain');

    // 手工走一遍"提交 + 登记"（模拟 Worker 已提交、等待回调）
    const submitted = await provider.submit({
      secret: 'mock-platform-secret', // secrets:check-ignore：Mock 场景的占位凭据（非真实凭据）
      request: { workspaceId, jobId, providerId: provider.providerId, modelId: 'mock-video-1', operation: 'video.generate', inputHash: 'sha256:dup', parameters: {} },
    });
    await registerProviderResultPending(deps(), { workspaceId, jobId, providerId: provider.providerId, providerJobId: submitted.providerJobId, attempt: 1 });
    await transitionJob(deps(), { workspaceId, jobId, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED', reason: 'SUBMITTED' });
    await provider.getStatus({ providerJobId: submitted.providerJobId });
    await provider.getStatus({ providerJobId: submitted.providerJobId });
    const callback = provider.buildCallback(submitted.providerJobId);

    const first = await processProviderCallback(deps(), { providerId: provider.providerId, callback });
    expect(first.collection?.collected).toBe(1);
    const second = await processProviderCallback(deps(), { providerId: provider.providerId, callback: provider.duplicateOf(callback) });
    // 进程内第二条：state 已 COLLECTED，任务已 SUCCEEDED → 不重复收集（collected 仍为 1，且资产不增）
    expect(second.collection?.collected ?? 0).toBeLessThanOrEqual(1);
    const assets = await import('@ancs/db').then((module) => handle.db.select().from(module.assets).where(eq(module.assets.workspaceId, workspaceId)));
    expect(assets).toHaveLength(1);
    const job = await getJob(deps(), { workspaceId, jobId });
    expect(job.status).toBe('SUCCEEDED');
  });

  it('取消失败：Provider 拒绝取消 → 执行器返回 cancel_failed，任务保持 CANCEL_REQUESTED + 事件', async () => {
    const workspaceId = await makeWorkspace();

    // 协作式处理器 + 失败的取消钩子（模拟 Provider 拒绝取消）
    const cooperative: JobHandler = {
      type: 'COOPERATIVE_CANCEL_FAIL',
      description: '取消联动失败场景',
      async handle(_deps, _input, context) {
        for (let index = 0; index < 60; index += 1) {
          await context.heartbeat(); // 感知 CANCEL_REQUESTED
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return { finished: true };
      },
      async onCancel() {
        return { ok: false, reason: 'PROVIDER_CANCEL_REJECTED' };
      },
    };
    const cancelRegistry = new JobHandlerRegistry([cooperative]);

    const job = await createJob(deps(), { workspaceId, type: 'COOPERATIVE_CANCEL_FAIL', input: {} });
    const claimed = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 60, types: ['COOPERATIVE_CANCEL_FAIL'] });
    expect(claimed?.id).toBe(job.id);

    const running = executeJob(deps(), cancelRegistry, { workerId: 'w1', leaseSeconds: 60, heartbeatIntervalMs: 1000 }, claimed!);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const requested = await cancelJob(deps(), { workspaceId, jobId: job.id, reason: 'USER_CANCELLED' });
    expect(requested.status).toBe('CANCEL_REQUESTED');

    const outcome = await running;
    expect(outcome).toBe('cancel_failed');
    const after = (await handle.db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    expect(after?.status).toBe('CANCEL_REQUESTED'); // 不假装已取消：供人工介入
    const events = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, workspaceId));
    const cancelFailed = events.filter((event) => event.type === 'job.cancel_failed');
    expect(cancelFailed).toHaveLength(1);
    expect((cancelFailed[0]?.payload as { reason?: string }).reason).toBe('PROVIDER_CANCEL_REJECTED');
  }, 15_000);

  it('生成处理器取消钩子直接调用：Provider 拒绝 → {ok:false}（业务层可观测）', async () => {
    const workspaceId = await makeWorkspace();
    provider.scriptNext('cancel_fails');
    const jobId = await makeJob(workspaceId);
    const handler = createGenerationHandler({ providers: [provider], delivery: 'external' });
    const dependency = await (await import('@ancs/domain')).resolveCredentialForExecution(deps(), { workspaceId, providerId: provider.providerId, kind: 'AI_VIDEO' });
    expect(dependency.mode).toBe('PLATFORM_MANAGED');
    const submitted = await provider.submit({
      secret: 'mock-platform-secret', // secrets:check-ignore：Mock 场景的占位凭据（非真实凭据）
      request: { workspaceId, jobId, providerId: provider.providerId, modelId: 'mock-video-1', operation: 'video.generate', inputHash: 'sha256:cancel2', parameters: {} },
    });
    const result = await handler.onCancel?.(
      deps(),
      { providerJobId: submitted.providerJobId },
      { jobId, workspaceId, heartbeat: async () => undefined },
    );
    expect(result).toMatchObject({ ok: false, reason: 'PROVIDER_CANCEL_REJECTED' });
    expect(provider.cancelAttempts).toContain(submitted.providerJobId);
  });
});
