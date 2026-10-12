import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projectSequences } from './composition.js';
import { projects } from './projects.js';
import { proposals } from './proposals.js';
import { workflowRuns } from './workflow.js';
import { workspaces } from './workspaces.js';

/**
 * V6 §6/§8：通用导演 Agent 的会话、轮次与消息日志。
 *
 * - 一次轮次（turn）= 用户的一句话 + AI 的一次完整处理，经工作流 `AGENT_TURN` 执行；
 *   同一会话同一时刻只允许一个进行中的轮次（部分唯一索引）。
 * - `agent_turn_messages` 是模型对话的**追加式日志**（每次模型调用与工具结果各一行，含用量与成本）：
 *   轮次步骤崩溃重试时从日志续跑，不重复为已完成的模型调用付费，也不改写历史（思考块原样回放）。
 * - 本轮的时间线改动先累积在 `draft_operations`（只做内存试改，不落工程），结束时成为一个提案，由用户采用或撤回。
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
    locale: text('locale').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_sessions_project_idx').on(table.projectId, table.createdAt),
    check('agent_sessions_locale_ck', sql`${table.locale} in ('zh-CN','en')`),
  ],
);

export const agentTurns = pgTable(
  'agent_turns',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull().references(() => agentSessions.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    workflowRunId: text('workflow_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('RUNNING'),
    message: text('message').notNull(),
    pointer: jsonb('pointer').notNull(),
    strategyPackId: text('strategy_pack_id'),
    baseRevision: integer('base_revision').notNull(),
    draftOperations: jsonb('draft_operations').notNull().default([]),
    reply: text('reply'),
    proposalId: text('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    toolCalls: jsonb('tool_calls').notNull().default([]),
    usage: jsonb('usage').notNull(),
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull().default(0),
    unpricedCalls: integer('unpriced_calls').notNull().default(0),
    error: jsonb('error'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_turns_one_running_uq').on(table.sessionId).where(sql`${table.status} = 'RUNNING'`),
    index('agent_turns_session_idx').on(table.sessionId, table.createdAt),
    check('agent_turns_status_ck', sql`${table.status} in ('RUNNING','COMPLETED','FAILED','CANCELLED')`),
    check('agent_turns_cost_ck', sql`${table.costMicros} >= 0 and ${table.unpricedCalls} >= 0`),
  ],
);

export const agentTurnMessages = pgTable(
  'agent_turn_messages',
  {
    id: text('id').primaryKey(),
    turnId: text('turn_id').notNull().references(() => agentTurns.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    seq: integer('seq').notNull(),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    model: text('model'),
    usage: jsonb('usage'),
    costMicros: bigint('cost_micros', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('agent_turn_messages_seq_uq').on(table.turnId, table.seq),
    check('agent_turn_messages_role_ck', sql`${table.role} in ('user','assistant')`),
    check('agent_turn_messages_seq_ck', sql`${table.seq} >= 0`),
  ],
);
