import { z } from 'zod';
import { visualParametersSchema } from './visual-transform.js';
export { visualParametersSchema };
import { opaqueIdSchema } from './common/ids.js';
import { frameRateSchema, mediaRangeSchema, mediaTimeSchema, rationalSchema } from './common/media-time.js';
import { isoDateTimeSchema } from './common/time.js';

export const TRACK_KINDS = ['VIDEO', 'AUDIO', 'GRAPHIC', 'CAPTION'] as const;
export const trackKindSchema = z.enum(TRACK_KINDS);

export const clipTimeMappingSchema = z.object({
  kind: z.literal('LINEAR'),
  /** source duration / sequence duration; reduced positive rational */
  rate: rationalSchema.default({ num: 1, den: 1 }),
  direction: z.enum(['FORWARD', 'REVERSE']).default('FORWARD'),
  preservePitch: z.boolean().default(true),
}).strict();

export const sequenceSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  name: z.string().min(1).max(200),
  frameRate: frameRateSchema,
  start: mediaTimeSchema,
  duration: mediaTimeSchema,
  parentSequenceId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export const trackSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  kind: trackKindSchema,
  position: z.number().int().nonnegative(),
  name: z.string().min(1).max(200),
  locked: z.boolean().default(false),
  muted: z.boolean().default(false),
  hidden: z.boolean().default(false),
  /** N03-04：独奏（预览与导出按同一归一化规则处理） */
  solo: z.boolean().default(false),
  /** N03-04：同步锁（涟漪/插入等结构性操作联动本轨） */
  syncLocked: z.boolean().default(false),
  createdAt: isoDateTimeSchema,
});

export const clipSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema.nullable().default(null),
  nestedSequenceId: opaqueIdSchema.nullable().default(null),
  sourceStreamId: z.string().max(200).nullable().default(null),
  sourceRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  avGroupId: opaqueIdSchema.nullable().default(null),
  parentClipId: opaqueIdSchema.nullable().default(null),
  /** N03-05：可编辑变换/裁切/透明度参数（缺省即旧语义：无位移、无缩放、无裁切、不透明）。 */
  parameters: visualParametersSchema.optional(),
  createdAt: isoDateTimeSchema,
}).superRefine((value, context) => {
  if ((value.assetVersionId === null) === (value.nestedSequenceId === null)) {
    context.addIssue({ code: 'custom', message: 'clip must reference exactly one assetVersionId or nestedSequenceId' });
  }
});

export const createSequenceRequestSchema = z.object({
  name: z.string().min(1).max(200),
  frameRate: frameRateSchema,
  duration: mediaTimeSchema,
  parentSequenceId: opaqueIdSchema.nullable().optional(),
}).strict();

export const createTrackRequestSchema = z.object({
  kind: trackKindSchema,
  position: z.number().int().nonnegative(),
  name: z.string().min(1).max(200),
  locked: z.boolean().optional(),
  muted: z.boolean().optional(),
  hidden: z.boolean().optional(),
  solo: z.boolean().optional(),
  syncLocked: z.boolean().optional(),
}).strict();

export const createClipRequestSchema = z.object({
  trackId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema.nullable().optional(),
  nestedSequenceId: opaqueIdSchema.nullable().optional(),
  sourceStreamId: z.string().max(200).nullable().optional(),
  sourceRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  avGroupId: opaqueIdSchema.nullable().optional(),
  parentClipId: opaqueIdSchema.nullable().optional(),
}).strict().superRefine((value, context) => {
  if ((value.assetVersionId == null) === (value.nestedSequenceId == null)) {
    context.addIssue({ code: 'custom', message: 'clip must reference exactly one assetVersionId or nestedSequenceId' });
  }
});

export type TrackKind = z.infer<typeof trackKindSchema>;
export type ClipTimeMapping = z.infer<typeof clipTimeMappingSchema>;
export type Sequence = z.infer<typeof sequenceSchema>;
export type Track = z.infer<typeof trackSchema>;
export type Clip = z.infer<typeof clipSchema>;
export type CreateSequenceRequest = z.infer<typeof createSequenceRequestSchema>;
export type CreateTrackRequest = z.infer<typeof createTrackRequestSchema>;
export type CreateClipRequest = z.infer<typeof createClipRequestSchema>;
