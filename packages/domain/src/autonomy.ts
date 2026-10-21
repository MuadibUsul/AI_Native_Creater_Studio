import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  AUTONOMY_ERROR_REASONS,
  DEFAULT_AUTONOMY_POLICY,
  ERROR_CODES,
  productionPolicySchema,
  signAutonomyRequestSchema,
  type AutonomyPolicy,
  type AutonomySpendDecision,
  type SignAutonomyRequest,
} from '@ancs/contracts';
import { autonomousRuns, outboxEvents, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * 自主制作的授权与花费门禁（裁决 0020，Proposal 0.1 §8 / AP-03）。
 *
 * 门禁是纯函数：输入签署的授权与已花的钱，输出能不能花这一笔、不能时为什么、要不要转而请用户确认。
 * - 没有签署 → 一律不允许（按逐项审批处理）；
 * - 总预算是硬上限，任何档位都不例外（所有者 2026-10-19 确认）；
 * - 付费生成：逐项 / 自动审批两档仍由用户逐次确认；完全授权下不超过单项上限与剩余预算才允许代为确认；
 * - 用到本人形象或声音时还要有 `allowOwnLikeness`（身份档案里的授权记录另由生成流程校验，这里不能代替）。
 */

export type AutonomySpendKind = 'MODEL' | 'GENERATION';

export function autonomySpendDecision(policy: AutonomyPolicy, input: {
  kind: AutonomySpendKind;
  /** 这一笔的预估上限（美元微单位） */
  estimateMicros: number;
  /** 本次授权下已经花掉与预留的（美元微单位） */
  spentMicros: number;
  /** 这一笔会用到本人形象或声音 */
  likeness?: boolean;
}): AutonomySpendDecision {
  if (policy.signature === null || policy.budgetMicros === null) {
    return { allowed: false, reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED, askUser: true };
  }
  const estimate = Math.max(0, Math.ceil(input.estimateMicros));
  const spent = Math.max(0, Math.ceil(input.spentMicros));
  const remaining = policy.budgetMicros - spent;
  if (input.kind === 'GENERATION') {
    if (policy.approval !== 'FULL') return { allowed: false, reason: AUTONOMY_ERROR_REASONS.GENERATION_NEEDS_CONFIRMATION, askUser: true };
    if (input.likeness === true && !policy.allowOwnLikeness) return { allowed: false, reason: AUTONOMY_ERROR_REASONS.LIKENESS_NOT_AUTHORIZED, askUser: true };
    if (policy.perGenerationMicros === null || estimate > policy.perGenerationMicros) {
      return { allowed: false, reason: AUTONOMY_ERROR_REASONS.PER_GENERATION_LIMIT, askUser: true };
    }
  }
  // 总预算：硬上限，不转请示（超了就停，用户要继续须重新签署更高的预算）
  if (estimate > remaining) return { allowed: false, reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED, askUser: false };
  return { allowed: true, remainingMicros: remaining - estimate };
}

/** 自主制作结束时可以由系统采用改动：已签署，且档位不是逐项审批。 */
export function autonomyMayAdopt(policy: AutonomyPolicy): boolean {
  return policy.signature !== null && policy.budgetMicros !== null && policy.approval !== 'ASK_EACH';
}

/** 授权剩余预算（美元微单位）；未签署为 0。 */
export function autonomyRemainingMicros(policy: AutonomyPolicy, spentMicros: number): number {
  if (policy.signature === null || policy.budgetMicros === null) return 0;
  return Math.max(0, policy.budgetMicros - Math.max(0, Math.ceil(spentMicros)));
}

async function lockPolicy(tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0], input: { workspaceId: string; projectId: string }) {
  const rows = await tx.select({ productionPolicy: projects.productionPolicy }).from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
    .for('update').limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return productionPolicySchema.parse(row.productionPolicy);
}

export async function getProjectAutonomy(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<AutonomyPolicy> {
  const rows = await deps.db.select({ productionPolicy: projects.productionPolicy }).from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return productionPolicySchema.parse(row.productionPolicy).autonomy;
}

/**
 * 签署（或重新签署）这条视频的自主制作授权：行锁内读改写，版本号加一，签署人与时间由服务端写入；
 * 写工作区事件（谁、改前改后）。重新签署即替换旧授权（旧授权下已花的钱仍计入后续运行的花费）。
 */
export async function signProjectAutonomy(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; actorId: string; request: SignAutonomyRequest; now?: Date },
): Promise<AutonomyPolicy> {
  const request = signAutonomyRequestSchema.parse(input.request);
  return deps.db.transaction(async (tx) => {
    const before = await lockPolicy(tx, input);
    // 版本号单调递增（撤回后重新签署也不复用旧版本号：花费按版本计，旧版本下的花费不能算进新授权）
    const used = await tx.select({ version: sql<number>`coalesce(max(${autonomousRuns.policyVersion}), 0)::int` }).from(autonomousRuns).where(eq(autonomousRuns.projectId, input.projectId));
    const version = Math.max(before.autonomy.signature?.version ?? 0, Number(used[0]?.version ?? 0)) + 1;
    const after: AutonomyPolicy = {
      approval: request.approval,
      budgetMicros: request.budgetMicros,
      perGenerationMicros: request.perGenerationMicros,
      allowOwnLikeness: request.allowOwnLikeness,
      maxRetriesPerTask: request.maxRetriesPerTask,
      signature: { userId: input.actorId, signedAt: (input.now ?? new Date()).toISOString(), version },
    };
    const policy = productionPolicySchema.parse({ ...before, autonomy: after });
    await tx.update(projects).set({ productionPolicy: policy, updatedAt: sql`now()` }).where(eq(projects.id, input.projectId));
    await tx.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'project.autonomy.signed',
      payload: { projectId: input.projectId, before: before.autonomy, after: policy.autonomy, actorId: input.actorId, actorType: 'USER' },
    });
    return policy.autonomy;
  });
}

/** 撤回授权：回到逐项审批、不授权任何花费；版本号保留在事件里。进行中的自主制作在下一次花费前停下。 */
export async function revokeProjectAutonomy(deps: DomainDeps, input: { workspaceId: string; projectId: string; actorId: string }): Promise<AutonomyPolicy> {
  return deps.db.transaction(async (tx) => {
    const before = await lockPolicy(tx, input);
    if (before.autonomy.signature === null) return before.autonomy;
    const policy = productionPolicySchema.parse({ ...before, autonomy: DEFAULT_AUTONOMY_POLICY });
    await tx.update(projects).set({ productionPolicy: policy, updatedAt: sql`now()` }).where(eq(projects.id, input.projectId));
    await tx.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'project.autonomy.revoked',
      payload: { projectId: input.projectId, before: before.autonomy, actorId: input.actorId, actorType: 'USER' },
    });
    return policy.autonomy;
  });
}
