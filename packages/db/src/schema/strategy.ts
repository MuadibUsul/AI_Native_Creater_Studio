import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { workspaces } from './workspaces.js';

/** V6 §6.6：工作区自己的策略包（蒸馏 / 用户编辑）；内置预设在代码里。`pack` 是完整的 StrategyPack 数据。 */
export const strategyPacks = pgTable(
  'strategy_packs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    version: integer('version').notNull().default(1),
    genre: text('genre').notNull(),
    pack: jsonb('pack').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    index('strategy_packs_workspace_idx').on(table.workspaceId, table.createdAt),
    check('strategy_packs_kind_ck', sql`${table.kind} in ('DISTILLED','USER')`),
    check('strategy_packs_version_ck', sql`${table.version} > 0`),
  ],
);
