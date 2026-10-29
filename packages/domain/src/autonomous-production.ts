import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AUTONOMOUS_CHAPTER_WORKFLOW,
  AUTONOMOUS_CHAPTER_WORKFLOW_VERSION,
  AUTONOMOUS_PRODUCTION_WORKFLOW,
  AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION,
  AUTONOMOUS_RUN_ACTIVE_STATUSES,
  AUTONOMOUS_RUN_ERROR_REASONS,
  AUTONOMY_ERROR_REASONS,
  AgentModelFailure,
  ApiFailure,
  ERROR_CODES,
  autonomousChapterSchema,
  autonomousReportSchema,
  autonomousRunModeSchema,
  autonomousRunSchema,
  editOperationSchema,
  frameRateSchema,
  mediaTimeSchema,
  mediaTimeToDisplaySecondsText,
  productionPolicySchema,
  startAutonomousRunRequestSchema,
  type AgentTurn,
  type AutonomousReport,
  type AutonomousRun,
  type AutonomousRunStatus,
  type CreateTrackRequest,
  type EditOperation,
  type MediaTime,
  type SceneContract,
  type StartAutonomousRunRequest,
  type WorkflowErrorClass,
} from '@ancs/contracts';
import { agentTurns, assets, assetVersions, autonomousChapters, autonomousRuns, projects, projectSequences, workflowRuns } from '@ancs/db';
import { assembleChapters } from '@ancs/kernel';
import type { DomainDeps } from './deps.js';
import { assertAiSpendAvailable } from './ai-spend.js';
import { createAgentSession, createAutonomousTurn, getAgentTurn, runAgentTurnLoop, type AgentTurnPorts } from './agent-runtime.js';
import { agentTimelineViewOf, defaultAgentToolCatalog, simulateAgentDraft, type AgentToolContext } from './agent-tools.js';
import { draftPace } from './agent-edit-points.js';
import { autonomyMayAdopt, autonomySpendDecision } from './autonomy.js';
import { getLatestProductionPlan } from './production-plan.js';
import { adoptProposal, loadProposalForRead } from './proposals.js';
import { getStrategyPack, resolveStrategyKnobs } from './strategies.js';
import { getStudioState } from './studio.js';
import { createSequence, createTrack } from './composition.js';
import { readTimelineSnapshot } from './edit-trial.js';
import { cancelWorkflow, defaultWorkflowErrorClass, startWorkflow, type WorkflowDefinition, type WorkflowStepDefinition, type WorkflowStepOutcome } from './workflow.js';

/**
 * 自主制作（裁决 0020，Proposal 0.1 §2.1 A / AP-05）：用户一次交代需求并签好授权，AI 自己做完——
 *
 *   等素材（上传、探测、理解都结束）→ 导演（计划 + 粗剪 + 原声字幕 + 自检修复，模型花费不超过授权剩余）
 *   → 交付（自检门禁 + 授权核对 → 按审批档位由系统采用或留作试改）→ 交付报告。
 *
 * - 经工作流 AUTONOMOUS_PRODUCTION 执行；同一工程同一时刻只有一个进行中的运行（部分唯一索引）；
 * - 总预算是硬上限：开始前用门禁核对，导演的模型花费上限 = 授权剩余 − 一次调用的余量（单次调用的实际费用要返回后才知道）；
 * - 不调用付费生成（报价需要用户确认，而用户不在场）；
 * - 采用前再核对一次授权：运行期间授权被改动或撤回 → 不采用，留作试改；采用如实记为 AI 在用户授权下的改动，可整体撤销；
 * - 导演与调度代码不按视频类型或策略分支（裁决 0018）：自主制作只是同一个通用导演多了一段交代。
 */

export interface AutonomousProductionPorts extends AgentTurnPorts {
  /** 等素材：最长等待（默认 2 小时）、一直没有素材时的等待（默认 30 分钟）、轮询间隔（默认 15 秒） */
  footageWait?: { maxSeconds?: number; noFootageSeconds?: number; pollSeconds?: number };
  /** 导演最多走多少步（默认 60） */
  maxIterations?: number;
  /** 会话里正有一轮进行中时最多等多久（默认 30 分钟） */
  sessionBusySeconds?: number;
  /**
   * V6-10 分章：可用素材总时长达到多少秒才分章（缺省 8 分钟）、同时剪几章（资源池，缺省 3）、一章失败后再试几次（缺省 1）、
   * 每章与规划最多走多少步（缺省 30 / 16）、父运行轮询间隔与各章总时限（缺省 5 秒 / 3 小时）。
   */
  chapters?: { minFootageSeconds?: number; concurrency?: number; retries?: number; iterations?: number; planIterations?: number; pollSeconds?: number; maxSeconds?: number };
}

/** 开始一次运行至少要剩下的预算（0.2 美元：不够一次像样的导演调用就不开始） */
export const MIN_AUTONOMOUS_RUN_MICROS = 200_000;
/** 给"一次调用的实际费用只有返回后才知道"留的余量：剩余预算的 10%，最多 0.6 美元 */
const callReserveMicros = (remaining: number): number => Math.min(Math.round(remaining * 0.1), 600_000);

type Row = typeof autonomousRuns.$inferSelect;

const ACTIVE = new Set<string>(AUTONOMOUS_RUN_ACTIVE_STATUSES);

async function progressOf(deps: DomainDeps, turnId: string | null): Promise<AutonomousRun['progress']> {
  if (turnId === null) return { steps: 0, lastStep: null, lastTool: null };
  const rows = await deps.db.select({ toolCalls: agentTurns.toolCalls }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
  const calls = (rows[0]?.toolCalls ?? []) as { name: string; summary: string }[];
  const last = calls.at(-1);
  return { steps: calls.length, lastStep: last?.summary.slice(0, 500) ?? null, lastTool: last?.name.slice(0, 80) ?? null };
}

/** V6-10：分章模式的各章（按成片顺序），进行中的章带上步骤进度 */
async function chaptersOf(deps: DomainDeps, runId: string): Promise<AutonomousRun['chapters']> {
  const rows = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, runId)).orderBy(asc(autonomousChapters.index));
  return Promise.all(rows.map(async (chapter) => {
    const progress = await progressOf(deps, chapter.turnId);
    const error = chapter.error as { reason?: unknown; message?: unknown } | null;
    return autonomousChapterSchema.parse({
      id: chapter.id, index: chapter.index, sceneId: chapter.sceneId, title: chapter.title, status: chapter.status, attempts: chapter.attempts,
      budgetMicros: chapter.budgetMicros, costMicros: chapter.costMicros,
      progress: { steps: progress.steps, lastStep: progress.lastStep },
      error: error === null ? null : { reason: String(error.reason ?? 'FAILED').slice(0, 80), message: String(error.message ?? '').slice(0, 300) },
      startedAt: chapter.startedAt?.toISOString() ?? null,
      completedAt: chapter.completedAt?.toISOString() ?? null,
    });
  }));
}

async function toRun(deps: DomainDeps, row: Row): Promise<AutonomousRun> {
  return autonomousRunSchema.parse({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
    mode: autonomousRunModeSchema.parse(row.mode),
    chapters: row.mode === 'CHAPTERS' ? await chaptersOf(deps, row.id) : [],
    goal: row.goal,
    targetDurationSeconds: row.targetDurationSeconds,
    strategyPackId: row.strategyPackId,
    approval: row.approval,
    policyVersion: row.policyVersion,
    budgetMicros: row.budgetMicros,
    modelCapMicros: row.modelCapMicros,
    locale: row.locale === 'en' ? 'en' : 'zh-CN',
    turnId: row.turnId,
    workflowRunId: row.workflowRunId,
    proposalId: row.proposalId,
    adoptedRevision: row.adoptedRevision,
    progress: await progressOf(deps, row.turnId),
    report: row.report === null ? null : autonomousReportSchema.parse(row.report),
    error: (row.error as Record<string, unknown> | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

/** 轮次 id 由运行（与章节、尝试次数）决定：步骤重试时找回同一轮，不重复付费；花费也能逐轮汇总 */
const turnIdOf = (...parts: string[]): string => `agt_${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32)}`;
const autonomousTurnId = (runId: string): string => turnIdOf('autonomous', runId);
/** V6-10：分章前的规划那一轮；一章的第 attempt 次尝试 */
const planTurnId = (runId: string): string => turnIdOf('autonomous-plan', runId);
const chapterTurnId = (runId: string, index: number, attempt: number): string => turnIdOf('autonomous-chapter', runId, String(index), String(attempt));

/** 一次运行的全部轮次：自主制作那一轮（含分章的通看收尾）、V6-10 的规划，以及各章的每一次尝试 */
async function runTurnIds(deps: DomainDeps, runs: readonly { id: string; turnId: string | null }[]): Promise<string[]> {
  const ids = runs.flatMap((run) => [...(run.turnId === null ? [] : [run.turnId]), planTurnId(run.id)]);
  if (runs.length === 0) return ids;
  const chapters = await deps.db.select({ runId: autonomousChapters.runId, index: autonomousChapters.index, attempts: autonomousChapters.attempts }).from(autonomousChapters)
    .where(inArray(autonomousChapters.runId, runs.map((run) => run.id)));
  for (const chapter of chapters) {
    for (let attempt = 1; attempt <= chapter.attempts; attempt += 1) ids.push(chapterTurnId(chapter.runId, chapter.index, attempt));
  }
  return ids;
}

async function turnsCost(deps: DomainDeps, ids: readonly string[]): Promise<{ spentMicros: number; unpricedCalls: number }> {
  if (ids.length === 0) return { spentMicros: 0, unpricedCalls: 0 };
  const rows = await deps.db.select({
    spent: sql<number>`coalesce(sum(${agentTurns.costMicros}), 0)::bigint`,
    unpriced: sql<number>`coalesce(sum(${agentTurns.unpricedCalls}), 0)::bigint`,
  }).from(agentTurns).where(inArray(agentTurns.id, [...ids]));
  return { spentMicros: Number(rows[0]?.spent ?? 0), unpricedCalls: Number(rows[0]?.unpriced ?? 0) };
}

/** 本次签署的授权下，这条视频的自主制作已经花掉的模型费用（美元微单位；未定价的调用不计入，另行标注）。分章时含规划与各章各次尝试。 */
export async function autonomousSpentMicros(deps: DomainDeps, input: { projectId: string; policyVersion: number; excludeRunId?: string }): Promise<number> {
  const runs = await deps.db.select({ id: autonomousRuns.id, turnId: autonomousRuns.turnId }).from(autonomousRuns)
    .where(and(
      eq(autonomousRuns.projectId, input.projectId),
      eq(autonomousRuns.policyVersion, input.policyVersion),
      ...(input.excludeRunId === undefined ? [] : [sql`${autonomousRuns.id} <> ${input.excludeRunId}`]),
    ));
  return (await turnsCost(deps, await runTurnIds(deps, runs))).spentMicros;
}

async function loadPolicy(deps: DomainDeps, input: { workspaceId: string; projectId: string }) {
  const rows = await deps.db.select({ productionPolicy: projects.productionPolicy }).from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return productionPolicySchema.parse(row.productionPolicy).autonomy;
}

const isUniqueViolation = (error: unknown, constraint: string): boolean => {
  const cause = (error as { cause?: unknown } | null)?.cause ?? error;
  return (cause as { code?: unknown } | null)?.code === '23505' && String((cause as { constraint?: unknown }).constraint ?? '') === constraint;
};

/**
 * 开始一次自主制作：必须已签署授权、剩余预算够开始；同一工程同一时刻只有一个进行中的运行（409）；
 * 幂等键 → 同一运行。运行先进入"等素材"，素材都准备好后自动开始导演。
 */
export async function startAutonomousRun(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  request: StartAutonomousRunRequest;
  createdBy: string | null;
  idempotencyKey?: string | null;
}): Promise<AutonomousRun> {
  const request = startAutonomousRunRequestSchema.parse(input.request);
  if (input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
    const existing = await deps.db.select().from(autonomousRuns)
      .where(and(eq(autonomousRuns.projectId, input.projectId), eq(autonomousRuns.workspaceId, input.workspaceId), eq(autonomousRuns.idempotencyKey, input.idempotencyKey))).limit(1);
    if (existing[0] !== undefined) return toRun(deps, existing[0]);
  }
  const policy = await loadPolicy(deps, input);
  if (policy.signature === null || policy.budgetMicros === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'sign the autonomous production authorization first', 409, { reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED });
  }
  // 工作区本月 AI 费用已达上限：不开始（用户在场，当场说明；进行中的一轮由导演循环在模型调用前停下）
  await assertAiSpendAvailable(deps, { workspaceId: input.workspaceId });
  const spent = await autonomousSpentMicros(deps, { projectId: input.projectId, policyVersion: policy.signature.version });
  const decision = autonomySpendDecision(policy, { kind: 'MODEL', estimateMicros: MIN_AUTONOMOUS_RUN_MICROS, spentMicros: spent });
  if (!decision.allowed) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'not enough authorized budget left to start', 409, { reason: decision.reason, spentMicros: spent, budgetMicros: policy.budgetMicros });
  }
  const strategyKnobs = request.strategyPackId === null ? {}
    : resolveStrategyKnobs(await getStrategyPack(deps, { workspaceId: input.workspaceId, packId: request.strategyPackId }), request.strategyKnobs);
  const id = `aut_${randomUUID()}`;
  let row: Row | undefined;
  try {
    [row] = await deps.db.insert(autonomousRuns).values({
      id,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      status: 'WAITING_FOR_FOOTAGE',
      goal: request.goal,
      targetDurationSeconds: request.targetDurationSeconds,
      strategyPackId: request.strategyPackId,
      strategyKnobs,
      approval: policy.approval,
      policyVersion: policy.signature.version,
      budgetMicros: policy.budgetMicros,
      locale: request.locale,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.createdBy,
    }).returning();
  } catch (error) {
    if (isUniqueViolation(error, 'autonomous_runs_active_uq')) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'an autonomous run is already in progress for this video', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.RUN_IN_PROGRESS });
    }
    if (isUniqueViolation(error, 'autonomous_runs_idempotency_uq') && input.idempotencyKey !== undefined && input.idempotencyKey !== null) {
      const existing = await deps.db.select().from(autonomousRuns).where(and(eq(autonomousRuns.projectId, input.projectId), eq(autonomousRuns.idempotencyKey, input.idempotencyKey))).limit(1);
      if (existing[0] !== undefined) return toRun(deps, existing[0]);
    }
    throw error;
  }
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'autonomous run insert failed', 500);
  try {
    const run = await startWorkflow(deps, {
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      type: AUTONOMOUS_PRODUCTION_WORKFLOW,
      version: AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION,
      subjectRef: `autonomous-run:${id}`,
      input: { runId: id },
      idempotencyKey: `autonomous-run:${id}`,
      createdBy: input.createdBy,
    });
    const [updated] = await deps.db.update(autonomousRuns).set({ workflowRunId: run.id, updatedAt: new Date() }).where(eq(autonomousRuns.id, id)).returning();
    return toRun(deps, updated ?? row);
  } catch (error) {
    await deps.db.update(autonomousRuns).set({ status: 'FAILED', error: { reason: 'WORKFLOW_START_FAILED' }, updatedAt: new Date(), completedAt: new Date() }).where(eq(autonomousRuns.id, id));
    throw error;
  }
}

async function loadRow(deps: DomainDeps, input: { workspaceId: string; projectId?: string; runId: string }): Promise<Row> {
  const rows = await deps.db.select().from(autonomousRuns).where(and(
    eq(autonomousRuns.id, input.runId),
    eq(autonomousRuns.workspaceId, input.workspaceId),
    ...(input.projectId === undefined ? [] : [eq(autonomousRuns.projectId, input.projectId)]),
  )).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'autonomous run not found', 404, { reason: AUTONOMOUS_RUN_ERROR_REASONS.RUN_NOT_FOUND });
  return row;
}

export async function getAutonomousRun(deps: DomainDeps, input: { workspaceId: string; projectId: string; runId: string }): Promise<AutonomousRun> {
  return toRun(deps, await loadRow(deps, input));
}

export async function listAutonomousRuns(deps: DomainDeps, input: { workspaceId: string; projectId: string; limit?: number }): Promise<AutonomousRun[]> {
  const rows = await deps.db.select().from(autonomousRuns)
    .where(and(eq(autonomousRuns.workspaceId, input.workspaceId), eq(autonomousRuns.projectId, input.projectId)))
    .orderBy(desc(autonomousRuns.createdAt)).limit(Math.min(Math.max(input.limit ?? 10, 1), 50));
  const out: AutonomousRun[] = [];
  for (const row of rows) out.push(await toRun(deps, row));
  return out;
}

/** 停止：协作式（在步骤边界生效；导演正在走的那一步做完后停下）。已结束的运行不能停止（409）。 */
export async function cancelAutonomousRun(deps: DomainDeps, input: { workspaceId: string; projectId: string; runId: string }): Promise<AutonomousRun> {
  const row = await loadRow(deps, input);
  if (!ACTIVE.has(row.status) || row.workflowRunId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'autonomous run already finished', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.NOT_CANCELLABLE, status: row.status });
  }
  await cancelWorkflow(deps, { workspaceId: input.workspaceId, runId: row.workflowRunId });
  return toRun(deps, await loadRow(deps, input));
}

// ---------------------------------------------------------------------------
// 工作流
// ---------------------------------------------------------------------------

const setStatus = (deps: DomainDeps, id: string, status: AutonomousRunStatus, extra: Partial<typeof autonomousRuns.$inferInsert> = {}) =>
  deps.db.update(autonomousRuns).set({ status, updatedAt: new Date(), ...extra }).where(eq(autonomousRuns.id, id));

const elapsedSeconds = (row: Row): number => (Date.now() - row.createdAt.getTime()) / 1000;

/** 交给导演的那句话：需求 + 目标时长（用户的语言）。 */
function briefMessage(row: Row): string {
  const target = row.targetDurationSeconds;
  if (row.locale === 'en') {
    return [row.goal, target === null ? 'Choose the length from the footage.' : `Target length: about ${String(target)} seconds.`].join('\n');
  }
  return [row.goal, target === null ? '成片时长由你按素材决定。' : `目标时长：约 ${String(target)} 秒。`].join('\n');
}


type ChapterRow = typeof autonomousChapters.$inferSelect;

/** V6-10：可用素材总时长达到这个秒数才分章（只看时长，不看视频类型）；最多分几章 */
export const CHAPTER_MODE_MIN_SECONDS = 8 * 60;
const MAX_CHAPTERS = 12;
/** 分章时的预算分配：计划最多拿剩余的 15%，各章合计 60%（按场景时长分），收尾拿剩下的全部 */
const PLAN_SHARE = 0.15;
const CHAPTERS_SHARE = 0.6;

const chapterSettings = (ports: AutonomousProductionPorts) => ({
  minFootageSeconds: CHAPTER_MODE_MIN_SECONDS, concurrency: 3, retries: 1, iterations: 30, planIterations: 16, pollSeconds: 5, maxSeconds: 3 * 3600,
  ...ports.chapters,
});

const directClassify = (error: unknown): WorkflowErrorClass => {
  if (error instanceof AgentModelFailure) return error.retryable ? 'RETRYABLE' : 'NON_RETRYABLE';
  return defaultWorkflowErrorClass(error);
};

/** 共看片室的主会话（没有就建一个）与主序列 */
async function mainSession(deps: DomainDeps, row: Row): Promise<{ sessionId: string; sequenceId: string }> {
  const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  const session = state.session ?? await createAgentSession(deps, { workspaceId: row.workspaceId, projectId: row.projectId, request: { sequenceId: state.sequenceId, locale: row.locale === 'en' ? 'en' : 'zh-CN' }, createdBy: row.createdBy });
  return { sessionId: session.id, sequenceId: state.sequenceId };
}

/** 授权在运行期间被撤回或改过 → 不再花钱 */
async function assertStillSigned(deps: DomainDeps, row: Row, phase: string): Promise<void> {
  const policy = await loadPolicy(deps, row);
  if (policy.signature?.version !== row.policyVersion) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `the authorization changed before ${phase}`, 409, { reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED });
  }
}

/** 本次授权下还剩多少预算（含这次运行已经花掉的） */
async function remainingMicros(deps: DomainDeps, row: Row): Promise<number> {
  return Math.max(0, row.budgetMicros - await autonomousSpentMicros(deps, { projectId: row.projectId, policyVersion: row.policyVersion }));
}

/** 用户正在和 AI 说话时建不了新的一轮：等它结束（有上限） */
async function createTurnOrWait(row: Row, ports: AutonomousProductionPorts, wait: { maxSeconds: number }, create: () => Promise<unknown>): Promise<WorkflowStepOutcome | null> {
  try {
    await create();
    return null;
  } catch (error) {
    if (error instanceof ApiFailure && error.details['reason'] === AGENT_ERROR_REASONS.TURN_IN_PROGRESS) {
      if (elapsedSeconds(row) > (ports.sessionBusySeconds ?? 30 * 60) + wait.maxSeconds) {
        throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the session stayed busy', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.SESSION_BUSY });
      }
      return { kind: 'WAIT_UNTIL', delaySeconds: 10, reason: 'another turn is running in this session' };
    }
    throw error;
  }
}

function autonomousSteps(ports: AutonomousProductionPorts) {
  const wait = { maxSeconds: 2 * 3600, noFootageSeconds: 30 * 60, pollSeconds: 15, ...ports.footageWait };
  const waitFootage: WorkflowStepDefinition = {
    key: 'wait_footage',
    maxAttempts: 3,
    run: async ({ deps, run }) => {
      const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (row.status !== 'WAITING_FOR_FOOTAGE') return { kind: 'DONE', output: { skipped: true } };
      const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
      const ready = state.footage.filter((item) => item.status === 'READY');
      const busy = state.footage.some((item) => item.status === 'UPLOADING' || item.status === 'PROCESSING'
        || (item.status === 'READY' && Object.values(item.understanding).some((value) => value === 'WORKING')));
      if (busy) {
        if (elapsedSeconds(row) > wait.maxSeconds) {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'footage was not ready in time', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.FOOTAGE_TIMEOUT });
        }
        return { kind: 'WAIT_UNTIL', delaySeconds: wait.pollSeconds, reason: 'footage is still processing' };
      }
      if (ready.length === 0 && state.project.article === null) {
        if (elapsedSeconds(row) > wait.noFootageSeconds) {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'no footage was added', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.NO_FOOTAGE });
        }
        return { kind: 'WAIT_UNTIL', delaySeconds: wait.pollSeconds, reason: 'waiting for footage' };
      }
      await setStatus(deps, row.id, 'DIRECTING');
      return { kind: 'DONE', output: { footage: ready.length } };
    },
  };
  const direct: WorkflowStepDefinition = {
    key: 'direct',
    maxAttempts: 2,
    run: async ({ deps, run }) => {
      const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (!ACTIVE.has(row.status)) return { kind: 'DONE', output: { skipped: true } };
      const turnId = row.turnId ?? autonomousTurnId(row.id);
      const existing = await deps.db.select({ status: agentTurns.status }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
      if (existing[0] === undefined) {
        await assertStillSigned(deps, row, 'directing started');
        const remaining = await remainingMicros(deps, row);
        const cap = remaining - callReserveMicros(remaining);
        if (cap < MIN_AUTONOMOUS_RUN_MICROS / 2) {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'not enough authorized budget left', 409, { reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, spentMicros: row.budgetMicros - remaining, budgetMicros: row.budgetMicros });
        }
        const main = await mainSession(deps, row);
        const waiting = await createTurnOrWait(row, ports, wait, () => createAutonomousTurn(deps, {
          workspaceId: row.workspaceId, sessionId: main.sessionId, turnId, message: briefMessage(row), workflowRunId: run.id,
          strategyPackId: row.strategyPackId, strategyKnobs: row.strategyKnobs as Record<string, string>, createdBy: row.createdBy,
        }));
        if (waiting !== null) return waiting;
        await deps.db.update(autonomousRuns).set({ turnId, sessionId: main.sessionId, modelCapMicros: cap, updatedAt: new Date() }).where(eq(autonomousRuns.id, row.id));
      }
      const capRow = await loadRow(deps, { workspaceId: run.workspaceId, runId: row.id });
      const result = await runAgentTurnLoop(deps, ports, {
        turnId,
        workflowRunId: run.id,
        limits: { maxIterations: ports.maxIterations ?? 60, maxCostMicros: capRow.modelCapMicros ?? MIN_AUTONOMOUS_RUN_MICROS },
      });
      await setStatus(deps, row.id, 'CHECKING');
      return { kind: 'DONE', output: { turnId, proposalId: typeof result['proposalId'] === 'string' ? result['proposalId'] : null } };
    },
    classify: directClassify,
  };
  const deliver: WorkflowStepDefinition = {
    key: 'deliver',
    maxAttempts: 3,
    run: async ({ deps, run }) => {
      const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (!ACTIVE.has(row.status)) return { kind: 'DONE', output: { skipped: true } };
      const delivered = await deliverAutonomousRun(deps, row, placementsOf(run.outputs));
      return { kind: 'DONE', output: { status: delivered.status, outcome: delivered.report.outcome } };
    },
  };
  // 运行以失败或取消结束：收尾运行记录、仍在进行中的轮次与各章（取消还在剪的章），并写一份如实的报告（不留悬挂的进行中状态）
  const onTerminated: NonNullable<WorkflowDefinition['onTerminated']> = async ({ deps, run, status, error }) => {
    const runId = String(run.input['runId']);
    const rows = await deps.db.select().from(autonomousRuns).where(eq(autonomousRuns.id, runId)).limit(1);
    const row = rows[0];
    if (row === undefined) return;
    const turnError = status === 'CANCELLED' ? { reason: 'CANCELLED' } : error ?? { reason: 'AUTONOMOUS_RUN_FAILED' };
    const openTurns = [...(row.turnId === null ? [] : [row.turnId]), planTurnId(row.id)];
    await deps.db.update(agentTurns).set({ status, error: turnError, completedAt: new Date() })
      .where(and(inArray(agentTurns.id, openTurns), eq(agentTurns.status, 'RUNNING')));
    const chapters = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id));
    for (const chapter of chapters.filter((item) => item.status === 'PENDING' || item.status === 'RUNNING')) {
      if (chapter.status === 'RUNNING' && chapter.workflowRunId !== null) await cancelWorkflow(deps, { workspaceId: row.workspaceId, runId: chapter.workflowRunId }).catch(() => undefined);
      await deps.db.update(autonomousChapters).set({ status: 'CANCELLED', updatedAt: new Date(), completedAt: new Date() }).where(eq(autonomousChapters.id, chapter.id));
    }
    if (!ACTIVE.has(row.status)) return;
    const now = new Date();
    const report = row.turnId === null && chapters.length === 0 ? null : await buildReport(deps, row, { outcome: 'FAILED', notAdoptedReason: 'TURN_FAILED', adopted: false, placements: placementsOf(run.outputs) }).catch(() => null);
    await deps.db.update(autonomousRuns).set({ status, error: status === 'CANCELLED' ? { reason: 'CANCELLED' } : error, ...(report === null ? {} : { report }), updatedAt: now, completedAt: now })
      .where(eq(autonomousRuns.id, row.id));
  };
  return { wait, waitFootage, direct, deliver, onTerminated };
}

/** V6-9 的定义（v1）：等素材 → 一轮导演 → 交付。升级前开始的运行按它走完。 */
export function autonomousProductionWorkflowV1(ports: AutonomousProductionPorts): WorkflowDefinition {
  const steps = autonomousSteps(ports);
  return { type: AUTONOMOUS_PRODUCTION_WORKFLOW, version: 1, steps: [steps.waitFootage, steps.direct, steps.deliver], onTerminated: steps.onTerminated };
}

/**
 * V6-10（v2）：等素材 → 定计划（素材够长才分章）→ 分章并行 → 拼装 → 通看收尾（同一个 direct 步骤）→ 交付。
 * 素材短时计划、分章、拼装都跳过，行为与 v1 相同。
 */
export function autonomousProductionWorkflow(ports: AutonomousProductionPorts): WorkflowDefinition {
  const steps = autonomousSteps(ports);
  const settings = chapterSettings(ports);

  const plan: WorkflowStepDefinition = {
    key: 'plan',
    maxAttempts: 2,
    run: async ({ deps, run }) => {
      let row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (row.status === 'DIRECTING' && row.mode === 'SINGLE' && row.turnId === null) {
        const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
        const footageSeconds = state.footage.filter((item) => item.status === 'READY' && (item.kind === 'video' || item.kind === 'audio'))
          .reduce((total, item) => total + (item.duration === null ? 0 : Number(item.duration)), 0);
        if (footageSeconds < settings.minFootageSeconds) return { kind: 'DONE', output: { mode: 'SINGLE', footageSeconds } };
        await setStatus(deps, row.id, 'PLANNING', { mode: 'CHAPTERS' });
        row = await loadRow(deps, { workspaceId: run.workspaceId, runId: row.id });
      }
      if (row.status !== 'PLANNING') return { kind: 'DONE', output: { skipped: true } };
      const turnId = planTurnId(row.id);
      const existing = await deps.db.select({ status: agentTurns.status }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
      let cap = row.modelCapMicros ?? 0;
      if (existing[0] === undefined) {
        await assertStillSigned(deps, row, 'planning started');
        const remaining = await remainingMicros(deps, row);
        cap = Math.min(Math.round(remaining * PLAN_SHARE), remaining - callReserveMicros(remaining));
        if (cap < MIN_AUTONOMOUS_RUN_MICROS / 4) {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'not enough authorized budget left', 409, { reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, spentMicros: row.budgetMicros - remaining, budgetMicros: row.budgetMicros });
        }
        const main = await mainSession(deps, row);
        const waiting = await createTurnOrWait(row, ports, steps.wait, () => createAutonomousTurn(deps, {
          workspaceId: row.workspaceId, sessionId: main.sessionId, turnId, message: briefMessage(row), workflowRunId: run.id, purpose: 'AUTONOMOUS_PLAN',
          strategyPackId: row.strategyPackId, strategyKnobs: row.strategyKnobs as Record<string, string>, createdBy: row.createdBy,
        }));
        if (waiting !== null) return waiting;
        await deps.db.update(autonomousRuns).set({ sessionId: main.sessionId, modelCapMicros: cap, updatedAt: new Date() }).where(eq(autonomousRuns.id, row.id));
      }
      await runAgentTurnLoop(deps, ports, { turnId, workflowRunId: run.id, limits: { maxIterations: settings.planIterations, maxCostMicros: Math.max(1, cap) } });
      const latest = await getLatestProductionPlan(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
      const planned = latest !== null && latest.turnId === turnId ? latest : null;
      if (planned === null || planned.scenes.length < 2) {
        // 没有可分的计划：退回一轮剪完（计划若有，会作为上下文交给那一轮）
        await setStatus(deps, row.id, 'DIRECTING', { mode: 'SINGLE', modelCapMicros: null });
        return { kind: 'DONE', output: { mode: 'SINGLE', reason: planned === null ? 'NO_PLAN' : 'ONE_SCENE' } };
      }
      const remaining = await remainingMicros(deps, row);
      await createChapters(deps, row, planned.scenes.slice(0, MAX_CHAPTERS), Math.round(remaining * CHAPTERS_SHARE));
      await setStatus(deps, row.id, 'CUTTING_CHAPTERS');
      return { kind: 'DONE', output: { mode: 'CHAPTERS', chapters: Math.min(planned.scenes.length, MAX_CHAPTERS), planVersion: planned.version } };
    },
    classify: directClassify,
  };

  const chapters: WorkflowStepDefinition = {
    key: 'chapters',
    maxAttempts: 3,
    run: async ({ deps, run }) => {
      const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (row.mode !== 'CHAPTERS' || row.status !== 'CUTTING_CHAPTERS') return { kind: 'DONE', output: { skipped: true } };
      let rows = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id)).orderBy(asc(autonomousChapters.index));
      const now = new Date();
      // 1) 收回结束了的章：成功 → 完成；失败 → 还有次数就重排（下一次是新的一轮），否则记为失败
      for (const chapter of rows.filter((item) => item.status === 'RUNNING' && item.workflowRunId !== null)) {
        const child = (await deps.db.select({ status: workflowRuns.status, error: workflowRuns.error }).from(workflowRuns).where(eq(workflowRuns.id, chapter.workflowRunId!)).limit(1))[0];
        if (child === undefined || !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(child.status)) continue;
        const costMicros = await chapterCost(deps, chapter);
        if (child.status === 'SUCCEEDED') {
          await deps.db.update(autonomousChapters).set({ status: 'SUCCEEDED', costMicros, error: null, updatedAt: now, completedAt: now }).where(eq(autonomousChapters.id, chapter.id));
          continue;
        }
        const failure = chapterError(child.error, child.status === 'CANCELLED' ? 'CANCELLED' : 'CHAPTER_FAILED');
        const again = chapter.attempts < 1 + settings.retries && costMicros < chapter.budgetMicros;
        await deps.db.update(autonomousChapters).set({ status: again ? 'PENDING' : 'FAILED', costMicros, error: failure, updatedAt: now, ...(again ? {} : { completedAt: now }) }).where(eq(autonomousChapters.id, chapter.id));
      }
      rows = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id)).orderBy(asc(autonomousChapters.index));
      // 2) 超时或预算用完：不再开始新的章，还在剪的取消
      const started = rows.map((item) => item.startedAt?.getTime() ?? Number.POSITIVE_INFINITY).reduce((min, value) => Math.min(min, value), Number.POSITIVE_INFINITY);
      const timedOut = Number.isFinite(started) && (now.getTime() - started) / 1000 > settings.maxSeconds;
      const exhausted = (await remainingMicros(deps, row)) <= callReserveMicros(row.budgetMicros);
      if (timedOut || exhausted) {
        const reason = timedOut ? { reason: 'CHAPTER_TIMEOUT', message: 'the chapter did not finish in time' } : { reason: 'BUDGET_EXHAUSTED', message: 'the authorized budget ran out before this chapter' };
        for (const chapter of rows.filter((item) => item.status === 'PENDING' || item.status === 'RUNNING')) {
          if (chapter.status === 'RUNNING' && chapter.workflowRunId !== null) await cancelWorkflow(deps, { workspaceId: row.workspaceId, runId: chapter.workflowRunId }).catch(() => undefined);
          await deps.db.update(autonomousChapters).set({ status: 'FAILED', error: reason, costMicros: await chapterCost(deps, chapter), updatedAt: now, completedAt: now }).where(eq(autonomousChapters.id, chapter.id));
        }
      } else {
        // 3) 资源池：同时最多 concurrency 章在剪
        let running = rows.filter((item) => item.status === 'RUNNING').length;
        for (const chapter of rows.filter((item) => item.status === 'PENDING')) {
          if (running >= settings.concurrency) break;
          await assertStillSigned(deps, row, 'cutting a chapter');
          const attempt = chapter.attempts + 1;
          const child = await startWorkflow(deps, {
            workspaceId: row.workspaceId, projectId: row.projectId, type: AUTONOMOUS_CHAPTER_WORKFLOW, version: AUTONOMOUS_CHAPTER_WORKFLOW_VERSION,
            subjectRef: `${row.id}:${String(chapter.index)}`, input: { runId: row.id, chapterId: chapter.id, attempt },
            idempotencyKey: `autonomous-chapter:${chapter.id}:${String(attempt)}`, createdBy: row.createdBy,
          });
          await deps.db.update(autonomousChapters).set({
            status: 'RUNNING', attempts: attempt, workflowRunId: child.id, updatedAt: now, ...(chapter.startedAt === null ? { startedAt: now } : {}),
          }).where(eq(autonomousChapters.id, chapter.id));
          running += 1;
        }
      }
      rows = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id)).orderBy(asc(autonomousChapters.index));
      if (rows.every((item) => item.status === 'SUCCEEDED' || item.status === 'FAILED' || item.status === 'CANCELLED')) {
        await setStatus(deps, row.id, 'DIRECTING');
        return { kind: 'DONE', output: { succeeded: rows.filter((item) => item.status === 'SUCCEEDED').length, failed: rows.filter((item) => item.status !== 'SUCCEEDED').length } };
      }
      return { kind: 'WAIT_UNTIL', delaySeconds: settings.pollSeconds, reason: 'chapters are being cut' };
    },
  };

  const assemble: WorkflowStepDefinition = {
    key: 'assemble',
    maxAttempts: 2,
    run: async ({ deps, run }) => {
      const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
      if (row.mode !== 'CHAPTERS' || row.status !== 'DIRECTING' || row.turnId !== null) return { kind: 'DONE', output: { skipped: true } };
      const assembled = await assembleRunChapters(deps, row);
      const remaining = await remainingMicros(deps, row);
      const cap = Math.max(0, remaining - callReserveMicros(remaining));
      const main = await mainSession(deps, row);
      const turnId = autonomousTurnId(row.id);
      const waiting = await createTurnOrWait(row, ports, steps.wait, () => createAutonomousTurn(deps, {
        workspaceId: row.workspaceId, sessionId: main.sessionId, turnId, message: briefMessage(row), workflowRunId: run.id,
        strategyPackId: row.strategyPackId, strategyKnobs: row.strategyKnobs as Record<string, string>, createdBy: row.createdBy,
        draft: { baseRevision: assembled.baseRevision, operations: assembled.operations },
      }));
      if (waiting !== null) return waiting;
      await deps.db.update(autonomousRuns).set({ turnId, sessionId: main.sessionId, modelCapMicros: cap, updatedAt: new Date() }).where(eq(autonomousRuns.id, row.id));
      return { kind: 'DONE', output: { placements: assembled.placements, assembled: Object.keys(assembled.placements).length } };
    },
  };

  return {
    type: AUTONOMOUS_PRODUCTION_WORKFLOW,
    version: AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION,
    steps: [steps.waitFootage, plan, chapters, assemble, steps.direct, steps.deliver],
    onTerminated: steps.onTerminated,
  };
}

/** V6-10：一章一个子运行——同一个通用导演，在本章的子序列上剪；草稿留在轮次上交给拼装 */
export function autonomousChapterWorkflow(ports: AutonomousProductionPorts): WorkflowDefinition {
  const settings = chapterSettings(ports);
  return {
    type: AUTONOMOUS_CHAPTER_WORKFLOW,
    version: AUTONOMOUS_CHAPTER_WORKFLOW_VERSION,
    steps: [{
      key: 'cut',
      maxAttempts: 2,
      run: async ({ deps, run }) => {
        const chapter = (await deps.db.select().from(autonomousChapters).where(and(eq(autonomousChapters.id, String(run.input['chapterId'])), eq(autonomousChapters.workspaceId, run.workspaceId))).limit(1))[0];
        if (chapter === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'chapter not found', 404, { reason: AUTONOMOUS_RUN_ERROR_REASONS.RUN_NOT_FOUND });
        const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: chapter.runId });
        if (row.status !== 'CUTTING_CHAPTERS') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the run is no longer cutting chapters', 409, { reason: 'CANCELLED' });
        if (chapter.sessionId === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'chapter has no session', 409, { reason: 'CHAPTER_SESSION_MISSING' });
        const attempt = Number(run.input['attempt'] ?? chapter.attempts);
        // 被新的一次尝试取代的旧子运行不再剪
        if (attempt !== chapter.attempts) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this chapter attempt was superseded', 409, { reason: 'CHAPTER_ATTEMPT_SUPERSEDED' });
        const turnId = chapterTurnId(row.id, chapter.index, attempt);
        const existing = await deps.db.select({ status: agentTurns.status }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
        if (existing[0] === undefined) {
          const of = (await deps.db.select({ id: autonomousChapters.id }).from(autonomousChapters).where(eq(autonomousChapters.runId, row.id))).length;
          await createAutonomousTurn(deps, {
            workspaceId: row.workspaceId, sessionId: chapter.sessionId, turnId, message: chapterBrief(row, chapter, of), workflowRunId: run.id, purpose: 'AUTONOMOUS_CHAPTER',
            strategyPackId: row.strategyPackId, strategyKnobs: row.strategyKnobs as Record<string, string>, createdBy: row.createdBy,
          });
        }
        // 先记下这一章当前的轮次，再开始导演：交代（本章的场景契约）按轮次找到这一章
        await deps.db.update(autonomousChapters).set({ turnId, updatedAt: new Date() }).where(eq(autonomousChapters.id, chapter.id));
        const spentBefore = await chapterCost(deps, { ...chapter, attempts: attempt - 1 });
        await runAgentTurnLoop(deps, ports, { turnId, workflowRunId: run.id, limits: { maxIterations: settings.iterations, maxCostMicros: Math.max(1, chapter.budgetMicros - spentBefore) } });
        const turn = (await deps.db.select({ status: agentTurns.status, error: agentTurns.error, draft: agentTurns.draftOperations }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1))[0];
        if (turn === undefined || turn.status !== 'COMPLETED') {
          throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the chapter turn did not complete', 409, { reason: 'CHAPTER_TURN_NOT_COMPLETED', ...((turn?.error as Record<string, unknown> | null) ?? {}) });
        }
        return { kind: 'DONE', output: { turnId, operations: (turn.draft as unknown[]).length } };
      },
      classify: directClassify,
    }],
    onTerminated: async ({ deps, run, status, error }) => {
      const chapter = (await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.id, String(run.input['chapterId']))).limit(1))[0];
      if (chapter === undefined) return;
      const turnId = chapterTurnId(chapter.runId, chapter.index, Number(run.input['attempt'] ?? chapter.attempts));
      await deps.db.update(agentTurns).set({ status, error: status === 'CANCELLED' ? { reason: 'CANCELLED' } : error ?? { reason: 'CHAPTER_FAILED' }, completedAt: new Date() })
        .where(and(eq(agentTurns.id, turnId), eq(agentTurns.status, 'RUNNING')));
    },
  };
}

/** 一章各次尝试的实际花费 */
async function chapterCost(deps: DomainDeps, chapter: Pick<ChapterRow, 'runId' | 'index' | 'attempts'>): Promise<number> {
  const ids = Array.from({ length: chapter.attempts }, (_, offset) => chapterTurnId(chapter.runId, chapter.index, offset + 1));
  return (await turnsCost(deps, ids)).spentMicros;
}

function chapterError(error: unknown, fallback: string): { reason: string; message: string } {
  const value = (error ?? {}) as { reason?: unknown; message?: unknown };
  return { reason: String(value.reason ?? fallback).slice(0, 80), message: String(value.message ?? '').slice(0, 300) };
}

/** 交给一章导演的那句话（用户的语言）：第几章、标题、整部的需求 */
function chapterBrief(row: Row, chapter: ChapterRow, of: number): string {
  return row.locale === 'en'
    ? `Chapter ${String(chapter.index + 1)} of ${String(of)}: ${chapter.title}. Film goal: ${row.goal}`
    : `第 ${String(chapter.index + 1)} 章（共 ${String(of)} 章）：${chapter.title}。整部的要求：${row.goal}`;
}

/**
 * 为计划里的每个场景建一章：主序列下的子序列（同帧率，轨道照主序列的种类、名称与位置建，拼装时按"种类 + 名称"归位）、
 * 这一章自己的会话与章节记录。各章预算按场景素材时长分配。已建过的章跳过（步骤重试时不重复建）。
 */
async function createChapters(deps: DomainDeps, row: Row, scenes: readonly SceneContract[], poolMicros: number): Promise<void> {
  const main = await mainSession(deps, row);
  const sequence = (await deps.db.select().from(projectSequences).where(eq(projectSequences.id, main.sequenceId)).limit(1))[0];
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'main sequence not found', 404);
  const snapshot = await readTimelineSnapshot(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  const tracks = snapshot.timeline.tracks.filter((track) => track.sequenceId === main.sequenceId).sort((left, right) => left.position - right.position);
  const timebase = mediaTimeSchema.parse(sequence.duration).timebase;
  const weightOf = (scene: SceneContract): number => {
    const sourceSeconds = scene.sources.reduce((total, source) => total + Math.max(0, Number(source.to) - Number(source.from)), 0);
    const windowSeconds = scene.window === null ? 0 : Math.max(0, Number(scene.window.end) - Number(scene.window.start));
    return sourceSeconds > 0 ? sourceSeconds : windowSeconds > 0 ? windowSeconds : 1;
  };
  const total = scenes.reduce((sum, scene) => sum + weightOf(scene), 0);
  const existing = new Set((await deps.db.select({ index: autonomousChapters.index }).from(autonomousChapters).where(eq(autonomousChapters.runId, row.id))).map((item) => item.index));
  for (const [index, scene] of scenes.entries()) {
    if (existing.has(index)) continue;
    const child = await createSequence(deps, {
      workspaceId: row.workspaceId, projectId: row.projectId,
      input: { name: `${String(index + 1)}. ${scene.title}`.slice(0, 200), frameRate: frameRateSchema.parse(sequence.frameRate), duration: secondsInTimebase(10, timebase), parentSequenceId: main.sequenceId },
    });
    for (const track of tracks) {
      await createTrack(deps, { workspaceId: row.workspaceId, projectId: row.projectId, sequenceId: child.id, input: { kind: track.kind as CreateTrackRequest['kind'], position: track.position, name: track.name } });
    }
    const session = await createAgentSession(deps, { workspaceId: row.workspaceId, projectId: row.projectId, request: { sequenceId: child.id, locale: row.locale === 'en' ? 'en' : 'zh-CN' }, createdBy: row.createdBy });
    await deps.db.insert(autonomousChapters).values({
      id: `ach_${randomUUID()}`, workspaceId: row.workspaceId, runId: row.id, index, sceneId: scene.id, title: scene.title.slice(0, 80),
      sequenceId: child.id, sessionId: session.id, status: 'PENDING', budgetMicros: Math.floor((poolMicros * weightOf(scene)) / total),
    }).onConflictDoNothing();
  }
}

/** 十进制秒 → 指定时基的 MediaTime（整数秒，精确） */
const secondsInTimebase = (seconds: number, timebase: { num: number; den: number }): MediaTime =>
  mediaTimeSchema.parse({ ticks: String((BigInt(seconds) * BigInt(timebase.den)) / BigInt(timebase.num)), timebase });

/**
 * 拼装（S1 的内核纯函数）：完成的各章草稿一起在当前工程版本上模拟，再按计划顺序拷进主序列。
 * 某章的草稿放不上去，或含拼装器不认识的内容 → 这一章记为失败（写明原因），其余照常拼。
 */
async function assembleRunChapters(deps: DomainDeps, row: Row): Promise<{ baseRevision: number; operations: EditOperation[]; placements: Record<string, [string, string]> }> {
  const main = await mainSession(deps, row);
  const context = { deps, workspaceId: row.workspaceId, projectId: row.projectId, actorId: 'agent' };
  const snapshot = await readTimelineSnapshot(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  const rows = await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id)).orderBy(asc(autonomousChapters.index));
  const fail = async (chapter: ChapterRow, reason: string, message: string) => {
    await deps.db.update(autonomousChapters).set({ status: 'FAILED', error: { reason, message: message.slice(0, 300) }, updatedAt: new Date() }).where(eq(autonomousChapters.id, chapter.id));
  };
  const drafts = new Map<string, EditOperation[]>();
  for (const chapter of rows.filter((item) => item.status === 'SUCCEEDED')) {
    const turn = chapter.turnId === null ? undefined : (await deps.db.select({ draft: agentTurns.draftOperations }).from(agentTurns).where(eq(agentTurns.id, chapter.turnId)).limit(1))[0];
    if (turn === undefined || chapter.sequenceId === null) { await fail(chapter, 'CHAPTER_DRAFT_MISSING', 'the chapter draft was not found'); continue; }
    drafts.set(chapter.id, editOperationSchema.array().parse(turn.draft));
  }
  // 各章草稿只改各自的子序列：一起模拟；某章放不上去时逐章找出来，记为失败
  const simulate = (ids: string[]) => simulateAgentDraft(context, { baseRevision: snapshot.revision, operations: ids.flatMap((id) => drafts.get(id) ?? []) });
  let ok = rows.filter((chapter) => drafts.has(chapter.id));
  let simulated = await simulate(ok.map((chapter) => chapter.id)).catch(() => null);
  if (simulated === null) {
    for (const chapter of ok) {
      const alone = await simulate([chapter.id]).catch((error: unknown) => error);
      if (alone instanceof Error) { await fail(chapter, 'CHAPTER_DRAFT_INVALID', alone.message); drafts.delete(chapter.id); }
    }
    ok = ok.filter((chapter) => drafts.has(chapter.id));
    simulated = await simulate(ok.map((chapter) => chapter.id));
  }
  for (;;) {
    try {
      const assembly = assembleChapters(simulated.timeline, { mainSequenceId: main.sequenceId, chapters: ok.map((chapter) => ({ id: chapter.id, sequenceId: chapter.sequenceId! })) }, { newId: (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}` });
      // 拼装结果只改主序列：在当前版本上验证一次（内核拒绝就让这一步失败，不交出一份放不上去的草稿）
      if (assembly.operations.length > 0) await simulateAgentDraft(context, { baseRevision: simulated.baseRevision, operations: assembly.operations });
      const placements = Object.fromEntries(assembly.chapters.map((chapter) => [chapter.id, [mediaTimeToDisplaySecondsText(chapter.start, 3), mediaTimeToDisplaySecondsText(chapter.end, 3)] as [string, string]]));
      return { baseRevision: simulated.baseRevision, operations: assembly.operations, placements };
    } catch (error) {
      const chapterId = error instanceof ApiFailure ? error.details['chapterId'] : undefined;
      const chapter = ok.find((item) => item.id === chapterId);
      if (chapter === undefined) throw error;
      await fail(chapter, String(error instanceof ApiFailure ? error.details['reason'] : 'CHAPTER_ASSEMBLY_FAILED'), error instanceof Error ? error.message : String(error));
      ok = ok.filter((item) => item.id !== chapter.id);
    }
  }
}

const placementsOf = (outputs: Record<string, unknown>): Record<string, [string, string]> =>
  ((outputs['assemble'] as { placements?: Record<string, [string, string]> } | undefined)?.placements) ?? {};

// ---------------------------------------------------------------------------
// 交付：门禁 + 授权核对 + 采用 + 报告
// ---------------------------------------------------------------------------

async function deliverAutonomousRun(deps: DomainDeps, row: Row, placements: Record<string, [string, string]> = {}): Promise<{ status: AutonomousRunStatus; report: AutonomousReport }> {
  const turn = row.turnId === null ? null : await getAgentTurn(deps, { workspaceId: row.workspaceId, turnId: row.turnId });
  const finish = async (status: AutonomousRunStatus, report: AutonomousReport, extra: Partial<typeof autonomousRuns.$inferInsert> = {}) => {
    const now = new Date();
    await deps.db.update(autonomousRuns).set({ status, report, updatedAt: now, completedAt: now, ...extra }).where(eq(autonomousRuns.id, row.id));
    return { status, report };
  };
  if (turn === null || turn.status !== 'COMPLETED') {
    const report = await buildReport(deps, row, { outcome: 'FAILED', notAdoptedReason: 'TURN_FAILED', adopted: false, placements });
    return finish('FAILED', report, { error: turn?.error ?? { reason: 'TURN_NOT_COMPLETED' } });
  }
  if (turn.proposalId === null) {
    return finish('DELIVERED', await buildReport(deps, row, { outcome: 'NO_CHANGES', notAdoptedReason: 'NO_CHANGES', adopted: false, placements }));
  }
  const proposal = await loadProposalForRead(deps, { workspaceId: row.workspaceId, projectId: row.projectId, proposalId: turn.proposalId });
  const review = await reviewOperations(deps, row, { baseRevision: proposal.baseProjectRevision, operations: editOperationSchema.array().parse(proposal.operations) });
  const policy = await loadPolicy(deps, row);
  let notAdoptedReason: AutonomousReport['notAdoptedReason'] = null;
  if (row.approval === 'ASK_EACH') notAdoptedReason = 'APPROVAL_ASK_EACH';
  else if (policy.signature?.version !== row.policyVersion || !autonomyMayAdopt(policy) || policy.approval === 'ASK_EACH') notAdoptedReason = 'AUTHORIZATION_CHANGED';
  else if (review.warnings > 0) notAdoptedReason = 'REVIEW_GATE';
  let adoptedRevision: number | null = null;
  if (notAdoptedReason === null) {
    try {
      const adopted = await adoptProposal(deps, {
        workspaceId: row.workspaceId,
        projectId: row.projectId,
        proposalId: proposal.proposalId,
        actorId: `autonomous:${row.id}`,
        actorType: 'AI',
        expectedOperationsHash: proposal.operationsHash,
        expectedSelectionFingerprint: proposal.selectionFingerprint,
        idempotencyKey: `autonomous-adopt:${row.id}`,
      });
      adoptedRevision = adopted.projectRevision;
    } catch (error) {
      // 用户在运行期间改过作品：不覆盖用户的改动，留作试改
      if (!(error instanceof ApiFailure) || error.httpStatus !== 409) throw error;
      notAdoptedReason = 'PROJECT_CHANGED';
    }
  }
  const report = await buildReport(deps, row, { outcome: adoptedRevision === null ? 'TRIAL' : 'ADOPTED', notAdoptedReason, adopted: adoptedRevision !== null, review, turn, placements });
  return finish(adoptedRevision === null ? 'NEEDS_REVIEW' : 'DELIVERED', report, { proposalId: proposal.proposalId, adoptedRevision });
}

interface ReviewSummary {
  warnings: number;
  notes: number;
  findings: AutonomousReport['review']['findings'];
  notChecked: string[];
}

function toolContext(deps: DomainDeps, row: Row, sequenceId: string, draft: { baseRevision: number; operations: AgentToolContext['draft']['operations'] }): AgentToolContext {
  return { deps, workspaceId: row.workspaceId, projectId: row.projectId, sequenceId, actorId: 'agent', locale: row.locale, draft };
}

/** 用导演自检的同一套通用规则检查一份改动（review_draft 工具，不需要看画面）。 */
async function reviewOperations(deps: DomainDeps, row: Row, draft: AgentToolContext['draft']): Promise<ReviewSummary> {
  const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  const tool = defaultAgentToolCatalog().get('review_draft');
  if (tool === undefined) return { warnings: 0, notes: 0, findings: [], notChecked: ['review_draft unavailable'] };
  const outcome = await tool.run(toolContext(deps, row, state.sequenceId, draft), {});
  const parsed = JSON.parse(outcome.content) as { findings?: { kind: string; severity: 'warning' | 'info'; at: [string, string]; message: string }[]; notChecked?: string[] };
  const findings = (parsed.findings ?? []).slice(0, 40).map((finding) => ({ kind: finding.kind.slice(0, 40), severity: finding.severity, at: finding.at, message: finding.message.slice(0, 500) }));
  return {
    warnings: (parsed.findings ?? []).filter((finding) => finding.severity === 'warning').length,
    notes: (parsed.findings ?? []).filter((finding) => finding.severity !== 'warning').length,
    findings,
    notChecked: (parsed.notChecked ?? []).slice(0, 20).map((item) => String(item).slice(0, 200)),
  };
}

const secondsOf = (pair: [string, string]): number => Math.max(0, Number(pair[1]) - Number(pair[0]));
const secText = (value: number): string => value.toFixed(3);

async function buildReport(deps: DomainDeps, row: Row, input: {
  outcome: AutonomousReport['outcome'];
  notAdoptedReason: AutonomousReport['notAdoptedReason'];
  adopted: boolean;
  review?: ReviewSummary;
  turn?: AgentTurn;
  /** V6-10：各章拼进成片时的位置（拼装步骤的输出） */
  placements?: Record<string, [string, string]>;
}): Promise<AutonomousReport> {
  const turn = input.turn ?? (row.turnId === null ? null : await getAgentTurn(deps, { workspaceId: row.workspaceId, turnId: row.turnId }).catch(() => null));
  const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  // 报告描述的是交付的那一版：已采用 → 工程当前版本；试改 → 提案里的改动
  const proposal = !input.adopted && turn?.proposalId !== null && turn?.proposalId !== undefined
    ? await loadProposalForRead(deps, { workspaceId: row.workspaceId, projectId: row.projectId, proposalId: turn.proposalId }).catch(() => null)
    : null;
  const draft = proposal === null
    ? { baseRevision: state.project.revision, operations: [] }
    : { baseRevision: proposal.baseProjectRevision, operations: editOperationSchema.array().parse(proposal.operations) };
  const context = toolContext(deps, row, state.sequenceId, draft);
  const simulated = await simulateAgentDraft(context, draft);
  const { view, effects, narrations } = await agentTimelineViewOf(context, simulated.timeline, state.sequenceId);

  const videoTracks = new Set(view.tracks.filter((track) => track.kind === 'VIDEO').map((track) => track.id));
  const footageIds = [...new Set(view.clips.map((clip) => clip.footageId).filter((id): id is string => id !== null))];
  const origins = footageIds.length === 0 ? [] : await deps.db.select({ id: assetVersions.id, origin: assets.origin, name: assets.metadata }).from(assetVersions)
    .innerJoin(assets, eq(assets.id, assetVersions.assetId)).where(inArray(assetVersions.id, footageIds));
  const originOf = new Map(origins.map((item) => [item.id, item.origin]));
  const nameOf = new Map(state.footage.flatMap((item) => (item.footageId === null ? [] : [[item.footageId, item.name] as const])));
  const footageSeconds = new Map<string, number>();
  const generated: AutonomousReport['sources']['generated'] = [];
  let pictureSeconds = 0;
  let pictureClips = 0;
  let originalSeconds = 0;
  for (const clip of view.clips) {
    if (clip.footageId === null) continue;
    const seconds = secondsOf(clip.at);
    if (effects.has(clip.footageId)) { generated.push({ kind: 'EFFECT', name: (clip.effect ?? '').slice(0, 200), seconds: secText(seconds) }); continue; }
    if (narrations.has(clip.footageId)) { generated.push({ kind: 'NARRATION', name: (clip.narration ?? '').slice(0, 200), seconds: secText(seconds) }); continue; }
    if (!videoTracks.has(clip.track)) continue;
    pictureSeconds += seconds;
    pictureClips += 1;
    if (originOf.get(clip.footageId) === 'GENERATED') { generated.push({ kind: 'GENERATED_VIDEO', name: (nameOf.get(clip.footageId) ?? clip.footageId).slice(0, 200), seconds: secText(seconds) }); continue; }
    originalSeconds += seconds;
    footageSeconds.set(clip.footageId, (footageSeconds.get(clip.footageId) ?? 0) + seconds);
  }

  const review = input.review ?? (draft.operations.length > 0 || input.adopted ? await reviewOperations(deps, row, draft) : { warnings: 0, notes: 0, findings: [], notChecked: [] });
  const pace = view.clips.length === 0 ? null : await draftPace(context).then(({ score, target, deviations }) => ({
    cutsPerMinute: score.overall.cutsPerMinute,
    wordsPerSecond: score.overall.wordsPerSecond,
    target,
    deviations: deviations.slice(0, 60).map((deviation) => ({ at: [secText(deviation.startMs / 1000), secText(deviation.endMs / 1000)] as [string, string], component: deviation.component, measured: deviation.measured, target: deviation.target, direction: deviation.direction })),
  })).catch(() => null);
  const plan = await getLatestProductionPlan(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
  const planned = plan !== null && (plan.turnId === row.turnId || plan.turnId === planTurnId(row.id)) ? plan : null;
  // V6-10：逐章结果（按成片顺序）；没剪成或拼不进去的章写明原因
  const chapterRows = row.mode === 'CHAPTERS' ? await deps.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, row.id)).orderBy(asc(autonomousChapters.index)) : [];
  const chapters: AutonomousReport['chapters'] = chapterRows.map((chapter) => {
    const placement = input.placements?.[chapter.id] ?? null;
    const outcome = chapter.status !== 'SUCCEEDED' || placement === null ? 'FAILED' : placement[0] === placement[1] ? 'EMPTY' : 'ASSEMBLED';
    const error = chapter.error as { reason?: unknown; message?: unknown } | null;
    return {
      sceneId: chapter.sceneId.slice(0, 40), title: chapter.title.slice(0, 80), outcome, placement: outcome === 'FAILED' ? null : placement,
      reason: outcome !== 'FAILED' ? null : String(error?.message || error?.reason || (chapter.status === 'CANCELLED' ? 'CANCELLED' : 'NOT_ASSEMBLED')).slice(0, 300),
      costMicros: chapter.costMicros,
    };
  });
  const runCost = await turnsCost(deps, await runTurnIds(deps, [row]));

  const unmet: AutonomousReport['unmet'] = [];
  const length = Number(view.length);
  if (row.targetDurationSeconds !== null && view.clips.length > 0 && Math.abs(length - row.targetDurationSeconds) > row.targetDurationSeconds * 0.2) {
    unmet.push({ code: 'TARGET_DURATION', detail: `${String(row.targetDurationSeconds)}/${length.toFixed(1)}` });
  }
  if (view.clips.length > 0 && originalSeconds === 0 && state.project.article === null) unmet.push({ code: 'NO_FOOTAGE_USED', detail: '' });
  const turnError = JSON.stringify(turn?.error ?? {});
  if (turnError.includes(AGENT_ERROR_REASONS.BUDGET_EXCEEDED)) unmet.push({ code: 'BUDGET_REACHED', detail: secText((row.modelCapMicros ?? 0) / 1_000_000) });
  if (turnError.includes(AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED)) unmet.push({ code: 'MONTHLY_AI_LIMIT', detail: '' });
  if (turnError.includes(AGENT_ERROR_REASONS.ITERATION_LIMIT)) unmet.push({ code: 'ITERATION_LIMIT', detail: '' });
  const missing = chapters.filter((chapter) => chapter.outcome === 'FAILED');
  if (missing.length > 0) unmet.push({ code: 'CHAPTER_NOT_ASSEMBLED', detail: missing.map((chapter) => chapter.title).join(' / ').slice(0, 300) });
  const unpriced = runCost.unpricedCalls;
  // 有未定价的调用，或因模型没有单价而没有开始（设了月度上限时）
  if (unpriced > 0 || turnError.includes(AGENT_ERROR_REASONS.MODEL_UNPRICED)) unmet.push({ code: 'UNPRICED_MODEL', detail: String(unpriced) });

  return autonomousReportSchema.parse({
    outcome: input.outcome,
    note: turn?.reply ?? null,
    notAdoptedReason: input.adopted ? null : input.notAdoptedReason,
    timeline: { lengthSeconds: view.length, clips: pictureClips, captions: view.captions.length },
    sources: {
      footage: [...footageSeconds.entries()].map(([footageId, seconds]) => ({ footageId, name: (nameOf.get(footageId) ?? footageId).slice(0, 200), seconds: secText(seconds) })),
      generated,
      originalShare: pictureSeconds === 0 ? null : Math.round((originalSeconds / pictureSeconds) * 1000) / 1000,
    },
    review,
    pace,
    plan: planned === null ? null : { version: planned.version, logline: planned.blueprint.logline, scenes: planned.scenes.length, intents: planned.scenes.reduce((total, scene) => total + scene.intents.length, 0) },
    unmet,
    cost: { spentMicros: runCost.spentMicros, budgetMicros: row.budgetMicros, unpricedCalls: unpriced },
    chapters,
  });
}
