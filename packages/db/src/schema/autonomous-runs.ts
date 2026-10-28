import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { agentSessions, agentTurns } from './agent.js';
import { user } from './auth.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 自主制作运行（裁决 0020，AP-05）：一次交代 → 等素材 → 导演（计划 + 粗剪 + 自检）→ 按档位采用 → 交付报告。
 * 同一工程同一时刻只有一个进行中的运行（部分唯一索引）；运行开始时记下签署的授权版本与总预算。
 */
export const autonomousRuns = pgTable(
  'autonomous_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    turnId: text('turn_id').references(() => agentTurns.id, { onDelete: 'set null' }),
    workflowRunId: text('workflow_run_id'),
    status: text('status').notNull().default('WAITING_FOR_FOOTAGE'),
    goal: text('goal').notNull(),
    targetDurationSeconds: integer('target_duration_seconds'),
    strategyPackId: text('strategy_pack_id'),
    strategyKnobs: jsonb('strategy_knobs').notNull().default({}),
    approval: text('approval').notNull(),
    policyVersion: integer('policy_version').notNull(),
    budgetMicros: bigint('budget_micros', { mode: 'number' }).notNull(),
    modelCapMicros: bigint('model_cap_micros', { mode: 'number' }),
    locale: text('locale').notNull().default('zh-CN'),
    proposalId: text('proposal_id'),
    adoptedRevision: integer('adopted_revision'),
    report: jsonb('report'),
    error: jsonb('error'),
    idempotencyKey: text('idempotency_key'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    index('autonomous_runs_project_idx').on(table.projectId, table.createdAt),
    uniqueIndex('autonomous_runs_active_uq').on(table.projectId).where(sql`${table.status} in ('WAITING_FOR_FOOTAGE','DIRECTING','CHECKING')`),
    uniqueIndex('autonomous_runs_idempotency_uq').on(table.projectId, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    check('autonomous_runs_status_ck', sql`${table.status} in ('WAITING_FOR_FOOTAGE','DIRECTING','CHECKING','DELIVERED','NEEDS_REVIEW','FAILED','CANCELLED')`),
    check('autonomous_runs_approval_ck', sql`${table.approval} in ('ASK_EACH','AUTO_SAFE','FULL')`),
    check('autonomous_runs_budget_ck', sql`${table.budgetMicros} >= 0`),
  ],
);
