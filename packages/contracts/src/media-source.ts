import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { isoDateTimeSchema } from './common/time.js';
import { assetVersionStatusSchema } from './assets.js';
import { clipTimeMappingSchema } from './composition.js';

export const MEDIA_DERIVATIVE_KINDS = ['PROXY', 'ANALYSIS'] as const;
export const MEDIA_DERIVATIVE_STATUSES = ['PENDING', 'PROCESSING', 'READY', 'FAILED'] as const;
export const mediaDerivativeSchema = z.object({
  id: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  kind: z.enum(MEDIA_DERIVATIVE_KINDS),
  profileKey: z.string().trim().min(1).max(120),
  status: z.enum(MEDIA_DERIVATIVE_STATUSES),
  derivativeAssetVersionId: opaqueIdSchema.nullable(),
  sourceChecksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  metadata: z.record(z.string(), z.unknown()),
  errorSummary: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();

export const mediaSourceViewSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  sourceAssetVersionId: opaqueIdSchema,
  versionNumber: z.number().int().positive(),
  status: assetVersionStatusSchema,
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  duration: mediaTimeSchema.nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  mediaMetadata: z.record(z.string(), z.unknown()),
  derivatives: z.array(mediaDerivativeSchema),
  createdAt: isoDateTimeSchema,
}).strict();

export const clipInstanceViewSchema = z.object({
  id: opaqueIdSchema,
  clipId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  sourceKind: z.enum(['MEDIA_SOURCE', 'NESTED_SEQUENCE']),
  sourceId: opaqueIdSchema,
  sourceStreamId: z.string().nullable(),
  sourceRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  avGroupId: opaqueIdSchema.nullable(),
  parentClipId: opaqueIdSchema.nullable(),
}).strict();

export const legacyClipProjectionSchema = z.object({
  clipId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema.nullable(),
  nestedSequenceId: opaqueIdSchema.nullable(),
  sourceInMs: z.number().int().nonnegative(),
  sourceOutMs: z.number().int().positive(),
  sequenceStartMs: z.number().int().nonnegative(),
  sequenceEndMs: z.number().int().positive(),
}).strict().superRefine((value, context) => {
  if ((value.assetVersionId === null) === (value.nestedSequenceId === null)) {
    context.addIssue({ code: 'custom', message: 'legacy clip projection must reference exactly one source' });
  }
});

export type MediaDerivative = z.infer<typeof mediaDerivativeSchema>;
export type MediaSourceView = z.infer<typeof mediaSourceViewSchema>;
export type ClipInstanceView = z.infer<typeof clipInstanceViewSchema>;
export type LegacyClipProjection = z.infer<typeof legacyClipProjectionSchema>;
