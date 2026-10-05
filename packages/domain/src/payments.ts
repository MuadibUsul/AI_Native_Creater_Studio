import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PAYMENT_ERROR_REASONS,
  billingApplyResultSchema,
  billingEventSchema,
  billingStateSchema,
  createCheckoutRequestSchema,
  type BillingApplyResult,
  type BillingEvent,
  type BillingState,
  type CreateCheckoutRequest,
  type PaymentProvider,
} from '@ancs/contracts';
import { billingEvents, workspaceBillingStates } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { assignWorkspacePlanInTx, cancelWorkspaceSubscriptionInTx, getActivePlanVersion } from './plans.js';
import { applyCreditPurchaseInTx } from './credits.js';

/**
 * 订阅收款服务（P09-02 / 规范 §35、§73.1）。
 *
 * - **事件是唯一入账/状态来源**（计划原文："商业上线不依赖用户返回成功页面"）：
 *   `applyBillingEvent` 幂等闸门（providerEventId 唯一）+ **乱序忽略**（occurredAt ≤ 水位）——
 *   重复/乱序都留审计行（不静默）；
 * - 状态 → 权益效果：ACTIVE/TRIALING（携带 planKey）→ 订阅切换该套餐版本；PAST_DUE/UNPAID → 保留套餐但
 *   状态降级（P09-04 的"降级套餐有清晰超额处理"消费此状态）；CANCELED → 订阅取消（回落部署默认套餐）；
 * - 收款适配器注入（PaymentProvider；无配置 → 501 fail-closed——**无 key 绝不伪成功**）。
 */

const toStateDto = (row: typeof workspaceBillingStates.$inferSelect): BillingState =>
  billingStateSchema.parse({
    workspaceId: row.workspaceId,
    state: row.state,
    planKey: row.planKey,
    providerSubscriptionRef: row.providerSubscriptionRef,
    currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
    lastEventAt: row.lastEventAt?.toISOString() ?? null,
    updatedAt: row.updatedAt.toISOString(),
  });

/** 当前收款状态（无行 = NONE）。 */
export async function getBillingState(deps: DomainDeps, input: { workspaceId: string }): Promise<BillingState> {
  const rows = await deps.db.select().from(workspaceBillingStates).where(eq(workspaceBillingStates.workspaceId, input.workspaceId)).limit(1);
  const row = rows[0];
  if (row === undefined) {
    return billingStateSchema.parse({ workspaceId: input.workspaceId, state: 'NONE', updatedAt: new Date().toISOString() });
  }
  return toStateDto(row);
}

/** 发起结账（返回渠道结账页 URL；**成功页返回不改变状态**——事件才改变）。 */
export async function startCheckout(
  deps: DomainDeps,
  input: { workspaceId: string; request: CreateCheckoutRequest; provider: PaymentProvider | undefined; successUrl: string; cancelUrl: string },
): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }> {
  const provider = requirePaymentProvider(input.provider);
  const body = createCheckoutRequestSchema.parse(input.request);
  await getActivePlanVersion(deps, body.planKey); // 目标套餐必须存在（否则明确失败）
  return provider.createCheckout({
    workspaceId: input.workspaceId,
    planKey: body.planKey,
    successUrl: body.successUrl ?? input.successUrl,
    cancelUrl: body.cancelUrl ?? input.cancelUrl,
  });
}

/** 账单入口（渠道客户门户；未配置 → null，由路由层 501）。 */
export async function getBillingPortal(
  deps: DomainDeps,
  input: { workspaceId: string; provider: PaymentProvider | undefined },
): Promise<{ portalUrl: string } | null> {
  const provider = requirePaymentProvider(input.provider);
  return provider.createPortal({ workspaceId: input.workspaceId });
}

/** Webhook 验签（适配器实现；失败 → PaymentSignatureError）。 */
export async function verifyPaymentWebhook(
  provider: PaymentProvider | undefined,
  input: { headers: Record<string, string | undefined>; rawBody: string },
): Promise<BillingEvent> {
  const resolved = requirePaymentProvider(provider);
  return resolved.verifyWebhook(input);
}

export const requirePaymentProvider = (provider: PaymentProvider | undefined): PaymentProvider => {
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置收款适配器（PaymentProvider）：订阅收款不可用（fail-closed，无 key 绝不伪成功）', 501, {
      reason: PAYMENT_ERROR_REASONS.PAYMENT_PROVIDER_UNAVAILABLE,
    });
  }
  return provider;
};

/** 状态机迁移（事件 → 状态；见文件头口径表）。 */
const nextStateFor = (current: BillingState['state'], type: BillingEvent['type']): BillingState['state'] => {
  switch (type) {
    case 'CHECKOUT_COMPLETED':
      return 'ACTIVE';
    case 'INVOICE_PAID':
    case 'SUBSCRIPTION_RENEWED':
      return 'ACTIVE';
    case 'PAYMENT_FAILED':
      // ACTIVE 中的失败 → PAST_DUE（宽限期）；INCOMPLETE 保持
      return current === 'NONE' ? 'INCOMPLETE' : 'PAST_DUE';
    case 'SUBSCRIPTION_CANCELED':
      return 'CANCELED';
    default:
      return current;
  }
};

/**
 * 应用收款事件（幂等 + 乱序闸门）。**唯一状态来源**：
 * 1) providerEventId 已存在 → DUPLICATE（不重复生效，落审计行）；
 * 2) occurredAt ≤ 水位 → OUT_OF_ORDER（忽略状态变化，落审计行）；
 * 3) 否则按状态机迁移 + （ACTIVE 且携带 planKey 时）切换订阅到对应套餐版本。
 */
export async function applyBillingEvent(deps: DomainDeps, rawEvent: BillingEvent): Promise<BillingApplyResult> {
  const event = billingEventSchema.parse(rawEvent);
  return deps.db.transaction(async (tx) => {
    // 幂等闸门：唯一键冲突 = 重复事件
    const existing = await tx.select({ id: billingEvents.id }).from(billingEvents).where(eq(billingEvents.providerEventId, event.providerEventId)).limit(1);
    const stateRows = await tx.select().from(workspaceBillingStates).where(eq(workspaceBillingStates.workspaceId, event.workspaceId)).limit(1);
    const current = stateRows[0];
    const currentDto: BillingState =
      current === undefined ? billingStateSchema.parse({ workspaceId: event.workspaceId, state: 'NONE', updatedAt: new Date().toISOString() }) : toStateDto(current);

    const recordEvent = async (outcome: 'APPLIED' | 'DUPLICATE' | 'OUT_OF_ORDER'): Promise<void> => {
      await tx.insert(billingEvents).values({
        id: `bev_${randomUUID()}`,
        workspaceId: event.workspaceId,
        providerEventId: event.providerEventId,
        type: event.type,
        planKey: event.planKey,
        packCode: event.packCode,
        providerSubscriptionRef: event.providerSubscriptionRef,
        occurredAt: new Date(event.occurredAt),
        payload: event.payload,
        outcome,
      });
    };

    if (existing[0] !== undefined) {
      // 重复事件：不重复生效（幂等），但**不留空**——审计行以 DUPLICATE 落库会撞唯一键，故仅返回结果
      return billingApplyResultSchema.parse({ applied: false, outcome: 'DUPLICATE', state: currentDto });
    }

    const watermark = currentDto.lastEventAt === null ? null : new Date(currentDto.lastEventAt).getTime();
    const occurred = new Date(event.occurredAt).getTime();
    if (watermark !== null && occurred <= watermark) {
      await recordEvent('OUT_OF_ORDER');
      return billingApplyResultSchema.parse({ applied: false, outcome: 'OUT_OF_ORDER', state: currentDto });
    }

    const state = nextStateFor(currentDto.state, event.type);
    const planKey = event.type === 'SUBSCRIPTION_CANCELED' ? null : (event.planKey ?? currentDto.planKey);
    const now = new Date();

    await recordEvent('APPLIED');
    const updated = await tx
      .insert(workspaceBillingStates)
      .values({
        workspaceId: event.workspaceId,
        state,
        planKey,
        providerSubscriptionRef: event.providerSubscriptionRef ?? currentDto.providerSubscriptionRef,
        currentPeriodEnd: current?.currentPeriodEnd ?? null,
        lastEventAt: new Date(event.occurredAt),
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceBillingStates.workspaceId,
        set: {
          state,
          planKey,
          providerSubscriptionRef: event.providerSubscriptionRef ?? currentDto.providerSubscriptionRef,
          lastEventAt: new Date(event.occurredAt),
          updatedAt: now,
        },
      })
      .returning();
    const row = updated[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'billing state upsert failed', 500);

    // 权益效果：**计划类事件**且 ACTIVE 且套餐确有变化 → 切换订阅（append-only；同事务）
    const planAffecting = event.type === 'CHECKOUT_COMPLETED' || event.type === 'SUBSCRIPTION_RENEWED' || event.type === 'INVOICE_PAID';
    if (planAffecting && state === 'ACTIVE' && planKey !== null && planKey !== currentDto.planKey) {
      let plan;
      try {
        plan = await getActivePlanVersion(deps, planKey);
      } catch {
        // 未知套餐（事件携带的 planKey 不在目录）→ 明确失败（路由 422），不静默保留旧权益
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `事件目标套餐不存在：${planKey}`, 422, {
          reason: PAYMENT_ERROR_REASONS.UNKNOWN_PLAN,
          planKey,
        });
      }
      await assignWorkspacePlanInTx(tx, { workspaceId: event.workspaceId, planKey, assignedBy: 'billing:event', note: `billing:${event.type}`, plan });
    }

    // 入账：CREDIT_PURCHASED → 账本 CREDIT 条目（**同事务**；入账唯一 = 事件闸门 + 账本 billing_event 唯一索引）
    if (event.type === 'CREDIT_PURCHASED') {
      await applyCreditPurchaseInTx(tx, { workspaceId: event.workspaceId, providerEventId: event.providerEventId, packCode: event.packCode });
    }

    // 取消事件：终止当前 ACTIVE 订阅（权益回落部署默认套餐；历史保留）
    if (event.type === 'SUBSCRIPTION_CANCELED') {
      await cancelWorkspaceSubscriptionInTx(tx, { workspaceId: event.workspaceId, note: 'billing:SUBSCRIPTION_CANCELED' });
    }

    return billingApplyResultSchema.parse({ applied: true, outcome: 'APPLIED', state: toStateDto(row) });
  });
}

/** 最近收款事件（审计视图；含 DUPLICATE/OUT_OF_ORDER）。 */
export async function listBillingEvents(deps: DomainDeps, input: { workspaceId: string; limit?: number }): Promise<{ id: string; providerEventId: string; type: string; outcome: string; occurredAt: string; receivedAt: string }[]> {
  const rows = await deps.db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.workspaceId, input.workspaceId))
    .orderBy(desc(billingEvents.receivedAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map((row) => ({
    id: row.id,
    providerEventId: row.providerEventId,
    type: row.type,
    outcome: row.outcome,
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
  }));
}
