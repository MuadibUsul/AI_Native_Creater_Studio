import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';

/**
 * 租户模型（P01-03 / 规范 §22.1、计划 §4.3 不变量 1）：
 * 所有业务资源 MUST 归属 Workspace；workspace_members 是授权判定的权威数据。
 */

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workspaceMembers = pgTable(
  'workspace_members',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** OWNER / ADMIN / EDITOR / REVIEWER / VIEWER（契约层枚举校验） */
    role: text('role').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_members_workspace_user_uq').on(table.workspaceId, table.userId),
    index('workspace_members_user_idx').on(table.userId),
  ],
);
