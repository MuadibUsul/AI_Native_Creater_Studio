import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { assetVersions } from './assets.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

export const projectSequences = pgTable(
  'project_sequences',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    frameRate: jsonb('frame_rate').notNull(),
    start: jsonb('start').notNull(),
    duration: jsonb('duration').notNull(),
    /** Validated in domain to avoid a self-referential Drizzle type cycle. */
    parentSequenceId: text('parent_sequence_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('project_sequences_workspace_project_idx').on(table.workspaceId, table.projectId),
    index('project_sequences_parent_idx').on(table.parentSequenceId),
  ],
);

export const sequenceTracks = pgTable(
  'sequence_tracks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    position: integer('position').notNull(),
    name: text('name').notNull(),
    locked: boolean('locked').notNull().default(false),
    muted: boolean('muted').notNull().default(false),
    hidden: boolean('hidden').notNull().default(false),
    /** N03-04 独奏（混音/预览一致：solo 归一化后仅播放被独奏的轨） */
    solo: boolean('solo').notNull().default(false),
    /** N03-04 同步锁：涟漪/插入等结构性操作会联动本轨（显式覆盖时不受限） */
    syncLocked: boolean('sync_locked').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('sequence_tracks_sequence_position_uq').on(table.sequenceId, table.position),
    index('sequence_tracks_workspace_project_idx').on(table.workspaceId, table.projectId),
  ],
);

export const sequenceClips = pgTable(
  'sequence_clips',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
    trackId: text('track_id').notNull().references(() => sequenceTracks.id, { onDelete: 'cascade' }),
    assetVersionId: text('asset_version_id').references(() => assetVersions.id, { onDelete: 'restrict' }),
    /** Domain validated; no FK avoids a recursive sequence row type. */
    nestedSequenceId: text('nested_sequence_id'),
    sourceStreamId: text('source_stream_id'),
    sourceRange: jsonb('source_range').notNull(),
    sequenceRange: jsonb('sequence_range').notNull(),
    timeMapping: jsonb('time_mapping').notNull(),
    avGroupId: text('av_group_id'),
    /** N03-05 可编辑变换与基础关键帧：片段参数命名空间（默认值保证旧片段语义不变） */
    parameters: jsonb('parameters'),
    /** Domain validated parent-child relation; clip rows are otherwise append-only in N01-03. */
    parentClipId: text('parent_clip_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('sequence_clips_workspace_project_idx').on(table.workspaceId, table.projectId),
    index('sequence_clips_sequence_track_idx').on(table.sequenceId, table.trackId),
    index('sequence_clips_asset_version_idx').on(table.assetVersionId),
    index('sequence_clips_nested_sequence_idx').on(table.nestedSequenceId),
    index('sequence_clips_av_group_idx').on(table.avGroupId),
    check('sequence_clips_source_xor_ck', sql`(${table.assetVersionId} IS NULL) <> (${table.nestedSequenceId} IS NULL)`),
  ],
);
