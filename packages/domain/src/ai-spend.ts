import { and, eq, gte, sql } from 'drizzle-orm';
import { AGENT_ERROR_REASONS, ApiFailure, ERROR_CODES, REFERENCE_DISTILL_WORKFLOW, aiSpendSchema, type AiSpend } from '@ancs/contracts';
import { agentTurns, workflowRuns, workflowSteps } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { deploymentPolicy } from './deployment-policy.js';
import { getWorkspacePlan } from './plans.js';

/**
 * 工作区 AI 月度费用上限：邀请内测期间防止单个工作区无上限地花掉部署方的模型费用；商业化后由套餐区分额度。
 *
 * - 口径：UTC 自然月内开始的导演轮次（对话、审片讨论/执行、自主制作）的模型费用，加上风格撰写（参考视频蒸馏）的模型费用；
 *   付费生成（配音、数字人、生成镜头）另有工作区生成预算，不在这里重复计算；
 * - 上限：套餐的 `aiSpendMicrosPerMonth`；套餐不设（null）时取部署缺省 `ANCS_AI_MONTHLY_CAP_USD`；都没有 = 不设上限；
 * - 执行：新的一轮在开始前检查（402 AI_MONTHLY_CAP_REACHED）；进行中的一轮在每次模型调用前检查，达到即停下并保留已完成的修改。
 *   所以实际花费最多超出上限"一次模型调用"（同一工作区并发的几轮各一次）；
 * - 未定价的模型调用不计入金额（不填零），另计次数供界面提示。
 */

export function aiSpendWindow(now: Date): { period: string; start: Date; resetsAt: Date } {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const resetsAt = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { period: start.toISOString().slice(0, 7), start, resetsAt };
}

export async function workspaceAiSpend(deps: DomainDeps, input: { workspaceId: string; now?: Date }): Promise<AiSpend> {
  const window = aiSpendWindow(input.now ?? new Date());
  const { plan } = await getWorkspacePlan(deps, input);
  const planCap = plan.entitlements.aiSpendMicrosPerMonth;
  const deploymentCap = deploymentPolicy().aiMonthlyCapMicros;
  const capMicros = planCap ?? deploymentCap;
  const [turns, distills] = await Promise.all([
    deps.db.select({
      spent: sql<string>`coalesce(sum(${agentTurns.costMicros}), 0)`,
      unpriced: sql<string>`coalesce(sum(${agentTurns.unpricedCalls}), 0)`,
    }).from(agentTurns).where(and(eq(agentTurns.workspaceId, input.workspaceId), gte(agentTurns.createdAt, window.start))),
    // 风格撰写的费用记在 compose 步骤的结果里（一次蒸馏一次模型调用）
    deps.db.select({
      spent: sql<string>`coalesce(sum((${workflowSteps.result} ->> 'costMicros')::bigint), 0)`,
      unpriced: sql<string>`count(*) filter (where ${workflowSteps.result} ->> 'composer' = 'MODEL' and ${workflowSteps.result} ->> 'costMicros' is null)`,
    }).from(workflowRuns).innerJoin(workflowSteps, eq(workflowSteps.runId, workflowRuns.id))
      .where(and(
        eq(workflowRuns.workspaceId, input.workspaceId),
        eq(workflowRuns.type, REFERENCE_DISTILL_WORKFLOW),
        gte(workflowRuns.createdAt, window.start),
        eq(workflowSteps.stepKey, 'compose'),
        eq(workflowSteps.status, 'SUCCEEDED'),
      )),
  ]);
  const spentMicros = Number(turns[0]?.spent ?? 0) + Number(distills[0]?.spent ?? 0);
  return aiSpendSchema.parse({
    period: window.period,
    capMicros,
    capSource: planCap !== null ? 'PLAN' : deploymentCap !== null ? 'DEPLOYMENT' : null,
    spentMicros,
    unpricedCalls: Number(turns[0]?.unpriced ?? 0) + Number(distills[0]?.unpriced ?? 0),
    reached: capMicros !== null && spentMicros >= capMicros,
    resetsAt: window.resetsAt.toISOString(),
  });
}

/** 开始一件会调用模型的事之前：本月已达上限 → 402 AI_MONTHLY_CAP_REACHED（带上限、已花费、恢复时间）。 */
export async function assertAiSpendAvailable(deps: DomainDeps, input: { workspaceId: string; now?: Date }): Promise<AiSpend> {
  const spend = await workspaceAiSpend(deps, input);
  if (spend.reached) {
    throw new ApiFailure(ERROR_CODES.BUDGET_EXCEEDED, 'this workspace has used its AI allowance for this month', 402, {
      reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED,
      capMicros: spend.capMicros,
      spentMicros: spend.spentMicros,
      resetsAt: spend.resetsAt,
    });
  }
  return spend;
}
