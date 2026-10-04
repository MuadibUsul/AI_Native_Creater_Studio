import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, jobs, outboxEvents, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import {
  cancelJob,
  claimJob,
  completeJob,
  computeBackoffSeconds,
  createJob,
  failJob,
  inspectJobs,
  listJobs,
  NOOP_JOB_TYPE,
  promoteRetryableJobs,
  requeueExpiredLeases,
  retryJob,
  resolveStuckDependents,
  transitionJob,
  type DomainDeps,
} from '@ancs/domain';
import { createDefaultRegistry, JobHandlerRegistry, type JobHandler } from './handlers.js';
import { executeJob, type JobPhase } from './runner.js';

/**
 * P03-02 验收（真实 DB）：恢复与取消。
 *
 * - 退避与抖动：FAILED_RETRYABLE 设置 nextAttemptAt（指数 + 抖动；可注入随机源）；
 *   退避未到期不可认领；到期由 promoteRetryableJobs 升级（可重入）；
 * - **各关键点杀 Worker 后可继续**：after-claim / mid-handler / before-complete 三处注入崩溃，
 *   租约回收后重新认领并成功（不丢任务、无半途终态）；
 * - **重复消费不产生重复副作用**：过期租约的陈旧 Worker 上报结果 → 409 拒绝，结果不被覆盖；
 * - 取消协作：CANCEL_REQUESTED → 执行器心跳感知 → CANCELLED（不是 FAILED）；
 * - 失败检查：孤儿依赖解析（依赖已终态但自身仍等待）与 inspectJobs 运维视图。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({
  db: handle.db,
  // 确定性退避（测试）：base 5s、cap 300s、无抖动、随机源固定
  retryPolicy: { baseSeconds: 5, capSeconds: 300, jitterRatio: 0.2, random: () => 0.5 },
});

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
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function makeWorkspace(): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '恢复测试租户' });
  return workspaceId;
}

describe('退避与自动重试（P03-02）', () => {
  it('指数退避 + 抖动（可注入随机源）；未到期不可认领，到期自动升级', async () => {
    // 纯函数：attempts 1 → 5s（抖动 0.5 → 系数 1.0）、attempts 2 → 10s；cap 生效
    expect(computeBackoffSeconds(1, { baseSeconds: 5, capSeconds: 300, jitterRatio: 0, random: () => 0.5 })).toBe(5);
    expect(computeBackoffSeconds(2, { baseSeconds: 5, capSeconds: 300, jitterRatio: 0, random: () => 0.5 })).toBe(10);
    expect(computeBackoffSeconds(9, { baseSeconds: 5, capSeconds: 300, jitterRatio: 0, random: () => 0.5 })).toBe(300);
    // 抖动范围：random=0 → -20%，random≈1 → +20%
    expect(computeBackoffSeconds(1, { baseSeconds: 100, capSeconds: 1000, jitterRatio: 0.2, random: () => 0 })).toBe(80);
    expect(computeBackoffSeconds(1, { baseSeconds: 100, capSeconds: 1000, jitterRatio: 0.2, random: () => 0.999 })).toBe(120);

    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {}, maxAttempts: 3 });
    await claimJob(deps(), { workerId: 'w1', leaseSeconds: 30 });
    const failed = await failJob(deps(), { workspaceId, jobId: job.id, error: { reason: 'TEMP' }, now: new Date('2026-10-04T00:00:00Z') });
    expect(failed.status).toBe('FAILED_RETRYABLE');
    // 抖动固定 0.5 → 系数 1.0 → 5s
    expect(failed.nextAttemptAt).toBe('2026-10-04T00:00:05.000Z');

    // 退避未到期：不可认领
    expect(await claimJob(deps(), { workerId: 'w1', now: new Date('2026-10-04T00:00:03Z') })).toBeNull();
    // 到期：自动升级（可重入）
    const promoted = await promoteRetryableJobs(deps(), { now: new Date('2026-10-04T00:00:06Z') });
    expect(promoted.promoted).toBe(1);
    // 重跑不重复（已是 QUEUED，不再计入）
    expect((await promoteRetryableJobs(deps(), { now: new Date('2026-10-04T00:00:06Z') })).promoted).toBe(0);
    const requeued = await listJobs(deps(), { workspaceId });
    expect(requeued[0]?.status).toBe('QUEUED');
    expect(requeued[0]?.nextAttemptAt).toBeNull();
    const events = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'job.queued'));
    expect(events.some((row) => (row.payload as { reason?: string }).reason === 'BACKOFF_ELAPSED')).toBe(true);
    expect((await claimJob(deps(), { workerId: 'w1', now: new Date('2026-10-04T00:00:07Z') }))?.id).toBe(job.id);
  });

  it('人工重试清退避立即生效', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    await claimJob(deps(), { workerId: 'w1' });
    await failJob(deps(), { workspaceId, jobId: job.id, error: { reason: 'TEMP' } });
    const retried = await retryJob(deps(), { workspaceId, jobId: job.id });
    expect(retried.status).toBe('QUEUED');
    expect(retried.nextAttemptAt).toBeNull();
    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(rows[0]?.nextAttemptAt).toBeNull();
    expect((await claimJob(deps(), { workerId: 'w1' }))?.id).toBe(job.id);
  });
});

describe('各关键点杀 Worker 后可继续（故障注入）', () => {
  const phases: JobPhase[] = ['after-claim', 'mid-handler', 'before-complete'];

  for (const phase of phases) {
    it(`在 ${phase} 崩溃（不写终态）→ 租约回收 → 重新认领并成功`, async () => {
      const workspaceId = await makeWorkspace();
      const registry = createDefaultRegistry();
      const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { phase } });
      const claimed = await claimJob(deps(), { workerId: 'doomed-worker', leaseSeconds: 1 });
      expect(claimed?.id).toBe(job.id);

      // 崩溃注入：抛错等价于进程被杀——不得写终态、不得释放租约
      await expect(
        executeJob(
          deps(),
          registry,
          {
            workerId: 'doomed-worker',
            leaseSeconds: 1,
            heartbeatIntervalMs: 500,
            onPhase: (current) => {
              if (current === phase) throw new Error(`simulated crash at ${current}`);
            },
          },
          claimed!,
        ),
      ).rejects.toThrow(`simulated crash at ${phase}`);

      const during = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
      expect(during[0]?.status).toBe('RUNNING'); // 未写终态
      expect(during[0]?.completedAt).toBeNull();
      expect(during[0]?.leaseOwner).toBe('doomed-worker');

      // 租约到期 → 回收 → 新 Worker 继续（不丢任务）
      const recovery = await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 2000) });
      expect(recovery.requeued).toBe(1);
      const reclaimed = await claimJob(deps(), { workerId: 'healthy-worker', leaseSeconds: 30 });
      expect(reclaimed?.id).toBe(job.id);
      const outcome = await executeJob(deps(), registry, { workerId: 'healthy-worker', leaseSeconds: 30, heartbeatIntervalMs: 1000 }, reclaimed!);
      expect(outcome).toBe('succeeded');
      const finalRows = await listJobs(deps(), { workspaceId });
      expect(finalRows[0]?.status).toBe('SUCCEEDED');
      expect(finalRows[0]?.completedAt).not.toBeNull();
    });
  }

  it('真实"杀进程"语义：崩溃点不写终态，恢复后原任务可完成（不丢任务）', async () => {
    const workspaceId = await makeWorkspace();
    const registry = createDefaultRegistry();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    const claimed = await claimJob(deps(), { workerId: 'killed-worker', leaseSeconds: 1 });

    const during = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(during[0]?.status).toBe('RUNNING');
    expect(during[0]?.attempts).toBe(1);
    expect(during[0]?.completedAt).toBeNull();

    await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 2000) });
    const reclaimed = await claimJob(deps(), { workerId: 'new-worker', leaseSeconds: 30 });
    expect(reclaimed?.id).toBe(claimed?.id);
    expect(reclaimed?.attempts).toBe(2);
    await executeJob(deps(), registry, { workerId: 'new-worker', leaseSeconds: 30, heartbeatIntervalMs: 1000 }, reclaimed!);
    const rows = await listJobs(deps(), { workspaceId });
    expect(rows[0]?.status).toBe('SUCCEEDED');
  });
});

describe('重复消费不产生重复副作用', () => {
  it('陈旧 Worker 上报结果 → 409 拒绝；已完成结果不被覆盖、事件不重复', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    await claimJob(deps(), { workerId: 'w1' });
    await completeJob(deps(), { workspaceId, jobId: job.id, result: { by: 'w1' } });

    // 陈旧 Worker（租约已被回收/任务已完成）尝试再次上报
    const stale = await completeJob(deps(), { workspaceId, jobId: job.id, result: { by: 'stale' } }).catch((error: unknown) => error);
    expect(stale).toMatchObject({ httpStatus: 409 });

    const rows = await handle.db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(rows[0]?.result).toEqual({ by: 'w1' });
    const completedEvents = (await handle.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'job.completed'))).filter(
      (row) => (row.payload as { jobId?: string }).jobId === job.id,
    );
    expect(completedEvents).toHaveLength(1);
  });
});

describe('取消协作（P03-02）', () => {
  it('CANCEL_REQUESTED → 执行器心跳感知 → CANCELLED（不是 FAILED）', async () => {
    const workspaceId = await makeWorkspace();
    // 自定 handler：执行中调用 heartbeat（可感知取消请求）
    const cooperative: JobHandler = {
      type: 'COOPERATIVE_TEST',
      description: '取消协作测试',
      async handle(_deps, _input, context) {
        for (let index = 0; index < 20; index += 1) {
          await context.heartbeat(); // 取消请求在此抛 CancellationRequested
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
        return { finished: true };
      },
    };
    const registry = new JobHandlerRegistry([cooperative]);
    const job = await createJob(deps(), { workspaceId, type: 'COOPERATIVE_TEST', input: {} });
    const claimed = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 30, types: ['COOPERATIVE_TEST'] });

    const running = executeJob(deps(), registry, { workerId: 'w1', leaseSeconds: 30, heartbeatIntervalMs: 1000 }, claimed!);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const requested = await cancelJob(deps(), { workspaceId, jobId: job.id });
    expect(requested.status).toBe('CANCEL_REQUESTED');

    const outcome = await running;
    expect(outcome).toBe('cancelled');
    const rows = await listJobs(deps(), { workspaceId });
    expect(rows[0]?.status).toBe('CANCELLED');
    expect(rows[0]?.error).toBeNull();
  }, 15_000);

  it('取消传播：依赖方以明确结果终止（不永久等待）', async () => {
    const workspaceId = await makeWorkspace();
    const upstream = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    const downstream = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {}, dependsOn: [upstream.id] });
    await cancelJob(deps(), { workspaceId, jobId: upstream.id });
    const rows = await listJobs(deps(), { workspaceId });
    const dependent = rows.find((row) => row.id === downstream.id);
    expect(dependent?.status).toBe('FAILED_FINAL');
    expect(dependent?.error).toMatchObject({ reason: 'DEPENDENCY_FAILED', dependencyJobId: upstream.id, status: 'CANCELLED' });
  });
});

describe('失败检查（P03-02）', () => {
  it('孤儿依赖解析：依赖已终态但自身仍等待 → 升级或明确失败', async () => {
    const workspaceId = await makeWorkspace();
    const done = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    const blocked = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {}, dependsOn: [done.id] });
    // done 走正常路径：认领 → 完成（完成时依赖解析会把 blocked 升级——随后人为回退制造"孤儿等待"）
    await claimJob(deps(), { workerId: 'w1' });
    await completeJob(deps(), { workspaceId, jobId: done.id, result: {}, });
    await handle.db.update(jobs).set({ status: 'WAITING_DEPENDENCY' }).where(eq(jobs.id, blocked.id));

    const resolved = await resolveStuckDependents(deps(), {});
    expect(resolved.resolved).toBe(1);
    const rows = await listJobs(deps(), { workspaceId });
    expect(rows.find((row) => row.id === blocked.id)?.status).toBe('QUEUED');

    // 重跑不重复解析
    expect((await resolveStuckDependents(deps(), {})).resolved).toBe(0);
  });

  it('inspectJobs：状态计数 / 需对账 / 终态失败清单', async () => {
    const workspaceId = await makeWorkspace();
    const ok = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    const bad = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    await claimJob(deps(), { workerId: 'w1' });
    await completeJob(deps(), { workspaceId, jobId: ok.id, result: {} });
    await claimJob(deps(), { workerId: 'w1' });
    await failJob(deps(), { workspaceId, jobId: bad.id, error: { reason: 'PERMANENT' }, retryable: false });
    // 需对账标记
    await transitionJob(deps(), { workspaceId, jobId: bad.id, to: 'QUEUED', reason: 'MANUAL_RETRY' });
    await claimJob(deps(), { workerId: 'w1' });
    await transitionJob(deps(), { workspaceId, jobId: bad.id, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED' });
    await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 61_000) });
    await cancelJob(deps(), { workspaceId, jobId: bad.id });

    const report = await inspectJobs(deps(), { workspaceId });
    expect(report.byStatus['SUCCEEDED']).toBe(1);
    expect(report.byStatus['CANCELLED']).toBe(1);
    expect(report.needsReconciliation).toBe(1);
    expect(report.failedFinal.map((row) => row.jobId)).not.toContain(ok.id);
  });
});
