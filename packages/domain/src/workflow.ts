import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  WORKFLOW_ADVANCE_JOB_TYPE,
  WORKFLOW_ERROR_REASONS,
  WORKFLOW_TERMINAL_STATUSES,
  workflowRunSchema,
  type WorkflowErrorClass,
  type WorkflowRun,
  type WorkflowRunStatus,
} from '@ancs/contracts';
import { workflowRuns, workflowSteps } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { computeBackoffSeconds, createJobInTx } from './jobs.js';

/**
 * V5-M4（§11.1）：工作流引擎（库，不引入外部平台）。
 *
 * - 运行与每个步骤的每次尝试都持久化；推进由 `WORKFLOW_ADVANCE` 任务承载（沿用任务租约/心跳/退避）。
 * - **单推进者**：运行行记录 `active_job_id`，推进前比较并占用（CAS）；过期或被替换的推进任务直接退出。
 * - 失败分类：步骤声明的 `classify`（缺省：4xx/501 的 ApiFailure 不可重试，其余可重试）；
 *   可重试且未达上限 → 记失败尝试、按退避入队新推进任务；否则运行失败并**逆序补偿**已成功步骤。
 * - 人工门：步骤返回 `WAIT_HUMAN` → 运行进入 WAITING_HUMAN，`resolveWorkflowGate` 决定后继续。
 * - 等条件：步骤返回 `WAIT_UNTIL` → 本次尝试撤销（不计次数），延迟后由新的推进任务重新执行该步骤；运行保持 RUNNING。
 * - 推进任务丢租约时遗留的 RUNNING 尝试，由下一次推进记为 `LEASE_LOST`（计入尝试次数）。
 * 外部/付费调用只能作为步骤存在（V5 §11.1）；步骤实现自己负责幂等（例如产物按 (runId, kind) 复用）。
 */

export type WorkflowStepOutcome =
  | { kind: 'DONE'; output: Record<string, unknown> }
  | { kind: 'WAIT_HUMAN'; gate: string; reason: string }
  /**
   * 条件还没满足（例如素材还在处理）：过一会儿再执行同一步骤。不算一次失败的尝试，也不留下尝试记录；
   * 等多久、等到什么时候放弃由步骤自己决定（步骤必须有自己的截止时间，引擎不替它无限等待）。
   */
  | { kind: 'WAIT_UNTIL'; delaySeconds: number; reason: string };

export interface WorkflowStepContext {
  deps: DomainDeps;
  run: { id: string; workspaceId: string; projectId: string | null; type: string; input: Record<string, unknown>; outputs: Record<string, unknown> };
  attempt: number;
  jobId: string | null;
}

export interface WorkflowStepDefinition {
  key: string;
  /** 含首次尝试 */
  maxAttempts: number;
  run(context: WorkflowStepContext): Promise<WorkflowStepOutcome>;
  compensate?(context: WorkflowStepContext): Promise<void>;
  classify?(error: unknown): WorkflowErrorClass;
}

export interface WorkflowDefinition {
  type: string;
  version: number;
  steps: readonly WorkflowStepDefinition[];
  /**
   * 运行以失败或取消结束时调用（补偿之后、运行状态落定之前）：让拥有者收尾自己的业务记录
   * （例如把仍在进行中的 AI 轮次标为失败/取消），即使一个步骤都没有执行过。失败只吞掉不阻断收尾。
   */
  onTerminated?(context: { deps: DomainDeps; run: WorkflowStepContext['run']; status: 'FAILED' | 'CANCELLED'; error: Record<string, unknown> | null }): Promise<void>;
}

export class WorkflowRegistry {
  private readonly definitions = new Map<string, WorkflowDefinition>();
  register(definition: WorkflowDefinition): this {
    const keys = new Set(definition.steps.map((step) => step.key));
    if (keys.size !== definition.steps.length) throw new Error(`workflow ${definition.type} has duplicate step keys`);
    this.definitions.set(`${definition.type}@${String(definition.version)}`, definition);
    return this;
  }
  get(type: string, version: number): WorkflowDefinition {
    const definition = this.definitions.get(`${type}@${String(version)}`);
    if (definition === undefined) {
      throw new ApiFailure(ERROR_CODES.INTERNAL, `unknown workflow definition ${type}@${String(version)}`, 500, { reason: WORKFLOW_ERROR_REASONS.UNKNOWN_DEFINITION });
    }
    return definition;
  }
}

/** 缺省分类：业务前置条件/能力缺失（4xx、501）不可重试；其余（含意外异常）可重试。 */
export function defaultWorkflowErrorClass(error: unknown): WorkflowErrorClass {
  if (error instanceof ApiFailure) return error.httpStatus < 500 || error.httpStatus === 501 ? 'NON_RETRYABLE' : 'RETRYABLE';
  return 'RETRYABLE';
}

const errorSummary = (error: unknown): Record<string, unknown> => (error instanceof ApiFailure
  ? { code: error.code, message: error.message.slice(0, 500), httpStatus: error.httpStatus, details: error.details }
  : { message: (error instanceof Error ? error.message : String(error)).slice(0, 500) });

type RunRow = typeof workflowRuns.$inferSelect;
type StepRow = typeof workflowSteps.$inferSelect;

const isTerminal = (status: string): boolean => (WORKFLOW_TERMINAL_STATUSES as readonly string[]).includes(status);

function toWorkflowRun(row: RunRow, steps: readonly StepRow[]): WorkflowRun {
  return workflowRunSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    type: row.type,
    version: row.version,
    subjectRef: row.subjectRef,
    status: row.status,
    currentStep: row.currentStep,
    outputs: (row.context as Record<string, unknown>) ?? {},
    error: (row.error as Record<string, unknown> | null) ?? null,
    steps: steps.map((step) => ({
      stepKey: step.stepKey,
      attempt: step.attempt,
      status: step.status,
      errorClass: step.errorClass,
      error: (step.error as Record<string, unknown> | null) ?? null,
      compensationStatus: step.compensationStatus,
      startedAt: step.startedAt.toISOString(),
      finishedAt: step.finishedAt?.toISOString() ?? null,
    })),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

async function loadRun(deps: DomainDeps, input: { workspaceId: string; runId: string }): Promise<RunRow> {
  const rows = await deps.db.select().from(workflowRuns).where(and(eq(workflowRuns.id, input.runId), eq(workflowRuns.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'workflow run not found', 404, { reason: WORKFLOW_ERROR_REASONS.RUN_NOT_FOUND });
  return row;
}

async function loadSteps(deps: DomainDeps, runId: string): Promise<StepRow[]> {
  return deps.db.select().from(workflowSteps).where(eq(workflowSteps.runId, runId)).orderBy(workflowSteps.startedAt, workflowSteps.attempt);
}

export async function getWorkflowRun(deps: DomainDeps, input: { workspaceId: string; runId: string }): Promise<WorkflowRun> {
  const row = await loadRun(deps, input);
  return toWorkflowRun(row, await loadSteps(deps, row.id));
}

export async function listWorkflowRuns(deps: DomainDeps, input: { workspaceId: string; projectId: string; type: string; limit?: number }): Promise<WorkflowRun[]> {
  const rows = await deps.db.select().from(workflowRuns)
    .where(and(eq(workflowRuns.workspaceId, input.workspaceId), eq(workflowRuns.projectId, input.projectId), eq(workflowRuns.type, input.type)))
    .orderBy(desc(workflowRuns.createdAt)).limit(Math.min(input.limit ?? 20, 100));
  const out: WorkflowRun[] = [];
  for (const row of rows) out.push(toWorkflowRun(row, await loadSteps(deps, row.id)));
  return out;
}

type Tx = Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0];

/**
 * 入队一个推进任务并把它登记为运行的唯一有效推进者（替换旧推进者）。
 * 必须与任务创建同一事务：否则任务可能在登记前被认领，看到推进者不符而退出，运行就此搁置。
 */
async function enqueueAdvanceInTx(tx: Tx, run: Pick<RunRow, 'id' | 'workspaceId' | 'projectId'>, options: { delaySeconds?: number; priority?: number; createdBy?: string | null } = {}): Promise<string> {
  const job = await createJobInTx(tx, {
    workspaceId: run.workspaceId,
    projectId: run.projectId,
    type: WORKFLOW_ADVANCE_JOB_TYPE,
    input: { runId: run.id },
    priority: options.priority,
    // 推进任务本身不重试业务步骤（步骤重试由引擎按步骤策略另起推进任务）；只允许一次租约恢复
    maxAttempts: 2,
    createdBy: options.createdBy ?? null,
    notBefore: options.delaySeconds === undefined ? undefined : new Date(Date.now() + options.delaySeconds * 1000),
  });
  await tx.update(workflowRuns).set({ activeJobId: job.id, updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
  return job.id;
}

const enqueueAdvance = (deps: DomainDeps, run: Pick<RunRow, 'id' | 'workspaceId' | 'projectId'>, options: { delaySeconds?: number; priority?: number; createdBy?: string | null } = {}): Promise<string> =>
  deps.db.transaction((tx) => enqueueAdvanceInTx(tx, run, options));

export interface StartWorkflowInput {
  workspaceId: string;
  projectId: string | null;
  type: string;
  version: number;
  subjectRef: string;
  input: Record<string, unknown>;
  /** 同一工作区 + 类型 + 幂等键 → 返回已有运行（不重复启动） */
  idempotencyKey?: string | null;
  createdBy?: string | null;
  priority?: number;
}

/**
 * 启动运行：幂等键命中返回已有运行；否则在同一事务里建运行行并入队首个推进任务。
 * 定义（步骤实现）只在 Worker 注册；API 进程只按类型/版本启动，未知定义在推进时显式失败。
 */
export async function startWorkflow(deps: DomainDeps, input: StartWorkflowInput): Promise<WorkflowRun> {
  if (!Number.isInteger(input.version) || input.version < 1) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'workflow version must be a positive integer', 422);
  const id = `wfr_${randomUUID()}`;
  const created = await deps.db.transaction(async (tx) => {
    const now = new Date();
    const inserted = await tx.insert(workflowRuns).values({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      type: input.type,
      version: input.version,
      subjectRef: input.subjectRef,
      status: 'RUNNING',
      input: input.input,
      context: {},
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoNothing().returning();
    const row = inserted[0];
    if (row === undefined) return null;
    await enqueueAdvanceInTx(tx, row, { priority: input.priority, createdBy: input.createdBy ?? null });
    return row;
  });
  if (created === null) {
    // 幂等命中：同一工作区 + 类型 + 键已有运行
    const existing = await deps.db.select().from(workflowRuns).where(and(
      eq(workflowRuns.workspaceId, input.workspaceId),
      eq(workflowRuns.type, input.type),
      eq(workflowRuns.idempotencyKey, input.idempotencyKey ?? ''),
    )).limit(1);
    const found = existing[0];
    if (found === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'workflow run insert conflicted without an existing run', 500);
    return toWorkflowRun(found, await loadSteps(deps, found.id));
  }
  return getWorkflowRun(deps, { workspaceId: input.workspaceId, runId: id });
}

type NextAction =
  | { kind: 'COMPLETE' }
  | { kind: 'WAIT' }
  | { kind: 'RUN'; step: WorkflowStepDefinition; attempt: number }
  | { kind: 'FAIL'; step: WorkflowStepDefinition; error: Record<string, unknown> };

function nextAction(definition: WorkflowDefinition, steps: readonly StepRow[]): NextAction {
  for (const step of definition.steps) {
    const attempts = steps.filter((row) => row.stepKey === step.key).sort((left, right) => left.attempt - right.attempt);
    const last = attempts.at(-1);
    if (last === undefined) return { kind: 'RUN', step, attempt: 1 };
    if (last.status === 'SUCCEEDED') continue;
    if (last.status === 'WAITING_HUMAN') return { kind: 'WAIT' };
    // RUNNING 只可能是丢租约的遗留（本推进者独占运行）；调用方会先把它记为 LEASE_LOST
    const retryable = last.errorClass === 'RETRYABLE' || last.errorClass === 'LEASE_LOST';
    const humanApprovedRetry = (last.result as { humanApprovedRetry?: unknown } | null)?.humanApprovedRetry === true;
    // 人工批准的重试（NEEDS_HUMAN 处理完毕）不受错误分类与尝试上限约束，但只放行这一次
    if (last.status === 'FAILED' && ((retryable && last.attempt < step.maxAttempts) || humanApprovedRetry)) return { kind: 'RUN', step, attempt: last.attempt + 1 };
    return { kind: 'FAIL', step, error: (last.error as Record<string, unknown> | null) ?? { errorClass: last.errorClass } };
  }
  return { kind: 'COMPLETE' };
}

const runContextOf = (row: RunRow) => ({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  type: row.type,
  input: row.input as Record<string, unknown>,
  outputs: (row.context as Record<string, unknown>) ?? {},
});

/** 逆序补偿已成功的步骤；补偿失败只记录，不中断其他补偿。 */
async function compensateAndFinish(deps: DomainDeps, definition: WorkflowDefinition, run: RunRow, finalStatus: Extract<WorkflowRunStatus, 'FAILED' | 'CANCELLED'>, error: Record<string, unknown> | null, jobId: string): Promise<void> {
  const steps = await loadSteps(deps, run.id);
  for (const step of [...definition.steps].reverse()) {
    const succeeded = steps.filter((row) => row.stepKey === step.key && row.status === 'SUCCEEDED').at(-1);
    if (succeeded === undefined || step.compensate === undefined || succeeded.compensationStatus !== null) continue;
    let status: 'COMPENSATED' | 'COMPENSATION_FAILED' = 'COMPENSATED';
    try {
      await step.compensate({ deps, run: runContextOf(run), attempt: succeeded.attempt, jobId });
    } catch {
      status = 'COMPENSATION_FAILED';
    }
    await deps.db.update(workflowSteps).set({ compensationStatus: status }).where(eq(workflowSteps.id, succeeded.id));
  }
  if (definition.onTerminated !== undefined) {
    try {
      await definition.onTerminated({ deps, run: runContextOf(run), status: finalStatus, error });
    } catch {
      // 收尾钩子失败不阻断运行落定（业务记录可由运维投影发现并修复）
    }
  }
  const now = new Date();
  await deps.db.update(workflowRuns).set({ status: finalStatus, error, currentStep: null, updatedAt: now, completedAt: now }).where(eq(workflowRuns.id, run.id));
}

export interface AdvanceWorkflowResult {
  status: WorkflowRunStatus;
  executedSteps: string[];
  /** 本推进任务已被替换（另有有效推进者）——直接退出，不做任何写入 */
  superseded: boolean;
}

/**
 * 推进一次运行：从第一个未完成步骤开始顺序执行，直到完成、失败、等待人工、需要退避或被替换。
 * `heartbeat` 在步骤执行期间定时调用（长步骤保持任务租约）。
 */
export async function advanceWorkflow(
  deps: DomainDeps,
  registry: WorkflowRegistry,
  input: { workspaceId: string; runId: string; jobId: string; heartbeat?: () => Promise<void>; heartbeatIntervalMs?: number },
): Promise<AdvanceWorkflowResult> {
  const executedSteps: string[] = [];
  for (;;) {
    const run = await loadRun(deps, input);
    if (isTerminal(run.status)) return { status: run.status as WorkflowRunStatus, executedSteps, superseded: false };
    if (run.activeJobId !== input.jobId) return { status: run.status as WorkflowRunStatus, executedSteps, superseded: true };
    const definition = registry.get(run.type, run.version);
    if (run.status === 'CANCEL_REQUESTED') {
      await compensateAndFinish(deps, definition, run, 'CANCELLED', { reason: 'CANCELLED' }, input.jobId);
      return { status: 'CANCELLED', executedSteps, superseded: false };
    }
    // 丢租约的遗留尝试记为 LEASE_LOST（计入尝试次数）
    const stale = (await loadSteps(deps, run.id)).filter((row) => row.status === 'RUNNING');
    for (const row of stale) {
      await deps.db.update(workflowSteps).set({ status: 'FAILED', errorClass: 'LEASE_LOST', error: { message: 'advance job lost its lease while the step was running' }, finishedAt: new Date() }).where(eq(workflowSteps.id, row.id));
    }
    const action = nextAction(definition, await loadSteps(deps, run.id));
    if (action.kind === 'COMPLETE') {
      const now = new Date();
      await deps.db.update(workflowRuns).set({ status: 'SUCCEEDED', currentStep: null, updatedAt: now, completedAt: now }).where(eq(workflowRuns.id, run.id));
      return { status: 'SUCCEEDED', executedSteps, superseded: false };
    }
    if (action.kind === 'WAIT') {
      await deps.db.update(workflowRuns).set({ status: 'WAITING_HUMAN', updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
      return { status: 'WAITING_HUMAN', executedSteps, superseded: false };
    }
    if (action.kind === 'FAIL') {
      await compensateAndFinish(deps, definition, run, 'FAILED', { step: action.step.key, ...action.error }, input.jobId);
      return { status: 'FAILED', executedSteps, superseded: false };
    }

    const { step, attempt } = action;
    const stepRowId = `wfs_${randomUUID()}`;
    await deps.db.insert(workflowSteps).values({ id: stepRowId, runId: run.id, workspaceId: run.workspaceId, stepKey: step.key, attempt, status: 'RUNNING', jobId: input.jobId });
    await deps.db.update(workflowRuns).set({ status: 'RUNNING', currentStep: step.key, updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
    executedSteps.push(step.key);
    const timer = input.heartbeat === undefined ? null : setInterval(() => { void input.heartbeat?.().catch(() => undefined); }, input.heartbeatIntervalMs ?? 10_000);
    let outcome: WorkflowStepOutcome | null = null;
    let failure: unknown = null;
    try {
      outcome = await step.run({ deps, run: runContextOf(run), attempt, jobId: input.jobId });
    } catch (error) {
      failure = error;
    } finally {
      if (timer !== null) clearInterval(timer);
    }
    const finishedAt = new Date();
    if (outcome !== null && outcome.kind === 'DONE') {
      await deps.db.update(workflowSteps).set({ status: 'SUCCEEDED', result: outcome.output, finishedAt }).where(eq(workflowSteps.id, stepRowId));
      // 步骤输出按步骤键并入运行上下文（jsonb 合并，单推进者无并发写）
      await deps.db.update(workflowRuns).set({ context: sql`${workflowRuns.context} || ${JSON.stringify({ [step.key]: outcome.output })}::jsonb`, updatedAt: finishedAt }).where(eq(workflowRuns.id, run.id));
      continue;
    }
    if (outcome !== null && outcome.kind === 'WAIT_UNTIL') {
      await deps.db.delete(workflowSteps).where(eq(workflowSteps.id, stepRowId));
      await enqueueAdvance(deps, run, { delaySeconds: Math.min(Math.max(outcome.delaySeconds, 1), 3600) });
      return { status: 'RUNNING', executedSteps, superseded: false };
    }
    if (outcome !== null && outcome.kind === 'WAIT_HUMAN') {
      await deps.db.update(workflowSteps).set({ status: 'WAITING_HUMAN', result: { gate: outcome.gate, reason: outcome.reason } }).where(eq(workflowSteps.id, stepRowId));
      await deps.db.update(workflowRuns).set({ status: 'WAITING_HUMAN', updatedAt: finishedAt }).where(eq(workflowRuns.id, run.id));
      return { status: 'WAITING_HUMAN', executedSteps, superseded: false };
    }
    const errorClass = (step.classify ?? defaultWorkflowErrorClass)(failure);
    if (errorClass === 'NEEDS_HUMAN') {
      // 需要人工处理：尝试停在 WAITING_HUMAN，人工批准 = 处理后再试一次，拒绝 = 失败并补偿
      await deps.db.update(workflowSteps).set({ status: 'WAITING_HUMAN', errorClass, error: errorSummary(failure), finishedAt }).where(eq(workflowSteps.id, stepRowId));
      await deps.db.update(workflowRuns).set({ status: 'WAITING_HUMAN', updatedAt: finishedAt }).where(eq(workflowRuns.id, run.id));
      return { status: 'WAITING_HUMAN', executedSteps, superseded: false };
    }
    await deps.db.update(workflowSteps).set({ status: 'FAILED', errorClass, error: errorSummary(failure), finishedAt }).where(eq(workflowSteps.id, stepRowId));
    if (errorClass === 'RETRYABLE' && attempt < step.maxAttempts) {
      // 退避后由新的推进任务重试（不占用本任务的尝试次数；付费步骤自行决定 maxAttempts，引擎不无限重试）
      await enqueueAdvance(deps, run, { delaySeconds: computeBackoffSeconds(attempt) });
      return { status: 'RUNNING', executedSteps, superseded: false };
    }
    // 不可重试或已达上限：下一轮循环进入 FAIL 分支（补偿 + 运行失败）
  }
}

/** 人工门：只在该步骤等待人工时可决；批准 → 步骤成功，拒绝 → 不可重试失败（随后补偿）。 */
export async function resolveWorkflowGate(
  deps: DomainDeps,
  input: { workspaceId: string; runId: string; stepKey: string; decision: 'APPROVE' | 'REJECT'; actorId: string | null; note?: string },
): Promise<WorkflowRun> {
  const run = await loadRun(deps, input);
  const waiting = (await loadSteps(deps, run.id)).filter((row) => row.stepKey === input.stepKey).at(-1);
  if (run.status !== 'WAITING_HUMAN' || waiting === undefined || waiting.status !== 'WAITING_HUMAN') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'workflow step is not waiting for a human decision', 409, { reason: WORKFLOW_ERROR_REASONS.GATE_NOT_WAITING });
  }
  const decided = { decision: input.decision, actorId: input.actorId, note: input.note ?? null };
  const finishedAt = new Date();
  if (input.decision === 'REJECT') {
    await deps.db.update(workflowSteps).set({ status: 'FAILED', errorClass: 'NON_RETRYABLE', error: { reason: 'REJECTED_BY_HUMAN', ...decided, previous: waiting.error }, finishedAt }).where(eq(workflowSteps.id, waiting.id));
  } else if (waiting.errorClass === 'NEEDS_HUMAN') {
    // 失败需人工：批准 = 原因已处理，再试一次（即使已达尝试上限）
    await deps.db.update(workflowSteps).set({ status: 'FAILED', result: { humanApprovedRetry: true, ...decided }, finishedAt }).where(eq(workflowSteps.id, waiting.id));
  } else {
    // 人工门：批准 = 该步骤完成，决定并入运行上下文
    await deps.db.update(workflowSteps).set({ status: 'SUCCEEDED', result: { ...(waiting.result as Record<string, unknown> | null), ...decided }, finishedAt }).where(eq(workflowSteps.id, waiting.id));
    await deps.db.update(workflowRuns).set({ context: sql`${workflowRuns.context} || ${JSON.stringify({ [input.stepKey]: decided })}::jsonb` }).where(eq(workflowRuns.id, run.id));
  }
  await deps.db.update(workflowRuns).set({ status: 'RUNNING', updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
  await enqueueAdvance(deps, run);
  return getWorkflowRun(deps, input);
}

/**
 * 取消（协作式，步骤边界生效）：标记 CANCEL_REQUESTED；当前推进任务若未在执行，入队新的推进任务处理补偿。
 * 正在执行的步骤不中断（与渲染执行器"不支持中途中断"的既有纪律一致），完成后由同一推进者在边界处补偿。
 */
export async function cancelWorkflow(deps: DomainDeps, input: { workspaceId: string; runId: string }): Promise<WorkflowRun> {
  const run = await loadRun(deps, input);
  if (isTerminal(run.status)) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'workflow run already finished', 409, { reason: WORKFLOW_ERROR_REASONS.NOT_CANCELLABLE, status: run.status });
  }
  await deps.db.update(workflowRuns).set({ status: 'CANCEL_REQUESTED', updatedAt: new Date() }).where(eq(workflowRuns.id, run.id));
  const executing = (await loadSteps(deps, run.id)).some((row) => row.status === 'RUNNING');
  if (!executing) await enqueueAdvance(deps, run);
  return getWorkflowRun(deps, input);
}
