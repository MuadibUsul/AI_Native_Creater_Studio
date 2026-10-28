import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AUTONOMOUS_PRODUCTION_WORKFLOW,
  AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION,
  AUTONOMOUS_RUN_ACTIVE_STATUSES,
  AUTONOMOUS_RUN_ERROR_REASONS,
  AUTONOMY_ERROR_REASONS,
  AgentModelFailure,
  ApiFailure,
  ERROR_CODES,
  autonomousReportSchema,
  autonomousRunSchema,
  editOperationSchema,
  productionPolicySchema,
  startAutonomousRunRequestSchema,
  type AgentTurn,
  type AutonomousReport,
  type AutonomousRun,
  type AutonomousRunStatus,
  type StartAutonomousRunRequest,
  type WorkflowErrorClass,
} from '@ancs/contracts';
import { agentTurns, assets, assetVersions, autonomousRuns, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assertAiSpendAvailable } from './ai-spend.js';
import { createAgentSession, createAutonomousTurn, getAgentTurn, legacyAgentRuntime, type AgentTurnPorts } from './agent-runtime.js';
import { agentTimelineViewOf, defaultAgentToolCatalog, simulateAgentDraft, type AgentToolContext } from './agent-tools.js';
import { draftPace } from './agent-edit-points.js';
import { autonomyMayAdopt, autonomySpendDecision } from './autonomy.js';
import { getLatestProductionPlan } from './production-plan.js';
import { adoptProposal, loadProposalForRead } from './proposals.js';
import { getStrategyPack, resolveStrategyKnobs } from './strategies.js';
import { getStudioState } from './studio.js';
import { cancelWorkflow, defaultWorkflowErrorClass, startWorkflow, type WorkflowDefinition } from './workflow.js';

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

async function toRun(deps: DomainDeps, row: Row): Promise<AutonomousRun> {
  return autonomousRunSchema.parse({
    id: row.id,
    projectId: row.projectId,
    status: row.status,
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

/** 本次签署的授权下，这条视频的自主制作已经花掉的模型费用（美元微单位；未定价的调用不计入，另行标注）。 */
export async function autonomousSpentMicros(deps: DomainDeps, input: { projectId: string; policyVersion: number; excludeRunId?: string }): Promise<number> {
  const rows = await deps.db.select({ spent: sql<number>`coalesce(sum(${agentTurns.costMicros}), 0)::bigint` }).from(autonomousRuns)
    .innerJoin(agentTurns, eq(agentTurns.id, autonomousRuns.turnId))
    .where(and(
      eq(autonomousRuns.projectId, input.projectId),
      eq(autonomousRuns.policyVersion, input.policyVersion),
      ...(input.excludeRunId === undefined ? [] : [sql`${autonomousRuns.id} <> ${input.excludeRunId}`]),
    ));
  return Number(rows[0]?.spent ?? 0);
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

const autonomousTurnId = (runId: string): string => `agt_${createHash('sha256').update(`autonomous\u0000${runId}`).digest('hex').slice(0, 32)}`;

export function autonomousProductionWorkflow(ports: AutonomousProductionPorts): WorkflowDefinition {
  const wait = { maxSeconds: 2 * 3600, noFootageSeconds: 30 * 60, pollSeconds: 15, ...ports.footageWait };
  return {
    type: AUTONOMOUS_PRODUCTION_WORKFLOW,
    version: AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION,
    steps: [
      {
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
      },
      {
        key: 'direct',
        maxAttempts: 2,
        run: async ({ deps, run }) => {
          const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
          const turnId = row.turnId ?? autonomousTurnId(row.id);
          const existing = await deps.db.select({ status: agentTurns.status }).from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
          if (existing[0] === undefined) {
            // 授权在等素材期间被撤回或改过 → 不开始花钱
            const policy = await loadPolicy(deps, row);
            if (policy.signature?.version !== row.policyVersion) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the authorization changed before directing started', 409, { reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED });
            }
            const spent = await autonomousSpentMicros(deps, { projectId: row.projectId, policyVersion: row.policyVersion, excludeRunId: row.id });
            const remaining = Math.max(0, row.budgetMicros - spent);
            const cap = remaining - callReserveMicros(remaining);
            if (cap < MIN_AUTONOMOUS_RUN_MICROS / 2) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'not enough authorized budget left', 409, { reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, spentMicros: spent, budgetMicros: row.budgetMicros });
            }
            const state = await getStudioState(deps, { workspaceId: row.workspaceId, projectId: row.projectId });
            const session = state.session ?? await createAgentSession(deps, { workspaceId: row.workspaceId, projectId: row.projectId, request: { sequenceId: state.sequenceId, locale: row.locale === 'en' ? 'en' : 'zh-CN' }, createdBy: row.createdBy });
            try {
              await createAutonomousTurn(deps, {
                workspaceId: row.workspaceId, sessionId: session.id, turnId, message: briefMessage(row), workflowRunId: run.id,
                strategyPackId: row.strategyPackId, strategyKnobs: row.strategyKnobs as Record<string, string>, createdBy: row.createdBy,
              });
            } catch (error) {
              // 用户正在和 AI 说话：等这一轮结束（有上限）
              if (error instanceof ApiFailure && error.details['reason'] === AGENT_ERROR_REASONS.TURN_IN_PROGRESS) {
                if (elapsedSeconds(row) > (ports.sessionBusySeconds ?? 30 * 60) + wait.maxSeconds) {
                  throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the session stayed busy', 409, { reason: AUTONOMOUS_RUN_ERROR_REASONS.SESSION_BUSY });
                }
                return { kind: 'WAIT_UNTIL', delaySeconds: 10, reason: 'another turn is running in this session' };
              }
              throw error;
            }
            await deps.db.update(autonomousRuns).set({ turnId, sessionId: session.id, modelCapMicros: cap, updatedAt: new Date() }).where(eq(autonomousRuns.id, row.id));
          }
          const capRow = await loadRow(deps, { workspaceId: run.workspaceId, runId: row.id });
          const result = await (ports.runtime ?? legacyAgentRuntime).runTurn(deps, ports, {
            turnId,
            workflowRunId: run.id,
            limits: { maxIterations: ports.maxIterations ?? 60, maxCostMicros: capRow.modelCapMicros ?? MIN_AUTONOMOUS_RUN_MICROS },
          });
          await setStatus(deps, row.id, 'CHECKING');
          return { kind: 'DONE', output: { turnId, proposalId: typeof result['proposalId'] === 'string' ? result['proposalId'] : null } };
        },
        classify: (error): WorkflowErrorClass => {
          if (error instanceof AgentModelFailure) return error.retryable ? 'RETRYABLE' : 'NON_RETRYABLE';
          return defaultWorkflowErrorClass(error);
        },
      },
      {
        key: 'deliver',
        maxAttempts: 3,
        run: async ({ deps, run }) => {
          const row = await loadRow(deps, { workspaceId: run.workspaceId, runId: String(run.input['runId']) });
          if (!ACTIVE.has(row.status)) return { kind: 'DONE', output: { skipped: true } };
          const delivered = await deliverAutonomousRun(deps, row);
          return { kind: 'DONE', output: { status: delivered.status, outcome: delivered.report.outcome } };
        },
      },
    ],
    // 运行以失败或取消结束：收尾运行记录与仍在进行中的那一轮，并写一份如实的报告（不留悬挂的进行中状态）
    onTerminated: async ({ deps, run, status, error }) => {
      const runId = String(run.input['runId']);
      const rows = await deps.db.select().from(autonomousRuns).where(eq(autonomousRuns.id, runId)).limit(1);
      const row = rows[0];
      if (row === undefined) return;
      if (row.turnId !== null) {
        await deps.db.update(agentTurns).set({ status, error: status === 'CANCELLED' ? { reason: 'CANCELLED' } : error ?? { reason: 'AUTONOMOUS_RUN_FAILED' }, completedAt: new Date() })
          .where(and(eq(agentTurns.id, row.turnId), eq(agentTurns.status, 'RUNNING')));
      }
      if (!ACTIVE.has(row.status)) return;
      const now = new Date();
      const report = row.turnId === null ? null : await buildReport(deps, row, { outcome: 'FAILED', notAdoptedReason: 'TURN_FAILED', adopted: false }).catch(() => null);
      await deps.db.update(autonomousRuns).set({ status, error: status === 'CANCELLED' ? { reason: 'CANCELLED' } : error, ...(report === null ? {} : { report }), updatedAt: now, completedAt: now })
        .where(eq(autonomousRuns.id, row.id));
    },
  };
}

// ---------------------------------------------------------------------------
// 交付：门禁 + 授权核对 + 采用 + 报告
// ---------------------------------------------------------------------------

async function deliverAutonomousRun(deps: DomainDeps, row: Row): Promise<{ status: AutonomousRunStatus; report: AutonomousReport }> {
  const turn = row.turnId === null ? null : await getAgentTurn(deps, { workspaceId: row.workspaceId, turnId: row.turnId });
  const finish = async (status: AutonomousRunStatus, report: AutonomousReport, extra: Partial<typeof autonomousRuns.$inferInsert> = {}) => {
    const now = new Date();
    await deps.db.update(autonomousRuns).set({ status, report, updatedAt: now, completedAt: now, ...extra }).where(eq(autonomousRuns.id, row.id));
    return { status, report };
  };
  if (turn === null || turn.status !== 'COMPLETED') {
    const report = await buildReport(deps, row, { outcome: 'FAILED', notAdoptedReason: 'TURN_FAILED', adopted: false });
    return finish('FAILED', report, { error: turn?.error ?? { reason: 'TURN_NOT_COMPLETED' } });
  }
  if (turn.proposalId === null) {
    return finish('DELIVERED', await buildReport(deps, row, { outcome: 'NO_CHANGES', notAdoptedReason: 'NO_CHANGES', adopted: false }));
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
  const report = await buildReport(deps, row, { outcome: adoptedRevision === null ? 'TRIAL' : 'ADOPTED', notAdoptedReason, adopted: adoptedRevision !== null, review, turn });
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
  const planned = plan !== null && plan.turnId === row.turnId ? plan : null;

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
  const unpriced = turn === null ? 0 : (await deps.db.select({ unpriced: agentTurns.unpricedCalls }).from(agentTurns).where(eq(agentTurns.id, turn.id)).limit(1))[0]?.unpriced ?? 0;
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
    cost: { spentMicros: turn?.costMicros ?? 0, budgetMicros: row.budgetMicros, unpricedCalls: unpriced },
  });
}
