import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { animationTargetKindSchema, keyframeSchema, timeBindingSchema, versionedParametersSchema } from './composition-objects.js';
import { clipTimeMappingSchema, createTrackRequestSchema } from './composition.js';
import { insertClipOperationSchema } from './composition-edits.js';
import { EDIT_OPERATION_TYPES, editOperationSchema, type EditOperationType } from './edits.js';

export const SOURCE_EDIT_OPERATION_TYPES = [
  'insert_clip', 'delete_clip', 'move_clip', 'trim_clip', 'split_clip', 'duplicate_clip', 'slip_clip',
  'set_clip_transform', 'set_clip_crop', 'set_clip_opacity', 'set_clip_speed',
  'add_effect', 'update_effect', 'remove_effect',
  'add_keyframe', 'update_keyframe', 'remove_keyframe',
  'create_track', 'move_track', 'delete_track',
  'set_audio_gain', 'set_audio_fade', 'set_audio_pan', 'set_audio_automation',
  'add_marker', 'update_marker', 'remove_marker',
  'update_caption_segment', 'regenerate_region', 'replace_region',
  'create_preview_branch', 'commit_preview_branch', 'discard_preview_branch',
] as const;

export const EDIT_OPERATION_V2_RESOLUTIONS = ['NATIVE', 'COMPILED_ALIAS', 'PLANNED'] as const;
export const EDIT_OPERATION_V2_CATEGORIES = ['EDIT', 'ASYNC_COMMAND', 'PREVIEW_COMMAND'] as const;
export const EDIT_OPERATION_V2_COST_CATEGORIES = ['LOCAL', 'PROVIDER_ESTIMATE_REQUIRED'] as const;
export const EDIT_OPERATION_V2_ENTRYPOINTS = ['GUI', 'SHORTCUT', 'AGENT', 'LEGACY_CLIENT'] as const;
export const EDIT_OPERATION_V2_TARGET_KINDS = [
  'PROJECT', 'SEQUENCE', 'TRACK', 'CLIP', 'EFFECT_INSTANCE', 'ANIMATION_BINDING', 'KEYFRAME',
  'AUDIO_REGION', 'MARKER', 'CAPTION_SEGMENT', 'REGION', 'PREVIEW_BRANCH',
] as const;

export type SourceEditOperationType = (typeof SOURCE_EDIT_OPERATION_TYPES)[number];
export type EditOperationV2Resolution = (typeof EDIT_OPERATION_V2_RESOLUTIONS)[number];
export type EditOperationV2Category = (typeof EDIT_OPERATION_V2_CATEGORIES)[number];
export type EditOperationV2Entrypoint = (typeof EDIT_OPERATION_V2_ENTRYPOINTS)[number];
export const editOperationV2EntrypointSchema = z.enum(EDIT_OPERATION_V2_ENTRYPOINTS);

export const editOperationV2RegistrationSchema = z.object({
  operation: z.enum(SOURCE_EDIT_OPERATION_TYPES),
  schemaVersion: z.literal('1.0'),
  resolution: z.enum(EDIT_OPERATION_V2_RESOLUTIONS),
  category: z.enum(EDIT_OPERATION_V2_CATEGORIES),
  canonicalOperation: z.enum(EDIT_OPERATION_TYPES).nullable(),
  targetKinds: z.array(z.enum(EDIT_OPERATION_V2_TARGET_KINDS)).min(1),
  inputSchemaId: z.string().min(1),
  requiredPermission: z.literal('project:write'),
  readSet: z.array(z.string().min(1)),
  writeSet: z.array(z.string().min(1)),
  preconditions: z.array(z.string().min(1)),
  postconditions: z.array(z.string().min(1)),
  costCategory: z.enum(EDIT_OPERATION_V2_COST_CATEGORIES),
  compensation: z.string().min(1),
  supportedBackends: z.array(z.enum(['LEGACY_SCENE', 'PROJECT_DOCUMENT_V2', 'PROPOSAL_SERVICE'])).min(1),
  limitations: z.array(z.string().min(1)),
  testIds: z.array(z.string().min(1)).min(1),
  plannedTask: z.string().min(1).nullable(),
}).strict().superRefine((value, context) => {
  if (value.resolution === 'PLANNED' && value.plannedTask === null) {
    context.addIssue({ code: 'custom', path: ['plannedTask'], message: 'planned operation requires an owning task' });
  }
  if (value.resolution !== 'PLANNED' && value.canonicalOperation === null) {
    context.addIssue({ code: 'custom', path: ['canonicalOperation'], message: 'executable operation requires a canonical operation' });
  }
});

export type EditOperationV2Registration = z.infer<typeof editOperationV2RegistrationSchema>;

const clipId = { clipId: opaqueIdSchema };
const animationRef = {
  animationId: opaqueIdSchema,
  targetKind: animationTargetKindSchema,
  targetId: opaqueIdSchema,
};

export const moveClipSourceOperationSchema = z.object({
  op: z.literal('move_clip'),
  ...clipId,
  trackId: opaqueIdSchema.optional(),
  sequenceRange: mediaRangeSchema.optional(),
}).strict().refine((value) => value.trackId !== undefined || value.sequenceRange !== undefined, 'move_clip requires trackId or sequenceRange');
export const trimClipSourceOperationSchema = z.object({ op: z.literal('trim_clip'), ...clipId, sourceRange: mediaRangeSchema, sequenceRange: mediaRangeSchema }).strict();
export const slipClipSourceOperationSchema = z.object({ op: z.literal('slip_clip'), ...clipId, sourceRange: mediaRangeSchema }).strict();
export const setClipSpeedSourceOperationSchema = z.object({
  op: z.literal('set_clip_speed'),
  ...clipId,
  timeMapping: clipTimeMappingSchema,
  sourceRange: mediaRangeSchema.optional(),
  sequenceRange: mediaRangeSchema.optional(),
}).strict();
export const keyframeSourceOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_keyframe'), ...animationRef, keyframe: keyframeSchema }).strict(),
  z.object({ op: z.literal('update_keyframe'), ...animationRef, keyframe: keyframeSchema }).strict(),
  z.object({ op: z.literal('remove_keyframe'), ...animationRef, keyframeId: opaqueIdSchema }).strict(),
]);
export const setAudioGainSourceOperationSchema = z.object({ op: z.literal('set_audio_gain'), audioRegionId: opaqueIdSchema, gainDb: z.number().finite().min(-96).max(24) }).strict();
export const setAudioFadeSourceOperationSchema = z.object({
  op: z.literal('set_audio_fade'), audioRegionId: opaqueIdSchema,
  fadeIn: mediaTimeSchema.optional(), fadeOut: mediaTimeSchema.optional(),
}).strict().refine((value) => value.fadeIn !== undefined || value.fadeOut !== undefined, 'set_audio_fade requires fadeIn or fadeOut');
export const setAudioPanSourceOperationSchema = z.object({ op: z.literal('set_audio_pan'), audioRegionId: opaqueIdSchema, pan: z.number().finite().min(-1).max(1) }).strict();
export const setAudioAutomationSourceOperationSchema = z.object({
  op: z.literal('set_audio_automation'),
  animationId: opaqueIdSchema,
  audioRegionId: opaqueIdSchema,
  keyframes: z.array(keyframeSchema).min(1),
}).strict();

const plannedSchemas = {
  delete_clip: z.object({ op: z.literal('delete_clip'), ...clipId }).strict(),
  split_clip: z.object({ op: z.literal('split_clip'), ...clipId, at: mediaTimeSchema }).strict(),
  duplicate_clip: z.object({ op: z.literal('duplicate_clip'), ...clipId, afterClipId: opaqueIdSchema.nullable(), createdClipId: opaqueIdSchema.optional() }).strict(),
  set_clip_transform: z.object({ op: z.literal('set_clip_transform'), ...clipId, transform: versionedParametersSchema }).strict(),
  set_clip_crop: z.object({ op: z.literal('set_clip_crop'), ...clipId, crop: versionedParametersSchema }).strict(),
  set_clip_opacity: z.object({ op: z.literal('set_clip_opacity'), ...clipId, opacity: z.number().min(0).max(1) }).strict(),
  add_effect: z.object({ op: z.literal('add_effect'), targetKind: z.enum(['CLIP', 'VISUAL_OBJECT', 'AUDIO_REGION', 'TRACK']), targetId: opaqueIdSchema, effectType: z.string().min(1), effectVersion: z.string().min(1), parameters: versionedParametersSchema }).strict(),
  update_effect: z.object({ op: z.literal('update_effect'), effectId: opaqueIdSchema, parameters: versionedParametersSchema.optional(), enabled: z.boolean().optional() }).strict().refine((value) => value.parameters !== undefined || value.enabled !== undefined, 'update_effect requires changes'),
  remove_effect: z.object({ op: z.literal('remove_effect'), effectId: opaqueIdSchema }).strict(),
  create_track: z.object({ op: z.literal('create_track'), sequenceId: opaqueIdSchema, track: createTrackRequestSchema }).strict(),
  move_track: z.object({ op: z.literal('move_track'), trackId: opaqueIdSchema, position: z.number().int().nonnegative() }).strict(),
  delete_track: z.object({ op: z.literal('delete_track'), trackId: opaqueIdSchema, nonEmptyPolicy: z.enum(['REJECT', 'MOVE_CLIPS']), destinationTrackId: opaqueIdSchema.nullable() }).strict().superRefine((value, context) => {
    if ((value.nonEmptyPolicy === 'MOVE_CLIPS') !== (value.destinationTrackId !== null)) context.addIssue({ code: 'custom', path: ['destinationTrackId'], message: 'MOVE_CLIPS requires exactly one destination track' });
  }),
  add_marker: z.object({ op: z.literal('add_marker'), markerId: opaqueIdSchema.optional(), timeBinding: timeBindingSchema, time: mediaTimeSchema, label: z.string().max(500) }).strict(),
  update_marker: z.object({ op: z.literal('update_marker'), markerId: opaqueIdSchema, timeBinding: timeBindingSchema.optional(), time: mediaTimeSchema.optional(), label: z.string().max(500).optional() }).strict().refine((value) => value.timeBinding !== undefined || value.time !== undefined || value.label !== undefined, 'update_marker requires changes'),
  remove_marker: z.object({ op: z.literal('remove_marker'), markerId: opaqueIdSchema }).strict(),
  update_caption_segment: z.object({ op: z.literal('update_caption_segment'), captionId: opaqueIdSchema, text: z.string().optional(), range: mediaRangeSchema.optional(), position: versionedParametersSchema.optional() }).strict().refine((value) => value.text !== undefined || value.range !== undefined || value.position !== undefined, 'update_caption_segment requires changes'),
  regenerate_region: z.object({ op: z.literal('regenerate_region'), targetRefs: z.array(opaqueIdSchema).min(1), sequenceRange: mediaRangeSchema, constraints: z.record(z.string(), z.unknown()) }).strict(),
  replace_region: z.object({ op: z.literal('replace_region'), targetRefs: z.array(opaqueIdSchema).min(1), derivedAssetVersionId: opaqueIdSchema, sequenceRange: mediaRangeSchema, sourceRange: mediaRangeSchema }).strict(),
  create_preview_branch: z.object({ op: z.literal('create_preview_branch'), baseProjectRevision: z.number().int().positive(), operation: z.record(z.string(), z.unknown()) }).strict(),
  commit_preview_branch: z.object({ op: z.literal('commit_preview_branch'), previewBranchId: opaqueIdSchema }).strict(),
  discard_preview_branch: z.object({ op: z.literal('discard_preview_branch'), previewBranchId: opaqueIdSchema, reason: z.string().max(500).optional() }).strict(),
} as const;

export const EDIT_OPERATION_V2_INPUT_SCHEMAS: Readonly<Record<SourceEditOperationType, z.ZodType>> = {
  insert_clip: insertClipOperationSchema,
  delete_clip: plannedSchemas.delete_clip,
  move_clip: moveClipSourceOperationSchema,
  trim_clip: trimClipSourceOperationSchema,
  split_clip: plannedSchemas.split_clip,
  duplicate_clip: plannedSchemas.duplicate_clip,
  slip_clip: slipClipSourceOperationSchema,
  set_clip_transform: plannedSchemas.set_clip_transform,
  set_clip_crop: plannedSchemas.set_clip_crop,
  set_clip_opacity: plannedSchemas.set_clip_opacity,
  set_clip_speed: setClipSpeedSourceOperationSchema,
  add_effect: plannedSchemas.add_effect,
  update_effect: plannedSchemas.update_effect,
  remove_effect: plannedSchemas.remove_effect,
  add_keyframe: keyframeSourceOperationSchema,
  update_keyframe: keyframeSourceOperationSchema,
  remove_keyframe: keyframeSourceOperationSchema,
  create_track: plannedSchemas.create_track,
  move_track: plannedSchemas.move_track,
  delete_track: plannedSchemas.delete_track,
  set_audio_gain: setAudioGainSourceOperationSchema,
  set_audio_fade: setAudioFadeSourceOperationSchema,
  set_audio_pan: setAudioPanSourceOperationSchema,
  set_audio_automation: setAudioAutomationSourceOperationSchema,
  add_marker: plannedSchemas.add_marker,
  update_marker: plannedSchemas.update_marker,
  remove_marker: plannedSchemas.remove_marker,
  update_caption_segment: plannedSchemas.update_caption_segment,
  regenerate_region: plannedSchemas.regenerate_region,
  replace_region: plannedSchemas.replace_region,
  create_preview_branch: plannedSchemas.create_preview_branch,
  commit_preview_branch: plannedSchemas.commit_preview_branch,
  discard_preview_branch: plannedSchemas.discard_preview_branch,
};

const alias = (
  operation: SourceEditOperationType,
  canonicalOperation: EditOperationType,
  targetKinds: EditOperationV2Registration['targetKinds'],
  readSet: string[],
  writeSet: string[],
  options: { limitations?: string[]; plannedTask?: string } = {},
): EditOperationV2Registration => ({
  operation, schemaVersion: '1.0', resolution: 'COMPILED_ALIAS', category: 'EDIT', canonicalOperation,
  targetKinds, inputSchemaId: `ancs.edit-operation-v2.${operation}.1.0`, requiredPermission: 'project:write',
  readSet, writeSet, preconditions: ['TARGET_EXISTS', 'PROJECT_REVISION_MATCHES', 'OBJECT_LOCKS_ALLOW_CHANGE'],
  postconditions: ['CANONICAL_EDIT_VALIDATED', 'PROJECT_REVISION_ADVANCES'], costCategory: 'LOCAL',
  compensation: 'CANONICAL_EDIT_EVENT_INVERSE', supportedBackends: ['LEGACY_SCENE'], plannedTask: null,
  limitations: options.limitations ?? [], testIds: ['N01-11_CONTRACT', 'N01-11_ALIAS_INTEGRATION'],
  ...(options.plannedTask === undefined ? {} : { plannedTask: options.plannedTask }),
});
/** NATIVE：源操作本身即权威操作（在 PROJECT_DOCUMENT_V2 后端原生执行，无别名编译）。 */
const native = (
  operation: SourceEditOperationType & EditOperationType,
  targetKinds: EditOperationV2Registration['targetKinds'],
  readSet: string[],
  writeSet: string[],
  testIds: string[] = ['N01-11_CONTRACT', 'N03-01_NATIVE_INTEGRATION'],
): EditOperationV2Registration => ({
  operation, schemaVersion: '1.0', resolution: 'NATIVE', category: 'EDIT', canonicalOperation: operation,
  targetKinds, inputSchemaId: `ancs.edit-operation-v2.${operation}.1.0`, requiredPermission: 'project:write',
  readSet, writeSet, preconditions: ['TARGET_EXISTS', 'PROJECT_REVISION_MATCHES', 'OBJECT_LOCKS_ALLOW_CHANGE'],
  postconditions: ['CANONICAL_EDIT_VALIDATED', 'PROJECT_REVISION_ADVANCES'], costCategory: 'LOCAL',
  compensation: 'CANONICAL_EDIT_EVENT_INVERSE', supportedBackends: ['PROJECT_DOCUMENT_V2'], plannedTask: null,
  limitations: [], testIds,
});
const planned = (
  operation: SourceEditOperationType,
  category: EditOperationV2Category,
  targetKinds: EditOperationV2Registration['targetKinds'],
  plannedTask: string,
  costCategory: EditOperationV2Registration['costCategory'] = 'LOCAL',
): EditOperationV2Registration => ({
  operation, schemaVersion: '1.0', resolution: 'PLANNED', category, canonicalOperation: null,
  targetKinds, inputSchemaId: `ancs.edit-operation-v2.${operation}.1.0`, requiredPermission: 'project:write',
  readSet: ['PROJECT_DOCUMENT'], writeSet: ['PROJECT_DOCUMENT'], preconditions: ['IMPLEMENTATION_AVAILABLE'],
  postconditions: ['NO_EMPTY_SUCCESS'], costCategory, compensation: 'PLANNED_WITH_OWNING_TASK',
  supportedBackends: category === 'PREVIEW_COMMAND' ? ['PROPOSAL_SERVICE'] : ['PROJECT_DOCUMENT_V2'],
  limitations: ['NO_EXECUTABLE_HANDLER'], testIds: ['N01-11_CONTRACT', 'N01-11_FAIL_CLOSED'], plannedTask,
});

export const EDIT_OPERATION_V2_REGISTRY: Readonly<Record<SourceEditOperationType, EditOperationV2Registration>> = {
  insert_clip: native('insert_clip', ['SEQUENCE', 'TRACK', 'CLIP'], ['SEQUENCE', 'TRACK', 'CLIP'], ['CLIP', 'SEQUENCE'], ['N01-11_CONTRACT', 'N03-01_NATIVE_INTEGRATION']),
  delete_clip: planned('delete_clip', 'EDIT', ['CLIP'], 'N03-02'),
  move_clip: alias('move_clip', 'update_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP']),
  trim_clip: alias('trim_clip', 'update_clip', ['CLIP'], ['CLIP'], ['CLIP']),
  split_clip: planned('split_clip', 'EDIT', ['CLIP'], 'N03-02'),
  duplicate_clip: planned('duplicate_clip', 'EDIT', ['CLIP'], 'N03-02'),
  slip_clip: alias('slip_clip', 'update_clip', ['CLIP'], ['CLIP'], ['CLIP']),
  set_clip_transform: planned('set_clip_transform', 'EDIT', ['CLIP', 'EFFECT_INSTANCE'], 'N03-05'),
  set_clip_crop: planned('set_clip_crop', 'EDIT', ['CLIP', 'EFFECT_INSTANCE'], 'N03-05'),
  set_clip_opacity: planned('set_clip_opacity', 'EDIT', ['CLIP', 'EFFECT_INSTANCE'], 'N03-05'),
  set_clip_speed: alias('set_clip_speed', 'update_clip', ['CLIP'], ['CLIP'], ['CLIP'], { limitations: ['CONSTANT_LINEAR_REVERSE_ONLY'], plannedTask: 'N11-02' }),
  add_effect: planned('add_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  update_effect: planned('update_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  remove_effect: planned('remove_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  add_keyframe: alias('add_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-01' }),
  update_keyframe: alias('update_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-01' }),
  remove_keyframe: alias('remove_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['FINAL_KEYFRAME_REQUIRES_BINDING_REMOVAL'], plannedTask: 'N11-01' }),
  create_track: planned('create_track', 'EDIT', ['SEQUENCE', 'TRACK'], 'N03-04'),
  move_track: planned('move_track', 'EDIT', ['TRACK'], 'N03-04'),
  delete_track: planned('delete_track', 'EDIT', ['TRACK'], 'N03-04'),
  set_audio_gain: alias('set_audio_gain', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  set_audio_fade: alias('set_audio_fade', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  set_audio_pan: alias('set_audio_pan', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  set_audio_automation: alias('set_audio_automation', 'update_animation', ['AUDIO_REGION', 'ANIMATION_BINDING'], ['AUDIO_REGION', 'ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['EXISTING_AUTOMATION_BINDING_REQUIRED', 'LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-08' }),
  add_marker: planned('add_marker', 'EDIT', ['MARKER'], 'N03-09'),
  update_marker: planned('update_marker', 'EDIT', ['MARKER'], 'N03-09'),
  remove_marker: planned('remove_marker', 'EDIT', ['MARKER'], 'N03-09'),
  update_caption_segment: planned('update_caption_segment', 'EDIT', ['CAPTION_SEGMENT'], 'N03-07'),
  regenerate_region: planned('regenerate_region', 'ASYNC_COMMAND', ['REGION'], 'N08-09', 'PROVIDER_ESTIMATE_REQUIRED'),
  replace_region: planned('replace_region', 'EDIT', ['REGION'], 'N08-09'),
  create_preview_branch: planned('create_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-10'),
  commit_preview_branch: planned('commit_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-11'),
  discard_preview_branch: planned('discard_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-10'),
};

export const canonicalEditOperationSchema = editOperationSchema;
