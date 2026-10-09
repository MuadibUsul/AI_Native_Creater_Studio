import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
}, (table) => [
  uniqueIndex('admin_principals_user_environment_unique').on(table.userId, table.environment),
  check('admin_principals_environment_check', sql`${table.environment} in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')`),
]);

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
  check('admin_role_grants_role_check', sql`${table.role} in ('PLATFORM_OWNER', 'SUPPORT_L1', 'SUPPORT_L2', 'PRODUCTION_OPERATOR', 'PROVIDER_MANAGER', 'BILLING_OPERATOR', 'BILLING_APPROVER', 'CONTENT_REVIEWER', 'REVIEW_LEAD', 'AI_QUALITY', 'STRATEGY_CURATOR', 'GROWTH_ANALYST', 'PRIVACY_OFFICER', 'SECURITY_ADMIN', 'AUDITOR', 'SERVICE_ACCOUNT')`),
]);

/** One role may have several independent, revocable scopes. Existing role grants have none and authorize no action. */
export const adminRoleScopes = pgTable('admin_role_scopes', {
  id: text('id').primaryKey(),
  roleGrantId: text('role_grant_id').notNull().references(() => adminRoleGrants.id, { onDelete: 'cascade' }),
  scopeKind: text('scope_kind').notNull(),
  workspaceId: text('workspace_id'),
  resourceKind: text('resource_kind'),
  resourceId: text('resource_id'),
  ticketId: text('ticket_id'),
  maxCredits: integer('max_credits'),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  grantedByPrincipalId: text('granted_by_principal_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('admin_role_scopes_grant_idx').on(table.roleGrantId, table.revokedAt),
  index('admin_role_scopes_workspace_idx').on(table.workspaceId, table.revokedAt),
  check('admin_role_scopes_kind_check', sql`${table.scopeKind} in ('PLATFORM', 'WORKSPACE', 'OBJECT')`),
  check('admin_role_scopes_resource_kind_check', sql`${table.resourceKind} is null or ${table.resourceKind} in ('USER', 'WORKSPACE', 'PROJECT', 'JOB', 'ABUSE_FLAG', 'SUPPORT_GRANT', 'LEDGER_ENTRY', 'PLAN')`),
  check('admin_role_scopes_shape_check', sql`(
    (${table.scopeKind} = 'PLATFORM' and ${table.workspaceId} is null and ${table.resourceKind} is null and ${table.resourceId} is null)
    or (${table.scopeKind} = 'WORKSPACE' and ${table.workspaceId} is not null and ${table.resourceKind} is null and ${table.resourceId} is null)
    or (${table.scopeKind} = 'OBJECT' and ${table.workspaceId} is not null and ${table.resourceKind} is not null and ${table.resourceId} is not null)
  )`),
  check('admin_role_scopes_amount_check', sql`${table.maxCredits} is null or ${table.maxCredits} >= 0`),
  check('admin_role_scopes_time_check', sql`${table.expiresAt} is null or ${table.expiresAt} > ${table.startsAt}`),
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
  check('admin_sessions_environment_check', sql`${table.environment} in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')`),
]);
