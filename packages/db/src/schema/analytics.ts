import { boolean, doublePrecision, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects, projectVersions } from './projects.js';
import { publications } from './publications.js';
import { workspaces } from './workspaces.js';
import { channels } from './creator.js';

export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    publicationId: text('publication_id').notNull().references(() => publications.id, { onDelete: 'cascade' }),
    platformId: text('platform_id').notNull(),
    remoteId: text('remote_id').notNull(),
    sampling: jsonb('sampling').notNull(),
    payload: jsonb('payload').notNull(),
    payloadHash: text('payload_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('analytics_events_publication_payload_uq').on(table.publicationId, table.payloadHash),
    index('analytics_events_workspace_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const videoPerformance = pgTable(
  'video_performance',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    publicationId: text('publication_id').notNull().references(() => publications.id, { onDelete: 'cascade' }),
    projectVersionId: text('project_version_id').notNull().references(() => projectVersions.id, { onDelete: 'cascade' }),
    platformId: text('platform_id').notNull(),
    remoteId: text('remote_id').notNull(),
    sampling: jsonb('sampling').notNull(),
    metrics: jsonb('metrics').notNull(),
    rawEventId: text('raw_event_id').notNull().references(() => analyticsEvents.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('video_performance_raw_event_uq').on(table.rawEventId),
    index('video_performance_publication_idx').on(table.publicationId, table.createdAt),
    index('video_performance_workspace_idx').on(table.workspaceId, table.createdAt),
  ],
);

export const scenePerformance = pgTable(
  'scene_performance',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    projectVersionId: text('project_version_id').notNull().references(() => projectVersions.id, { onDelete: 'cascade' }),
    videoPerformanceId: text('video_performance_id').notNull().references(() => videoPerformance.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id').notNull(),
    sceneType: text('scene_type').notNull(),
    position: integer('position').notNull(),
    startMs: integer('start_ms').notNull(),
    durationMs: integer('duration_ms').notNull(),
    retentionRate: doublePrecision('retention_rate'),
    interpretation: text('interpretation').notNull().default('CORRELATION_ONLY'),
    derivation: jsonb('derivation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('scene_performance_sample_scene_uq').on(table.videoPerformanceId, table.sceneId),
    index('scene_performance_project_idx').on(table.projectId, table.createdAt),
  ],
);

export const creatorLearnings = pgTable(
  'creator_learnings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    channelId: text('channel_id').notNull().references(() => channels.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    title: text('title').notNull(),
    explanation: text('explanation').notNull(),
    evidence: jsonb('evidence').notNull(),
    recommendation: jsonb('recommendation').notNull(),
    channelMutationApplied: boolean('channel_mutation_applied').notNull().default(false),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    disabledAt: timestamp('disabled_at', { withTimezone: true }),
    revertedAt: timestamp('reverted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('creator_learnings_channel_idx').on(table.workspaceId, table.channelId, table.createdAt),
    index('creator_learnings_project_idx').on(table.projectId, table.createdAt),
  ],
);
