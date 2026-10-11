import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { jobs } from './jobs.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 工作流引擎（V5 §11.1，M4）：一次长流程 = 一行 `workflow_runs`，每个步骤的每次尝试 = 一行 `workflow_steps`。
 *
 * - 执行载体是任务表（`WORKFLOW_ADVANCE`）；`active_job_id` 是该运行**唯一有效**的推进任务（推进前比较，旧任务自动退出）；
 * - `context` 按步骤键累积已提交的步骤输出（冻结后的计划、产物引用等），步骤输入只从这里与 `input` 读取；
 * - 幂等：同一工作区 + 类型 + 幂等键只会有一个运行（部分唯一索引）。
 */
export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    version: integer('version').notNull(),
    subjectRef: text('subject_ref').notNull(),
    status: text('status').notNull().default('RUNNING'),
    input: jsonb('input').notNull(),
    context: jsonb('context').notNull().default({}),
    currentStep: text('current_step'),
    activeJobId: text('active_job_id'),
    idempotencyKey: text('idempotency_key'),
    error: jsonb('error'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('workflow_runs_idempotency_uq').on(table.workspaceId, table.type, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    index('workflow_runs_workspace_status_idx').on(table.workspaceId, table.status),
    index('workflow_runs_project_idx').on(table.projectId, table.createdAt),
    check('workflow_runs_status_ck', sql`${table.status} in ('RUNNING','WAITING_HUMAN','SUCCEEDED','FAILED','CANCEL_REQUESTED','CANCELLED')`),
    check('workflow_runs_version_ck', sql`${table.version} >= 1`),
  ],
);

export const workflowSteps = pgTable(
  'workflow_steps',
  {
    id: text('id').primaryKey(),
    runId: text('run_id').notNull().references(() => workflowRuns.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    stepKey: text('step_key').notNull(),
    attempt: integer('attempt').notNull(),
    status: text('status').notNull(),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    result: jsonb('result'),
    errorClass: text('error_class'),
    error: jsonb('error'),
    compensationStatus: text('compensation_status'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('workflow_steps_attempt_uq').on(table.runId, table.stepKey, table.attempt),
    index('workflow_steps_run_idx').on(table.runId, table.startedAt),
    check('workflow_steps_status_ck', sql`${table.status} in ('RUNNING','SUCCEEDED','FAILED','WAITING_HUMAN')`),
    check('workflow_steps_error_class_ck', sql`${table.errorClass} is null or ${table.errorClass} in ('RETRYABLE','NON_RETRYABLE','NEEDS_HUMAN','LEASE_LOST','CANCELLED')`),
    check('workflow_steps_compensation_ck', sql`${table.compensationStatus} is null or ${table.compensationStatus} in ('COMPENSATED','COMPENSATION_FAILED')`),
    check('workflow_steps_attempt_ck', sql`${table.attempt} >= 1`),
  ],
);
