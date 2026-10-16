import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, WORKFLOW_ADVANCE_JOB_TYPE, WORKFLOW_ERROR_REASONS } from '@ancs/contracts';
import { createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workflowRuns, workflowSteps, workspaces, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  advanceWorkflow,
  cancelWorkflow,
  getWorkflowRun,
  resolveWorkflowGate,
  startWorkflow,
  type DomainDeps,
  type WorkflowStepDefinition,
} from './index.js';

/**
 * V5-M4（§11.1）工作流引擎（真实 PostgreSQL）：
 * 顺序推进与输出累积、幂等启动、可重试失败的退避再推进、单推进者（被替换的任务直接退出）、丢租约遗留、
 * 不可重试失败的逆序补偿（补偿失败不阻断其他补偿）、人工门批准/拒绝、NEEDS_HUMAN 人工批准后重试、
 * 取消（步骤边界 + 补偿）、长步骤心跳。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) {
    await handle.close();
    throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error });
  }
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

async function workspace(): Promise<string> {
  const id = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id, name: 'V5-M4 工作流引擎' });
  return id;
}

const step = (key: string, run: WorkflowStepDefinition['run'], extra: Partial<WorkflowStepDefinition> = {}): WorkflowStepDefinition => ({ key, maxAttempts: 2, run, ...extra });
const done = (output: Record<string, unknown> = {}) => async () => ({ kind: 'DONE' as const, output });

async function start(registry: WorkflowRegistry, type: string, workspaceId: string, idempotencyKey: string | null = null) {
  registry.get(type, 1);
  return startWorkflow(deps(), { workspaceId, projectId: null, type, version: 1, subjectRef: 'test:subject', input: { n: 1 }, idempotencyKey });
}
const activeJob = async (runId: string): Promise<string> => (await handle.db.select({ activeJobId: workflowRuns.activeJobId }).from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!.activeJobId!;
const advance = async (registry: WorkflowRegistry, workspaceId: string, runId: string, jobId?: string) =>
  advanceWorkflow(deps(), registry, { workspaceId, runId, jobId: jobId ?? await activeJob(runId) });

describe('工作流引擎（真实 PostgreSQL）', () => {
  it('顺序推进：步骤输出按步骤键累积，后续步骤可读前序输出；运行与首个推进任务同事务创建', async () => {
    const workspaceId = await workspace();
    const seen: unknown[] = [];
    const registry = new WorkflowRegistry().register({
      type: 'T_SUCCESS', version: 1, steps: [
        step('a', done({ value: 1 })),
        step('b', async (context) => { seen.push(context.run.outputs['a']); return { kind: 'DONE', output: { value: 2 } }; }),
      ],
    });
    const run = await start(registry, 'T_SUCCESS', workspaceId);
    expect(run.status).toBe('RUNNING');
    const job = (await handle.db.select().from(jobs).where(eq(jobs.id, await activeJob(run.id))))[0]!;
    expect(job).toMatchObject({ type: WORKFLOW_ADVANCE_JOB_TYPE, status: 'QUEUED', input: { runId: run.id } });

    const result = await advance(registry, workspaceId, run.id);
    expect(result).toEqual({ status: 'SUCCEEDED', executedSteps: ['a', 'b'], superseded: false });
    expect(seen).toEqual([{ value: 1 }]);
    const finished = await getWorkflowRun(deps(), { workspaceId, runId: run.id });
    expect(finished.outputs).toEqual({ a: { value: 1 }, b: { value: 2 } });
    expect(finished.steps.map((row) => `${row.stepKey}#${String(row.attempt)}:${row.status}`)).toEqual(['a#1:SUCCEEDED', 'b#1:SUCCEEDED']);
    expect(finished.completedAt).not.toBeNull();
    // 终态后再推进：无写入
    expect((await advance(registry, workspaceId, run.id)).executedSteps).toEqual([]);
  });

  it('幂等启动：同工作区 + 类型 + 键只建一个运行、一个推进任务；不同工作区互不影响', async () => {
    const workspaceId = await workspace();
    const registry = new WorkflowRegistry().register({ type: 'T_IDEM', version: 1, steps: [step('a', done())] });
    const first = await start(registry, 'T_IDEM', workspaceId, 'key-1');
    const second = await start(registry, 'T_IDEM', workspaceId, 'key-1');
    expect(second.id).toBe(first.id);
    const jobRows = await handle.db.select().from(jobs).where(and(eq(jobs.workspaceId, workspaceId), eq(jobs.type, WORKFLOW_ADVANCE_JOB_TYPE)));
    expect(jobRows).toHaveLength(1);
    const other = await start(registry, 'T_IDEM', await workspace(), 'key-1');
    expect(other.id).not.toBe(first.id);
  });

  it('可重试失败：记失败尝试并按退避另起推进任务（旧任务被替换后直接退出）；新任务重试成功', async () => {
    const workspaceId = await workspace();
    let calls = 0;
    const registry = new WorkflowRegistry().register({
      type: 'T_RETRY', version: 1, steps: [step('flaky', async () => {
        calls += 1;
        if (calls === 1) throw new Error('transient network glitch');
        return { kind: 'DONE', output: { calls } };
      })],
    });
    const run = await start(registry, 'T_RETRY', workspaceId);
    const firstJob = await activeJob(run.id);
    const first = await advance(registry, workspaceId, run.id, firstJob);
    expect(first.status).toBe('RUNNING');
    const retryJobId = await activeJob(run.id);
    expect(retryJobId).not.toBe(firstJob);
    const retryJob = (await handle.db.select().from(jobs).where(eq(jobs.id, retryJobId)))[0]!;
    expect(retryJob.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    // 被替换的旧推进任务：不写任何东西
    expect(await advance(registry, workspaceId, run.id, firstJob)).toEqual({ status: 'RUNNING', executedSteps: [], superseded: true });
    expect(calls).toBe(1);

    const second = await advance(registry, workspaceId, run.id, retryJobId);
    expect(second.status).toBe('SUCCEEDED');
    const finished = await getWorkflowRun(deps(), { workspaceId, runId: run.id });
    expect(finished.steps.map((row) => [row.attempt, row.status, row.errorClass])).toEqual([[1, 'FAILED', 'RETRYABLE'], [2, 'SUCCEEDED', null]]);
    expect(finished.steps[0]!.error).toMatchObject({ message: 'transient network glitch' });
  });

  it('达到尝试上限 / 不可重试：逆序补偿已成功步骤（补偿失败只记录，不阻断其他补偿），运行失败带错误', async () => {
    const workspaceId = await workspace();
    const compensated: string[] = [];
    const registry = new WorkflowRegistry().register({
      type: 'T_FAIL', version: 1, steps: [
        step('reserve', done({ reserved: true }), { compensate: async () => { compensated.push('reserve'); } }),
        step('submit', done({ submitted: true }), { compensate: async () => { compensated.push('submit'); throw new Error('provider cancel failed'); } }),
        step('verify', async () => { throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'quality gate failed', 409, { reason: 'QA' }); }),
      ],
    });
    const run = await start(registry, 'T_FAIL', workspaceId);
    const result = await advance(registry, workspaceId, run.id);
    expect(result.status).toBe('FAILED');
    expect(compensated).toEqual(['submit', 'reserve']);
    const finished = await getWorkflowRun(deps(), { workspaceId, runId: run.id });
    expect(finished.error).toMatchObject({ step: 'verify', httpStatus: 409, details: { reason: 'QA' } });
    expect(finished.steps.find((row) => row.stepKey === 'verify')).toMatchObject({ attempt: 1, status: 'FAILED', errorClass: 'NON_RETRYABLE' });
    expect(Object.fromEntries(finished.steps.filter((row) => row.status === 'SUCCEEDED').map((row) => [row.stepKey, row.compensationStatus]))).toEqual({ reserve: 'COMPENSATED', submit: 'COMPENSATION_FAILED' });

    // 可重试错误在 maxAttempts=1 时同样直接失败（付费类步骤不无限重试）
    const once = new WorkflowRegistry().register({ type: 'T_ONCE', version: 1, steps: [step('paid', async () => { throw new Error('timeout'); }, { maxAttempts: 1 })] });
    const onceRun = await start(once, 'T_ONCE', workspaceId);
    expect((await advance(once, workspaceId, onceRun.id)).status).toBe('FAILED');
  });

  it('丢租约：推进任务崩溃遗留的 RUNNING 尝试由下一次推进记为 LEASE_LOST 并重试', async () => {
    const workspaceId = await workspace();
    const registry = new WorkflowRegistry().register({ type: 'T_LEASE', version: 1, steps: [step('render', done({ ok: true }))] });
    const run = await start(registry, 'T_LEASE', workspaceId);
    // 模拟：上一个推进者开始了第 1 次尝试后进程被杀
    await handle.db.insert(workflowSteps).values({ id: `wfs_${randomUUID()}`, runId: run.id, workspaceId, stepKey: 'render', attempt: 1, status: 'RUNNING' });
    expect((await advance(registry, workspaceId, run.id)).status).toBe('SUCCEEDED');
    const finished = await getWorkflowRun(deps(), { workspaceId, runId: run.id });
    expect(finished.steps.map((row) => [row.attempt, row.status, row.errorClass])).toEqual([[1, 'FAILED', 'LEASE_LOST'], [2, 'SUCCEEDED', null]]);
  });

  it('人工门：等待人工 → 批准后继续（决定并入上下文）；拒绝 → 失败并补偿；非等待状态决策 409', async () => {
    const workspaceId = await workspace();
    const compensated: string[] = [];
    const registry = new WorkflowRegistry().register({
      type: 'T_GATE', version: 1, steps: [
        step('quote', done({ amount: 3 }), { compensate: async () => { compensated.push('quote'); } }),
        step('authorize', async () => ({ kind: 'WAIT_HUMAN', gate: 'AUTHORIZATION', reason: 'paid generation needs approval' })),
        step('submit', done({ submitted: true })),
      ],
    });
    const approved = await start(registry, 'T_GATE', workspaceId);
    expect((await advance(registry, workspaceId, approved.id)).status).toBe('WAITING_HUMAN');
    await expect(resolveWorkflowGate(deps(), { workspaceId, runId: approved.id, stepKey: 'quote', decision: 'APPROVE', actorId: null }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: WORKFLOW_ERROR_REASONS.GATE_NOT_WAITING } });
    await resolveWorkflowGate(deps(), { workspaceId, runId: approved.id, stepKey: 'authorize', decision: 'APPROVE', actorId: 'usr_owner', note: 'ok' });
    expect((await advance(registry, workspaceId, approved.id)).status).toBe('SUCCEEDED');
    expect((await getWorkflowRun(deps(), { workspaceId, runId: approved.id })).outputs['authorize']).toEqual({ decision: 'APPROVE', actorId: 'usr_owner', note: 'ok' });

    const rejected = await start(registry, 'T_GATE', workspaceId);
    await advance(registry, workspaceId, rejected.id);
    await resolveWorkflowGate(deps(), { workspaceId, runId: rejected.id, stepKey: 'authorize', decision: 'REJECT', actorId: 'usr_owner' });
    expect((await advance(registry, workspaceId, rejected.id)).status).toBe('FAILED');
    expect(compensated).toEqual(['quote']);
    expect((await getWorkflowRun(deps(), { workspaceId, runId: rejected.id })).error).toMatchObject({ step: 'authorize', reason: 'REJECTED_BY_HUMAN' });
  });

  it('NEEDS_HUMAN：失败需人工 → 等待；人工批准后即使已达尝试上限也再试一次', async () => {
    const workspaceId = await workspace();
    let calls = 0;
    const registry = new WorkflowRegistry().register({
      type: 'T_HUMAN', version: 1, steps: [step('publish', async () => {
        calls += 1;
        if (calls === 1) throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'platform account needs re-authorization', 403);
        return { kind: 'DONE', output: { published: true } };
      }, { maxAttempts: 1, classify: () => 'NEEDS_HUMAN' })],
    });
    const run = await start(registry, 'T_HUMAN', workspaceId);
    expect((await advance(registry, workspaceId, run.id)).status).toBe('WAITING_HUMAN');
    await resolveWorkflowGate(deps(), { workspaceId, runId: run.id, stepKey: 'publish', decision: 'APPROVE', actorId: 'usr_owner' });
    expect((await advance(registry, workspaceId, run.id)).status).toBe('SUCCEEDED');
    expect(calls).toBe(2);
  });

  it('取消：等待人工时取消 → 新推进任务补偿并置 CANCELLED；终态运行再取消 409', async () => {
    const workspaceId = await workspace();
    const compensated: string[] = [];
    const registry = new WorkflowRegistry().register({
      type: 'T_CANCEL', version: 1, steps: [
        step('reserve', done(), { compensate: async () => { compensated.push('reserve'); } }),
        step('gate', async () => ({ kind: 'WAIT_HUMAN', gate: 'APPROVAL', reason: 'review' })),
      ],
    });
    const run = await start(registry, 'T_CANCEL', workspaceId);
    await advance(registry, workspaceId, run.id);
    const cancelled = await cancelWorkflow(deps(), { workspaceId, runId: run.id });
    expect(cancelled.status).toBe('CANCEL_REQUESTED');
    expect((await advance(registry, workspaceId, run.id)).status).toBe('CANCELLED');
    expect(compensated).toEqual(['reserve']);
    await expect(cancelWorkflow(deps(), { workspaceId, runId: run.id })).rejects.toMatchObject({ httpStatus: 409, details: { reason: WORKFLOW_ERROR_REASONS.NOT_CANCELLABLE } });
    // 跨工作区读取 → 404
    await expect(getWorkflowRun(deps(), { workspaceId: await workspace(), runId: run.id })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('长步骤执行期间定时心跳（保持推进任务租约）', async () => {
    const workspaceId = await workspace();
    const registry = new WorkflowRegistry().register({
      type: 'T_HEARTBEAT', version: 1, steps: [step('slow', async () => { await new Promise((resolve) => { setTimeout(resolve, 60); }); return { kind: 'DONE', output: {} }; })],
    });
    const run = await start(registry, 'T_HEARTBEAT', workspaceId);
    let beats = 0;
    await advanceWorkflow(deps(), registry, { workspaceId, runId: run.id, jobId: await activeJob(run.id), heartbeat: async () => { beats += 1; }, heartbeatIntervalMs: 10 });
    expect(beats).toBeGreaterThanOrEqual(3);
  });

  it('未注册的定义：推进时显式失败（不静默跳过）', async () => {
    const workspaceId = await workspace();
    const run = await startWorkflow(deps(), { workspaceId, projectId: null, type: 'T_UNKNOWN', version: 1, subjectRef: 'x', input: {} });
    await expect(advance(new WorkflowRegistry(), workspaceId, run.id)).rejects.toMatchObject({ httpStatus: 500, details: { reason: WORKFLOW_ERROR_REASONS.UNKNOWN_DEFINITION } });
  });
});
