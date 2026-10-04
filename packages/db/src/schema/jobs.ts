import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 任务系统（P03-01 / 计划 §5.5；规范 §35 之前的 Jobs 约定）。
 *
 * 权威状态在 PostgreSQL（规范 §35 的强制规则：BullMQ 消息只携带任务 ID；
 * Worker 从数据库读取权威输入；事务 + Outbox 保证已接受任务不丢；Worker 崩溃由租约恢复）。
 *
 * 状态机（计划 §5.5）：
 *   WAITING_DEPENDENCY → QUEUED → RUNNING → PROVIDER_QUEUED → SUCCEEDED
 *                                      ↘ FAILED_RETRYABLE ↔（重试）→ QUEUED
 *                                      ↘ FAILED_FINAL
 *   QUEUED/RUNNING/PROVIDER_QUEUED → CANCEL_REQUESTED → CANCELLED
 *
 * 字段：执行阶段（stage）、提交状态（submit_state）、重试次数、租约（lease_*）、心跳（heartbeat_at）、
 * 是否需要对账（needs_reconciliation，供 P03-02/P03-06 的迟到结果与对账使用）。
 */

export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** 任务类型（如 NOOP / MAINTENANCE_RETENTION_SWEEP；Provider 生成类型随 P03-06/P06） */
    type: text('type').notNull(),
    status: text('status').notNull().default('QUEUED'),
    /** 执行阶段（人类可读；如 PREPARE / SUBMIT / POLL / DOWNLOAD / FINALIZE） */
    stage: text('stage'),
    /** NOT_SUBMITTED / SUBMITTED / SUBMISSION_UNKNOWN（付费提交的对账依据，§5.6） */
    submitState: text('submit_state').notNull().default('NOT_SUBMITTED'),
    /** 权威输入（Worker 从这里读取；消息体不携带） */
    input: jsonb('input').notNull().default({}),
    result: jsonb('result'),
    error: jsonb('error'),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    /** 并发/优先级（数值越大越先；同值按创建时间） */
    priority: integer('priority').notNull().default(0),
    /** 租约与心跳（Worker 崩溃恢复） */
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
    heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
    /** 需要对账（Provider 结果不确定；禁止自动重复付费提交） */
    needsReconciliation: boolean('needs_reconciliation').notNull().default(false),
    enqueuedAt: timestamp('enqueued_at', { withTimezone: true }),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('jobs_workspace_status_idx').on(table.workspaceId, table.status),
    index('jobs_project_idx').on(table.projectId, table.createdAt),
    /** 认领扫描与租约恢复 */
    index('jobs_claim_idx').on(table.status, table.priority, table.createdAt),
    index('jobs_lease_idx').on(table.status, table.leaseExpiresAt),
  ],
);

export const jobDependencies = pgTable(
  'job_dependencies',
  {
    id: text('id').primaryKey(),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    dependsOnJobId: text('depends_on_job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_dependencies_pair_uq').on(table.jobId, table.dependsOnJobId),
    index('job_dependencies_depends_on_idx').on(table.dependsOnJobId),
  ],
);
