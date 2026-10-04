import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * 账本、预算与 Provider 用量（P03-05 / 规范 §35.1、§68；REQ-25-01、REQ-68-01）。
 *
 * - `credit_ledger`：**只追加**（无 UPDATE/DELETE 路径）；余额是推论而非可变字段；
 * - `credit_holds`：预算预留（Credits Hold）；`job_id` 唯一 → 一个任务至多一个活跃预留，
 *   结算/释放的幂等以此为键；
 * - `workspace_budgets` + `budget_counters`：周期预算与**原子计数器**（并发预留靠行锁判定
 *   `spent + reserved + amount ≤ limit`，AC-11）；
 * - `provider_generations`：每次 Provider 调用的可追踪记录（§25；含凭证模式、输入指纹、
 *   估算/实际成本、延迟、重试、错误、时间戳）；UNIQUE(job_id, attempt, provider_id, operation)
 *   保证回调重放不重复记账。
 */

export const creditLedger = pgTable(
  'credit_ledger',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** CREDIT | DEBIT | REFUND | ADJUSTMENT | HOLD | HOLD_RELEASE */
    entryType: text('entry_type').notNull(),
    /** 整数 Credits（非负；符号由 entryType 决定） */
    amount: integer('amount').notNull(),
    referenceType: text('reference_type').notNull(),
    referenceId: text('reference_id'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('credit_ledger_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('credit_ledger_reference_idx').on(table.referenceType, table.referenceId),
  ],
);

export const creditHolds = pgTable(
  'credit_holds',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 一个任务至多一个活跃预留（结算幂等的天然键） */
    jobId: text('job_id').notNull(),
    reservedCredits: integer('reserved_credits').notNull(),
    /** 预留涉及的周期键快照（结算可能跨周期：必须按**预留时**的周期归还/计入） */
    periodKeys: jsonb('period_keys').notNull().default([]),
    settledCredits: integer('settled_credits'),
    /** HELD | SETTLED | RELEASED */
    status: text('status').notNull().default('HELD'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    releasedAt: timestamp('released_at', { withTimezone: true }),
    releaseReason: text('release_reason'),
  },
  (table) => [
    uniqueIndex('credit_holds_workspace_job_uq').on(table.workspaceId, table.jobId),
    index('credit_holds_status_idx').on(table.workspaceId, table.status),
  ],
);

export const workspaceBudgets = pgTable(
  'workspace_budgets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** DAILY | MONTHLY */
    period: text('period').notNull().default('MONTHLY'),
    /** 周期上限（0 = 不限制） */
    limitCredits: integer('limit_credits').notNull().default(0),
    /** 单任务上限（0 = 不限制；REQ-68-01 per-job max cost） */
    perJobMaxCredits: integer('per_job_max_credits').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('workspace_budgets_workspace_uq').on(table.workspaceId)],
);

export const budgetCounters = pgTable(
  'budget_counters',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** '2026-10-04'（DAILY）或 '2026-10'（MONTHLY） */
    periodKey: text('period_key').notNull(),
    spentCredits: integer('spent_credits').notNull().default(0),
    reservedCredits: integer('reserved_credits').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('budget_counters_workspace_period_uq').on(table.workspaceId, table.periodKey)],
);

export const providerGenerations = pgTable(
  'provider_generations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: text('job_id'),
    providerId: text('provider_id').notNull(),
    modelId: text('model_id').notNull(),
    operation: text('operation').notNull(),
    credentialMode: text('credential_mode').notNull(),
    inputHash: text('input_hash').notNull(),
    status: text('status').notNull().default('RECORDED'),
    providerJobId: text('provider_job_id'),
    attempt: integer('attempt').notNull().default(0),
    latencyMs: integer('latency_ms'),
    estimatedCost: jsonb('estimated_cost'),
    actualCost: jsonb('actual_cost'),
    estimatedCredits: integer('estimated_credits'),
    actualCredits: integer('actual_credits'),
    error: jsonb('error'),
    /** P06-07 Native Fallback：外部处理完成后回绑的结果资产（新 AssetVersion；不原地覆盖） */
    resultAssetId: text('result_asset_id'),
    resultAssetVersionId: text('result_asset_version_id'),
    /** 回绑来源（EXTERNAL_UPLOAD = 用户在平台外处理后上传） */
    rebindSource: text('rebind_source'),
    reboundAt: timestamp('rebound_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    /** 回调重放不重复记账：同一 (job, attempt, provider, operation) 唯一 */
    uniqueIndex('provider_generations_key_uq').on(table.workspaceId, table.jobId, table.attempt, table.providerId, table.operation),
    index('provider_generations_workspace_created_idx').on(table.workspaceId, table.createdAt),
    index('provider_generations_provider_job_idx').on(table.providerId, table.providerJobId),
  ],
);
