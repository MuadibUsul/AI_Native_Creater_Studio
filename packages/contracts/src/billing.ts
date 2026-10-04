import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { creditsSchema, moneySchema } from './common/money.js';
import { isoDateTimeSchema } from './common/time.js';
import { credentialModeSchema } from './credentials.js';

/**
 * 账本与预算契约（P03-05 / 规范 §35.1、§35.2、§68；计划 §5.6 三种幂等之一：账本结算幂等）。
 *
 * 原则：
 * - **账本只追加**（§35.1）：credit_ledger 只写不删；余额 = 各条目效果之和（不维护可变 balance）；
 * - **预算预留原子化**：并发抢预算不超额（AC-11）——预留必须原子判定 `spent + reserved + amount ≤ limit`；
 * - **结算幂等**：同一预留（hold）的结算只发生一次；回调重放返回原结果、不产生新账本条目；
 * - Credits 使用**整数**（计划 §4.1：禁止浮点累计）；Provider 金额使用定点十进制字符串。
 */

export const LEDGER_ENTRY_TYPES = ['CREDIT', 'DEBIT', 'REFUND', 'ADJUSTMENT', 'HOLD', 'HOLD_RELEASE'] as const;
export const ledgerEntryTypeSchema = z.enum(LEDGER_ENTRY_TYPES);
export type LedgerEntryType = z.infer<typeof ledgerEntryTypeSchema>;

/** 条目效果（符号约定：CREDIT/REFUND 为 +；DEBIT 为 -；ADJUSTMENT 按 amount 符号；HOLD/HOLD_RELEASE 为 0） */
export const ledgerEntrySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  entryType: ledgerEntryTypeSchema,
  /** 整数 Credits（正数；符号由 entryType 决定） */
  amount: creditsSchema.refine((value) => value >= 0, 'amount 必须为非负整数（符号由 entryType 决定）'),
  referenceType: z.string().min(1).max(64),
  referenceId: z.string().min(1).max(128).nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema,
});

export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;

export const HOLD_STATUSES = ['HELD', 'SETTLED', 'RELEASED'] as const;
export const holdStatusSchema = z.enum(HOLD_STATUSES);
export type HoldStatus = z.infer<typeof holdStatusSchema>;

/** 预算预留（Credits Hold）：一个 job 至多一个活跃预留（结算幂等的天然键） */
export const creditHoldSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  jobId: z.string().min(1),
  reservedCredits: creditsSchema,
  settledCredits: creditsSchema.nullable().default(null),
  status: holdStatusSchema,
  createdAt: isoDateTimeSchema,
  settledAt: isoDateTimeSchema.nullable().default(null),
  releasedAt: isoDateTimeSchema.nullable().default(null),
  releaseReason: z.string().max(200).nullable().default(null),
});

export type CreditHold = z.infer<typeof creditHoldSchema>;

export const BUDGET_PERIODS = ['DAILY', 'MONTHLY'] as const;
export const budgetPeriodSchema = z.enum(BUDGET_PERIODS);
export type BudgetPeriod = z.infer<typeof budgetPeriodSchema>;

export const workspaceBudgetSchema = z.object({
  workspaceId: opaqueIdSchema,
  period: budgetPeriodSchema,
  /** 周期内可消耗上限（整数 Credits；0 = 未设置 = 不限制） */
  limitCredits: creditsSchema,
  /** 单任务上限（0 = 不限制）——REQ-68-01 的 per-job max cost */
  perJobMaxCredits: creditsSchema,
  updatedAt: isoDateTimeSchema,
});

export type WorkspaceBudget = z.infer<typeof workspaceBudgetSchema>;

export const upsertBudgetRequestSchema = z.object({
  period: budgetPeriodSchema.default('MONTHLY'),
  limitCredits: creditsSchema.min(0),
  perJobMaxCredits: creditsSchema.min(0).default(0),
});

export type UpsertBudgetRequest = z.infer<typeof upsertBudgetRequestSchema>;

/** 计费状态视图（余额 = 账本效果之和；预留与消耗按周期） */
export const billingStatusSchema = z.object({
  workspaceId: opaqueIdSchema,
  /** 可用余额（整数 Credits；账本推论，非可变字段） */
  balanceCredits: creditsSchema,
  budget: workspaceBudgetSchema.nullable().default(null),
  usage: z.object({
    periodKey: z.string().min(1),
    spentCredits: creditsSchema,
    reservedCredits: creditsSchema,
  }),
  /** 各历史周期快照（最近若干） */
  recentPeriods: z
    .array(
      z.object({
        periodKey: z.string().min(1),
        spentCredits: creditsSchema,
        reservedCredits: creditsSchema,
      }),
    )
    .default([]),
});

export type BillingStatus = z.infer<typeof billingStatusSchema>;

export const topUpRequestSchema = z.object({
  amountCredits: creditsSchema.positive(),
  note: z.string().max(200).optional(),
});

export type TopUpRequest = z.infer<typeof topUpRequestSchema>;

/** ---------- Provider 用量记录（REQ-25-01） ---------- */

export const PROVIDER_GENERATION_STATUSES = [
  'RECORDED',
  'SUBMITTED',
  'SUCCEEDED',
  'FAILED',
  'NEEDS_RECONCILIATION',
] as const;
export const providerGenerationStatusSchema = z.enum(PROVIDER_GENERATION_STATUSES);
export type ProviderGenerationStatus = z.infer<typeof providerGenerationStatusSchema>;

export const providerGenerationSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  jobId: z.string().nullable().default(null),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  operation: z.string().min(1).max(64),
  credentialMode: credentialModeSchema,
  /** 输入指纹（§5.6 生成指纹的摘要；原始输入不在此表） */
  inputHash: z.string().min(1).max(128),
  status: providerGenerationStatusSchema,
  providerJobId: z.string().nullable().default(null),
  latencyMs: z.number().int().nonnegative().nullable().default(null),
  estimatedCost: moneySchema.nullable().default(null),
  actualCost: moneySchema.nullable().default(null),
  /** 平台 Credits 侧的成本（整数；BYOK 按策略可为 0） */
  estimatedCredits: creditsSchema.nullable().default(null),
  actualCredits: creditsSchema.nullable().default(null),
  attempt: z.number().int().nonnegative().default(0),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
  /** P06-07：外部处理回绑的结果资产（新 AssetVersion；来源/授权随资产保留） */
  resultAssetId: opaqueIdSchema.nullable().default(null),
  resultAssetVersionId: opaqueIdSchema.nullable().default(null),
  rebindSource: z.enum(['EXTERNAL_UPLOAD']).nullable().default(null),
  reboundAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ProviderGeneration = z.infer<typeof providerGenerationSchema>;

/** P06-07 Native Fallback：把外部处理完成的产物资产回绑到 Provider 任务引用 */
export const REBIND_ERROR_REASONS = {
  /** 资产不属于该工作区（跨租户/错误引用一律拒绝） */
  ASSET_NOT_IN_WORKSPACE: 'ASSET_NOT_IN_WORKSPACE',
  /** 资产尚未 READY（未完成上传/探测失败） */
  ASSET_NOT_READY: 'ASSET_NOT_READY',
  /** Provider 任务引用不存在（本工作区） */
  GENERATION_NOT_FOUND: 'GENERATION_NOT_FOUND',
} as const;

export type RebindErrorReason = (typeof REBIND_ERROR_REASONS)[keyof typeof REBIND_ERROR_REASONS];

export const rebindExternalResultRequestSchema = z.object({
  /** 外部处理后上传的资产（必须是 READY 且属于同一工作区） */
  assetId: opaqueIdSchema,
  /** 备注（例如"人工在 Provider 后台完成"） */
  note: z.string().max(300).optional(),
});

export type RebindExternalResultRequest = z.infer<typeof rebindExternalResultRequestSchema>;

/** 记录一次 Provider 调用（P03-06/P06 使用；本任务提供幂等的记录/结算原语） */
export const recordGenerationRequestSchema = z.object({
  jobId: z.string().min(1).nullable().default(null),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  operation: z.string().min(1).max(64),
  credentialMode: credentialModeSchema,
  inputHash: z.string().min(1).max(128),
  attempt: z.number().int().nonnegative().default(0),
  providerJobId: z.string().max(200).nullable().default(null),
  estimatedCost: moneySchema.nullable().default(null),
  estimatedCredits: creditsSchema.nullable().default(null),
});

export type RecordGenerationRequest = z.infer<typeof recordGenerationRequestSchema>;

export const BUDGET_REJECTION_REASONS = {
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  PER_JOB_LIMIT: 'PER_JOB_LIMIT',
  NO_BUDGET_CONFIGURED: 'NO_BUDGET_CONFIGURED',
} as const;

export const billingSummaryId = opaqueIdSchema;
