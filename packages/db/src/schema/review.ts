import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projectSequences } from './composition.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * V6-4 批注式审片：一轮审片绑定所看的工程版本（`base_revision`）；批注 = 定位 + 一句话 + 确定的方案。
 * 讨论与执行都是普通的 AI 轮次（`agent_turns.purpose`），轮次状态由执行轮与它的提案派生。
 */
export const reviewRounds = pgTable(
  'review_rounds',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
    baseRevision: integer('base_revision').notNull(),
    /** 最近一次"全部执行"的 AI 轮次（不建外键：轮次表引用本表，避免环） */
    applyTurnId: text('apply_turn_id'),
    appliedNoteIds: jsonb('applied_note_ids').notNull().default([]),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('review_rounds_project_idx').on(table.projectId, table.createdAt),
    check('review_rounds_base_revision_ck', sql`${table.baseRevision} >= 0`),
  ],
);

export const reviewNotes = pgTable(
  'review_notes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    roundId: text('round_id').notNull().references(() => reviewRounds.id, { onDelete: 'cascade' }),
    pointer: jsonb('pointer').notNull(),
    region: jsonb('region'),
    text: text('text').notNull(),
    status: text('status').notNull().default('OPEN'),
    plan: text('plan'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('review_notes_round_idx').on(table.roundId, table.createdAt),
    check('review_notes_status_ck', sql`${table.status} in ('OPEN','AGREED','DISMISSED')`),
  ],
);
