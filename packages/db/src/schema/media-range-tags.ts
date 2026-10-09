import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { assets, assetVersions } from './assets.js';
import { workspaces } from './workspaces.js';

export const mediaRangeTags = pgTable('media_range_tags', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  assetId: text('asset_id').notNull().references(() => assets.id, { onDelete: 'cascade' }),
  sourceAssetVersionId: text('source_asset_version_id').notNull().references(() => assetVersions.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  sourceStartPts: text('source_start_pts').notNull(),
  sourceEndPts: text('source_end_pts').notNull(),
  timeBaseNumerator: integer('time_base_numerator').notNull(),
  timeBaseDenominator: integer('time_base_denominator').notNull(),
  createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('media_range_tags_workspace_asset_idx').on(table.workspaceId, table.assetId, table.createdAt),
  index('media_range_tags_workspace_label_idx').on(table.workspaceId, table.label),
  check('media_range_tags_pts_ck', sql`${table.sourceStartPts} ~ '^-?[0-9]+$' and ${table.sourceEndPts} ~ '^-?[0-9]+$'`),
  check('media_range_tags_positive_range_ck', sql`(${table.sourceEndPts})::numeric > (${table.sourceStartPts})::numeric`),
  check('media_range_tags_time_base_ck', sql`${table.timeBaseNumerator} > 0 and ${table.timeBaseDenominator} > 0`),
]);
