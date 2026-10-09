import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { mediaRationalSchema, sourceMediaProbeResultSchema } from './assets.js';

export const MEDIA_INDEX_JOB_TYPE = 'MEDIA_INDEX';
export const MEDIA_INDEX_PROCESSOR_VERSION = 'source-index-v1';
export const MEDIA_INDEX_ANALYSIS_CONFIG_HASH = '5718708ba312bf304e8b86a3f160ffa383a565b1dea6163806a8a4bc0a8eb585';
export const MEDIA_INDEX_VERSION = 1;
export const MEDIA_INDEX_STATUSES = ['QUEUED', 'RUNNING', 'PARTIAL', 'READY', 'EMPTY', 'FAILED', 'STALE'] as const;
export const MEDIA_INDEX_KINDS = ['THUMBNAIL', 'WAVEFORM', 'SHOT', 'QUALITY'] as const;
export const mediaIndexStatusSchema = z.enum(MEDIA_INDEX_STATUSES);
export const mediaIndexKindSchema = z.enum(MEDIA_INDEX_KINDS);
const ptsSchema = z.string().regex(/^-?\d+$/);

export const mediaIndexJobInputSchema = z.object({
  runId: opaqueIdSchema,
  sourceAssetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  sourceStorageKey: z.string().min(1).max(512),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  processorVersion: z.literal(MEDIA_INDEX_PROCESSOR_VERSION),
  analysisConfigHash: z.literal(MEDIA_INDEX_ANALYSIS_CONFIG_HASH),
  indexVersion: z.literal(MEDIA_INDEX_VERSION),
}).strict();
export type MediaIndexJobInput = z.infer<typeof mediaIndexJobInputSchema>;

export const generatedMediaIndexEntrySchema = z.object({
  kind: mediaIndexKindSchema,
  ordinal: z.number().int().nonnegative(),
  sourceStartPts: ptsSchema,
  sourceEndPts: ptsSchema,
  timeBase: mediaRationalSchema,
  streamId: z.string().min(1).max(120),
  confidencePermille: z.number().int().min(0).max(1000).nullable(),
  payload: z.record(z.string(), z.unknown()),
  localFilename: z.string().min(1).max(160).nullable(),
}).strict();
export type GeneratedMediaIndexEntry = z.infer<typeof generatedMediaIndexEntrySchema>;

export const generatedMediaIndexSchema = z.object({
  schemaVersion: z.literal('1.0'),
  processorVersion: z.literal(MEDIA_INDEX_PROCESSOR_VERSION),
  durationMs: z.number().int().nonnegative(),
  entries: z.array(generatedMediaIndexEntrySchema).max(5000),
}).strict();
export type GeneratedMediaIndex = z.infer<typeof generatedMediaIndexSchema>;

export const mediaIndexEntrySchema = generatedMediaIndexEntrySchema.omit({ localFilename: true }).extend({
  id: opaqueIdSchema,
  previewUrl: z.string().url().nullable(),
  previewExpiresAt: isoDateTimeSchema.nullable(),
}).strict();
export type MediaIndexEntry = z.infer<typeof mediaIndexEntrySchema>;

export const mediaIndexPageSchema = z.object({
  runId: opaqueIdSchema.nullable(),
  sourceAssetVersionId: opaqueIdSchema,
  processorVersion: z.string().min(1),
  status: mediaIndexStatusSchema,
  coveragePermille: z.number().int().min(0).max(1000),
  checkpointMs: z.number().int().nonnegative(),
  errorSummary: z.string().nullable(),
  items: z.array(mediaIndexEntrySchema),
  nextCursor: z.string().nullable(),
}).strict();
export type MediaIndexPage = z.infer<typeof mediaIndexPageSchema>;

export const mediaIndexQuerySchema = z.object({
  kind: mediaIndexKindSchema.optional(),
  cursor: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
}).strict();

/** Worker I/O seam. Implementations run media tooling outside the API process. */
export interface SourceMediaIndexer {
  readonly kind: string;
  index(input: { sourcePath: string; outputDirectory: string; sourceProbe: z.infer<typeof sourceMediaProbeResultSchema> }): Promise<GeneratedMediaIndex>;
}
