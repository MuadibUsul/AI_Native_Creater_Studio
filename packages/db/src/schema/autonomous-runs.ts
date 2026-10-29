import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { agentSessions, agentTurns } from './agent.js';
import { user } from './auth.js';
import { projectSequences } from './composition.js';
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
    /** V6-10：SINGLE 一轮剪完；CHAPTERS 分章（在定计划时按可用素材总时长决定） */
    mode: text('mode').notNull().default('SINGLE'),
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
    uniqueIndex('autonomous_runs_active_uq').on(table.projectId).where(sql`${table.status} in ('WAITING_FOR_FOOTAGE','PLANNING','CUTTING_CHAPTERS','DIRECTING','CHECKING')`),
    uniqueIndex('autonomous_runs_idempotency_uq').on(table.projectId, table.idempotencyKey).where(sql`${table.idempotencyKey} is not null`),
    check('autonomous_runs_status_ck', sql`${table.status} in ('WAITING_FOR_FOOTAGE','PLANNING','CUTTING_CHAPTERS','DIRECTING','CHECKING','DELIVERED','NEEDS_REVIEW','FAILED','CANCELLED')`),
    check('autonomous_runs_mode_ck', sql`${table.mode} in ('SINGLE','CHAPTERS')`),
    check('autonomous_runs_approval_ck', sql`${table.approval} in ('ASK_EACH','AUTO_SAFE','FULL')`),
    check('autonomous_runs_budget_ck', sql`${table.budgetMicros} >= 0`),
  ],
);

/**
 * V6-10 分章（`docs/V06/milestones/V6-10.md`）：自主制作运行的一章。
 * 每章在主序列下的一个子序列上由同一个通用导演剪（子运行 AUTONOMOUS_CHAPTER）；草稿交给拼装，不单独建提案。
 * 预算是分到这一章的模型花费上限（美元微单位）；花费按这一章各轮实际记录的费用对账。
 */
export const autonomousChapters = pgTable(
  'autonomous_chapters',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => autonomousRuns.id, { onDelete: 'cascade' }),
    index: integer('index').notNull(),
    sceneId: text('scene_id').notNull(),
    title: text('title').notNull(),
    sequenceId: text('sequence_id').references(() => projectSequences.id, { onDelete: 'set null' }),
    sessionId: text('session_id').references(() => agentSessions.id, { onDelete: 'set null' }),
    turnId: text('turn_id').references(() => agentTurns.id, { onDelete: 'set null' }),
    workflowRunId: text('workflow_run_id'),
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    budgetMicros: bigint('budget_micros', { mode: 'number' }).notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    error: jsonb('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('autonomous_chapters_run_index_uq').on(table.runId, table.index),
    check('autonomous_chapters_status_ck', sql`${table.status} in ('PENDING','RUNNING','SUCCEEDED','FAILED','CANCELLED')`),
    check('autonomous_chapters_amounts_ck', sql`${table.attempts} >= 0 and ${table.budgetMicros} >= 0 and ${table.costMicros} >= 0`),
  ],
);
