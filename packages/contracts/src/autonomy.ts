import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * 自主制作的授权（裁决 0020，Proposal 0.1 §8 / AP-03）。
 *
 * - 工作方式（审批档位）与内容来源（FOOTAGE_EDIT / HYBRID / GENERATIVE）是两个独立维度：档位存在
 *   `productionPolicy.autonomy`，内容来源仍是 `productionPolicy.mode`，二者不合成一个枚举；
 * - 授权 = 预算上限 + 允许的能力，由用户显式签署（谁、何时、第几版）；没有签署时一律按逐项审批处理；
 * - 总预算（美元微单位，含 AI 模型调用与付费生成）在任何档位下都是硬上限；
 * - 审批档位不能授予身份权利：数字人与克隆声音另外需要身份档案里有效的授权记录（V6-7）。
 */

export const APPROVAL_TIERS = ['ASK_EACH', 'AUTO_SAFE', 'FULL'] as const;
export const approvalTierSchema = z.enum(APPROVAL_TIERS);
export type ApprovalTier = z.infer<typeof approvalTierSchema>;

/** 单个工程可签署的总预算上限（1000 美元）；更大的项目需另行商定，不在界面里放开。 */
export const MAX_AUTONOMY_BUDGET_MICROS = 1_000_000_000;
/** 每个制作任务的有限重试上限（0.1 §6.4：有限次数，值为配置项） */
export const MAX_AUTONOMY_RETRIES = 5;

const budgetMicrosSchema = z.number().int().positive().max(MAX_AUTONOMY_BUDGET_MICROS);

export const autonomySignatureSchema = z.object({
  userId: opaqueIdSchema,
  signedAt: z.string().datetime(),
  /** 每签一次加一；审计与代为确认的记录都引用这个版本 */
  version: z.number().int().positive(),
}).strict();
export type AutonomySignature = z.infer<typeof autonomySignatureSchema>;

export const autonomyPolicySchema = z.object({
  approval: approvalTierSchema,
  /** 总预算（美元微单位）；null = 没有授权任何花费 */
  budgetMicros: budgetMicrosSchema.nullable(),
  /** 单次付费生成的上限（只在完全授权下用于代为确认）；null = 不允许代为确认任何付费生成 */
  perGenerationMicros: budgetMicrosSchema.nullable(),
  /** 允许使用你本人的形象与声音（仍需身份档案里有效的授权记录） */
  allowOwnLikeness: z.boolean(),
  /** 每个制作任务最多重试几次 */
  maxRetriesPerTask: z.number().int().min(0).max(MAX_AUTONOMY_RETRIES),
  signature: autonomySignatureSchema.nullable(),
}).strict();
export type AutonomyPolicy = z.infer<typeof autonomyPolicySchema>;

export const DEFAULT_AUTONOMY_POLICY: AutonomyPolicy = Object.freeze({
  approval: 'ASK_EACH',
  budgetMicros: null,
  perGenerationMicros: null,
  allowOwnLikeness: false,
  maxRetriesPerTask: 2,
  signature: null,
}) as AutonomyPolicy;

/** 签署（或重新签署）授权：预算必填；单次生成上限不得超过总预算。服务端写入签署人、时间与版本。 */
export const signAutonomyRequestSchema = z.object({
  approval: approvalTierSchema,
  budgetMicros: budgetMicrosSchema,
  perGenerationMicros: budgetMicrosSchema.nullable().default(null),
  allowOwnLikeness: z.boolean().default(false),
  maxRetriesPerTask: z.number().int().min(0).max(MAX_AUTONOMY_RETRIES).default(2),
}).strict().refine((value) => value.perGenerationMicros === null || value.perGenerationMicros <= value.budgetMicros, {
  message: 'perGenerationMicros must not exceed budgetMicros',
  path: ['perGenerationMicros'],
});
export type SignAutonomyRequest = z.input<typeof signAutonomyRequestSchema>;

export const AUTONOMY_ERROR_REASONS = {
  /** 没有签署授权（或已撤回） */
  NOT_SIGNED: 'AUTONOMY_NOT_SIGNED',
  /** 再花就会超过签署的总预算 */
  BUDGET_EXHAUSTED: 'AUTONOMY_BUDGET_EXHAUSTED',
  /** 这一档位下付费生成仍需用户逐次确认 */
  GENERATION_NEEDS_CONFIRMATION: 'AUTONOMY_GENERATION_NEEDS_CONFIRMATION',
  /** 单次生成超过签署的单项上限（或没有授权单项上限） */
  PER_GENERATION_LIMIT: 'AUTONOMY_PER_GENERATION_LIMIT',
  /** 没有授权使用本人形象与声音 */
  LIKENESS_NOT_AUTHORIZED: 'AUTONOMY_LIKENESS_NOT_AUTHORIZED',
} as const;
export type AutonomyErrorReason = (typeof AUTONOMY_ERROR_REASONS)[keyof typeof AUTONOMY_ERROR_REASONS];

/** 一次花费的门禁结论：不允许时给出原因，以及是否应当转为请用户确认（而不是直接放弃）。 */
export type AutonomySpendDecision =
  | { allowed: true; remainingMicros: number }
  | { allowed: false; reason: AutonomyErrorReason; askUser: boolean };
