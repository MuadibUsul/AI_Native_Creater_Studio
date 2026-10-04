import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { WEBHOOK_SIGNATURE_HEADER, WEBHOOK_TIMESTAMP_HEADER, type ProviderCallback, type ResultFetcher, type WebhookVerifier } from '@ancs/contracts';
import { assets as assetsTable, createDb, jobs, providerResultStates, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, webhookEvents, workspaces, type DbHandle } from '@ancs/db';
import {
  claimJob,
  collectProviderResult,
  createHmacWebhookVerifier,
  createJob,
  getJob,
  ingestProviderWebhook,
  listJobs,
  listLedger,
  NOOP_JOB_TYPE,
  registerProviderResultPending,
  reserveCredits,
  runResultExpirySweep,
  transitionJob,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';

/**
 * P03-06 验收（真实 DB + 真实本地存储）：
 * - **下载失败不重生成**（AC-09）：回收失败只增加回收尝试、任务保持可回收、不产生再次提交；
 * - **Provider URL 失效后已完成资产仍可用**（AC-10/§75-5）：回收成功即落自有存储，随后 URL 失效不影响；
 * - Webhook：验签（HMAC+时间窗）拒绝伪造；**replay 幂等**（同 eventId 只生效一次，AC-08）；
 *   迟到结果只登记不应用（AC-05）；未知 providerJobId 不据回调创建任务；
 * - 结果校验：大小/MIME 嗅探/校验和不符 → 拒收且**不落库**；
 * - 完成后：任务 SUCCEEDED、生成记录 SUCCEEDED、账本结算（HOLD→SETTLED）；
 * - 过期预警：临近过期 → 事件；已过期 → EXPIRED + needs_reconciliation（不自动重复付费）。
 */

let handle: DbHandle;
let rootDir: string;
let storage: LocalObjectStorage;

/** 脚本化结果拉取器：可编程返回字节/抛错（模拟临时 URL 失效） */
class ScriptedFetcher implements ResultFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  failWith = new Map<string, Error>();
  calls: string[] = [];
  async fetch(input: { url: string }): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    this.calls.push(input.url);
    const failure = this.failWith.get(input.url);
    if (failure !== undefined) throw failure;
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`provider URL 不可用（404）：${input.url}`);
    return response;
  }
}

const fetcher = new ScriptedFetcher();
const deps = (): DomainDeps => ({ db: handle.db, storage, resultFetcher: fetcher });

const WEBHOOK_SECRET = 'webhook-test-secret-0123456789'; // secrets:check-ignore：测试专用假密钥
const verifiers: readonly WebhookVerifier[] = [createHmacWebhookVerifier('mock.provider', WEBHOOK_SECRET)];

function pngBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0x00, 0x00, 0x02, 0x80], 16);
  bytes.set([0x00, 0x00, 0x01, 0x68], 20);
  bytes[24] = 8;
  bytes[25] = 2;
  bytes[26] = seed & 0xff;
  return bytes;
}

function signedRequest(body: string, options: { timestamp?: number; secret?: string } = {}): { headers: Record<string, string>; rawBody: string } {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const signature = createHmac('sha256', options.secret ?? WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex');
  return { headers: { [WEBHOOK_SIGNATURE_HEADER]: signature, [WEBHOOK_TIMESTAMP_HEADER]: timestamp }, rawBody: body };
}

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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-results-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'results-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(webhookEvents); // 平台级表：无 workspace 级联，需显式清理
  fetcher.responses.clear();
  fetcher.failWith.clear();
  fetcher.calls = [];
});

/** 建一个"已提交给 Provider"的任务（含预算预留与结果登记） */
async function makeProviderJob(overrides: { estimatedCredits?: number } = {}) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '回收测试租户' });
  const estimatedCredits = overrides.estimatedCredits ?? 30;
  await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 1000, perJobMaxCredits: 0 } });
  const job = await createJob(deps(), {
    workspaceId,
    type: NOOP_JOB_TYPE,
    input: {
      modelId: 'mock-video-1',
      operation: 'video.generate',
      credentialMode: 'PLATFORM_MANAGED',
      inputHash: 'sha256:test-input',
      estimatedCredits,
    },
  });
  await claimJob(deps(), { workerId: 'w1', leaseSeconds: 60 });
  await transitionJob(deps(), { workspaceId, jobId: job.id, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED', reason: 'SUBMITTED_TO_PROVIDER' });
  await reserveCredits(deps(), { workspaceId, jobId: job.id, estimatedCredits });
  const providerJobId = `pjob_${randomUUID()}`;
  await registerProviderResultPending(deps(), {
    workspaceId,
    jobId: job.id,
    providerId: 'mock.provider',
    providerJobId,
    attempt: 1,
  });
  return { workspaceId, jobId: job.id, providerJobId, estimatedCredits };
}

function makeCallback(providerJobId: string, url: string, extra: Partial<ProviderCallback> = {}): ProviderCallback {
  return {
    eventId: `evt_${randomUUID()}`,
    eventType: 'job.succeeded',
    providerJobId,
    attempt: 1,
    results: [
      {
        url,
        contentType: 'image/png',
        sizeBytes: null,
        checksumSha256: null,
        assetType: 'GENERATED_IMAGE',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ],
    error: null,
    ...extra,
  };
}

describe('结果回收（AC-09 / AC-10 / §75 第 5 条）', () => {
  it('回收成功：下载 → 校验 → 落自有存储与 Asset → 任务完成与结算；URL 失效后资产仍可用（AC-10）', async () => {
    const { workspaceId, jobId, providerJobId, estimatedCredits } = await makeProviderJob();
    const bytes = pngBytes(1);
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(url, { bytes, contentType: 'image/png' });

    const body = JSON.stringify(makeCallback(providerJobId, url));
    const request = signedRequest(body);
    const result = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    expect(result.status).toBe('PROCESSED');
    expect(result.collection?.collected).toBe(1);
    const asset = result.collection?.assets[0];
    expect(asset?.storageKey.startsWith(`workspaces/${workspaceId}/library/providers/mock.provider/`)).toBe(true);

    // 任务完成 + 生成记录 + 账本结算
    const job = await getJob(deps(), { workspaceId, jobId });
    expect(job.status).toBe('SUCCEEDED');
    expect((job.result as { assets: unknown[] }).assets).toHaveLength(1);
    const entries = await listLedger(deps(), { workspaceId });
    expect(entries.filter((entry) => entry.entryType === 'HOLD_RELEASE')).toHaveLength(1);
    expect(entries.filter((entry) => entry.entryType === 'DEBIT' && entry.amount === estimatedCredits)).toHaveLength(1);
    const events = await handle.db.select().from(webhookEvents).where(eq(webhookEvents.providerId, 'mock.provider'));
    expect(events[0]?.status).toBe('PROCESSED');

    // ★ Provider URL 失效后：资产仍可用（内容在自有存储中）
    fetcher.failWith.set(url, new Error('URL 已过期（410 Gone）'));
    expect((await storage.probeObject(asset?.storageKey ?? '')).exists).toBe(true);
    const stored = await storage.readObject(asset?.storageKey ?? '');
    expect(Array.from(stored ?? new Uint8Array())).toEqual(Array.from(bytes));
  });

  it('下载失败不重生成（AC-09）：回收失败 → 保留待回收、回收尝试 +1、无重新提交；重试回收成功', async () => {
    const { workspaceId, jobId, providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.failWith.set(url, new Error('网络中断'));

    const body = JSON.stringify(makeCallback(providerJobId, url));
    const request = signedRequest(body);
    const first = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    expect(first.status).toBe('PROCESSED');
    expect(first.collection?.failure).toMatchObject({ reason: 'RESULT_FETCH_FAILED', retryable: true });

    const stateAfterFailure = await handle.db.select().from(providerResultStates).where(eq(providerResultStates.jobId, jobId));
    expect(stateAfterFailure[0]?.status).toBe('PENDING'); // 仍待回收
    expect(stateAfterFailure[0]?.collectAttempts).toBe(1);
    const jobAfterFailure = await getJob(deps(), { workspaceId, jobId });
    expect(jobAfterFailure.status).toBe('RUNNING'); // 未失败、未终态
    expect(jobAfterFailure.attempts).toBe(1); // 未重新提交（attempt 不变）
    const jobsRows = await handle.db.select().from(jobs).where(eq(jobs.id, jobId));
    expect(jobsRows[0]?.submitState).toBe('SUBMITTED'); // 未产生新的付费提交

    // 重试：URL 恢复 → 重试回收成功（**只重试回收**）
    fetcher.failWith.delete(url);
    fetcher.responses.set(url, { bytes: pngBytes(2), contentType: 'image/png' });
    const retry = await collectProviderResult(deps(), { workspaceId, jobId });
    expect(retry.collected).toBe(1);
    expect(retry.failure).toBeNull();
    expect((await getJob(deps(), { workspaceId, jobId })).status).toBe('SUCCEEDED');
    const stateAfterRetry = await handle.db.select().from(providerResultStates).where(eq(providerResultStates.jobId, jobId));
    expect(stateAfterRetry[0]?.status).toBe('COLLECTED');
    expect(stateAfterRetry[0]?.collectAttempts).toBe(2);
  });

  it('结果校验：大小/MIME 嗅探/校验和不符一律拒收且不落库（伪造结果不可 Ready）', async () => {
    const { workspaceId, jobId, providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    const bytes = pngBytes(3);
    fetcher.responses.set(url, { bytes, contentType: 'image/png' });

    // 校验和不符
    const wrongSum = 'f'.repeat(64);
    const body = JSON.stringify(
      makeCallback(providerJobId, url, {
        results: [
          {
            url,
            contentType: 'image/png',
            sizeBytes: null,
            checksumSha256: wrongSum,
            assetType: 'GENERATED_IMAGE',
            expiresAt: null,
          },
        ],
      }),
    );
    const request = signedRequest(body);
    const result = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    expect(result.collection?.failure).toMatchObject({ reason: 'RESULT_INVALID', retryable: false });
    const assetsRows = await handle.db.select().from(assetsTable);
    expect(assetsRows).toHaveLength(0);
    expect((await getJob(deps(), { workspaceId, jobId })).status).not.toBe('SUCCEEDED');

    // MIME 伪造（文本冒充 PNG）
    fetcher.responses.set(url, { bytes: new TextEncoder().encode('not a png'), contentType: 'image/png' });
    const second = await collectProviderResult(deps(), { workspaceId, jobId });
    expect(second.failure?.retryable).toBe(false);
    expect((await handle.db.select().from(assetsTable))).toHaveLength(0);
  });
});


describe('Webhook 验签与 replay 防护（§33.4 / AC-08 / AC-05）', () => {
  it('伪造签名 / 时间窗超限 / 非法载荷一律拒绝（不落事件行、不改任务状态）', async () => {
    const { jobId, providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(url, { bytes: pngBytes(4), contentType: 'image/png' });
    const body = JSON.stringify(makeCallback(providerJobId, url));

    // 签名错误
    const forged = signedRequest(body, { secret: 'wrong-secret-000000000000' }); // secrets:check-ignore：测试专用假密钥
    const rejected = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: forged.rawBody, headers: forged.headers, verifiers });
    expect(rejected).toMatchObject({ status: 'REJECTED', reason: 'INVALID_SIGNATURE' });

    // 时间窗超限（重放攻击：旧时间戳）
    const staleSignature = signedRequest(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 });
    const stale = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: staleSignature.rawBody, headers: staleSignature.headers, verifiers });
    expect(stale).toMatchObject({ status: 'REJECTED', reason: 'TIMESTAMP_OUT_OF_WINDOW' });

    // 缺签名头
    const missing = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: body, headers: {}, verifiers });
    expect(missing).toMatchObject({ status: 'REJECTED', reason: 'MISSING_SIGNATURE' });

    // 未知 Provider
    const unknown = await ingestProviderWebhook(deps(), { providerId: 'unknown.provider', rawBody: body, headers: {}, verifiers });
    expect(unknown).toMatchObject({ status: 'REJECTED', reason: 'UNKNOWN_PROVIDER' });

    // 非法载荷（签名有效但 JSON 不符合契约）
    const bad = signedRequest('{"not":"a callback"}');
    const invalid = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: bad.rawBody, headers: bad.headers, verifiers });
    expect(invalid).toMatchObject({ status: 'REJECTED', reason: 'INVALID_PAYLOAD' });

    // 伪造请求未污染审计与任务状态
    expect(await handle.db.select().from(webhookEvents)).toHaveLength(0);
    const jobRow = (await handle.db.select().from(jobs).where(eq(jobs.id, jobId)))[0];
    expect(jobRow?.status).toBe('PROVIDER_QUEUED');
  });

  it('replay 幂等：同 eventId 重复回调只生效一次（第二次返回 DUPLICATE 且不重复回收）', async () => {
    const { workspaceId, jobId, providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(url, { bytes: pngBytes(5), contentType: 'image/png' });

    const callback = makeCallback(providerJobId, url);
    const body = JSON.stringify(callback);
    const request = signedRequest(body);
    const first = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    expect(first.status).toBe('PROCESSED');

    const fetchesAfterFirst = fetcher.calls.length;
    const second = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    expect(second.status).toBe('DUPLICATE');
    expect(second.webhookEventId).toBe(first.webhookEventId);
    expect(fetcher.calls.length).toBe(fetchesAfterFirst); // 未重复下载
    expect((await handle.db.select().from(assetsTable).where(eq(assetsTable.workspaceId, workspaceId)))).toHaveLength(1);
    expect((await getJob(deps(), { workspaceId, jobId })).status).toBe('SUCCEEDED');
  });

  it('迟到结果只登记不应用（AC-05）；未知 providerJobId 不据回调创建任务', async () => {
    const { workspaceId, jobId, providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(url, { bytes: pngBytes(6), contentType: 'image/png' });

    // attempt=0 < 当前 1 → 迟到
    const staleCallback = makeCallback(providerJobId, url, { attempt: 0 });
    const staleBody = JSON.stringify(staleCallback);
    const staleRequest = signedRequest(staleBody);
    const stale = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: staleRequest.rawBody, headers: staleRequest.headers, verifiers });
    expect(stale).toMatchObject({ status: 'PROCESSED' });
    expect(stale.collection).toBeNull();
    expect(fetcher.calls).toHaveLength(0); // 未回收
    expect((await getJob(deps(), { workspaceId, jobId })).status).toBe('PROVIDER_QUEUED'); // 状态不变
    const staleEvent = (
      await handle.db.select().from(webhookEvents).orderBy(desc(webhookEvents.receivedAt)).limit(1)
    )[0];
    expect(staleEvent?.note).toBe('STALE_ATTEMPT_IGNORED');

    // 未知 providerJobId
    const unknownCallback = makeCallback(`pjob_${randomUUID()}`, 'https://provider.example/nope.png');
    const unknownBody = JSON.stringify(unknownCallback);
    const unknownRequest = signedRequest(unknownBody);
    const unknown = await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: unknownRequest.rawBody, headers: unknownRequest.headers, verifiers });
    expect(unknown.jobId).toBeNull();
    expect(await listJobs(deps(), { workspaceId })).toHaveLength(1); // 未创建新任务
  });
});

describe('过期预警（P03-06）', () => {
  it('临近过期 → 预警事件；已过期 → EXPIRED + needs_reconciliation（不自动重复付费）', async () => {
    const { providerJobId } = await makeProviderJob();
    const url = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(url, { bytes: pngBytes(7), contentType: 'image/png' });

    // 登记一个 5 分钟后过期的结果（在预警阈值 15 分钟内）
    const soon = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const callback = makeCallback(providerJobId, url, {
      results: [{ url, contentType: 'image/png', sizeBytes: null, checksumSha256: null, assetType: 'GENERATED_IMAGE', expiresAt: soon }],
    });
    const body = JSON.stringify(callback);
    const request = signedRequest(body);
    // 用手工登记（不经回收）：直接调用 processProviderCallback 之前先人为置 PENDING（由回调登记）
    await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: request.rawBody, headers: request.headers, verifiers });
    // 上面已回收成功 → 重置为 PENDING 场景：另建任务模拟未回收
    const second = await makeProviderJob();
    const secondUrl = `https://provider.example/ephemeral/${second.providerJobId}.png`;
    const secondSoon = new Date(Date.now() + 5 * 60 * 1000);
    fetcher.failWith.set(secondUrl, new Error('临时不可用'));
    const secondCallback = makeCallback(second.providerJobId, secondUrl, {
      results: [{ url: secondUrl, contentType: 'image/png', sizeBytes: null, checksumSha256: null, assetType: 'GENERATED_IMAGE', expiresAt: secondSoon.toISOString() }],
    });
    const secondBody = JSON.stringify(secondCallback);
    const secondRequest = signedRequest(secondBody);
    await ingestProviderWebhook(deps(), { providerId: 'mock.provider', rawBody: secondRequest.rawBody, headers: secondRequest.headers, verifiers });

    const warned = await runResultExpirySweep(deps(), { now: new Date() });
    expect(warned.warned).toBeGreaterThanOrEqual(1);
    expect(warned.expired).toBe(0);

    // 已过期：把 expiresAt 回拨后扫描
    await handle.db
      .update(providerResultStates)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(and(eq(providerResultStates.workspaceId, second.workspaceId), eq(providerResultStates.jobId, second.jobId)));
    const expired = await runResultExpirySweep(deps(), { now: new Date() });
    expect(expired.expired).toBe(1);
    const stateAfter = await handle.db.select().from(providerResultStates).where(eq(providerResultStates.jobId, second.jobId));
    expect(stateAfter[0]?.status).toBe('EXPIRED');
    const jobAfter = await handle.db.select().from(jobs).where(eq(jobs.id, second.jobId));
    expect(jobAfter[0]?.needsReconciliation).toBe(true); // 需对账：不得自动重复付费提交
  });
});
