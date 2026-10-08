import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { compareMediaTime, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import {
  animationTargetKindSchema,
  audioChannelMappingSchema,
  keyframeSchema,
  timeBindingSchema,
  versionedParametersSchema,
} from './composition-objects.js';
import { clipTimeMappingSchema } from './composition.js';

export const updateClipChangesSchema = z.object({
  trackId: opaqueIdSchema,
  sourceStreamId: z.string().max(200).nullable(),
  sourceRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  avGroupId: opaqueIdSchema.nullable(),
  parentClipId: opaqueIdSchema.nullable(),
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'update_clip requires at least one change');

export const updateClipOperationSchema = z.object({
  op: z.literal('update_clip'),
  clipId: opaqueIdSchema,
  changes: updateClipChangesSchema,
}).strict();

export const updateAnimationOperationSchema = z.object({
  op: z.literal('update_animation'),
  animationId: opaqueIdSchema,
  targetKind: animationTargetKindSchema,
  targetId: opaqueIdSchema,
  keyframes: z.array(keyframeSchema).min(1),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.keyframes.length; index += 1) {
    if (compareMediaTime(value.keyframes[index - 1]!.time, value.keyframes[index]!.time) >= 0) {
      context.addIssue({ code: 'custom', path: ['keyframes', index, 'time'], message: 'keyframe times must be strictly increasing' });
    }
  }
});

export const updateAudioRegionChangesSchema = z.object({
  trackId: opaqueIdSchema,
  timeBinding: timeBindingSchema,
  localRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  sourceStreamId: z.string().min(1).max(200),
  channelMapping: z.array(audioChannelMappingSchema).min(1),
  gainDb: z.number().finite().min(-96).max(24),
  pan: z.number().finite().min(-1).max(1),
  fadeIn: mediaTimeSchema,
  fadeOut: mediaTimeSchema,
  parameters: versionedParametersSchema,
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'update_audio_region requires at least one change');

export const updateAudioRegionOperationSchema = z.object({
  op: z.literal('update_audio_region'),
  audioRegionId: opaqueIdSchema,
  changes: updateAudioRegionChangesSchema,
}).strict();

export type UpdateClipChanges = z.infer<typeof updateClipChangesSchema>;
export type UpdateAudioRegionChanges = z.infer<typeof updateAudioRegionChangesSchema>;
