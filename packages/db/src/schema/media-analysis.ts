import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetVersions } from './assets.js';
import { jobs } from './jobs.js';
import { workspaces } from './workspaces.js';

export const mediaAnalysisStages = pgTable('media_analysis_stages', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
  stage: text('stage').notNull(),
  status: text('status').notNull().default('NOT_REQUESTED'),
  dependencies: jsonb('dependencies').notNull().default([]),
  coveragePermille: integer('coverage_permille').notNull().default(0),
  checkpoint: jsonb('checkpoint').notNull().default({ cursor: null, completedUnits: 0, totalUnits: null }),
  detectorConfigHash: text('detector_config_hash').notNull(),
  inputFingerprint: text('input_fingerprint').notNull(),
  jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
  budgetMicros: integer('budget_micros'),
  spentMicros: integer('spent_micros').notNull().default(0),
  errorSummary: text('error_summary'),
  invalidatedAt: timestamp('invalidated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('media_analysis_stages_source_stage_uq').on(table.sourceAssetVersionId, table.stage),
  index('media_analysis_stages_workspace_source_idx').on(table.workspaceId, table.sourceAssetVersionId),
  index('media_analysis_stages_workspace_status_idx').on(table.workspaceId, table.status),
  check('media_analysis_stages_name_ck', sql`${table.stage} in ('PROBE','PROXY','WAVEFORM','ASR','SHOT','SAMPLING','VISION','OCR','AUDIO','EMBEDDINGS','SEARCH_INDEX')`),
  check('media_analysis_stages_status_ck', sql`${table.status} in ('NOT_REQUESTED','QUEUED','RUNNING','PARTIAL','READY','EMPTY','FAILED','DISABLED','STALE','CANCEL_REQUESTED','CANCELLED')`),
  check('media_analysis_stages_coverage_ck', sql`${table.coveragePermille} between 0 and 1000`),
  check('media_analysis_stages_config_hash_ck', sql`${table.detectorConfigHash} ~ '^[0-9a-f]{64}$'`),
  check('media_analysis_stages_input_hash_ck', sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`),
  check('media_analysis_stages_cost_ck', sql`${table.spentMicros} >= 0 and (${table.budgetMicros} is null or ${table.budgetMicros} >= 0)`),
]);
