import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { projectSequences, sequenceTracks } from './composition.js';
import { workspaces } from './workspaces.js';

const scope = {
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
};

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const compositionVisualObjects = pgTable(
  'composition_visual_objects',
  {
    id: text('id').primaryKey(),
    ...scope,
    trackId: text('track_id').notNull().references(() => sequenceTracks.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    parentObjectId: text('parent_object_id'),
    semanticSceneId: text('semantic_scene_id'),
    timeBinding: jsonb('time_binding').notNull(),
    localRange: jsonb('local_range').notNull(),
    sequenceRange: jsonb('sequence_range').notNull(),
    component: jsonb('component'),
    parameters: jsonb('parameters').notNull(),
    ...timestamps,
  },
  (table) => [
    index('composition_visual_objects_scope_idx').on(table.workspaceId, table.projectId, table.sequenceId),
    index('composition_visual_objects_track_idx').on(table.trackId),
    index('composition_visual_objects_parent_idx').on(table.parentObjectId),
  ],
);

export const compositionAudioRegions = pgTable(
  'composition_audio_regions',
  {
    id: text('id').primaryKey(),
    ...scope,
    trackId: text('track_id').notNull().references(() => sequenceTracks.id, { onDelete: 'cascade' }),
    timeBinding: jsonb('time_binding').notNull(),
    localRange: jsonb('local_range').notNull(),
    sequenceRange: jsonb('sequence_range').notNull(),
    sourceStreamId: text('source_stream_id').notNull(),
    channelMapping: jsonb('channel_mapping').notNull(),
    gainDb: text('gain_db').notNull(),
    pan: text('pan').notNull(),
    fadeIn: jsonb('fade_in').notNull(),
    fadeOut: jsonb('fade_out').notNull(),
    parameters: jsonb('parameters').notNull(),
    ...timestamps,
  },
  (table) => [
    index('composition_audio_regions_scope_idx').on(table.workspaceId, table.projectId, table.sequenceId),
    index('composition_audio_regions_track_idx').on(table.trackId),
  ],
);

export const compositionCaptionSpans = pgTable(
  'composition_caption_spans',
  {
    id: text('id').primaryKey(),
    ...scope,
    trackId: text('track_id').notNull().references(() => sequenceTracks.id, { onDelete: 'cascade' }),
    timeBinding: jsonb('time_binding').notNull(),
    localRange: jsonb('local_range').notNull(),
    sequenceRange: jsonb('sequence_range').notNull(),
    text: text('text').notNull(),
    languageTag: text('language_tag').notNull(),
    style: jsonb('style').notNull(),
    words: jsonb('words').notNull().default([]),
    speechAnchorId: text('speech_anchor_id'),
    ...timestamps,
  },
  (table) => [
    index('composition_caption_spans_scope_idx').on(table.workspaceId, table.projectId, table.sequenceId),
    index('composition_caption_spans_track_idx').on(table.trackId),
    index('composition_caption_spans_speech_anchor_idx').on(table.speechAnchorId),
  ],
);

export const compositionEffectInstances = pgTable(
  'composition_effect_instances',
  {
    id: text('id').primaryKey(),
    ...scope,
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    effectType: text('effect_type').notNull(),
    effectVersion: text('effect_version').notNull(),
    requiredCapability: text('required_capability').notNull(),
    parameters: jsonb('parameters').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    index('composition_effect_instances_scope_idx').on(table.workspaceId, table.projectId, table.sequenceId),
    index('composition_effect_instances_target_idx').on(table.targetKind, table.targetId),
  ],
);

export const compositionAnimationBindings = pgTable(
  'composition_animation_bindings',
  {
    id: text('id').primaryKey(),
    ...scope,
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    propertyPath: text('property_path').notNull(),
    parameterSchemaVersion: text('parameter_schema_version').notNull(),
    timeBinding: jsonb('time_binding').notNull(),
    keyframes: jsonb('keyframes').notNull(),
    ...timestamps,
  },
  (table) => [
    index('composition_animation_bindings_scope_idx').on(table.workspaceId, table.projectId, table.sequenceId),
    index('composition_animation_bindings_target_idx').on(table.targetKind, table.targetId),
  ],
);
