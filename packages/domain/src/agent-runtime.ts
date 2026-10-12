import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  AGENT_TURN_WORKFLOW,
  AGENT_TURN_WORKFLOW_VERSION,
  AgentModelFailure,
  ApiFailure,
  ERROR_CODES,
  PROPOSAL_ERROR_REASONS,
  agentContentBlockSchema,
  agentModelCostMicros,
  agentPointerSchema,
  agentSessionSchema,
  agentTurnSchema,
  createAgentSessionRequestSchema,
  projectAgentCostSchema,
  editOperationSchema,
  isDecimalSecondsText,
  startAgentTurnRequestSchema,
  type AgentContentBlock,
  type AgentEffort,
  type AgentFrameSampler,
  type AgentModelAdapter,
  type AgentModelMessage,
  type AgentModelUsage,
  type AgentSession,
  type AgentStopReason,
  type AgentTurn,
  type CreateAgentSessionRequest,
  type EditOperation,
  type ProjectAgentCost,
  type StartAgentTurnRequest,
  type WorkflowErrorClass,
} from '@ancs/contracts';
import { agentSessions, agentTurnMessages, agentTurns, projectSequences, projects, proposals, workflowRuns, workflowSteps } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { AGENT_SYSTEM_PROMPT, compileAgentContext } from './agent-prompt.js';
import { buildAgentTimelineView, defaultAgentToolCatalog, simulateAgentDraft, type AgentToolCatalog, type AgentToolContext } from './agent-tools.js';
import { createProposalBranch } from './proposals.js';
import { defaultWorkflowErrorClass, startWorkflow, type WorkflowDefinition } from './workflow.js';

/**
 * 通用导演 Agent 的运行时（V6 §6.3、§8）：一轮 = 用户的一句话 + AI 的一次完整处理。
 *
 * - 轮次经工作流 `AGENT_TURN` 执行（外部付费调用只经工作流）：单步 `run`；运行失败/取消时由终止钩子收尾轮次；
 * - `run` 是可续跑的循环：对话日志逐条追加（模型响应一行、工具结果一行，均带用量与成本），
 *   崩溃重试时从日志续跑，已完成的模型调用不重复付费，思考块原样回放；
 * - 每轮有迭代与成本上限；超限时保留已完成的草稿并说明原因；模型拒绝/鉴权错误不可重试，限流/过载有界重试；
 * - 轮次结束：草稿非空 → 成为一个提案（试改），由用户采用或撤回；工程本身在采用前不变。
 * 这里没有任何按视频类型或策略分支的逻辑（裁决 0018）；可选策略只作为数据进入上下文。
 */

export interface AgentRuntimeLimits {
  maxIterations: number;
  maxOutputTokens: number;
  /** 每轮模型调用成本上限（微美元） */
  maxCostMicros: number;
  effort: AgentEffort;
}

export const DEFAULT_AGENT_RUNTIME_LIMITS: AgentRuntimeLimits = {
  maxIterations: 24,
  maxOutputTokens: 16_000,
  maxCostMicros: 1_500_000,
  effort: 'high',
};

export interface AgentTurnPorts {
  model: AgentModelAdapter;
  catalog?: AgentToolCatalog;
  limits?: Partial<AgentRuntimeLimits>;
  /** 素材抽帧（Worker 装配）；未装配时 look_at_footage 明确报不可用 */
  frames?: AgentFrameSampler;
  /** 可选策略（V6 §6.6）：按 id 返回风格要点文本；未配置或找不到 → 不注入 */
  strategyGuidance?: (input: { workspaceId: string; strategyPackId: string; locale: string }) => Promise<string | null>;
}

type TurnRow = typeof agentTurns.$inferSelect;
type SessionRow = typeof agentSessions.$inferSelect;

const ZERO_USAGE: AgentModelUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

/**
 * 未配置导演模型时装配的端口：每轮明确失败（501 AGENT_MODEL_NOT_CONFIGURED，不可重试），
 * 不回退 Mock，也不让轮次悬挂在进行中。
 */
export function unconfiguredAgentModel(): AgentModelAdapter {
  return {
    providerId: 'unconfigured',
    implementation: 'REAL',
    model: 'unconfigured',
    respond: () => Promise.reject(new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'AI director model is not configured', 501, { reason: AGENT_ERROR_REASONS.MODEL_NOT_CONFIGURED })),
  };
}

// ---------------------------------------------------------------------------
// 会话与轮次 API
// ---------------------------------------------------------------------------

function toSession(row: SessionRow): AgentSession {
  return agentSessionSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });
}

function toTurn(row: TurnRow): AgentTurn {
  return agentTurnSchema.parse({
    id: row.id,
    sessionId: row.sessionId,
    workflowRunId: row.workflowRunId,
    status: row.status,
    message: row.message,
    pointer: row.pointer,
    reply: row.reply,
    proposalId: row.proposalId,
    toolCalls: row.toolCalls,
    usage: row.usage,
    costMicros: row.unpricedCalls > 0 ? null : row.costMicros,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  });
}

async function loadSession(deps: DomainDeps, input: { workspaceId: string; sessionId: string }): Promise<SessionRow> {
  const rows = await deps.db.select().from(agentSessions)
    .where(and(eq(agentSessions.id, input.sessionId), eq(agentSessions.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'agent session not found', 404, { reason: AGENT_ERROR_REASONS.SESSION_NOT_FOUND });
  return row;
}

export async function createAgentSession(deps: DomainDeps, input: { workspaceId: string; projectId: string; request: CreateAgentSessionRequest; createdBy?: string | null }): Promise<AgentSession> {
  const request = createAgentSessionRequestSchema.parse(input.request);
  const sequence = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.id, request.sequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (sequence[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const [row] = await deps.db.insert(agentSessions).values({
    id: `ags_${randomUUID()}`,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    sequenceId: request.sequenceId,
    locale: request.locale,
    createdBy: input.createdBy ?? null,
  }).returning();
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'agent session insert failed', 500);
  return toSession(row);
}

export async function getAgentSession(deps: DomainDeps, input: { workspaceId: string; sessionId: string }): Promise<AgentSession> {
  return toSession(await loadSession(deps, input));
}

export async function getAgentTurn(deps: DomainDeps, input: { workspaceId: string; turnId: string }): Promise<AgentTurn> {
  const rows = await deps.db.select().from(agentTurns).where(and(eq(agentTurns.id, input.turnId), eq(agentTurns.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'agent turn not found', 404);
  return toTurn(row);
}

export async function listAgentTurns(deps: DomainDeps, input: { workspaceId: string; sessionId: string; limit?: number }): Promise<AgentTurn[]> {
  await loadSession(deps, input);
  const rows = await deps.db.select().from(agentTurns)
    .where(and(eq(agentTurns.sessionId, input.sessionId), eq(agentTurns.workspaceId, input.workspaceId)))
    .orderBy(desc(agentTurns.createdAt)).limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map(toTurn);
}

/** 这条视频（工程）全部 AI 轮次的用量与成本汇总。 */
export async function projectAgentCost(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ProjectAgentCost> {
  const rows = await deps.db.select({
    turns: sql<number>`count(*)::int`,
    inputTokens: sql<number>`coalesce(sum((${agentTurns.usage}->>'inputTokens')::bigint), 0)::bigint`,
    outputTokens: sql<number>`coalesce(sum((${agentTurns.usage}->>'outputTokens')::bigint), 0)::bigint`,
    cacheReadInputTokens: sql<number>`coalesce(sum((${agentTurns.usage}->>'cacheReadInputTokens')::bigint), 0)::bigint`,
    cacheCreationInputTokens: sql<number>`coalesce(sum((${agentTurns.usage}->>'cacheCreationInputTokens')::bigint), 0)::bigint`,
    costMicros: sql<number>`coalesce(sum(${agentTurns.costMicros}), 0)::bigint`,
    unpricedCalls: sql<number>`coalesce(sum(${agentTurns.unpricedCalls}), 0)::int`,
  }).from(agentTurns).where(and(eq(agentTurns.workspaceId, input.workspaceId), eq(agentTurns.projectId, input.projectId)));
  const row = rows[0];
  const unpriced = Number(row?.unpricedCalls ?? 0);
  return projectAgentCostSchema.parse({
    projectId: input.projectId,
    turns: Number(row?.turns ?? 0),
    usage: {
      inputTokens: Number(row?.inputTokens ?? 0),
      outputTokens: Number(row?.outputTokens ?? 0),
      cacheReadInputTokens: Number(row?.cacheReadInputTokens ?? 0),
      cacheCreationInputTokens: Number(row?.cacheCreationInputTokens ?? 0),
    },
    costMicros: unpriced > 0 ? null : Number(row?.costMicros ?? 0),
    unpricedCalls: unpriced,
  });
}

/**
 * 发起一轮：同会话同一时刻只允许一个进行中的轮次（409）；幂等键 → 同一轮次（轮次 id 由会话 + 键派生）。
 * 轮次行与工作流运行分两步建立：工作流启动失败时轮次立即标为失败（不留悬挂的 RUNNING）。
 */
export async function startAgentTurn(deps: DomainDeps, input: {
  workspaceId: string;
  sessionId: string;
  request: StartAgentTurnRequest;
  createdBy?: string | null;
  idempotencyKey?: string | null;
}): Promise<AgentTurn> {
  const request = startAgentTurnRequestSchema.parse(input.request);
  const turnId = input.idempotencyKey === null || input.idempotencyKey === undefined
    ? `agt_${randomUUID()}`
    : `agt_${createHash('sha256').update(`${input.sessionId}\u0000${input.idempotencyKey}`).digest('hex').slice(0, 32)}`;

  const created = await deps.db.transaction(async (tx) => {
    const sessionRows = await tx.select().from(agentSessions)
      .where(and(eq(agentSessions.id, input.sessionId), eq(agentSessions.workspaceId, input.workspaceId))).limit(1).for('update');
    const session = sessionRows[0];
    if (session === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'agent session not found', 404, { reason: AGENT_ERROR_REASONS.SESSION_NOT_FOUND });
    const existing = await tx.select().from(agentTurns).where(eq(agentTurns.id, turnId)).limit(1);
    if (existing[0] !== undefined) return { row: existing[0], fresh: false };
    const running = await tx.select({ id: agentTurns.id }).from(agentTurns)
      .where(and(eq(agentTurns.sessionId, session.id), eq(agentTurns.status, 'RUNNING'))).limit(1);
    if (running[0] !== undefined) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'another turn is still running in this session', 409, { reason: AGENT_ERROR_REASONS.TURN_IN_PROGRESS, turnId: running[0].id });
    }
    const project = await tx.select({ revision: projects.revision }).from(projects)
      .where(and(eq(projects.id, session.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
    if (project[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    const [row] = await tx.insert(agentTurns).values({
      id: turnId,
      sessionId: session.id,
      workspaceId: input.workspaceId,
      projectId: session.projectId,
      message: request.message,
      pointer: request.pointer,
      strategyPackId: request.strategyPackId,
      baseRevision: project[0].revision,
      usage: ZERO_USAGE,
      createdBy: input.createdBy ?? null,
    }).returning();
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'agent turn insert failed', 500);
    return { row, fresh: true };
  });
  if (!created.fresh) return toTurn(created.row);

  try {
    const run = await startWorkflow(deps, {
      workspaceId: input.workspaceId,
      projectId: created.row.projectId,
      type: AGENT_TURN_WORKFLOW,
      version: AGENT_TURN_WORKFLOW_VERSION,
      subjectRef: `agent-turn:${turnId}`,
      input: { turnId },
      idempotencyKey: `agent-turn:${turnId}`,
      createdBy: input.createdBy ?? null,
    });
    const [row] = await deps.db.update(agentTurns).set({ workflowRunId: run.id }).where(eq(agentTurns.id, turnId)).returning();
    return toTurn(row ?? created.row);
  } catch (error) {
    await deps.db.update(agentTurns).set({ status: 'FAILED', error: { reason: 'WORKFLOW_START_FAILED' }, completedAt: new Date() })
      .where(and(eq(agentTurns.id, turnId), eq(agentTurns.status, 'RUNNING')));
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 工作流定义
// ---------------------------------------------------------------------------

export function agentTurnWorkflow(ports: AgentTurnPorts): WorkflowDefinition {
  return {
    type: AGENT_TURN_WORKFLOW,
    version: AGENT_TURN_WORKFLOW_VERSION,
    steps: [
      {
        key: 'run',
        maxAttempts: 2,
        run: async (context) => {
          const result = await runAgentTurnLoop(context.deps, ports, { turnId: String(context.run.input['turnId']), workflowRunId: context.run.id });
          return { kind: 'DONE', output: result };
        },
        classify: (error): WorkflowErrorClass => {
          if (error instanceof AgentModelFailure) return error.retryable ? 'RETRYABLE' : 'NON_RETRYABLE';
          return defaultWorkflowErrorClass(error);
        },
      },
    ],
    // 运行以失败或取消结束（包括一步都没执行就被取消）：把仍在进行中的轮次收尾，不留悬挂的 RUNNING
    onTerminated: async ({ deps, run, status, error }) => {
      const turnId = String(run.input['turnId']);
      const failedSteps = await deps.db.select({ error: workflowSteps.error }).from(workflowSteps)
        .where(and(eq(workflowSteps.runId, run.id), eq(workflowSteps.status, 'FAILED'))).orderBy(desc(workflowSteps.startedAt)).limit(1);
      await deps.db.update(agentTurns).set({
        status,
        error: status === 'CANCELLED'
          ? { reason: 'CANCELLED' }
          : (failedSteps[0]?.error as Record<string, unknown> | null | undefined) ?? error ?? { reason: AGENT_ERROR_REASONS.MODEL_FAILED },
        completedAt: new Date(),
      }).where(and(eq(agentTurns.id, turnId), eq(agentTurns.status, 'RUNNING')));
    },
  };
}

// ---------------------------------------------------------------------------
// 可续跑的 Agent 循环
// ---------------------------------------------------------------------------

interface LoggedMessage {
  seq: number;
  role: 'user' | 'assistant';
  content: AgentContentBlock[];
  stopReason: AgentStopReason | null;
}

async function loadLog(deps: DomainDeps, turnId: string): Promise<LoggedMessage[]> {
  const rows = await deps.db.select().from(agentTurnMessages).where(eq(agentTurnMessages.turnId, turnId)).orderBy(asc(agentTurnMessages.seq));
  return rows.map((row) => ({
    seq: row.seq,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    content: agentContentBlockSchema.array().parse(row.content),
    stopReason: ((row.usage as { stopReason?: AgentStopReason } | null)?.stopReason) ?? null,
  }));
}

const textOf = (content: readonly AgentContentBlock[]): string =>
  content.filter((block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text').map((block) => block.text).join('\n').trim();

const addUsage = (left: AgentModelUsage, right: AgentModelUsage): AgentModelUsage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cacheReadInputTokens: left.cacheReadInputTokens + right.cacheReadInputTokens,
  cacheCreationInputTokens: left.cacheCreationInputTokens + right.cacheCreationInputTokens,
});

const LIMIT_REPLIES = {
  budget: { 'zh-CN': '这一轮已达到成本上限，目前的修改已保留为提案，可以先看看效果。', en: 'This turn reached its cost limit. The changes so far are kept as a proposal for you to preview.' },
  iterations: { 'zh-CN': '这一轮的步骤太多，先停在这里；目前的修改已保留为提案。', en: 'This turn ran long, so I stopped here. The changes so far are kept as a proposal.' },
} as const;

export async function runAgentTurnLoop(
  deps: DomainDeps,
  ports: AgentTurnPorts,
  input: { turnId: string; workflowRunId: string | null },
): Promise<Record<string, unknown>> {
  const limits = { ...DEFAULT_AGENT_RUNTIME_LIMITS, ...ports.limits };
  const catalog = ports.catalog ?? defaultAgentToolCatalog();
  const turnRows = await deps.db.select().from(agentTurns).where(eq(agentTurns.id, input.turnId)).limit(1);
  const loaded = turnRows[0];
  if (loaded === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'agent turn not found', 404);
  if (loaded.status !== 'RUNNING') return { turnId: loaded.id, status: loaded.status, skipped: true };
  let turn: TurnRow = loaded;
  let baseRevision = loaded.baseRevision;
  const session = await loadSession(deps, { workspaceId: turn.workspaceId, sessionId: turn.sessionId });
  const locale = session.locale === 'en' ? 'en' : 'zh-CN';
  const toolContext = (operations: EditOperation[]): AgentToolContext => ({
    deps,
    workspaceId: loaded.workspaceId,
    projectId: loaded.projectId,
    sequenceId: session.sequenceId,
    actorId: loaded.createdBy ?? 'agent',
    locale,
    draft: { baseRevision, operations },
    ...(ports.frames === undefined ? {} : { frames: ports.frames }),
  });
  let draft = editOperationSchema.array().parse(turn.draftOperations);
  const tools = catalog.descriptors().map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));

  const log = await loadLog(deps, turn.id);
  if (log.length === 0) {
    const context = await compileTurnContext(deps, ports, turn, session, locale, toolContext(draft));
    await deps.db.insert(agentTurnMessages).values({ id: `agm_${randomUUID()}`, turnId: turn.id, workspaceId: turn.workspaceId, seq: 0, role: 'user', content: [{ type: 'text', text: context }] });
    log.push({ seq: 0, role: 'user', content: [{ type: 'text', text: context }], stopReason: null });
  }

  for (;;) {
    if (input.workflowRunId !== null) {
      const runRows = await deps.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, input.workflowRunId)).limit(1);
      if (runRows[0]?.status === 'CANCEL_REQUESTED') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'agent turn cancelled', 409, { reason: 'CANCELLED' });
    }
    const last = log.at(-1);
    if (last === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'agent log is empty', 500);
    if (last.role === 'user') {
      const iterations = log.filter((message) => message.role === 'assistant').length;
      if (iterations >= limits.maxIterations) return finishTurn(deps, turn, draft, LIMIT_REPLIES.iterations[locale], { reason: AGENT_ERROR_REASONS.ITERATION_LIMIT });
      if (turn.costMicros >= limits.maxCostMicros) return finishTurn(deps, turn, draft, LIMIT_REPLIES.budget[locale], { reason: AGENT_ERROR_REASONS.BUDGET_EXCEEDED });
      const messages: AgentModelMessage[] = log.map((message) => ({ role: message.role, content: message.content }));
      const response = await ports.model.respond({ system: AGENT_SYSTEM_PROMPT, tools, messages, maxOutputTokens: limits.maxOutputTokens, effort: limits.effort });
      const cost = agentModelCostMicros(response.model, response.usage);
      const content = response.content.length > 0 ? response.content : [{ type: 'text' as const, text: '' }];
      const seq = last.seq + 1;
      const current = turn;
      turn = await deps.db.transaction(async (tx) => {
        await tx.insert(agentTurnMessages).values({
          id: `agm_${randomUUID()}`, turnId: current.id, workspaceId: current.workspaceId, seq, role: 'assistant', content,
          model: response.model, usage: { ...response.usage, stopReason: response.stopReason }, costMicros: cost,
        });
        const [updated] = await tx.update(agentTurns).set({
          usage: addUsage(current.usage as AgentModelUsage, response.usage),
          costMicros: sql`${agentTurns.costMicros} + ${cost ?? 0}`,
          unpricedCalls: sql`${agentTurns.unpricedCalls} + ${cost === null ? 1 : 0}`,
        }).where(eq(agentTurns.id, current.id)).returning();
        return updated ?? current;
      });
      log.push({ seq, role: 'assistant', content, stopReason: response.stopReason });
      continue;
    }

    // 最后一条是模型响应
    if (last.stopReason === 'refusal') {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'the model declined this request', 422, { reason: AGENT_ERROR_REASONS.MODEL_REFUSED });
    }
    const toolUses = last.content.filter((block): block is Extract<AgentContentBlock, { type: 'tool_use' }> => block.type === 'tool_use');
    if (toolUses.length === 0) return finishTurn(deps, turn, draft, textOf(last.content), null);

    const results: AgentContentBlock[] = [];
    const calls: { name: string; ok: boolean; summary: string }[] = [];
    for (const use of toolUses) {
      if (last.stopReason === 'max_tokens') {
        // 输入可能被截断：不执行，要求模型分批重发（协议要求每个 tool_use 都有结果）
        results.push({ type: 'tool_result', toolUseId: use.id, content: JSON.stringify({ error: 'your output was cut off before this tool input was complete; resend it in smaller batches' }), isError: true });
        calls.push({ name: use.name, ok: false, summary: 'input truncated' });
        continue;
      }
      const tool = catalog.get(use.name);
      if (tool === undefined) {
        results.push({ type: 'tool_result', toolUseId: use.id, content: JSON.stringify({ error: `unknown tool ${use.name}` }), isError: true });
        calls.push({ name: use.name, ok: false, summary: 'unknown tool' });
        continue;
      }
      const parsed = tool.input.safeParse(use.input);
      if (!parsed.success) {
        results.push({ type: 'tool_result', toolUseId: use.id, content: JSON.stringify({ error: 'invalid input', issues: parsed.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join('.'), message: issue.message })) }), isError: true });
        calls.push({ name: use.name, ok: false, summary: 'invalid input' });
        continue;
      }
      const outcome = await tool.run(toolContext(draft), parsed.data);
      if (outcome.draftOperations !== undefined && !outcome.isError) draft = outcome.draftOperations;
      if (outcome.baseRevision !== undefined && !outcome.isError) baseRevision = outcome.baseRevision;
      results.push({
        type: 'tool_result', toolUseId: use.id, content: outcome.content, isError: outcome.isError,
        ...(outcome.images === undefined || outcome.images.length === 0 ? {} : { images: outcome.images }),
      });
      calls.push({ name: use.name, ok: !outcome.isError, summary: outcome.summary.slice(0, 500) });
    }
    const seq = last.seq + 1;
    const current = turn;
    turn = await deps.db.transaction(async (tx) => {
      await tx.insert(agentTurnMessages).values({ id: `agm_${randomUUID()}`, turnId: current.id, workspaceId: current.workspaceId, seq, role: 'user', content: results });
      const [updated] = await tx.update(agentTurns).set({
        draftOperations: draft,
        baseRevision,
        toolCalls: sql`${agentTurns.toolCalls} || ${JSON.stringify(calls)}::jsonb`,
      }).where(eq(agentTurns.id, current.id)).returning();
      return updated ?? current;
    });
    log.push({ seq, role: 'user', content: results, stopReason: null });
  }
}

/** 收尾：草稿非空 → 提案（基线过期时在当前 revision 上重验后再建）；轮次标为完成。 */
async function finishTurn(deps: DomainDeps, turn: TurnRow, draft: EditOperation[], reply: string, error: Record<string, unknown> | null): Promise<Record<string, unknown>> {
  let proposalId: string | null = null;
  if (draft.length > 0) {
    const create = (baseProjectRevision: number) => createProposalBranch(deps, {
      workspaceId: turn.workspaceId,
      projectId: turn.projectId,
      ...(turn.createdBy === null ? {} : { actorId: turn.createdBy }),
      request: { baseProjectRevision, selectionAnchorId: null, intentRevisionId: null, operations: draft },
    });
    try {
      proposalId = (await create(turn.baseRevision)).proposalId;
    } catch (caught) {
      if (!(caught instanceof ApiFailure) || caught.details['reason'] !== PROPOSAL_ERROR_REASONS.STALE_BASE) throw caught;
      // 用户在本轮期间改过工程：草稿必须在最新版本上仍然成立才建提案，否则明确失败（不悄悄覆盖用户的改动）
      const current = Number(caught.details['currentRevision']);
      await simulateAgentDraft({ deps, workspaceId: turn.workspaceId, projectId: turn.projectId, actorId: turn.createdBy ?? 'agent' }, { baseRevision: current, operations: draft });
      proposalId = (await create(current)).proposalId;
    }
  }
  await deps.db.update(agentTurns).set({
    status: 'COMPLETED',
    reply: reply.length > 0 ? reply.slice(0, 4000) : null,
    proposalId,
    error,
    completedAt: new Date(),
  }).where(and(eq(agentTurns.id, turn.id), eq(agentTurns.status, 'RUNNING')));
  return { turnId: turn.id, proposalId, operations: draft.length };
}

// ---------------------------------------------------------------------------
// 上下文编译
// ---------------------------------------------------------------------------

async function compileTurnContext(
  deps: DomainDeps,
  ports: AgentTurnPorts,
  turn: TurnRow,
  session: SessionRow,
  locale: 'zh-CN' | 'en',
  context: AgentToolContext,
): Promise<string> {
  const projectRows = await deps.db.select({ title: projects.title, productionPolicy: projects.productionPolicy }).from(projects).where(eq(projects.id, turn.projectId)).limit(1);
  const policy = (projectRows[0]?.productionPolicy ?? {}) as Record<string, unknown>;
  const constraints = Object.entries(policy).filter(([key, value]) => key.startsWith('allow') && value === false).map(([key]) => key);
  const { timeline: state } = await simulateAgentDraft(context, context.draft);
  const timeline = buildAgentTimelineView(state, session.sequenceId);
  const catalog = ports.catalog ?? defaultAgentToolCatalog();
  const footageTool = catalog.get('list_footage');
  const footage = footageTool === undefined ? null : JSON.parse((await footageTool.run(context, {})).content) as unknown;

  const pointer = agentPointerSchema.parse(turn.pointer);
  const pointerView = {
    timeRange: pointer.timeRange !== null && isDecimalSecondsText(pointer.timeRange.start) && isDecimalSecondsText(pointer.timeRange.end) ? pointer.timeRange : null,
    clips: timeline.clips.filter((clip) => pointer.clipIds.includes(clip.id)),
  };

  let strategy: { id: string; guidance: string } | null = null;
  if (turn.strategyPackId !== null && ports.strategyGuidance !== undefined) {
    const guidance = await ports.strategyGuidance({ workspaceId: turn.workspaceId, strategyPackId: turn.strategyPackId, locale });
    if (guidance !== null) strategy = { id: turn.strategyPackId, guidance: guidance.slice(0, 8000) };
  }

  const previous = await deps.db.select().from(agentTurns)
    .where(and(eq(agentTurns.sessionId, session.id), sql`${agentTurns.id} <> ${turn.id}`, inArray(agentTurns.status, ['COMPLETED', 'FAILED', 'CANCELLED'])))
    .orderBy(desc(agentTurns.createdAt)).limit(5);
  const proposalIds = previous.map((row) => row.proposalId).filter((id): id is string => id !== null);
  const proposalStatus = new Map((proposalIds.length === 0 ? [] : await deps.db.select({ id: proposals.id, status: proposals.status }).from(proposals).where(inArray(proposals.id, proposalIds)))
    .map((row) => [row.id, row.status]));
  const recentTurns = previous.reverse().map((row) => ({
    request: row.message.slice(0, 500),
    reply: row.reply?.slice(0, 500) ?? null,
    outcome: row.status !== 'COMPLETED' ? row.status : row.proposalId === null ? 'NO_CHANGES' : `PROPOSAL_${proposalStatus.get(row.proposalId) ?? 'UNKNOWN'}`,
  }));

  return compileAgentContext({
    locale,
    project: { title: projectRows[0]?.title ?? '', mode: typeof policy['mode'] === 'string' ? policy['mode'] : 'UNKNOWN', ...(constraints.length === 0 ? {} : { disallowed: constraints }) } as { title: string; mode: string },
    timeline,
    footage,
    pointer: pointerView,
    strategy,
    recentTurns,
    request: turn.message,
  });
}
