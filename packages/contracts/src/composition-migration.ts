import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { sequenceSchema, trackSchema } from './composition.js';
import { audioRegionSchema, captionSpanSchema, visualObjectSchema } from './composition-objects.js';
import { sceneGraphSchema } from './scene-graph.js';

export const COMPOSITION_MIGRATION_STATUSES = ['PENDING', 'RUNNING', 'FAILED', 'COMPLETE'] as const;
export const compositionMigrationStatusSchema = z.enum(COMPOSITION_MIGRATION_STATUSES);

export const COMPOSITION_MIGRATION_STEPS = ['NONE', 'BASE', 'SCENES', 'VERSIONS', 'COMPLETE'] as const;
export const compositionMigrationStepSchema = z.enum(COMPOSITION_MIGRATION_STEPS);

export const COMPOSITION_AUTHORITY_MODES = ['LEGACY', 'COMPOSITION'] as const;
export const compositionAuthorityModeSchema = z.enum(COMPOSITION_AUTHORITY_MODES);

export const compositionMigrationSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  enabled: z.boolean(),
  status: compositionMigrationStatusSchema,
  completedStep: compositionMigrationStepSchema,
  authorityMode: compositionAuthorityModeSchema,
  attemptCount: z.number().int().nonnegative(),
  sourceDigestSha256: z.string().length(64).nullable(),
  targetDigestSha256: z.string().length(64).nullable(),
  lastError: z.string().max(2_000).nullable(),
  startedAt: isoDateTimeSchema.nullable(),
  completedAt: isoDateTimeSchema.nullable(),
  updatedAt: isoDateTimeSchema,
}).strict();

/** Immutable, independently verifiable projection of one legacy ProjectVersion. */
export const projectVersionCompositionProjectionSchema = z.object({
  schemaVersion: z.literal('1.0'),
  projectVersionId: opaqueIdSchema,
  sequence: sequenceSchema,
  tracks: z.array(trackSchema),
  visualObjects: z.array(visualObjectSchema),
  captions: z.array(captionSpanSchema),
  audioRegions: z.array(audioRegionSchema),
  compatibility: z.object({
    sceneGraph: sceneGraphSchema,
  }).strict(),
}).strict();

export const projectVersionProjectionRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  sourceSnapshotSha256: z.string().length(64),
  projectionSha256: z.string().length(64),
  projection: projectVersionCompositionProjectionSchema,
  createdAt: isoDateTimeSchema,
}).strict();

export const COMPOSITION_MIGRATION_ERROR_REASONS = {
  FEATURE_DISABLED: 'COMPOSITION_MIGRATION_FEATURE_DISABLED',
  ALREADY_HAS_COMPOSITION: 'COMPOSITION_ALREADY_EXISTS',
  SOURCE_CHANGED: 'LEGACY_SOURCE_CHANGED_DURING_MIGRATION',
  LEGACY_WRITE_BLOCKED: 'LEGACY_WRITE_BLOCKED_AFTER_COMPOSITION_CUTOVER',
} as const;

export type CompositionMigrationStatus = z.infer<typeof compositionMigrationStatusSchema>;
export type CompositionMigrationStep = z.infer<typeof compositionMigrationStepSchema>;
export type CompositionAuthorityMode = z.infer<typeof compositionAuthorityModeSchema>;
export type CompositionMigration = z.infer<typeof compositionMigrationSchema>;
export type ProjectVersionCompositionProjection = z.infer<typeof projectVersionCompositionProjectionSchema>;
export type ProjectVersionProjectionRecord = z.infer<typeof projectVersionProjectionRecordSchema>;
