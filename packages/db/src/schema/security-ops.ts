import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * SaaS 安全运营表（P09-05 / §43.3、§67、§24.2）：
 * - audit_log：**append-only 运营审计**（平台管理动作 + 系统安全事件；不含 Secret/私密内容）；
 * - abuse_flags：滥用/审核标记（调查载体）；
 * - support_access_grants：支持访问授权（时限化；访问留痕——"不可无痕"）。
 */

export const auditLog = pgTable(
  'audit_log',
  {
    id: text('id').primaryKey(),
    /** PLATFORM_ADMIN / SYSTEM */
    actorKind: text('actor_kind').notNull(),
    actorUserId: text('actor_user_id'),
    /** `<area>.<verb>`（如 job.retry / support.view / upload.malware_rejected） */
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    workspaceId: text('workspace_id'),
    details: jsonb('details').notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_occurred_idx').on(table.occurredAt),
    index('audit_log_workspace_idx').on(table.workspaceId, table.occurredAt),
    index('audit_log_action_idx').on(table.action, table.occurredAt),
  ],
);

export const abuseFlags = pgTable(
  'abuse_flags',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    /** SPAM / COPYRIGHT / HARASSMENT / FRAUD / POLICY / OTHER */
    category: text('category').notNull(),
    /** LOW / MEDIUM / HIGH */
    severity: text('severity').notNull(),
    /** OPEN / RESOLVED */
    status: text('status').notNull().default('OPEN'),
    note: text('note').notNull(),
    createdByUserId: text('created_by_user_id'),
    resolvedByUserId: text('resolved_by_user_id'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolutionNote: text('resolution_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('abuse_flags_workspace_idx').on(table.workspaceId, table.status), index('abuse_flags_status_idx').on(table.status, table.createdAt)],
);

export const supportAccessGrants = pgTable(
  'support_access_grants',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id').notNull(),
    purpose: text('purpose').notNull(),
    /** ACTIVE / REVOKED（EXPIRED 为读取推导态） */
    status: text('status').notNull().default('ACTIVE'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedByUserId: text('revoked_by_user_id'),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('support_grants_workspace_idx').on(table.workspaceId, table.status), index('support_grants_active_idx').on(table.status, table.expiresAt)],
);
