import { z } from 'zod';
import { compareMediaTime, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

export const TIME_BINDING_BASES = ['SEQUENCE', 'CLIP_LOCAL', 'SOURCE', 'SEMANTIC_CUE'] as const;
export const timeBindingBaseSchema = z.enum(TIME_BINDING_BASES);

export const timeBindingSchema = z.object({
  basis: timeBindingBaseSchema,
  clipId: opaqueIdSchema.nullable().default(null),
  semanticCueId: opaqueIdSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  const clipRequired = value.basis === 'CLIP_LOCAL' || value.basis === 'SOURCE';
  if (clipRequired !== (value.clipId !== null)) {
    context.addIssue({ code: 'custom', message: `${value.basis} binding has invalid clipId` });
  }
  if ((value.basis === 'SEMANTIC_CUE') !== (value.semanticCueId !== null)) {
    context.addIssue({ code: 'custom', message: `${value.basis} binding has invalid semanticCueId` });
  }
});

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) && Object.values(value as Record<string, unknown>).every(isJsonValue);
}

export const versionedParametersSchema = z.object({
  schemaVersion: z.string().min(1).max(64),
  values: z.record(z.string(), z.unknown()).default({}).refine(isJsonValue, 'parameters must contain JSON values'),
}).strict();

export const componentReferenceSchema = z.object({
  componentId: z.string().min(1).max(200),
  componentVersion: z.string().min(1).max(64),
}).strict();

export const VISUAL_OBJECT_KINDS = ['COMPONENT', 'TEXT', 'SHAPE', 'CHART', 'IMAGE', 'STICKER', 'OVERLAY'] as const;
export const visualObjectKindSchema = z.enum(VISUAL_OBJECT_KINDS);

export const visualObjectSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  kind: visualObjectKindSchema,
  parentObjectId: opaqueIdSchema.nullable().default(null),
  semanticSceneId: opaqueIdSchema.nullable().default(null),
  timeBinding: timeBindingSchema,
  localRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  component: componentReferenceSchema.nullable().default(null),
  parameters: versionedParametersSchema,
  createdAt: isoDateTimeSchema,
});

export const EFFECT_TARGET_KINDS = ['CLIP', 'VISUAL_OBJECT', 'AUDIO_REGION', 'TRACK'] as const;
export const effectTargetKindSchema = z.enum(EFFECT_TARGET_KINDS);

/** Domain-supported instance vocabulary. Execution layers must still check requiredCapability. */
export const SUPPORTED_EFFECTS = {
  TRANSFORM: { versions: ['1.0'], requiredCapability: 'effect.transform.v1' },
  CROP: { versions: ['1.0'], requiredCapability: 'effect.crop.v1' },
  OPACITY: { versions: ['1.0'], requiredCapability: 'effect.opacity.v1' },
  AUDIO_GAIN: { versions: ['1.0'], requiredCapability: 'effect.audio-gain.v1' },
  AUDIO_PAN: { versions: ['1.0'], requiredCapability: 'effect.audio-pan.v1' },
} as const;

export const effectInstanceSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  targetKind: effectTargetKindSchema,
  targetId: opaqueIdSchema,
  effectType: z.string().min(1).max(100),
  effectVersion: z.string().min(1).max(64),
  requiredCapability: z.string().min(1).max(200),
  parameters: versionedParametersSchema,
  enabled: z.boolean().default(true),
  createdAt: isoDateTimeSchema,
});

export const ANIMATION_TARGET_KINDS = ['VISUAL_OBJECT', 'EFFECT_INSTANCE', 'AUDIO_REGION'] as const;
export const animationTargetKindSchema = z.enum(ANIMATION_TARGET_KINDS);
export const KEYFRAME_INTERPOLATIONS = ['LINEAR', 'HOLD'] as const;
export const keyframeInterpolationSchema = z.enum(KEYFRAME_INTERPOLATIONS);

export const keyframeSchema = z.object({
  id: opaqueIdSchema,
  time: mediaTimeSchema,
  value: z.unknown().refine(isJsonValue, 'keyframe value must be JSON'),
  interpolation: keyframeInterpolationSchema,
}).strict();

export const animationBindingSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  targetKind: animationTargetKindSchema,
  targetId: opaqueIdSchema,
  propertyPath: z.string().min(1).max(300).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  parameterSchemaVersion: z.string().min(1).max(64),
  timeBinding: timeBindingSchema,
  keyframes: z.array(keyframeSchema).min(1),
  createdAt: isoDateTimeSchema,
}).superRefine((value, context) => {
  for (let index = 1; index < value.keyframes.length; index += 1) {
    if (compareMediaTime(value.keyframes[index - 1]!.time, value.keyframes[index]!.time) >= 0) {
      context.addIssue({ code: 'custom', path: ['keyframes', index, 'time'], message: 'keyframe times must be strictly increasing' });
    }
  }
});

export const captionWordTimingSchema = z.object({
  id: opaqueIdSchema,
  text: z.string(),
  range: mediaRangeSchema,
}).strict();

export const captionSpanSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  timeBinding: timeBindingSchema,
  localRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  text: z.string(),
  languageTag: z.string().min(2).max(35),
  style: versionedParametersSchema,
  words: z.array(captionWordTimingSchema).default([]),
  speechAnchorId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export const audioChannelMappingSchema = z.object({
  sourceChannel: z.number().int().nonnegative(),
  outputChannel: z.number().int().nonnegative(),
}).strict();

export const audioRegionSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
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
  createdAt: isoDateTimeSchema,
});

const objectTimingInput = {
  timeBinding: timeBindingSchema,
  localRange: mediaRangeSchema,
};

export const createVisualObjectRequestSchema = z.object({
  trackId: opaqueIdSchema,
  kind: visualObjectKindSchema,
  parentObjectId: opaqueIdSchema.nullable().optional(),
  semanticSceneId: opaqueIdSchema.nullable().optional(),
  ...objectTimingInput,
  component: componentReferenceSchema.nullable().optional(),
  parameters: versionedParametersSchema,
}).strict().superRefine((value, context) => {
  if ((value.kind === 'COMPONENT') !== (value.component != null)) {
    context.addIssue({ code: 'custom', path: ['component'], message: 'COMPONENT objects require exactly one component reference' });
  }
});

export const repositionVisualObjectRequestSchema = z.object({
  trackId: opaqueIdSchema,
  ...objectTimingInput,
}).strict();

export const createEffectInstanceRequestSchema = z.object({
  targetKind: effectTargetKindSchema,
  targetId: opaqueIdSchema,
  effectType: z.string().min(1).max(100),
  effectVersion: z.string().min(1).max(64),
  parameters: versionedParametersSchema,
  enabled: z.boolean().optional(),
}).strict();

export const createAnimationBindingRequestSchema = z.object({
  targetKind: animationTargetKindSchema,
  targetId: opaqueIdSchema,
  propertyPath: z.string().min(1).max(300).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
  parameterSchemaVersion: z.string().min(1).max(64),
  timeBinding: timeBindingSchema,
  keyframes: z.array(keyframeSchema.omit({ id: true })).min(1),
}).strict().superRefine((value, context) => {
  for (let index = 1; index < value.keyframes.length; index += 1) {
    if (compareMediaTime(value.keyframes[index - 1]!.time, value.keyframes[index]!.time) >= 0) {
      context.addIssue({ code: 'custom', path: ['keyframes', index, 'time'], message: 'keyframe times must be strictly increasing' });
    }
  }
});

export const createCaptionSpanRequestSchema = z.object({
  trackId: opaqueIdSchema,
  ...objectTimingInput,
  text: z.string(),
  languageTag: z.string().min(2).max(35),
  style: versionedParametersSchema,
  words: z.array(captionWordTimingSchema.omit({ id: true })).default([]),
  speechAnchorId: opaqueIdSchema.nullable().optional(),
}).strict();

export const createAudioRegionRequestSchema = z.object({
  trackId: opaqueIdSchema,
  ...objectTimingInput,
  sourceStreamId: z.string().min(1).max(200),
  channelMapping: z.array(audioChannelMappingSchema).min(1),
  gainDb: z.number().finite().min(-96).max(24).default(0),
  pan: z.number().finite().min(-1).max(1).default(0),
  fadeIn: mediaTimeSchema,
  fadeOut: mediaTimeSchema,
  parameters: versionedParametersSchema,
}).strict();

export type TimeBindingBase = z.infer<typeof timeBindingBaseSchema>;
export type TimeBinding = z.infer<typeof timeBindingSchema>;
export type VisualObjectKind = z.infer<typeof visualObjectKindSchema>;
export type VisualObject = z.infer<typeof visualObjectSchema>;
export type EffectTargetKind = z.infer<typeof effectTargetKindSchema>;
export type EffectInstance = z.infer<typeof effectInstanceSchema>;
export type AnimationTargetKind = z.infer<typeof animationTargetKindSchema>;
export type AnimationBinding = z.infer<typeof animationBindingSchema>;
export type CaptionSpan = z.infer<typeof captionSpanSchema>;
export type AudioRegion = z.infer<typeof audioRegionSchema>;
export type CreateVisualObjectRequest = z.infer<typeof createVisualObjectRequestSchema>;
export type RepositionVisualObjectRequest = z.infer<typeof repositionVisualObjectRequestSchema>;
export type CreateEffectInstanceRequest = z.infer<typeof createEffectInstanceRequestSchema>;
export type CreateAnimationBindingRequest = z.infer<typeof createAnimationBindingRequestSchema>;
export type CreateCaptionSpanRequest = z.infer<typeof createCaptionSpanRequestSchema>;
export type CreateAudioRegionRequest = z.infer<typeof createAudioRegionRequestSchema>;
