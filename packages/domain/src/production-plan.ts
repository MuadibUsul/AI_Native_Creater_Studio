import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  narrativeBlueprintSchema,
  productionPlanInputSchema,
  productionPlanSchema,
  sceneContractSchema,
  type ProductionPlan,
  type ProductionPlanInput,
} from '@ancs/contracts';
import { agentTurns, productionPlans, projects, proposals } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { json, listProjectFootage, type AgentToolContext, type AgentToolDefinition } from './agent-tools.js';

/**
 * 导演蓝图与场景契约（裁决 0020 第 4 条，AP-04；含 Proposal 0.2 A0 剪辑意图）。
 *
 * 规划记录是**附属**的：每次导演写计划新增一版（同一工程内版本号递增），记录制定时的工程版本号；
 * 它不进入组合状态、不阻塞任何编辑，读取时如实给出"计划之后工程是否又改过"（`changedSincePlan`）。
 */

type Row = typeof productionPlans.$inferSelect;

/**
 * 计划之后作品是否又改过：版本号没变 → 没改；唯一的变化是制定这份计划的那一轮的提案被采用（基于同一版本、
 * 采用后正是当前版本）→ 那是计划的落实，不算"之后又改过"；其他情况（用户又改了、撤销了、另一轮改了）都算。
 */
async function changedSincePlan(deps: DomainDeps, row: Row, currentRevision: number): Promise<boolean> {
  if (currentRevision === row.baseRevision) return false;
  if (row.turnId === null) return true;
  const own = await deps.db.select({ base: proposals.baseProjectRevision, committed: proposals.committedRevision })
    .from(agentTurns).innerJoin(proposals, eq(proposals.id, agentTurns.proposalId))
    .where(eq(agentTurns.id, row.turnId)).limit(1);
  const proposal = own[0];
  return !(proposal !== undefined && proposal.base === row.baseRevision && proposal.committed === currentRevision);
}

async function toPlan(deps: DomainDeps, row: Row, currentRevision: number): Promise<ProductionPlan> {
  return productionPlanSchema.parse({
    id: row.id,
    projectId: row.projectId,
    version: row.version,
    baseRevision: row.baseRevision,
    currentRevision,
    changedSincePlan: await changedSincePlan(deps, row, currentRevision),
    turnId: row.turnId,
    blueprint: narrativeBlueprintSchema.parse(row.blueprint),
    scenes: sceneContractSchema.array().parse(row.scenes),
    createdAt: row.createdAt.toISOString(),
  });
}

async function projectRevision(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<number> {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return row.revision;
}

/** 保存一版计划（版本号 = 该工程已有最大版本 + 1；并发撞号时重试一次）。 */
export async function saveProductionPlan(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  turnId: string | null;
  baseRevision: number;
  plan: ProductionPlanInput;
}): Promise<ProductionPlan> {
  const plan = productionPlanInputSchema.parse(input.plan);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await deps.db.select({ version: sql<number>`coalesce(max(${productionPlans.version}), 0)::int` }).from(productionPlans)
      .where(eq(productionPlans.projectId, input.projectId));
    const version = Number(current[0]?.version ?? 0) + 1;
    const inserted = await deps.db.insert(productionPlans).values({
      id: `ppl_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      version,
      baseRevision: input.baseRevision,
      turnId: input.turnId,
      blueprint: plan.blueprint,
      scenes: plan.scenes,
    }).onConflictDoNothing().returning();
    const row = inserted[0];
    if (row !== undefined) return toPlan(deps, row, await projectRevision(deps, input));
  }
  throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'another plan was saved at the same time; retry', 409);
}

/** 这条视频最新的一版计划；没有时为 null。 */
export async function getLatestProductionPlan(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ProductionPlan | null> {
  const revision = await projectRevision(deps, input);
  const rows = await deps.db.select().from(productionPlans)
    .where(and(eq(productionPlans.workspaceId, input.workspaceId), eq(productionPlans.projectId, input.projectId)))
    .orderBy(desc(productionPlans.version)).limit(1);
  return rows[0] === undefined ? null : toPlan(deps, rows[0], revision);
}

/** 给模型看的计划摘要（上下文与工具共用）：蓝图要点 + 每段的 id、标题、时间窗、意图（类型 + 目标感受）。 */
export function compactPlanView(plan: ProductionPlan): Record<string, unknown> {
  return {
    version: plan.version,
    ...(plan.changedSincePlan ? { projectChangedSincePlan: true } : {}),
    logline: plan.blueprint.logline,
    structure: plan.blueprint.structure,
    ...(plan.blueprint.targetDurationSeconds === null ? {} : { targetDurationSeconds: plan.blueprint.targetDurationSeconds }),
    scenes: plan.scenes.map((scene) => ({
      id: scene.id,
      title: scene.title,
      goal: scene.goal,
      ...(scene.window === null ? {} : { window: [scene.window.start, scene.window.end] }),
      intents: scene.intents.map((intent) => ({ id: intent.id, type: intent.type, targetFeeling: intent.targetFeeling })),
    })),
  };
}

// ---------------------------------------------------------------------------
// 导演工具
// ---------------------------------------------------------------------------

const planProductionTool: AgentToolDefinition<z.infer<typeof productionPlanInputSchema>> = {
  descriptor: {
    name: 'plan_production', capability: 'plan.write', effect: 'PLAN', permission: 'project:write', metered: false,
    description: [
      'Write the production plan for this video before a first cut or a restructure, and update it when the structure changes. It does not edit the timeline.',
      'blueprint: the one-line premise, audience, opening promise, structure, emotional arc, pacing, style notes, target length, what must be kept and what to avoid.',
      'scenes: each part of the video in order, with its narrative goal, rough timeline window, the footage ranges it draws on, what it needs (captions, title card, b-roll, music, narration…), acceptance points,',
      'and its edit intents: type (HOOK, SETUP, EMPHASIS, RHYTHM, COVER_JUMP, BREATHE, PAYOFF, TRANSITION, INFORM), the feeling it should create, the reason (based on the footage), and alternatives you rejected and why.',
      'Every call saves a new version; later feedback such as "the opening is not gripping" can then be traced to the HOOK intent.',
    ].join(' '),
  },
  input: productionPlanInputSchema,
  async run(context, input) {
    const footageIds = [...new Set(input.scenes.flatMap((scene) => scene.sources.map((source) => source.footageId)))];
    const footage = footageIds.length === 0 ? [] : await listProjectFootage(context, footageIds);
    const known = new Map(footage.map((row) => [row.footageId, row]));
    const unknown = footageIds.filter((id) => !known.has(id));
    if (unknown.length > 0) return { content: json({ error: 'unknown footage ids in scene sources', footageIds: unknown }), isError: true, summary: 'plan rejected: unknown footage' };
    const outOfRange = input.scenes.flatMap((scene) => scene.sources.flatMap((source) => {
      const duration = known.get(source.footageId)?.durationMs ?? null;
      return duration !== null && Number(source.to) * 1000 > duration + 50 ? [{ scene: scene.id, footageId: source.footageId, to: source.to, duration: (duration / 1000).toFixed(3) }] : [];
    }));
    if (outOfRange.length > 0) return { content: json({ error: 'scene sources reach past the end of the footage', sources: outOfRange }), isError: true, summary: 'plan rejected: source out of range' };
    const plan = await saveProductionPlan(context.deps, {
      workspaceId: context.workspaceId,
      projectId: context.projectId,
      turnId: context.turnId ?? null,
      baseRevision: context.draft.baseRevision,
      plan: input,
    });
    const intents = plan.scenes.reduce((total, scene) => total + scene.intents.length, 0);
    return {
      content: json({ saved: true, planId: plan.id, version: plan.version, scenes: plan.scenes.length, intents }),
      isError: false,
      summary: `plan v${String(plan.version)}: ${String(plan.scenes.length)} scenes, ${String(intents)} intents`,
    };
  },
};

const getProductionPlanTool: AgentToolDefinition<{ full?: boolean | undefined }> = {
  descriptor: {
    name: 'get_production_plan', capability: 'plan.read', effect: 'READ', permission: 'project:read', metered: false,
    description: 'Read the latest production plan of this video (blueprint, scenes and edit intents with their reasons). A short summary is already in the context when a plan exists; ask for full=true to see sources, needs, acceptance points and rejected alternatives.',
  },
  input: z.object({ full: z.boolean().optional() }).strict(),
  async run(context: AgentToolContext, input) {
    const plan = await getLatestProductionPlan(context.deps, { workspaceId: context.workspaceId, projectId: context.projectId });
    if (plan === null) return { content: json({ plan: null, note: 'no plan yet; write one with plan_production' }), isError: false, summary: 'no plan yet' };
    return {
      content: json(input.full === true ? { plan } : { plan: compactPlanView(plan) }),
      isError: false,
      summary: `plan v${String(plan.version)}`,
    };
  },
};

export const PLAN_AGENT_TOOLS = [planProductionTool, getProductionPlanTool] as const;
