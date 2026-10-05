import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { planKeySchema } from './plans.js';

/**
 * 订阅收款契约（P09-02 / 规范 §35、§73.1；计划 §8 P09-02）。
 *
 * 口径（计划："订阅状态通过服务端事件同步，**商业上线不依赖用户返回成功页面**"）：
 * - **收款渠道 = PaymentProvider 适配器**（Stripe 为默认；Mock/脚本化实现用于无凭据验证验收事件矩阵）；
 * - **事件是唯一入账/状态来源**：Webhook 验签 → `billing_events` **幂等闸门**（providerEventId 唯一）→
 *   状态机迁移；重复事件不重复生效；**乱序事件**（occurredAt 早于已应用水位）被忽略并审计；
 * - 用户从成功页返回**不影响任何状态**（页面不是事件）。
 */

/** 订阅状态机（Stripe 订阅语义的最小子集；状态 → 权益效果见 domain/payments.ts） */
export const SUBSCRIPTION_STATES = ['NONE', 'INCOMPLETE', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID'] as const;
export const subscriptionStateSchema = z.enum(SUBSCRIPTION_STATES);
export type SubscriptionState = z.infer<typeof subscriptionStateSchema>;

/** 收款事件类型（验收六类：成功/失败/续费/取消/重复/乱序——重复与乱序是"处理语义"而非事件类型） */
export const BILLING_EVENT_TYPES = ['CHECKOUT_COMPLETED', 'SUBSCRIPTION_RENEWED', 'PAYMENT_FAILED', 'SUBSCRIPTION_CANCELED', 'INVOICE_PAID'] as const;
export const billingEventTypeSchema = z.enum(BILLING_EVENT_TYPES);
export type BillingEventType = z.infer<typeof billingEventTypeSchema>;

export const billingEventSchema = z.object({
  /** 渠道侧事件唯一 ID（幂等闸门键） */
  providerEventId: z.string().min(1).max(200),
  type: billingEventTypeSchema,
  workspaceId: opaqueIdSchema,
  /** 目标套餐（CHECKOUT/RENEWED 携带；用于订阅生效） */
  planKey: planKeySchema.nullable().default(null),
  /** 渠道侧订阅引用（订阅生命周期操作与账单入口使用） */
  providerSubscriptionRef: z.string().min(1).max(200).nullable().default(null),
  /** 事件发生时间（乱序判定水位） */
  occurredAt: isoDateTimeSchema,
  /** 原始负载（审计；**严禁含卡号等支付敏感数据**——渠道只回传引用与状态） */
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type BillingEvent = z.infer<typeof billingEventSchema>;

export const billingStateSchema = z.object({
  workspaceId: opaqueIdSchema,
  state: subscriptionStateSchema,
  planKey: planKeySchema.nullable().default(null),
  /** 渠道订阅引用（可转账单入口） */
  providerSubscriptionRef: z.string().nullable().default(null),
  /** 当前周期结束（渠道回传；null = 未知） */
  currentPeriodEnd: isoDateTimeSchema.nullable().default(null),
  /** 已应用事件事件时间水位（乱序忽略依据） */
  lastEventAt: isoDateTimeSchema.nullable().default(null),
  updatedAt: isoDateTimeSchema,
});

export type BillingState = z.infer<typeof billingStateSchema>;

export const PAYMENT_ERROR_REASONS = {
  /** 未配置收款适配器（fail-closed；无 key 绝不伪成功） */
  PAYMENT_PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE',
  /** 验签失败（伪造/过期签名） */
  WEBHOOK_SIGNATURE_INVALID: 'WEBHOOK_SIGNATURE_INVALID',
  /** 未知事件类型 */
  UNKNOWN_EVENT_TYPE: 'UNKNOWN_EVENT_TYPE',
  /** 事件目标套餐不存在 */
  UNKNOWN_PLAN: 'UNKNOWN_PLAN',
} as const;

export type PaymentErrorReason = (typeof PAYMENT_ERROR_REASONS)[keyof typeof PAYMENT_ERROR_REASONS];

/** 结算结果（事件应用的幂等回执） */
export const billingApplyResultSchema = z.object({
  applied: z.boolean(),
  /** duplicate = 幂等重放；out_of_order = 早于水位被忽略；none = 无状态变化 */
  outcome: z.enum(['APPLIED', 'DUPLICATE', 'OUT_OF_ORDER', 'UNCHANGED']),
  state: billingStateSchema,
});

export type BillingApplyResult = z.infer<typeof billingApplyResultSchema>;

/** 收款渠道适配器（实现：Mock/脚本化——无凭据验证事件矩阵；stripe——真实渠道，需测试账号核验） */
export interface PaymentProvider {
  readonly kind: string;
  /** 创建结账会话（返回渠道结账页 URL 与订阅引用；**页面返回不作为入账依据**） */
  createCheckout(input: { workspaceId: string; planKey: string; successUrl: string; cancelUrl: string }): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }>;
  /** 账单入口（渠道客户门户；未配置 → null，由调用方 501） */
  createPortal(input: { workspaceId: string }): Promise<{ portalUrl: string } | null>;
  /** 验签并解析事件（签名无效 → 抛 PaymentSignatureError；调用方 401） */
  verifyWebhook(input: { headers: Record<string, string | undefined>; rawBody: string }): Promise<BillingEvent>;
}

/** 验签失败的领域错误（路由层统一 401；不泄漏签名材料） */
export class PaymentSignatureError extends Error {
  constructor(message = 'Webhook 签名无效') {
    super(message);
    this.name = 'PaymentSignatureError';
  }
}

export const createCheckoutRequestSchema = z.object({
  planKey: planKeySchema,
  successUrl: z.string().url().max(500).optional(),
  cancelUrl: z.string().url().max(500).optional(),
});

export type CreateCheckoutRequest = z.input<typeof createCheckoutRequestSchema>;
