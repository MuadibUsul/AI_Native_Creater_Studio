import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/** Policy rows are published explicitly; migration does not activate any environment. */
export const adminPermissionPolicyVersions = pgTable('admin_permission_policy_versions', {
  id: text('id').primaryKey(),
  environment: text('environment').notNull(),
  version: text('version').notNull(),
  rulesHash: text('rules_hash').notNull(),
  status: text('status').notNull().default('DRAFT'),
  createdByPrincipalId: text('created_by_principal_id'),
  publishedByPrincipalId: text('published_by_principal_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  publishedAt: timestamp('published_at', { withTimezone: true }),
  retiredAt: timestamp('retired_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('admin_policy_environment_version_unique').on(table.environment, table.version),
  uniqueIndex('admin_policy_one_active_per_environment').on(table.environment).where(sql`${table.status} = 'ACTIVE'`),
  check('admin_policy_environment_check', sql`${table.environment} in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')`),
  check('admin_policy_status_check', sql`${table.status} in ('DRAFT', 'ACTIVE', 'RETIRED')`),
  check('admin_policy_hash_check', sql`${table.rulesHash} ~ '^[0-9a-f]{64}$'`),
  check('admin_policy_version_check', sql`length(btrim(${table.version})) between 1 and 80`),
  check('admin_policy_lifecycle_check', sql`(
    (${table.status} = 'DRAFT' and ${table.publishedAt} is null and ${table.retiredAt} is null)
    or (${table.status} = 'ACTIVE' and ${table.publishedAt} is not null and ${table.retiredAt} is null and ${table.publishedByPrincipalId} is not null)
    or (${table.status} = 'RETIRED' and ${table.publishedAt} is not null and ${table.retiredAt} is not null and ${table.publishedByPrincipalId} is not null)
  )`),
]);

/** A narrowly scoped stop-loss grant. It never authorizes finance, content, or publishing actions. */
export const adminEmergencyGrants = pgTable('admin_emergency_grants', {
  id: text('id').primaryKey(),
  environment: text('environment').notNull(),
  principalId: text('principal_id').notNull(),
  action: text('action').notNull(),
  targetKind: text('target_kind').notNull(),
  targetId: text('target_id').notNull(),
  incidentId: text('incident_id').notNull(),
  reason: text('reason').notNull(),
  startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  alertedAt: timestamp('alerted_at', { withTimezone: true }),
  reviewDueAt: timestamp('review_due_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  reviewedByPrincipalId: text('reviewed_by_principal_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('admin_emergency_principal_target_idx').on(table.principalId, table.environment, table.action, table.targetId),
  index('admin_emergency_expires_idx').on(table.expiresAt),
  check('admin_emergency_environment_check', sql`${table.environment} in ('DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION')`),
  check('admin_emergency_action_target_check', sql`(
    (${table.action} = 'PAUSE_NEW_GENERATION' and ${table.targetKind} = 'WORKSPACE')
    or (${table.action} = 'REVOKE_COMPROMISED_OPS_SESSION' and ${table.targetKind} = 'OPS_SESSION')
  )`),
  check('admin_emergency_target_check', sql`length(btrim(${table.targetId})) > 0`),
  check('admin_emergency_incident_check', sql`length(btrim(${table.incidentId})) between 1 and 128`),
  check('admin_emergency_reason_check', sql`length(btrim(${table.reason})) between 10 and 500`),
  check('admin_emergency_time_check', sql`${table.expiresAt} > ${table.startsAt} and ${table.expiresAt} <= ${table.startsAt} + interval '30 minutes'`),
  check('admin_emergency_review_due_check', sql`${table.reviewDueAt} >= ${table.expiresAt} and ${table.reviewDueAt} <= ${table.expiresAt} + interval '24 hours'`),
  check('admin_emergency_review_check', sql`(${table.reviewedAt} is null and ${table.reviewedByPrincipalId} is null) or (${table.reviewedAt} is not null and ${table.reviewedByPrincipalId} is not null)`),
  check('admin_emergency_no_self_review_check', sql`${table.reviewedByPrincipalId} is null or ${table.reviewedByPrincipalId} <> ${table.principalId}`),
  // No trusted person/alias linkage exists yet; a second account cannot prove independent review.
  check('admin_emergency_review_requires_verified_identity_check', sql`${table.reviewedAt} is null and ${table.reviewedByPrincipalId} is null`),
]);
