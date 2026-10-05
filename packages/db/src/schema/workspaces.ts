import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { user } from './auth.js';

/**
 * 租户模型（P01-03 / 规范 §22.1、计划 §4.3 不变量 1）：
 * 所有业务资源 MUST 归属 Workspace；workspace_members 是授权判定的权威数据。
 * P09-04 增补：隐私档位（§20.4）与 Workspace 邀请。
 */

export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  /** STANDARD / PRIVATE / ENTERPRISE（P09-04 / §20.4；契约层枚举校验） */
  privacyTier: text('privacy_tier').notNull().default('STANDARD'),
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

/**
 * Workspace 邀请（P09-04）：邮箱 + 角色的待决记录。
 * 同 Workspace 同邮箱**至多一条 PENDING**（部分唯一索引；已接受/已撤销保留历史、不占用）。
 */
export const workspaceInvitations = pgTable(
  'workspace_invitations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** 归一化（lowercase）存储；接受时与登录邮箱比对 */
    email: text('email').notNull(),
    role: text('role').notNull(),
    /** PENDING / ACCEPTED / REVOKED（EXPIRED 为读取时推导） */
    status: text('status').notNull().default('PENDING'),
    invitedByUserId: text('invited_by_user_id'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    acceptedByUserId: text('accepted_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workspace_invitations_pending_uq')
      .on(table.workspaceId, table.email)
      .where(sql`${table.status} = 'PENDING'`),
    index('workspace_invitations_email_idx').on(table.email),
    index('workspace_invitations_workspace_idx').on(table.workspaceId),
  ],
);
