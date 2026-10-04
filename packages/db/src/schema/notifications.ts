import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { workspaces } from './workspaces.js';

/**
 * 通知存储（P02-06 / 规范 §34；"通知在后端持久化，前端只是视图"）。
 *
 * - 每条通知属于一个收件用户（user_id）并可关联 workspace（越权读取一律 404 抗枚举）；
 * - 由 Outbox 事件经通知规则生成（domain/events.ts：runNotificationDispatch），
 *   同一 (user, workspace, type, resourceId) 的未读通知**合并更新**（避免刷屏）；
 * - read_at 为空 = 未读；unread-count 供前端徽标。
 */

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 收件用户 */
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** 关联资源与合并键（如 projectId / jobId） */
    resourceId: text('resource_id'),
    payload: jsonb('payload').notNull().default({}),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId, table.readAt, table.createdAt),
    index('notifications_workspace_idx').on(table.workspaceId, table.createdAt),
    index('notifications_merge_idx').on(table.userId, table.type, table.resourceId, table.readAt),
  ],
);
