import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetVersions } from './assets.js';
import { workspaces } from './workspaces.js';

export const mediaIndexRuns = pgTable(
  'media_index_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
    sourceChecksumSha256: text('source_checksum_sha256').notNull(),
    processorVersion: text('processor_version').notNull(),
    status: text('status').notNull().default('QUEUED'),
    coveragePermille: integer('coverage_permille').notNull().default(0),
    checkpointMs: integer('checkpoint_ms').notNull().default(0),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_index_runs_source_processor_uq').on(table.sourceAssetVersionId, table.processorVersion),
    index('media_index_runs_workspace_source_idx').on(table.workspaceId, table.sourceAssetVersionId),
    check('media_index_runs_status_ck', sql`${table.status} in ('QUEUED','RUNNING','PARTIAL','READY','EMPTY','FAILED','STALE')`),
    check('media_index_runs_coverage_ck', sql`${table.coveragePermille} between 0 and 1000`),
    check('media_index_runs_checkpoint_ck', sql`${table.checkpointMs} >= 0`),
    check('media_index_runs_checksum_ck', sql`${table.sourceChecksumSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const mediaIndexEntries = pgTable(
  'media_index_entries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => mediaIndexRuns.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    ordinal: integer('ordinal').notNull(),
    sourceStartPts: text('source_start_pts').notNull(),
    sourceEndPts: text('source_end_pts').notNull(),
    timeBaseNumerator: integer('time_base_numerator').notNull(),
    timeBaseDenominator: integer('time_base_denominator').notNull(),
    confidencePermille: integer('confidence_permille'),
    payload: jsonb('payload').notNull().default({}),
    storageKey: text('storage_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_index_entries_run_kind_ordinal_uq').on(table.runId, table.kind, table.ordinal),
    index('media_index_entries_workspace_run_kind_idx').on(table.workspaceId, table.runId, table.kind, table.ordinal),
    check('media_index_entries_kind_ck', sql`${table.kind} in ('THUMBNAIL','WAVEFORM','SHOT','QUALITY')`),
    check('media_index_entries_ordinal_ck', sql`${table.ordinal} >= 0`),
    check('media_index_entries_pts_ck', sql`${table.sourceStartPts} ~ '^-?[0-9]+$' and ${table.sourceEndPts} ~ '^-?[0-9]+$'`),
    check('media_index_entries_time_base_ck', sql`${table.timeBaseNumerator} > 0 and ${table.timeBaseDenominator} > 0`),
    check('media_index_entries_confidence_ck', sql`${table.confidencePermille} is null or ${table.confidencePermille} between 0 and 1000`),
  ],
);
