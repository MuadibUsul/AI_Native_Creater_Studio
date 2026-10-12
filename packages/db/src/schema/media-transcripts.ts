import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { assetVersions } from './assets.js';
import { workspaces } from './workspaces.js';

export const mediaTranscriptRuns = pgTable(
  'media_transcript_runs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
    sourceChecksumSha256: text('source_checksum_sha256').notNull(),
    processorVersion: text('processor_version').notNull(),
    status: text('status').notNull().default('QUEUED'),
    currentVersion: integer('current_version').notNull().default(0),
    errorSummary: text('error_summary'),
    /** 机器可读错误码（CAPABILITY_NOT_CONFIGURED = 驱动未配置） */
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_transcript_runs_source_processor_uq').on(table.sourceAssetVersionId, table.processorVersion),
    index('media_transcript_runs_workspace_source_idx').on(table.workspaceId, table.sourceAssetVersionId),
    check('media_transcript_runs_status_ck', sql`${table.status} in ('QUEUED','RUNNING','READY','FAILED','STALE')`),
    check('media_transcript_runs_version_ck', sql`${table.currentVersion} >= 0`),
    check('media_transcript_runs_checksum_ck', sql`${table.sourceChecksumSha256} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const mediaTranscriptVersions = pgTable(
  'media_transcript_versions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    runId: text('run_id').notNull().references(() => mediaTranscriptRuns.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    source: text('source').notNull(),
    provider: text('provider').notNull(),
    model: text('model').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    affectedSegmentIds: jsonb('affected_segment_ids').notNull().default([]),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_transcript_versions_run_version_uq').on(table.runId, table.version),
    index('media_transcript_versions_workspace_run_idx').on(table.workspaceId, table.runId, table.version),
    check('media_transcript_versions_version_ck', sql`${table.version} > 0`),
    check('media_transcript_versions_source_ck', sql`${table.source} in ('ASR','CORRECTION','TERMINOLOGY')`),
  ],
);
