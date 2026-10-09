import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetVersions } from './assets.js';
import { workspaces } from './workspaces.js';

export const mediaEvidenceCaches = pgTable(
  'media_evidence_caches',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
    cacheKey: text('cache_key').notNull(),
    consumer: text('consumer').notNull(),
    sourceStartPts: text('source_start_pts'),
    sourceEndPts: text('source_end_pts'),
    timeBaseNumerator: integer('time_base_numerator'),
    timeBaseDenominator: integer('time_base_denominator'),
    requestedKind: text('requested_kind'),
    analysisConfigHash: text('analysis_config_hash').notNull(),
    indexFingerprint: text('index_fingerprint').notNull(),
    permissionContextHash: text('permission_context_hash').notNull(),
    payload: jsonb('payload').notNull(),
    hitCount: integer('hit_count').notNull().default(0),
    analysisReadCount: integer('analysis_read_count').notNull().default(1),
    rangeReadCount: integer('range_read_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_evidence_caches_key_uq').on(table.cacheKey),
    index('media_evidence_caches_workspace_source_idx').on(table.workspaceId, table.sourceAssetVersionId),
    check('media_evidence_caches_consumer_ck', sql`${table.consumer} in ('DIRECTOR','SELECTION','REFERENCE_ANALYSIS')`),
    check('media_evidence_caches_key_ck', sql`${table.cacheKey} ~ '^[0-9a-f]{64}$'`),
    check('media_evidence_caches_config_ck', sql`${table.analysisConfigHash} ~ '^[0-9a-f]{64}$'`),
    check('media_evidence_caches_fingerprint_ck', sql`${table.indexFingerprint} ~ '^[0-9a-f]{64}$'`),
    check('media_evidence_caches_permission_ck', sql`${table.permissionContextHash} ~ '^[0-9a-f]{64}$'`),
    check('media_evidence_caches_usage_ck', sql`${table.hitCount} >= 0 and ${table.analysisReadCount} >= 0 and ${table.rangeReadCount} >= 0`),
    check('media_evidence_caches_range_ck', sql`(${table.sourceStartPts} is null and ${table.sourceEndPts} is null and ${table.timeBaseNumerator} is null and ${table.timeBaseDenominator} is null) or (${table.sourceStartPts} ~ '^-?[0-9]+$' and ${table.sourceEndPts} ~ '^-?[0-9]+$' and ${table.timeBaseNumerator} > 0 and ${table.timeBaseDenominator} > 0)`),
  ],
);
