import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { animationTargetKindSchema, keyframeSchema, timeBindingSchema, versionedParametersSchema } from './composition-objects.js';
import { clipTimeMappingSchema } from './composition.js';
import {
  applyAudioCrossfadeOperationSchema,
  cutCaptionRangeOperationSchema,
  splitCaptionOperationSchema,
  createTrackOperationSchema,
  setClipCropOperationSchema,
  setClipOpacityOperationSchema,
  setClipTransformOperationSchema,
  deleteClipOperationSchema,
  deleteTrackOperationSchema,
  duplicateClipOperationSchema,
  insertClipOperationSchema,
  moveClipOperationSchema,
  moveTrackOperationSchema,
  replaceClipSourceOperationSchema,
  rippleClipOperationSchema,
  rollClipOperationSchema,
  slideClipOperationSchema,
  setAvLinkOperationSchema,
  slipClipOperationSchema,
  splitAvCutOperationSchema,
  splitClipOperationSchema,
  trimClipOperationSchema,
  updateTrackOperationSchema,
} from './composition-edits.js';
import { EDIT_OPERATION_TYPES, editOperationSchema, type EditOperationType } from './edits.js';

export const SOURCE_EDIT_OPERATION_TYPES = [
  'insert_clip', 'delete_clip', 'move_clip', 'trim_clip', 'split_clip', 'duplicate_clip', 'replace_clip_source', 'slip_clip', 'slide_clip', 'roll_clip', 'ripple_clip', 'split_av_cut', 'update_track', 'set_av_link',
  'set_clip_transform', 'set_clip_crop', 'set_clip_opacity', 'set_clip_speed',
  'add_effect', 'update_effect', 'remove_effect',
  'add_keyframe', 'update_keyframe', 'remove_keyframe',
  'create_track', 'move_track', 'delete_track',
  'set_audio_gain', 'set_audio_fade', 'set_audio_pan', 'set_audio_automation', 'apply_audio_crossfade',
  'add_marker', 'update_marker', 'remove_marker',
  'update_caption_segment', 'cut_caption_range', 'split_caption', 'regenerate_region', 'replace_region',
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

/** N03-02 起 move_clip／trim_clip 由规范原语直接承载，这里保留导出名指向同一 schema（不再另立一套形状）。 */
export const moveClipSourceOperationSchema = moveClipOperationSchema;
export const trimClipSourceOperationSchema = trimClipOperationSchema;
/** N03-03 起 slip_clip 由规范原语直接承载，保留导出名指向同一 schema。 */
export const slipClipSourceOperationSchema = slipClipOperationSchema;
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
  add_effect: z.object({ op: z.literal('add_effect'), targetKind: z.enum(['CLIP', 'VISUAL_OBJECT', 'AUDIO_REGION', 'TRACK']), targetId: opaqueIdSchema, effectType: z.string().min(1), effectVersion: z.string().min(1), parameters: versionedParametersSchema }).strict(),
  update_effect: z.object({ op: z.literal('update_effect'), effectId: opaqueIdSchema, parameters: versionedParametersSchema.optional(), enabled: z.boolean().optional() }).strict().refine((value) => value.parameters !== undefined || value.enabled !== undefined, 'update_effect requires changes'),
  remove_effect: z.object({ op: z.literal('remove_effect'), effectId: opaqueIdSchema }).strict(),
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
  delete_clip: deleteClipOperationSchema,
  replace_clip_source: replaceClipSourceOperationSchema,
  move_clip: moveClipOperationSchema,
  trim_clip: trimClipOperationSchema,
  split_clip: splitClipOperationSchema,
  duplicate_clip: duplicateClipOperationSchema,
  slip_clip: slipClipOperationSchema,
  slide_clip: slideClipOperationSchema,
  roll_clip: rollClipOperationSchema,
  ripple_clip: rippleClipOperationSchema,
  split_av_cut: splitAvCutOperationSchema,
  set_clip_transform: setClipTransformOperationSchema,
  set_clip_crop: setClipCropOperationSchema,
  set_clip_opacity: setClipOpacityOperationSchema,
  set_clip_speed: setClipSpeedSourceOperationSchema,
  add_effect: plannedSchemas.add_effect,
  update_effect: plannedSchemas.update_effect,
  remove_effect: plannedSchemas.remove_effect,
  add_keyframe: keyframeSourceOperationSchema,
  update_keyframe: keyframeSourceOperationSchema,
  remove_keyframe: keyframeSourceOperationSchema,
  create_track: createTrackOperationSchema,
  move_track: moveTrackOperationSchema,
  delete_track: deleteTrackOperationSchema,
  update_track: updateTrackOperationSchema,
  set_av_link: setAvLinkOperationSchema,
  set_audio_gain: setAudioGainSourceOperationSchema,
  set_audio_fade: setAudioFadeSourceOperationSchema,
  set_audio_pan: setAudioPanSourceOperationSchema,
  set_audio_automation: setAudioAutomationSourceOperationSchema,
  apply_audio_crossfade: applyAudioCrossfadeOperationSchema,
  add_marker: plannedSchemas.add_marker,
  update_marker: plannedSchemas.update_marker,
  remove_marker: plannedSchemas.remove_marker,
  update_caption_segment: plannedSchemas.update_caption_segment,
  cut_caption_range: cutCaptionRangeOperationSchema,
  split_caption: splitCaptionOperationSchema,
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
  delete_clip: native('delete_clip', ['CLIP', 'TRACK'], ['CLIP'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-01_NATIVE_INTEGRATION', 'N03-02_NATIVE_INTEGRATION']),
  move_clip: native('move_clip', ['CLIP', 'TRACK', 'SEQUENCE'], ['CLIP', 'TRACK', 'SEQUENCE'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-02_NATIVE_INTEGRATION']),
  trim_clip: native('trim_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP'], ['N01-11_CONTRACT', 'N03-02_NATIVE_INTEGRATION']),
  split_clip: native('split_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-02_NATIVE_INTEGRATION']),
  duplicate_clip: native('duplicate_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-02_NATIVE_INTEGRATION']),
  replace_clip_source: native('replace_clip_source', ['CLIP', 'SEQUENCE'], ['CLIP', 'SEQUENCE'], ['CLIP'], ['N01-11_CONTRACT', 'N03-02_NATIVE_INTEGRATION']),
  slip_clip: native('slip_clip', ['CLIP'], ['CLIP'], ['CLIP'], ['N01-11_CONTRACT', 'N03-03_NATIVE_INTEGRATION']),
  slide_clip: native('slide_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-03_NATIVE_INTEGRATION']),
  roll_clip: native('roll_clip', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP'], ['N01-11_CONTRACT', 'N03-03_NATIVE_INTEGRATION']),
  ripple_clip: native('ripple_clip', ['CLIP', 'TRACK', 'SEQUENCE'], ['CLIP', 'TRACK', 'SEQUENCE'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-03_NATIVE_INTEGRATION']),
  split_av_cut: native('split_av_cut', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-03_NATIVE_INTEGRATION']),
  // N03-05：变换/裁切/透明度由规范原语直接承载（参数化修改，不重生成镜头）
  set_clip_transform: native('set_clip_transform', ['CLIP'], ['CLIP'], ['CLIP'], ['N01-11_CONTRACT', 'N03-05_NATIVE_INTEGRATION']),
  set_clip_crop: native('set_clip_crop', ['CLIP'], ['CLIP'], ['CLIP'], ['N01-11_CONTRACT', 'N03-05_NATIVE_INTEGRATION']),
  set_clip_opacity: native('set_clip_opacity', ['CLIP'], ['CLIP'], ['CLIP'], ['N01-11_CONTRACT', 'N03-05_NATIVE_INTEGRATION']),
  set_clip_speed: alias('set_clip_speed', 'update_clip', ['CLIP'], ['CLIP'], ['CLIP'], { limitations: ['CONSTANT_LINEAR_REVERSE_ONLY'], plannedTask: 'N11-02' }),
  add_effect: planned('add_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  update_effect: planned('update_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  remove_effect: planned('remove_effect', 'EDIT', ['EFFECT_INSTANCE'], 'N03-05'),
  add_keyframe: alias('add_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-01' }),
  update_keyframe: alias('update_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-01' }),
  remove_keyframe: alias('remove_keyframe', 'update_animation', ['ANIMATION_BINDING', 'KEYFRAME'], ['ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['FINAL_KEYFRAME_REQUIRES_BINDING_REMOVAL'], plannedTask: 'N11-01' }),
  // N03-04：轨道生命周期与轨道控制由规范原语直接承载
  create_track: native('create_track', ['SEQUENCE', 'TRACK'], ['SEQUENCE', 'TRACK'], ['TRACK', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-04_NATIVE_INTEGRATION']),
  move_track: native('move_track', ['TRACK'], ['TRACK'], ['TRACK', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-04_NATIVE_INTEGRATION']),
  delete_track: native('delete_track', ['TRACK', 'CLIP'], ['TRACK', 'CLIP'], ['TRACK', 'CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-04_NATIVE_INTEGRATION']),
  update_track: native('update_track', ['TRACK'], ['TRACK'], ['TRACK'], ['N01-11_CONTRACT', 'N03-04_NATIVE_INTEGRATION']),
  set_av_link: native('set_av_link', ['CLIP', 'TRACK'], ['CLIP', 'TRACK'], ['CLIP'], ['N01-11_CONTRACT', 'N03-04_NATIVE_INTEGRATION']),
  set_audio_gain: alias('set_audio_gain', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  set_audio_fade: alias('set_audio_fade', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  set_audio_pan: alias('set_audio_pan', 'update_audio_region', ['AUDIO_REGION'], ['AUDIO_REGION'], ['AUDIO_REGION']),
  apply_audio_crossfade: native('apply_audio_crossfade', ['AUDIO_REGION', 'TRACK'], ['AUDIO_REGION', 'TRACK'], ['AUDIO_REGION'], ['N01-11_CONTRACT', 'N03-06_NATIVE_INTEGRATION']),
  set_audio_automation: alias('set_audio_automation', 'update_animation', ['AUDIO_REGION', 'ANIMATION_BINDING'], ['AUDIO_REGION', 'ANIMATION_BINDING'], ['ANIMATION_BINDING'], { limitations: ['EXISTING_AUTOMATION_BINDING_REQUIRED', 'LINEAR_AND_HOLD_INTERPOLATION_ONLY'], plannedTask: 'N11-08' }),
  add_marker: planned('add_marker', 'EDIT', ['MARKER'], 'N03-09'),
  update_marker: planned('update_marker', 'EDIT', ['MARKER'], 'N03-09'),
  remove_marker: planned('remove_marker', 'EDIT', ['MARKER'], 'N03-09'),
  // N03-07：字幕段落编辑落到规范 update_caption；转写驱动剪辑是规范操作本身
  update_caption_segment: alias('update_caption_segment', 'update_caption', ['CAPTION_SEGMENT'], ['CAPTION'], ['CAPTION'], { limitations: ['TEXT_AND_RANGE_ONLY'], plannedTask: 'N11-13' }),
  cut_caption_range: native('cut_caption_range', ['CAPTION_SEGMENT', 'CLIP', 'TRACK'], ['CAPTION', 'CLIP', 'TRACK'], ['CAPTION', 'CLIP', 'CLIP_ORDER'], ['N01-11_CONTRACT', 'N03-07_NATIVE_INTEGRATION']),
  split_caption: native('split_caption', ['CAPTION_SEGMENT'], ['CAPTION'], ['CAPTION'], ['N01-11_CONTRACT', 'N03-07_NATIVE_INTEGRATION']),
  regenerate_region: planned('regenerate_region', 'ASYNC_COMMAND', ['REGION'], 'N08-09', 'PROVIDER_ESTIMATE_REQUIRED'),
  replace_region: planned('replace_region', 'EDIT', ['REGION'], 'N08-09'),
  create_preview_branch: planned('create_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-10'),
  commit_preview_branch: planned('commit_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-11'),
  discard_preview_branch: planned('discard_preview_branch', 'PREVIEW_COMMAND', ['PREVIEW_BRANCH'], 'N06-10'),
};

export const canonicalEditOperationSchema = editOperationSchema;
