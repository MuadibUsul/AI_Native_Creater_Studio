import { sql } from 'drizzle-orm';
import { boolean, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { session, user } from './auth.js';

export const adminPrincipals = pgTable('admin_principals', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  environment: text('environment').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  grantVersion: integer('grant_version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  disabledAt: timestamp('disabled_at', { withTimezone: true }),
}, (table) => [uniqueIndex('admin_principals_user_environment_unique').on(table.userId, table.environment)]);

export const adminRoleGrants = pgTable('admin_role_grants', {
  id: text('id').primaryKey(),
  principalId: text('principal_id').notNull().references(() => adminPrincipals.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
  grantedByPrincipalId: text('granted_by_principal_id'),
  grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('admin_role_grants_active_unique').on(table.principalId, table.role).where(sql`${table.revokedAt} is null`),
  index('admin_role_grants_principal_idx').on(table.principalId),
]);

/** 独立运营受众：Cookie 只含随机值；数据库仅保留 SHA-256，且绑定普通 Web 会话。 */
export const adminSessions = pgTable('admin_sessions', {
  id: text('id').primaryKey(),
  principalId: text('principal_id').notNull().references(() => adminPrincipals.id, { onDelete: 'cascade' }),
  authSessionId: text('auth_session_id').notNull().references(() => session.id, { onDelete: 'cascade' }),
  tokenHash: text('token_hash').notNull(),
  environment: text('environment').notNull(),
  grantVersion: integer('grant_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  absoluteExpiresAt: timestamp('absolute_expires_at', { withTimezone: true }).notNull(),
  reauthenticatedAt: timestamp('reauthenticated_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  userAgentHash: text('user_agent_hash'),
  ipHash: text('ip_hash'),
  reauthFailures: integer('reauth_failures').notNull().default(0),
  reauthLockedUntil: timestamp('reauth_locked_until', { withTimezone: true }),
}, (table) => [
  uniqueIndex('admin_sessions_auth_session_unique').on(table.authSessionId),
  uniqueIndex('admin_sessions_token_hash_unique').on(table.tokenHash),
  index('admin_sessions_principal_idx').on(table.principalId, table.createdAt),
]);
