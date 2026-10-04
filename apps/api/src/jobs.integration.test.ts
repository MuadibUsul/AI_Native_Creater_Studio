import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import type { JobQueueAdapter, JobQueueMessage } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, outboxEvents, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import {
  NOOP_JOB_TYPE,
  cancelJob,
  claimJob,
  completeJob,
  createJob,
  failJob,
  heartbeatJob,
  listJobs,
  requeueExpiredLeases,
  retryJob,
  runJobDispatch,
  transitionJob,
  type DomainDeps,
} from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * P03-01 验收（真实 DB）：
 * - 事务 + Outbox 投递：创建/迁移同事务写事件；**派发中断（队列不可用）不丢任务**，重跑恢复；
 * - 状态机：合法迁移与非法迁移（409）；租约认领 / 心跳 / 完成 / 失败（可重试判定）；
 * - **Worker 崩溃恢复**：租约到期回收 → QUEUED（PROVIDER_QUEUED 回收标记需对账，不自动重复付费）；
 * - 依赖：全部成功 → 依赖方升级 QUEUED；任一失败/取消 → 依赖方 FAILED_FINAL（明确传播，不永久等待）；
 * - API/SDK：详情/列表/取消/重试；VIEWER 403（generation:run）；跨租户 404。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

/** 记录型队列适配器（契约验证 + 可控失败模拟"投递中断"） */
class RecordingQueue implements JobQueueAdapter {
  readonly kind = 'recording';
  messages: JobQueueMessage[] = [];
  failNext = false;
  async enqueue(message: JobQueueMessage): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('queue unavailable（模拟投递中断）');
    }
    this.messages.push(message);
  }
}

const queue = new RecordingQueue();
const deps = (): DomainDeps => ({ db: handle.db, queue });

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
  auth = createAuth({
    db: handle.db,
    secret: 'jobs-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  queue.messages = [];
  queue.failNext = false;
});

async function makeWorkspace(): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '任务测试租户' });
  return workspaceId;
}

const jobEvents = async (workspaceId: string, jobId?: string) =>
  (
    await handle.db
      .select()
      .from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspaceId), eq(outboxEvents.type, 'job.queued')))
      .orderBy(asc(outboxEvents.seq))
  ).filter((row) => (jobId === undefined ? true : (row.payload as { jobId?: string }).jobId === jobId));

describe('任务生命周期（P03-01）', () => {
  it('创建 → Outbox 派发（消息只含任务 ID）→ 认领 → 心跳 → 完成；事件与状态同事务', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { echo: 'hello' }, createdBy: null });
    expect(job.status).toBe('QUEUED');

    // 创建即写 Outbox（未发布）——事务提交后即使派发进程崩溃也不丢
    const pending = await jobEvents(workspaceId, job.id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.publishedAt).toBeNull();

    const dispatch = await runJobDispatch(deps(), { limit: 10 });
    expect(dispatch.enqueued).toBe(1);
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0]).toMatchObject({ jobId: job.id, queue: 'default', attempt: 0 });
    expect(Object.keys(queue.messages[0] ?? {}).sort()).toEqual(['attempt', 'jobId', 'queue']); // 权威输入不进消息

    const afterDispatch = await jobEvents(workspaceId, job.id);
    expect(afterDispatch[0]?.publishedAt).not.toBeNull();

    // 认领（attempts+1、设置租约、job.started 事件）
    const claimed = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 30 });
    expect(claimed?.id).toBe(job.id);
    expect(claimed?.status).toBe('RUNNING');
    expect(claimed?.attempts).toBe(1);
    const started = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.type, 'job.started'));
    expect(started.map((row) => (row.payload as { jobId?: string }).jobId)).toContain(job.id);

    // 心跳延长租约（仅租约持有者）
    const beat = await heartbeatJob(deps(), { workspaceId, jobId: job.id, workerId: 'w1', leaseSeconds: 60, stage: 'EXECUTE' });
    expect(beat.stage).toBe('EXECUTE');
    await expect(heartbeatJob(deps(), { workspaceId, jobId: job.id, workerId: 'w2' })).rejects.toMatchObject({ httpStatus: 409 });

    // 完成（终态 + 事件）
    const completed = await completeJob(deps(), { workspaceId, jobId: job.id, result: { ok: true } });
    expect(completed.status).toBe('SUCCEEDED');
    expect(completed.result).toEqual({ ok: true });
    expect(completed.completedAt).not.toBeNull();

    // 队列已空（认领不到）
    expect(await claimJob(deps(), { workerId: 'w1' })).toBeNull();
  });

  it('投递中断可恢复（不丢任务）：队列不可用时不标记发布，重跑派发恢复', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });

    queue.failNext = true; // 模拟"投递中断"（队列不可用/进程崩溃）
    const failedDispatch = await runJobDispatch(deps(), { limit: 10 });
    expect(failedDispatch.failed).toBe(1);
    expect(failedDispatch.enqueued).toBe(0);
    expect(queue.messages).toHaveLength(0);
    const stillPending = await jobEvents(workspaceId, job.id);
    expect(stillPending[0]?.publishedAt).toBeNull(); // 事件保持未发布
    const notEnqueued = await listJobs(deps(), { workspaceId });
    expect(notEnqueued[0]?.enqueuedAt).toBeNull();

    // 恢复后重跑派发 → 投递成功（任务未丢）
    const recovered = await runJobDispatch(deps(), { limit: 10 });
    expect(recovered.enqueued).toBe(1);
    expect(queue.messages[0]?.jobId).toBe(job.id);
  });

  it('Worker 崩溃恢复：租约到期回收 → QUEUED；PROVIDER_QUEUED 回收标记需对账（不自动重复付费）', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    await claimJob(deps(), { workerId: 'crashed-worker', leaseSeconds: 1 });
    // Worker 崩溃（不再心跳）→ 租约到期
    const recovered = await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 2000) });
    expect(recovered.requeued).toBe(1);
    expect(recovered.needsReconciliation).toBe(0);
    const requeued = await listJobs(deps(), { workspaceId });
    expect(requeued[0]?.status).toBe('QUEUED');
    expect(requeued[0]?.attempts).toBe(1); // 已消耗的尝试保留
    const leaseEvents = await jobEvents(workspaceId, job.id);
    expect(leaseEvents.some((row) => (row.payload as { reason?: string }).reason === 'LEASE_EXPIRED')).toBe(true);

    // 可再次认领
    const reclaimed = await claimJob(deps(), { workerId: 'healthy-worker', leaseSeconds: 30 });
    expect(reclaimed?.attempts).toBe(2);

    // PROVIDER_QUEUED（已提交 Provider）租约到期 → 需对账 + SUBMISSION_UNKNOWN，禁止自动重复提交
    await transitionJob(deps(), { workspaceId, jobId: job.id, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED' });
    await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 31_000) });
    const afterReconcile = await listJobs(deps(), { workspaceId });
    expect(afterReconcile[0]?.status).toBe('QUEUED');
    expect(afterReconcile[0]?.needsReconciliation).toBe(true);
    expect(afterReconcile[0]?.submitState).toBe('SUBMISSION_UNKNOWN');
  });

  it('依赖：全部成功 → 依赖方升级 QUEUED 并派发；任一失败 → 依赖方 FAILED_FINAL（不永久等待）', async () => {
    const workspaceId = await makeWorkspace();
    const upstream = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { step: 'A' } });
    const downstream = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { step: 'B' }, dependsOn: [upstream.id] });
    expect(downstream.status).toBe('WAITING_DEPENDENCY');
    // 等待依赖的任务不产生派发事件
    expect(await jobEvents(workspaceId, downstream.id)).toHaveLength(0);

    await claimJob(deps(), { workerId: 'w1' });
    await completeJob(deps(), { workspaceId, jobId: upstream.id, result: { ok: true } });

    const promoted = await listJobs(deps(), { workspaceId });
    const promotedB = promoted.find((row) => row.id === downstream.id);
    expect(promotedB?.status).toBe('QUEUED');
    const promotedEvents = await jobEvents(workspaceId, downstream.id);
    expect((promotedEvents.at(-1)?.payload as { reason?: string }).reason).toBe('DEPENDENCIES_RESOLVED');

    // 失败传播：C 失败（不可重试）→ D 明确 FAILED_FINAL
    const failing = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { step: 'C' } });
    const dependent = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: { step: 'D' }, dependsOn: [failing.id] });
    await claimJob(deps(), { workerId: 'w1' });
    await failJob(deps(), { workspaceId, jobId: failing.id, error: { reason: 'BOOM' }, retryable: false });

    const afterFailure = await listJobs(deps(), { workspaceId });
    const dependentRow = afterFailure.find((row) => row.id === dependent.id);
    expect(dependentRow?.status).toBe('FAILED_FINAL');
    expect(dependentRow?.error).toMatchObject({ reason: 'DEPENDENCY_FAILED', dependencyJobId: failing.id, status: 'FAILED_FINAL' });
  });

  it('取消与重试：QUEUED → CANCELLED；执行中 → CANCEL_REQUESTED → CANCELLED；人工重试重新派发', async () => {
    const workspaceId = await makeWorkspace();
    const queued = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    const cancelled = await cancelJob(deps(), { workspaceId, jobId: queued.id });
    expect(cancelled.status).toBe('CANCELLED');
    await expect(cancelJob(deps(), { workspaceId, jobId: queued.id })).rejects.toMatchObject({ httpStatus: 409 });

    // 执行中取消 → CANCEL_REQUESTED → Worker 协作式收敛为 CANCELLED
    const running = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {} });
    await claimJob(deps(), { workerId: 'w1', leaseSeconds: 30 });
    const requested = await cancelJob(deps(), { workspaceId, jobId: running.id });
    expect(requested.status).toBe('CANCEL_REQUESTED');
    const finished = await transitionJob(deps(), { workspaceId, jobId: running.id, to: 'CANCELLED', reason: 'WORKER_HONORED_CANCEL' });
    expect(finished.status).toBe('CANCELLED');

    // 人工重试：CANCELLED → QUEUED 且重新派发（Outbox 事件）
    queue.messages = [];
    const retried = await retryJob(deps(), { workspaceId, jobId: running.id });
    expect(retried.status).toBe('QUEUED');
    const dispatch = await runJobDispatch(deps(), { limit: 10 });
    // 至少一次投递（at-least-once）：重试可能让同一任务的旧事件也可派发，故允许 >1 条；
    // 重复投递无害——认领是 CAS（SKIP LOCKED + 状态条件），未持租约的消息不会执行任务。
    expect(dispatch.enqueued).toBeGreaterThanOrEqual(1);
    expect(queue.messages.every((message) => message.jobId === running.id)).toBe(true);
    const claimable = await claimJob(deps(), { workerId: 'w1', leaseSeconds: 30 });
    expect(claimable?.id).toBe(running.id);
    expect(await claimJob(deps(), { workerId: 'w2', leaseSeconds: 30 })).toBeNull(); // 重复消息不会产生第二个执行者
  });

  it('非法状态迁移 → 409（状态机强制）；失败可重试判定按尝试次数', async () => {
    const workspaceId = await makeWorkspace();
    const job = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {}, maxAttempts: 2 });
    await claimJob(deps(), { workerId: 'w1' });
    await completeJob(deps(), { workspaceId, jobId: job.id, result: {} });
    await expect(
      transitionJob(deps(), { workspaceId, jobId: job.id, to: 'RUNNING' }),
    ).rejects.toMatchObject({ httpStatus: 409, code: 'PRECONDITION_FAILED' });

    const retryable = await createJob(deps(), { workspaceId, type: NOOP_JOB_TYPE, input: {}, maxAttempts: 2 });
    await claimJob(deps(), { workerId: 'w1' });
    const firstFailure = await failJob(deps(), { workspaceId, jobId: retryable.id, error: { reason: 'TEMP' } });
    expect(firstFailure.status).toBe('FAILED_RETRYABLE');
    await retryJob(deps(), { workspaceId, jobId: retryable.id });
    await claimJob(deps(), { workerId: 'w1' });
    const finalFailure = await failJob(deps(), { workspaceId, jobId: retryable.id, error: { reason: 'TEMP_AGAIN' } });
    expect(finalFailure.status).toBe('FAILED_FINAL'); // attempts 2/2
  });

});

describe('任务 API / SDK（含越权）', () => {
  async function newClient(email?: string): Promise<{ client: AncsClient; email: string }> {
    const finalEmail = email ?? `jobs-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email: finalEmail, password: 'password-1234', name: '任务测试' });
    const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    await client.auth.signIn({ email: finalEmail, password: 'password-1234' });
    return { client, email: finalEmail };
  }

  it('SDK：详情/列表/取消；跨租户 404；VIEWER 取消 403（generation:run）', async () => {
    const owner = await newClient();
    const viewer = await newClient();
    const stranger = await newClient();
    const workspace = await owner.client.workspaces.create({ name: `任务-${randomUUID().slice(0, 8)}` });
    await owner.client.workspaces.members.add(workspace.id, { email: viewer.email, role: 'VIEWER' });

    // 该字段用于断言「消息体不携带权威输入」——普通标记值，非凭据
    const created = await createJob(deps(), { workspaceId: workspace.id, type: NOOP_JOB_TYPE, input: { markerInput: 'not-a-secret' } });
    const fetched = await owner.client.jobs.get(workspace.id, created.id);
    expect(fetched.id).toBe(created.id);
    expect(fetched.status).toBe('QUEUED');
    const listed = await owner.client.jobs.list(workspace.id, { status: 'QUEUED' });
    expect(listed.map((row) => row.id)).toContain(created.id);

    // VIEWER 可读（workspace:read），不可取消/重试
    expect((await viewer.client.jobs.get(workspace.id, created.id)).id).toBe(created.id);
    const forbidden = await viewer.client.jobs.cancel(workspace.id, created.id).catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(AncsApiError);
    expect(forbidden).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((forbidden as AncsApiError).details['requiredCapability']).toBe('generation:run');

    // 跨租户：404（抗枚举）
    const strangerFailure = await stranger.client.jobs.get(workspace.id, created.id).catch((error: unknown) => error);
    expect(strangerFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const strangerCancel = await stranger.client.jobs.cancel(workspace.id, created.id).catch((error: unknown) => error);
    expect(strangerCancel).toMatchObject({ status: 404 });

    // 取消（OWNER，generation:run）
    const cancelled = await owner.client.jobs.cancel(workspace.id, created.id);
    expect(cancelled.status).toBe('CANCELLED');
  });
});
