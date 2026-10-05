import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  CREDIT_ERROR_REASONS,
  DEFAULT_CREDIT_PACK_SEEDS,
  ERROR_CODES,
  buyCreditsRequestSchema,
  creditPackSchema,
  creditReconcileSchema,
  creditStatementSchema,
  grantCreditsRequestSchema,
  refundCreditRequestSchema,
  type CreditPack,
  type CreditReconcile,
  type CreditStatement,
  type LedgerEntry,
  type PaymentProvider,
} from '@ancs/contracts';
import { billingEvents, creditLedger, creditPacks } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { getBalanceCredits, listLedger } from './billing.js';
import { getWorkspaceEntitlement } from './plans.js';
import { requirePaymentProvider } from './payments.js';

/**
 * Credits 商业化服务（P09-03 / 规范 §35、§73.3）。
 *
 * 入账唯一来源 = 收款事件（`CREDIT_PURCHASED`）：
 * - 事件侧幂等闸门（billing_events.providerEventId 唯一，P09-02）+
 * - 账本侧唯一索引（reference_type='billing_event'，迁移 0029）——双保险；
 * - **网页跳转不触发任何入账**（结账只返回 URL；入账只经 webhook 事件）。
 * 其余账本路径：管理端赠送（CREDIT）/订阅月授予（CREDIT，账期幂等）/退款扣回（DEBIT+refund_of）——
 * 全部只追加、可对账（`reconcileCredits`：事件 ↔ 账本）。
 */

const toPackDto = (row: typeof creditPacks.$inferSelect): CreditPack =>
  creditPackSchema.parse({
    id: row.id,
    code: row.code,
    version: row.version,
    name: row.name,
    credits: row.credits,
    priceMinor: row.priceMinor,
    currency: row.currency,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  });

/** 首播 Credits 包（幂等；价格是数据——种子为 0 表示未定价，运营以新版本调整）。 */
export async function ensureDefaultCreditPacks(deps: DomainDeps): Promise<{ created: string[] }> {
  const any = await deps.db.select({ id: creditPacks.id }).from(creditPacks).limit(1);
  if (any[0] !== undefined) return { created: [] };
  const created: string[] = [];
  for (const seed of DEFAULT_CREDIT_PACK_SEEDS) {
    await deps.db.insert(creditPacks).values({
      id: `cpk_${randomUUID()}`,
      code: seed.code,
      version: 1,
      name: seed.name,
      credits: seed.credits,
      priceMinor: seed.priceMinor,
      currency: seed.currency,
      status: 'ACTIVE',
    });
    created.push(seed.code);
  }
  return { created };
}

/** 包目录（同 code 最新 ACTIVE 版本）。 */
export async function listCreditPacks(deps: DomainDeps): Promise<CreditPack[]> {
  await ensureDefaultCreditPacks(deps);
  const rows = await deps.db.select().from(creditPacks).where(eq(creditPacks.status, 'ACTIVE')).orderBy(creditPacks.code, desc(creditPacks.version));
  const latestByCode = new Map<string, CreditPack>();
  for (const row of rows) {
    if (!latestByCode.has(row.code)) latestByCode.set(row.code, toPackDto(row));
  }
  return [...latestByCode.values()];
}

/** 追加包新版本（运营调价/调量；旧版本行不可变）。 */
export async function createCreditPackVersion(
  deps: DomainDeps,
  input: { code: string; name: string; credits: number; priceMinor: number; currency: string },
): Promise<CreditPack> {
  const maxRows = await deps.db.select({ max: sql<number>`coalesce(max(${creditPacks.version}), 0)` }).from(creditPacks).where(eq(creditPacks.code, input.code));
  const version = Number(maxRows[0]?.max ?? 0) + 1;
  const inserted = await deps.db
    .insert(creditPacks)
    .values({ id: `cpk_${randomUUID()}`, code: input.code, version, name: input.name, credits: input.credits, priceMinor: input.priceMinor, currency: input.currency, status: 'ACTIVE' })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'pack insert failed', 500);
  return toPackDto(row);
}

/** 有效预扣 = sum(HOLD) − sum(HOLD_RELEASE)（仅追加账本推论）。 */
async function heldCreditsOf(deps: DomainDeps, workspaceId: string): Promise<number> {
  const rows = await deps.db
    .select({ entryType: creditLedger.entryType, total: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int` })
    .from(creditLedger)
    .where(and(eq(creditLedger.workspaceId, workspaceId), sql`${creditLedger.entryType} in ('HOLD', 'HOLD_RELEASE')`))
    .groupBy(creditLedger.entryType);
  const held = Number(rows.find((row) => row.entryType === 'HOLD')?.total ?? 0);
  const released = Number(rows.find((row) => row.entryType === 'HOLD_RELEASE')?.total ?? 0);
  return Math.max(0, held - released);
}

const loadActivePack = async (deps: DomainDeps, code: string): Promise<CreditPack> => {
  await ensureDefaultCreditPacks(deps);
  const rows = await deps.db
    .select()
    .from(creditPacks)
    .where(and(eq(creditPacks.code, code), eq(creditPacks.status, 'ACTIVE')))
    .orderBy(desc(creditPacks.version))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, `Credits 包不存在：${code}`, 404, { reason: CREDIT_ERROR_REASONS.PACK_NOT_FOUND, code });
  }
  return toPackDto(row);
};

/** 发起 Credits 购买结账（**只返回渠道 URL；网页跳转不入账**）。 */
export async function startCreditCheckout(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; provider: PaymentProvider | undefined; successUrl: string; cancelUrl: string },
): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }> {
  const provider = requirePaymentProvider(input.provider);
  const body = buyCreditsRequestSchema.parse(input.request);
  await loadActivePack(deps, body.packCode);
  return provider.createCheckout({ workspaceId: input.workspaceId, planKey: null, packCode: body.packCode, successUrl: input.successUrl, cancelUrl: input.cancelUrl });
}

/**
 * 事件入账（在收款事件的幂等闸门事务内调用——同一事件至多一条账本条目）。
 * 金额取自**包版本数据**（不由事件自述），杜绝"事件说多少就入多少"。
 */
export async function applyCreditPurchaseInTx(
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  input: { workspaceId: string; providerEventId: string; packCode: string | null },
): Promise<{ credits: number }> {
  if (input.packCode === null) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'CREDIT_PURCHASED 事件缺少 packCode', 422, { reason: CREDIT_ERROR_REASONS.MISSING_PACK_CODE });
  }
  const rows = await tx
    .select()
    .from(creditPacks)
    .where(and(eq(creditPacks.code, input.packCode), eq(creditPacks.status, 'ACTIVE')))
    .orderBy(desc(creditPacks.version))
    .limit(1);
  const pack = rows[0];
  if (pack === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, `Credits 包不存在：${input.packCode}`, 404, { reason: CREDIT_ERROR_REASONS.PACK_NOT_FOUND, packCode: input.packCode });
  }
  await tx.insert(creditLedger).values({
    id: `led_${randomUUID()}`,
    workspaceId: input.workspaceId,
    entryType: 'CREDIT',
    amount: pack.credits,
    referenceType: 'billing_event',
    referenceId: input.providerEventId,
    metadata: { packCode: pack.code, packVersion: pack.version },
  });
  return { credits: pack.credits };
}

/** 管理端赠送（只追加；可对账）。 */
export async function grantCredits(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; actorId?: string | null },
): Promise<{ entry: LedgerEntry; balanceCredits: number }> {
  const body = grantCreditsRequestSchema.parse(input.request);
  const inserted = await deps.db
    .insert(creditLedger)
    .values({
      id: `led_${randomUUID()}`,
      workspaceId: input.workspaceId,
      entryType: 'CREDIT',
      amount: body.amountCredits,
      referenceType: 'admin_grant',
      referenceId: null,
      metadata: { reason: body.reason, actorId: input.actorId ?? null },
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'ledger insert failed', 500);
  return {
    entry: {
      id: row.id,
      workspaceId: row.workspaceId,
      entryType: 'CREDIT',
      amount: row.amount,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    },
    balanceCredits: await getBalanceCredits(deps, { workspaceId: input.workspaceId }),
  };
}

/** 订阅月授予（幂等：同 workspace 同账期至多一次；金额取自 Plan 权益）。 */
export async function grantMonthlyCredits(
  deps: DomainDeps,
  input: { workspaceId: string; periodStart: Date },
): Promise<{ granted: number; skipped: 'NO_GRANT' | 'ALREADY_GRANTED' | null }> {
  const entitlement = await getWorkspaceEntitlement(deps, { workspaceId: input.workspaceId });
  const amount = entitlement.entitlements.managedCreditsPerMonth;
  if (amount <= 0) return { granted: 0, skipped: 'NO_GRANT' };
  const periodKey = input.periodStart.toISOString().slice(0, 7); // YYYY-MM
  const referenceId = `${input.workspaceId}:${periodKey}`;
  const existing = await deps.db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.referenceType, 'monthly_grant'), eq(creditLedger.referenceId, referenceId)))
    .limit(1);
  if (existing[0] !== undefined) return { granted: 0, skipped: 'ALREADY_GRANTED' };
  await deps.db.insert(creditLedger).values({
    id: `led_${randomUUID()}`,
    workspaceId: input.workspaceId,
    entryType: 'CREDIT',
    amount,
    referenceType: 'monthly_grant',
    referenceId,
    metadata: { periodKey, planKey: entitlement.plan.planKey, planVersion: entitlement.plan.version },
  });
  return { granted: amount, skipped: null };
}

/**
 * 退款（退款 = **扣回**原 CREDIT 条目：钱退回渠道 → 对应 Credits 从余额扣除）。
 *
 * 账本口径：`amount` 恒非负、符号由 `entryType` 决定（契约），全表唯一的负向类型是 `DEBIT`，
 * 故扣回写 `entryType='DEBIT'` + `reference_type='refund_of'`（与使用扣减以 referenceType 区分，
 * 退款对账/展示按 referenceType 过滤）。幂等与唯一约束见迁移 0029。
 */
export async function refundCreditEntry(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; actorId?: string | null },
): Promise<{ entry: LedgerEntry; balanceCredits: number; idempotent: boolean }> {
  const body = refundCreditRequestSchema.parse(input.request);
  const rows = await deps.db
    .select()
    .from(creditLedger)
    .where(and(eq(creditLedger.id, body.entryId), eq(creditLedger.workspaceId, input.workspaceId)))
    .limit(1);
  const entry = rows[0];
  if (entry === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '账本条目不存在（或跨工作区）', 404, { reason: CREDIT_ERROR_REASONS.ENTRY_NOT_FOUND, entryId: body.entryId });
  }
  if (entry.entryType !== 'CREDIT') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `该条目不可退款（类型 ${entry.entryType}）`, 422, { reason: CREDIT_ERROR_REASONS.ENTRY_NOT_REFUNDABLE, entryType: entry.entryType });
  }
  const existingRefund = await deps.db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.referenceType, 'refund_of'), eq(creditLedger.referenceId, body.entryId)))
    .limit(1);
  if (existingRefund[0] !== undefined) {
    const existingRows = await deps.db.select().from(creditLedger).where(eq(creditLedger.id, existingRefund[0].id)).limit(1);
    const existing = existingRows[0];
    if (existing !== undefined) {
      return {
        entry: {
          id: existing.id,
          workspaceId: existing.workspaceId,
          entryType: 'DEBIT',
          amount: existing.amount,
          referenceType: existing.referenceType,
          referenceId: existing.referenceId,
          metadata: existing.metadata as Record<string, unknown>,
          createdAt: existing.createdAt.toISOString(),
        },
        balanceCredits: await getBalanceCredits(deps, { workspaceId: input.workspaceId }),
        idempotent: true,
      };
    }
  }
  const inserted = await deps.db
    .insert(creditLedger)
    .values({
      id: `led_${randomUUID()}`,
      workspaceId: input.workspaceId,
      entryType: 'DEBIT',
      amount: entry.amount,
      referenceType: 'refund_of',
      referenceId: body.entryId,
      metadata: { reason: 'PURCHASE_REFUND', note: body.note ?? null, actorId: input.actorId ?? null, originalReferenceType: entry.referenceType },
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'refund insert failed', 500);
  return {
    entry: {
      id: row.id,
      workspaceId: row.workspaceId,
      entryType: 'DEBIT',
      amount: row.amount,
      referenceType: row.referenceType,
      referenceId: row.referenceId,
      metadata: row.metadata as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
    },
    balanceCredits: await getBalanceCredits(deps, { workspaceId: input.workspaceId }),
    idempotent: false,
  };
}

/** 账单（余额 + 预扣 + 明细）。 */
export async function getCreditStatement(deps: DomainDeps, input: { workspaceId: string; limit?: number }): Promise<CreditStatement> {
  const [balanceCredits, heldCredits, entries] = await Promise.all([
    getBalanceCredits(deps, { workspaceId: input.workspaceId }),
    heldCreditsOf(deps, input.workspaceId),
    listLedger(deps, { workspaceId: input.workspaceId, ...(input.limit !== undefined ? { limit: input.limit } : {}) }),
  ]);
  return creditStatementSchema.parse({
    workspaceId: input.workspaceId,
    balanceCredits,
    heldCredits,
    availableCredits: balanceCredits - heldCredits,
    entries,
  });
}

/** 对账（事件 ↔ 账本；不一致 = 明确 false，绝不自动"修正"）。 */
export async function reconcileCredits(deps: DomainDeps, input: { workspaceId: string }): Promise<CreditReconcile> {
  const [purchaseEventRows, purchaseEntryRows, refundRows, balanceCredits] = await Promise.all([
    deps.db
      .select({ total: sql<number>`count(*)::int` })
      .from(billingEvents)
      .where(and(eq(billingEvents.workspaceId, input.workspaceId), eq(billingEvents.type, 'CREDIT_PURCHASED'), eq(billingEvents.outcome, 'APPLIED'))),
    deps.db
      .select({ total: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(and(eq(creditLedger.workspaceId, input.workspaceId), eq(creditLedger.referenceType, 'billing_event'))),
    deps.db
      .select({ total: sql<number>`count(*)::int` })
      .from(creditLedger)
      .where(and(eq(creditLedger.workspaceId, input.workspaceId), eq(creditLedger.referenceType, 'refund_of'))),
    getBalanceCredits(deps, { workspaceId: input.workspaceId }),
  ]);
  const purchaseEvents = Number(purchaseEventRows[0]?.total ?? 0);
  const purchaseEntries = Number(purchaseEntryRows[0]?.total ?? 0);
  return creditReconcileSchema.parse({
    workspaceId: input.workspaceId,
    balanceCredits,
    purchaseEvents,
    purchaseEntries,
    refundEntries: Number(refundRows[0]?.total ?? 0),
    consistent: purchaseEvents === purchaseEntries,
  });
}
