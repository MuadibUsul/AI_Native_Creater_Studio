import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  BUDGET_REJECTION_REASONS,
  ERROR_CODES,
  billingStatusSchema,
  creditHoldSchema,
  ledgerEntrySchema,
  providerGenerationSchema,
  workspaceBudgetSchema,
  type BillingStatus,
  type CreditHold,
  type LedgerEntry,
  type LedgerEntryType,
  type ProviderGeneration,
  type ProviderGenerationStatus,
  type RecordGenerationRequest,
  type UpsertBudgetRequest,
  type WorkspaceBudget,
} from '@ancs/contracts';
import { budgetCounters, creditHolds, creditLedger, providerGenerations, workspaceBudgets } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * 账本与预算（P03-05 / 规范 §35.1、§35.2、§68；计划 §5.6"账本结算幂等"）。
 *
 * 不变量：
 * 1. **账本只追加**：任何资金/额度变化都写 credit_ledger 新条目；余额是推论（SUM 效果）；
 * 2. **原子预留（AC-11）**：预留在一个事务内对**预算计数器行加锁**后判定
 *    `spent + reserved + amount ≤ limit`——并发抢预算不可能超额；
 * 3. **结算幂等**：`settleHold` 对同一预留只生效一次（重复调用返回原结果、**不产生新账本条目**）；
 *    预留按 jobId 唯一（一个任务至多一个活跃预留），重试复用同行（记 periodKeys 快照，跨周期不串账）；
 * 4. **BYOK 计费策略可注入**（§35.2：不得硬编码在 generation service）：默认 BYOK 不扣 Provider
 *    Credits（策略实现见 DomainDeps.billingPolicy；平台策略属 P09-01）。
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BillingPolicy {
  /** BYOK 调用的平台 Credits 计费（默认 0：不扣 Provider Credits；§35.2 的策略位） */
  creditsForByok?: (meteredCredits: number) => number;
}

function requireBilling(deps: DomainDeps): void {
  void deps; // 账本不依赖外部适配器；保留函数以便未来注入 KMS/支付网关
}

/** 周期键：DAILY → 'YYYY-MM-DD'；MONTHLY → 'YYYY-MM' */
export function periodKey(period: 'DAILY' | 'MONTHLY', now: Date): string {
  const iso = now.toISOString();
  return period === 'DAILY' ? iso.slice(0, 10) : iso.slice(0, 7);
}

const toLedgerDto = (row: typeof creditLedger.$inferSelect): LedgerEntry =>
  ledgerEntrySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    entryType: row.entryType,
    amount: row.amount,
    referenceType: row.referenceType,
    referenceId: row.referenceId,
    metadata: row.metadata,
    createdAt: row.createdAt.toISOString(),
  });

const toHoldDto = (row: typeof creditHolds.$inferSelect): CreditHold =>
  creditHoldSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    reservedCredits: row.reservedCredits,
    settledCredits: row.settledCredits,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    settledAt: row.settledAt?.toISOString() ?? null,
    releasedAt: row.releasedAt?.toISOString() ?? null,
    releaseReason: row.releaseReason,
  });

const toBudgetDto = (row: typeof workspaceBudgets.$inferSelect): WorkspaceBudget =>
  workspaceBudgetSchema.parse({
    workspaceId: row.workspaceId,
    period: row.period,
    limitCredits: row.limitCredits,
    perJobMaxCredits: row.perJobMaxCredits,
    updatedAt: row.updatedAt.toISOString(),
  });

const toGenerationDto = (row: typeof providerGenerations.$inferSelect): ProviderGeneration =>
  providerGenerationSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    providerId: row.providerId,
    modelId: row.modelId,
    operation: row.operation,
    credentialMode: row.credentialMode,
    inputHash: row.inputHash,
    status: row.status,
    providerJobId: row.providerJobId,
    latencyMs: row.latencyMs,
    estimatedCost: row.estimatedCost,
    actualCost: row.actualCost,
    estimatedCredits: row.estimatedCredits,
    actualCredits: row.actualCredits,
    attempt: row.attempt,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/** 账本条目的余额效果（HOLD/HOLD_RELEASE 为 0：它们是预算预留的标记，不改变余额） */
export function ledgerEffect(entryType: LedgerEntryType, amount: number): number {
  switch (entryType) {
    case 'CREDIT':
    case 'REFUND':
      return amount;
    case 'DEBIT':
      return -amount;
    case 'ADJUSTMENT':
      return amount; // 允许负值（amount 字段本身非负，符号经 ADJUSTMENT 的 metadata.sign 表达）
    case 'HOLD':
    case 'HOLD_RELEASE':
      return 0;
  }
}

export async function getBalanceCredits(deps: DomainDeps, input: { workspaceId: string }): Promise<number> {
  const rows = await deps.db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, input.workspaceId));
  return rows.reduce((sum, row) => sum + ledgerEffect(row.entryType as LedgerEntryType, row.amount), 0);
}

export async function listLedger(deps: DomainDeps, input: { workspaceId: string; limit?: number }): Promise<LedgerEntry[]> {
  const rows = await deps.db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.workspaceId, input.workspaceId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map(toLedgerDto);
}

export async function upsertBudget(
  deps: DomainDeps,
  input: { workspaceId: string; input: UpsertBudgetRequest; now?: Date },
): Promise<WorkspaceBudget> {
  const now = input.now ?? new Date();
  const existing = await deps.db
    .select()
    .from(workspaceBudgets)
    .where(eq(workspaceBudgets.workspaceId, input.workspaceId))
    .limit(1);
  if (existing[0] !== undefined) {
    const updated = await deps.db
      .update(workspaceBudgets)
      .set({
        period: input.input.period,
        limitCredits: input.input.limitCredits,
        perJobMaxCredits: input.input.perJobMaxCredits,
        updatedAt: now,
      })
      .where(eq(workspaceBudgets.workspaceId, input.workspaceId))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'budget update failed', 500);
    return toBudgetDto(row);
  }
  const inserted = await deps.db
    .insert(workspaceBudgets)
    .values({
      id: `bud_${randomUUID()}`,
      workspaceId: input.workspaceId,
      period: input.input.period,
      limitCredits: input.input.limitCredits,
      perJobMaxCredits: input.input.perJobMaxCredits,
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'budget insert failed', 500);
  return toBudgetDto(row);
}

export async function getBudget(deps: DomainDeps, input: { workspaceId: string }): Promise<WorkspaceBudget | null> {
  const rows = await deps.db.select().from(workspaceBudgets).where(eq(workspaceBudgets.workspaceId, input.workspaceId)).limit(1);
  const row = rows[0];
  return row === undefined ? null : toBudgetDto(row);
}

/** 充值（CREDIT 条目；只追加）。 */
export async function topUpCredits(
  deps: DomainDeps,
  input: { workspaceId: string; amountCredits: number; note?: string },
): Promise<{ entry: LedgerEntry; balanceCredits: number }> {
  const inserted = await deps.db
    .insert(creditLedger)
    .values({
      id: `led_${randomUUID()}`,
      workspaceId: input.workspaceId,
      entryType: 'CREDIT',
      amount: input.amountCredits,
      referenceType: 'manual_topup',
      referenceId: null,
      metadata: input.note !== undefined ? { note: input.note } : {},
    })
    .returning();
  const row = inserted[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'ledger insert failed', 500);
  return { entry: toLedgerDto(row), balanceCredits: await getBalanceCredits(deps, { workspaceId: input.workspaceId }) };
}

async function writeLedger(
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  input: { workspaceId: string; entryType: LedgerEntryType; amount: number; referenceType: string; referenceId: string | null; metadata?: Record<string, unknown> },
): Promise<void> {
  await tx.insert(creditLedger).values({
    id: `led_${randomUUID()}`,
    workspaceId: input.workspaceId,
    entryType: input.entryType,
    amount: input.amount,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    metadata: input.metadata ?? {},
  });
}

/**
 * 取计数器行并**持有行锁**（同一事务内有效）。
 *
 * 并发正确性要点（AC-11）：行不存在时 `SELECT ... FOR UPDATE` 锁不住"未来行"（无行可锁），
 * 因此这里用 `INSERT ... ON CONFLICT DO NOTHING` 抢占创建，随后**带 FOR UPDATE 重读**——
 * 保证所有并发事务最终都持有同一行的排他锁后再读-判-写（避免丢失更新导致超额）。
 */
async function lockCounter(
  tx: Parameters<Parameters<DomainDeps['db']['transaction']>[0]>[0],
  workspaceId: string,
  key: string,
): Promise<typeof budgetCounters.$inferSelect> {
  const existing = await tx
    .select()
    .from(budgetCounters)
    .where(and(eq(budgetCounters.workspaceId, workspaceId), eq(budgetCounters.periodKey, key)))
    .limit(1)
    .for('update');
  if (existing[0] !== undefined) return existing[0];
  const inserted = await tx
    .insert(budgetCounters)
    .values({ id: `bct_${randomUUID()}`, workspaceId, periodKey: key })
    .onConflictDoNothing()
    .returning();
  if (inserted[0] !== undefined) return inserted[0];
  // 冲突：另一并发事务刚创建 → 带锁重读（关键：必须 FOR UPDATE，否则丢失更新）
  const retry = await tx
    .select()
    .from(budgetCounters)
    .where(and(eq(budgetCounters.workspaceId, workspaceId), eq(budgetCounters.periodKey, key)))
    .limit(1)
    .for('update');
  if (retry[0] === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'counter row missing', 500);
  return retry[0];
}

/**
 * 预算预留（Credits Hold）——**原子**：同一事务内锁定计数器行后判定上限（AC-11）。
 * 幂等：同一 (workspace, job) 已有 HELD 预留且金额相同 → 直接返回（不重复占额）；
 * 任务重试（已 SETTLED/RELEASED 的同行）→ 以新金额重新占用（旧账已结清）。
 */
export async function reserveCredits(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; estimatedCredits: number; now?: Date; referenceType?: string },
): Promise<CreditHold> {
  requireBilling(deps);
  if (!Number.isInteger(input.estimatedCredits) || input.estimatedCredits < 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'estimatedCredits 必须为非负整数', 400);
  }
  const now = input.now ?? new Date();

  return deps.db.transaction(async (tx) => {
    // 工作区预算（单行/工作区）
    const budgetRows = await tx.select().from(workspaceBudgets).where(eq(workspaceBudgets.workspaceId, input.workspaceId)).limit(1);
    const budget = budgetRows[0];
    const key = budget === undefined ? periodKey('MONTHLY', now) : periodKey(budget.period as 'DAILY' | 'MONTHLY', now);

    // 已有预留（行锁）：幂等或重试复用
    await tx.execute(sql`select id from credit_holds where workspace_id = ${input.workspaceId} and job_id = ${input.jobId} for update`);
    const holdRows = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.workspaceId, input.workspaceId), eq(creditHolds.jobId, input.jobId)))
      .limit(1);
    const existingHold = holdRows[0];

    // 单任务上限（REQ-68-01 per-job max cost）
    if (budget !== undefined && budget.perJobMaxCredits > 0 && input.estimatedCredits > budget.perJobMaxCredits) {
      throw new ApiFailure(ERROR_CODES.BUDGET_EXCEEDED, '单任务成本超过 per-job 上限', 402, {
        reason: BUDGET_REJECTION_REASONS.PER_JOB_LIMIT,
        requestedCredits: input.estimatedCredits,
        perJobMaxCredits: budget.perJobMaxCredits,
      });
    }

    if (existingHold !== undefined && existingHold.status === 'HELD' && existingHold.reservedCredits === input.estimatedCredits) {
      return toHoldDto(existingHold); // 幂等：不重复占额、不写账本
    }
    const delta =
      existingHold !== undefined && existingHold.status === 'HELD'
        ? input.estimatedCredits - existingHold.reservedCredits
        : input.estimatedCredits;

    // 原子预算判定（行锁下读-判-写）
    const counter = await lockCounter(tx, input.workspaceId, key);
    if (budget !== undefined && budget.limitCredits > 0) {
      const after = counter.spentCredits + counter.reservedCredits + delta;
      if (after > budget.limitCredits) {
        throw new ApiFailure(ERROR_CODES.BUDGET_EXCEEDED, '工作区预算不足（并发抢预算不超额）', 402, {
          reason: BUDGET_REJECTION_REASONS.BUDGET_EXCEEDED,
          periodKey: key,
          limitCredits: budget.limitCredits,
          spentCredits: counter.spentCredits,
          reservedCredits: counter.reservedCredits,
          requestedDelta: delta,
        });
      }
    }
    await tx
      .update(budgetCounters)
      .set({ reservedCredits: counter.reservedCredits + delta, updatedAt: now })
      .where(eq(budgetCounters.id, counter.id));

    if (existingHold !== undefined) {
      const updated = await tx
        .update(creditHolds)
        .set({
          reservedCredits: input.estimatedCredits,
          status: 'HELD',
          periodKeys: [key],
          settledCredits: null,
          settledAt: null,
          releasedAt: null,
          releaseReason: null,
        })
        .where(eq(creditHolds.id, existingHold.id))
        .returning();
      const row = updated[0];
      if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'hold update failed', 500);
      await writeLedger(tx, {
        workspaceId: input.workspaceId,
        entryType: 'HOLD',
        amount: input.estimatedCredits,
        referenceType: input.referenceType ?? 'credit_hold',
        referenceId: row.id,
        metadata: { jobId: input.jobId, periodKey: key, reReserved: true, delta },
      });
      return toHoldDto(row);
    }

    const inserted = await tx
      .insert(creditHolds)
      .values({
        id: `hld_${randomUUID()}`,
        workspaceId: input.workspaceId,
        jobId: input.jobId,
        reservedCredits: input.estimatedCredits,
        periodKeys: [key],
        status: 'HELD',
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'hold insert failed', 500);
    await writeLedger(tx, {
      workspaceId: input.workspaceId,
      entryType: 'HOLD',
      amount: input.estimatedCredits,
      referenceType: input.referenceType ?? 'credit_hold',
      referenceId: row.id,
      metadata: { jobId: input.jobId, periodKey: key },
    });
    return toHoldDto(row);
  });
}

/**
 * 结算（**幂等**：回调重放只结算一次）：释放预留额、计入实际消耗、写 HOLD_RELEASE + DEBIT 条目。
 * 已结算 → 返回原结果且**不产生新账本条目**；已释放 → 409（语义冲突，需人工处理）。
 */
export async function settleHold(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; actualCredits: number; now?: Date; referenceType?: string },
): Promise<{ hold: CreditHold; ledgerEntriesWritten: number }> {
  if (!Number.isInteger(input.actualCredits) || input.actualCredits < 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'actualCredits 必须为非负整数', 400);
  }
  const now = input.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from credit_holds where workspace_id = ${input.workspaceId} and job_id = ${input.jobId} for update`);
    const rows = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.workspaceId, input.workspaceId), eq(creditHolds.jobId, input.jobId)))
      .limit(1);
    const hold = rows[0];
    if (hold === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'hold not found', 404);
    if (hold.status === 'SETTLED') {
      return { hold: toHoldDto(hold), ledgerEntriesWritten: 0 }; // 重放：幂等返回
    }
    if (hold.status === 'RELEASED') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '预留已释放，不能结算（需人工处理）', 409, { status: hold.status });
    }

    const keys = Array.isArray(hold.periodKeys) ? (hold.periodKeys as string[]) : [];
    for (const key of keys.length > 0 ? keys : [periodKey('MONTHLY', now)]) {
      const counter = await lockCounter(tx, input.workspaceId, key);
      await tx
        .update(budgetCounters)
        .set({
          reservedCredits: Math.max(0, counter.reservedCredits - hold.reservedCredits),
          spentCredits: counter.spentCredits + input.actualCredits,
          updatedAt: now,
        })
        .where(eq(budgetCounters.id, counter.id));
    }

    await writeLedger(tx, {
      workspaceId: input.workspaceId,
      entryType: 'HOLD_RELEASE',
      amount: hold.reservedCredits,
      referenceType: input.referenceType ?? 'credit_hold',
      referenceId: hold.id,
      metadata: { jobId: input.jobId, reason: 'SETTLED' },
    });
    if (input.actualCredits > 0) {
      await writeLedger(tx, {
        workspaceId: input.workspaceId,
        entryType: 'DEBIT',
        amount: input.actualCredits,
        referenceType: input.referenceType ?? 'credit_hold',
        referenceId: hold.id,
        metadata: { jobId: input.jobId },
      });
    }
    const updated = await tx
      .update(creditHolds)
      .set({ status: 'SETTLED', settledCredits: input.actualCredits, settledAt: now })
      .where(eq(creditHolds.id, hold.id))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'hold settle failed', 500);
    return { hold: toHoldDto(row), ledgerEntriesWritten: input.actualCredits > 0 ? 2 : 1 };
  });
}

/** 释放（任务失败/取消且无消耗）：归还预留额；幂等（已释放 → 原结果）。 */
export async function releaseHold(
  deps: DomainDeps,
  input: { workspaceId: string; jobId: string; reason: string; now?: Date },
): Promise<{ hold: CreditHold; ledgerEntriesWritten: number }> {
  const now = input.now ?? new Date();
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from credit_holds where workspace_id = ${input.workspaceId} and job_id = ${input.jobId} for update`);
    const rows = await tx
      .select()
      .from(creditHolds)
      .where(and(eq(creditHolds.workspaceId, input.workspaceId), eq(creditHolds.jobId, input.jobId)))
      .limit(1);
    const hold = rows[0];
    if (hold === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'hold not found', 404);
    if (hold.status !== 'HELD') {
      return { hold: toHoldDto(hold), ledgerEntriesWritten: 0 }; // 已结算/已释放：幂等返回
    }
    const keys = Array.isArray(hold.periodKeys) ? (hold.periodKeys as string[]) : [];
    for (const key of keys.length > 0 ? keys : [periodKey('MONTHLY', now)]) {
      const counter = await lockCounter(tx, input.workspaceId, key);
      await tx
        .update(budgetCounters)
        .set({ reservedCredits: Math.max(0, counter.reservedCredits - hold.reservedCredits), updatedAt: now })
        .where(eq(budgetCounters.id, counter.id));
    }
    await writeLedger(tx, {
      workspaceId: input.workspaceId,
      entryType: 'HOLD_RELEASE',
      amount: hold.reservedCredits,
      referenceType: 'credit_hold',
      referenceId: hold.id,
      metadata: { jobId: input.jobId, reason: input.reason },
    });
    const updated = await tx
      .update(creditHolds)
      .set({ status: 'RELEASED', releasedAt: now, releaseReason: input.reason.slice(0, 200) })
      .where(eq(creditHolds.id, hold.id))
      .returning();
    const row = updated[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'hold release failed', 500);
    return { hold: toHoldDto(row), ledgerEntriesWritten: 1 };
  });
}

/** 计费状态视图。 */
export async function getBillingStatus(
  deps: DomainDeps,
  input: { workspaceId: string; now?: Date },
): Promise<BillingStatus> {
  const now = input.now ?? new Date();
  const budget = await getBudget(deps, { workspaceId: input.workspaceId });
  const key = periodKey(budget?.period ?? 'MONTHLY', now);
  const counters = await deps.db
    .select()
    .from(budgetCounters)
    .where(eq(budgetCounters.workspaceId, input.workspaceId))
    .orderBy(desc(budgetCounters.periodKey))
    .limit(6);
  const current = counters.find((row) => row.periodKey === key);
  return billingStatusSchema.parse({
    workspaceId: input.workspaceId,
    balanceCredits: await getBalanceCredits(deps, { workspaceId: input.workspaceId }),
    budget,
    usage: {
      periodKey: key,
      spentCredits: current?.spentCredits ?? 0,
      reservedCredits: current?.reservedCredits ?? 0,
    },
    recentPeriods: counters.map((row) => ({ periodKey: row.periodKey, spentCredits: row.spentCredits, reservedCredits: row.reservedCredits })),
  });
}

/** ---------- Provider 用量记录（REQ-25-01；回调重放不重复记账） ---------- */

export async function recordProviderGeneration(
  deps: DomainDeps,
  input: { workspaceId: string; input: RecordGenerationRequest },
): Promise<ProviderGeneration> {
  const inserted = await deps.db
    .insert(providerGenerations)
    .values({
      id: `pgn_${randomUUID()}`,
      workspaceId: input.workspaceId,
      jobId: input.input.jobId,
      providerId: input.input.providerId,
      modelId: input.input.modelId,
      operation: input.input.operation,
      credentialMode: input.input.credentialMode,
      inputHash: input.input.inputHash,
      attempt: input.input.attempt,
      providerJobId: input.input.providerJobId,
      estimatedCost: input.input.estimatedCost,
      estimatedCredits: input.input.estimatedCredits,
      status: 'RECORDED',
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0] !== undefined) return toGenerationDto(inserted[0]);
  // 冲突 = 重放：返回既有记录（不重复记账）
  const existing = await deps.db
    .select()
    .from(providerGenerations)
    .where(
      and(
        eq(providerGenerations.workspaceId, input.workspaceId),
        input.input.jobId === null ? sql`${providerGenerations.jobId} is null` : eq(providerGenerations.jobId, input.input.jobId),
        eq(providerGenerations.attempt, input.input.attempt),
        eq(providerGenerations.providerId, input.input.providerId),
        eq(providerGenerations.operation, input.input.operation),
      ),
    )
    .limit(1);
  const row = existing[0];
  if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'generation record conflict without existing row', 500);
  return toGenerationDto(row);
}

/** 完成/失败 Provider 调用：写入实际成本与 Credits（BYOK 按策略计费；**不硬编码**）。 */
export async function completeProviderGeneration(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    generationId: string;
    status: Extract<ProviderGenerationStatus, 'SUCCEEDED' | 'FAILED' | 'NEEDS_RECONCILIATION'>;
    actualCost?: Record<string, unknown> | null;
    meteredCredits?: number;
    latencyMs?: number;
    providerJobId?: string | null;
    error?: Record<string, unknown> | null;
    now?: Date;
  },
): Promise<ProviderGeneration> {
  const now = input.now ?? new Date();
  const rows = await deps.db
    .select()
    .from(providerGenerations)
    .where(and(eq(providerGenerations.id, input.generationId), eq(providerGenerations.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'generation not found', 404);

  // 策略（§35.2：BYOK 计费不得硬编码在 generation service）
  const metered = input.meteredCredits ?? 0;
  const billable =
    row.credentialMode === 'BYOK'
      ? (deps.billingPolicy?.creditsForByok?.(metered) ?? 0)
      : metered;

  // 幂等：已终态 → 原结果（重放不覆盖、不重复计费）
  if (row.status === 'SUCCEEDED' || row.status === 'FAILED') {
    return toGenerationDto(row);
  }

  const updated = await deps.db
    .update(providerGenerations)
    .set({
      status: input.status,
      ...(input.actualCost !== undefined ? { actualCost: input.actualCost } : {}),
      actualCredits: billable,
      ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
      ...(input.providerJobId !== undefined ? { providerJobId: input.providerJobId } : {}),
      ...(input.error !== undefined ? { error: input.error } : {}),
      updatedAt: now,
    })
    .where(and(eq(providerGenerations.id, input.generationId), eq(providerGenerations.workspaceId, input.workspaceId)))
    .returning();
  const next = updated[0];
  if (!next) throw new ApiFailure(ERROR_CODES.INTERNAL, 'generation update failed', 500);
  return toGenerationDto(next);
}

export async function listProviderGenerations(
  deps: DomainDeps,
  input: { workspaceId: string; jobId?: string; limit?: number },
): Promise<ProviderGeneration[]> {
  const conditions = [eq(providerGenerations.workspaceId, input.workspaceId)];
  if (input.jobId !== undefined) conditions.push(eq(providerGenerations.jobId, input.jobId));
  const rows = await deps.db
    .select()
    .from(providerGenerations)
    .where(and(...conditions))
    .orderBy(asc(providerGenerations.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  return rows.map(toGenerationDto);
}

export { DAY_MS };
