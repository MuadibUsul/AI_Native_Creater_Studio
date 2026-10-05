import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { ledgerEntrySchema } from './billing.js';

/**
 * Credits 商业化契约（P09-03 / 规范 §35、§73.3；计划 §8 P09-03）。
 *
 * 纪律（验收："支付成功事件只能入账一次；网页跳转不能作为入账依据"）：
 * - **入账唯一来源 = 收款事件**（`CREDIT_PURCHASED`）：与订阅状态同一幂等闸门（providerEventId 唯一）+
 *   账本侧 `reference_type='billing_event'` 的**唯一索引**双保险——同一事件至多一条账本条目；
 * - Credits 包价格是**版本化数据**（非业务硬编码）；
 * - 赠送（管理端/订阅月授予）/退款（对应原 CREDIT 的反向 REFUND）全部经账本（只追加）。
 */

export const CREDIT_ERROR_REASONS = {
  /** 套餐不存在（code 未在目录或已 RETIRED） */
  PACK_NOT_FOUND: 'PACK_NOT_FOUND',
  /** 账本条目不存在（或跨工作区） */
  ENTRY_NOT_FOUND: 'ENTRY_NOT_FOUND',
  /** 该条目不可退款（非 CREDIT 类型 / 已退款） */
  ENTRY_NOT_REFUNDABLE: 'ENTRY_NOT_REFUNDABLE',
  /** 金额非法 */
  AMOUNT_INVALID: 'AMOUNT_INVALID',
  /** 事件缺少 packCode（CREDIT_PURCHASED） */
  MISSING_PACK_CODE: 'MISSING_PACK_CODE',
} as const;

export type CreditErrorReason = (typeof CREDIT_ERROR_REASONS)[keyof typeof CREDIT_ERROR_REASONS];

export const CREDIT_PACK_STATUSES = ['ACTIVE', 'RETIRED'] as const;
export const creditPackStatusSchema = z.enum(CREDIT_PACK_STATUSES);

/** Credits 包（版本化：code+version 唯一；价格是数据） */
export const creditPackSchema = z.object({
  id: opaqueIdSchema,
  code: z.string().min(1).max(40),
  version: z.number().int().positive(),
  name: z.string().min(1).max(80),
  credits: z.number().int().positive(),
  priceMinor: z.number().int().nonnegative(),
  currency: z.string().length(3),
  status: creditPackStatusSchema,
  createdAt: isoDateTimeSchema,
});

export type CreditPack = z.infer<typeof creditPackSchema>;

/** 账本条目（含余额效果；复用 billing 契约） */
export const creditStatementSchema = z.object({
  workspaceId: opaqueIdSchema,
  balanceCredits: z.number().int(),
  /** 有效预扣（HOLD 未结算）合计——展示"可用余额 = balance − holds"口径 */
  heldCredits: z.number().int().nonnegative(),
  availableCredits: z.number().int(),
  entries: z.array(ledgerEntrySchema),
});

export type CreditStatement = z.infer<typeof creditStatementSchema>;

/** 对账（事件 ↔ 账本 ↔ 余额） */
export const creditReconcileSchema = z.object({
  workspaceId: opaqueIdSchema,
  balanceCredits: z.number().int(),
  /** 收款事件（APPLIED 的 CREDIT_PURCHASED）计数 */
  purchaseEvents: z.number().int().nonnegative(),
  /** 账本中 reference_type='billing_event' 的入账条目数（应等于 purchaseEvents） */
  purchaseEntries: z.number().int().nonnegative(),
  refundEntries: z.number().int().nonnegative(),
  /** 一致性结论（计数一致 = true；不一致须人工核查，绝不自动"修正"） */
  consistent: z.boolean(),
});

export type CreditReconcile = z.infer<typeof creditReconcileSchema>;

export const buyCreditsRequestSchema = z.object({
  packCode: z.string().min(1).max(40),
});

export type BuyCreditsRequest = z.infer<typeof buyCreditsRequestSchema>;

export const grantCreditsRequestSchema = z.object({
  amountCredits: z.number().int().positive().max(1_000_000),
  reason: z.string().min(1).max(200),
});

export type GrantCreditsRequest = z.infer<typeof grantCreditsRequestSchema>;

export const refundCreditRequestSchema = z.object({
  entryId: opaqueIdSchema,
  note: z.string().max(300).optional(),
});

export type RefundCreditRequest = z.infer<typeof refundCreditRequestSchema>;

/** 默认 Credits 包种子（**数据**；价格可为 0 表示"未定价/内测"——由运营以新版本调整） */
export const DEFAULT_CREDIT_PACK_SEEDS: readonly { code: string; name: string; credits: number; priceMinor: number; currency: string }[] = [
  { code: 'starter', name: 'Starter 包', credits: 500, priceMinor: 0, currency: 'USD' },
  { code: 'creator_2000', name: 'Creator 2000', credits: 2000, priceMinor: 0, currency: 'USD' },
  { code: 'studio_10000', name: 'Studio 10000', credits: 10_000, priceMinor: 0, currency: 'USD' },
];
