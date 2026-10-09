import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetVersions } from './assets.js';
import { workspaces } from './workspaces.js';

export const mediaDerivatives = pgTable(
  'media_derivatives',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    profileKey: text('profile_key').notNull(),
    status: text('status').notNull(),
    derivativeAssetVersionId: text('derivative_asset_version_id').references(() => assetVersions.id, { onDelete: 'set null' }),
    sourceChecksumSha256: text('source_checksum_sha256').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    errorSummary: text('error_summary'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('media_derivatives_source_profile_uq').on(table.sourceAssetVersionId, table.kind, table.profileKey),
    index('media_derivatives_workspace_source_idx').on(table.workspaceId, table.sourceAssetVersionId),
    index('media_derivatives_output_idx').on(table.derivativeAssetVersionId),
    check('media_derivatives_kind_ck', sql`${table.kind} in ('PROXY','ANALYSIS')`),
    check('media_derivatives_status_ck', sql`${table.status} in ('PENDING','PROCESSING','READY','FAILED')`),
    check('media_derivatives_profile_key_ck', sql`length(btrim(${table.profileKey})) between 1 and 120`),
    check('media_derivatives_source_checksum_ck', sql`${table.sourceChecksumSha256} ~ '^[0-9a-f]{64}$'`),
    check('media_derivatives_distinct_output_ck', sql`${table.derivativeAssetVersionId} is null or ${table.derivativeAssetVersionId} <> ${table.sourceAssetVersionId}`),
    check('media_derivatives_ready_proxy_output_ck', sql`${table.kind} <> 'PROXY' or ${table.status} <> 'READY' or ${table.derivativeAssetVersionId} is not null`),
  ],
);
