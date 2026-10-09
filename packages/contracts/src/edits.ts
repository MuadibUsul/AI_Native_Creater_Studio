import { z } from 'zod';
import { assetRoleSchema } from './assets.js';
import { idempotencyKeySchema } from './common/http.js';
import { opaqueIdSchema } from './common/ids.js';
import { revisionSchema } from './common/revision.js';
import { durationMsSchema, videoMsSchema } from './common/time.js';
import {
  assetBindingSchema,
  dataBindingSchema,
  providerRequirementSchema,
  sceneTransitionSchema,
  sourceBindingSchema,
} from './scene-graph.js';
import { setObjectLockOperationSchema } from './object-locks.js';
import {
  applyAudioCrossfadeOperationSchema,
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
  updateAnimationOperationSchema,
  updateAudioRegionOperationSchema,
  updateClipOperationSchema,
} from './composition-edits.js';

/**
 * 编辑协议契约（计划 §4.6）：客户端不得提交任意数据库补丁，只能提交显式类型的操作。
 *
 * 请求处理顺序（实现侧，P02-02）：身份/权限 → Schema 校验 → 幂等键与请求摘要 →
 * 加载聚合与预期 revision → Lock/引用/合法性检查 → 派生影响与失效范围 →
 * 事务提交（新状态 + revision + EditEvent + Outbox）→ 返回服务器权威结果。
 *
 * TODO(P02-02)：各操作的 payload 字段可能**增量扩展**（只增不改名），届时补充语义与校验；
 *   insert_scene 的 sceneDraft 细化、update_script 的块级定位方式在 P02-02 随实现定稿。
 */

export const EDIT_OPERATION_TYPES = [
  'update_project',
  'update_script',
  'insert_scene',
  'update_scene',
  'delete_scene',
  'duplicate_scene',
  'split_scene',
  'reorder_scenes',
  'replace_asset',
  'update_caption',
  'update_audio_track',
  'set_scene_lock',
  'set_object_lock',
  'insert_clip',
  'delete_clip',
  'split_clip',
  'trim_clip',
  'move_clip',
  'duplicate_clip',
  'replace_clip_source',
  'slip_clip',
  'slide_clip',
  'roll_clip',
  'ripple_clip',
  'split_av_cut',
  'create_track',
  'move_track',
  'delete_track',
  'update_track',
  'set_av_link',
  'set_clip_transform',
  'set_clip_crop',
  'set_clip_opacity',
  'apply_audio_crossfade',
  'update_clip',
  'update_animation',
  'update_audio_region',
  'restore_scene',
  'restore_project_version',
] as const;

export type EditOperationType = (typeof EDIT_OPERATION_TYPES)[number];

export const EDIT_EXECUTION_BACKENDS = ['LEGACY_SCENE'] as const;
export const editExecutionBackendSchema = z.enum(EDIT_EXECUTION_BACKENDS);
export const EDIT_OPERATION_AVAILABILITIES = ['ACTIVE', 'PLANNED'] as const;
export const editOperationAvailabilitySchema = z.enum(EDIT_OPERATION_AVAILABILITIES);
export const EDIT_COMPENSATION_MODES = ['EVENT_INVERSE', 'SNAPSHOT_RESTORE', 'PLANNED'] as const;
export const editCompensationModeSchema = z.enum(EDIT_COMPENSATION_MODES);

export const editOperationDefinitionSchema = z.object({
  operation: z.enum(EDIT_OPERATION_TYPES),
  availability: editOperationAvailabilitySchema,
  plannedPhase: z.string().nullable(),
  requiredPermission: z.literal('project:write'),
  actorTypes: z.array(z.enum(['USER', 'AI', 'SYSTEM'])).min(1),
  supportedBackends: z.array(editExecutionBackendSchema).min(1),
  structural: z.boolean(),
  readSet: z.array(z.string().min(1)),
  writeSet: z.array(z.string().min(1)),
  preconditions: z.array(z.string().min(1)),
  postconditions: z.array(z.string().min(1)),
  invalidates: z.array(z.string().min(1)),
  compensation: editCompensationModeSchema,
}).strict();

export type EditExecutionBackend = z.infer<typeof editExecutionBackendSchema>;
export type EditOperationDefinition = z.infer<typeof editOperationDefinitionSchema>;

const common: Pick<EditOperationDefinition, 'requiredPermission' | 'actorTypes' | 'supportedBackends' | 'invalidates'> = {
  requiredPermission: 'project:write' as const,
  actorTypes: ['USER', 'AI', 'SYSTEM'],
  supportedBackends: ['LEGACY_SCENE'],
  invalidates: ['PROJECT_PREVIEW', 'RENDER_APPROVAL'],
};

/** Server-owned operation registry shared by GUI, AI planning and execution. */
export const EDIT_OPERATION_REGISTRY: Readonly<Record<EditOperationType, EditOperationDefinition>> = {
  update_project: { ...common, operation: 'update_project', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['PROJECT'], writeSet: ['PROJECT'], preconditions: ['PROJECT_EXISTS'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  update_script: { ...common, operation: 'update_script', availability: 'PLANNED', plannedPhase: 'P04（Script/ContentBlock 模型）', structural: false, readSet: ['CONTENT_BLOCK'], writeSet: ['CONTENT_BLOCK'], preconditions: ['CONTENT_BLOCK_EXISTS'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'PLANNED' },
  insert_scene: { ...common, operation: 'insert_scene', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['PROJECT', 'SCENE_ORDER'], writeSet: ['SCENE', 'SCENE_ORDER'], preconditions: ['AFTER_SCENE_EXISTS', 'CREATED_ID_AVAILABLE'], postconditions: ['CREATED_SCENE_REFERENCE_AVAILABLE', 'TIMELINE_RECOMPUTED'], compensation: 'EVENT_INVERSE' },
  update_scene: { ...common, operation: 'update_scene', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['SCENE'], writeSet: ['SCENE'], preconditions: ['SCENE_EXISTS', 'SCENE_UNLOCKED', 'EXPECTED_REVISION_MATCHES'], postconditions: ['SCENE_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  delete_scene: { ...common, operation: 'delete_scene', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SCENE', 'SCENE_ORDER'], writeSet: ['SCENE', 'SCENE_ORDER'], preconditions: ['SCENE_EXISTS', 'SCENE_UNLOCKED', 'EXPECTED_REVISION_MATCHES'], postconditions: ['SCENE_REFERENCE_REMOVED', 'TIMELINE_RECOMPUTED'], compensation: 'EVENT_INVERSE' },
  duplicate_scene: { ...common, operation: 'duplicate_scene', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SCENE', 'SCENE_ORDER'], writeSet: ['SCENE', 'SCENE_ORDER'], preconditions: ['SOURCE_SCENE_EXISTS', 'AFTER_SCENE_EXISTS', 'CREATED_ID_AVAILABLE'], postconditions: ['CREATED_SCENE_REFERENCE_AVAILABLE', 'TIMELINE_RECOMPUTED'], compensation: 'EVENT_INVERSE' },
  split_scene: { ...common, operation: 'split_scene', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SCENE', 'SCENE_ORDER'], writeSet: ['SCENE', 'SCENE_ORDER'], preconditions: ['SCENE_EXISTS', 'SCENE_UNLOCKED', 'SPLIT_INSIDE_RANGE', 'CREATED_ID_AVAILABLE'], postconditions: ['CREATED_SCENE_REFERENCE_AVAILABLE', 'TIMELINE_RECOMPUTED'], compensation: 'EVENT_INVERSE' },
  reorder_scenes: { ...common, operation: 'reorder_scenes', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SCENE_ORDER'], writeSet: ['SCENE_ORDER'], preconditions: ['ORDER_CONTAINS_CANDIDATE_SCENES_EXACTLY_ONCE'], postconditions: ['TIMELINE_RECOMPUTED'], compensation: 'EVENT_INVERSE' },
  replace_asset: { ...common, operation: 'replace_asset', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['SCENE', 'ASSET'], writeSet: ['SCENE.ASSET_BINDINGS'], preconditions: ['SCENE_EXISTS', 'SCENE_UNLOCKED', 'ASSET_BINDABLE', 'EXPECTED_REVISION_MATCHES'], postconditions: ['SCENE_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  update_caption: { ...common, operation: 'update_caption', availability: 'PLANNED', plannedPhase: 'P06-06（字幕）', structural: false, readSet: ['CAPTION_SPAN'], writeSet: ['CAPTION_SPAN'], preconditions: ['CAPTION_EXISTS'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'PLANNED' },
  update_audio_track: { ...common, operation: 'update_audio_track', availability: 'PLANNED', plannedPhase: 'P06-06（混音）', structural: false, readSet: ['AUDIO_REGION'], writeSet: ['AUDIO_REGION'], preconditions: ['AUDIO_REGION_EXISTS'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'PLANNED' },
  set_scene_lock: { ...common, operation: 'set_scene_lock', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['SCENE'], writeSet: ['SCENE.LOCK'], preconditions: ['SCENE_EXISTS', 'EXPECTED_REVISION_MATCHES'], postconditions: ['SCENE_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  set_object_lock: { ...common, operation: 'set_object_lock', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['OBJECT_LOCK'], writeSet: ['OBJECT_LOCK'], preconditions: ['LOCK_TARGET_EXISTS'], postconditions: ['LOCK_STATE_UPDATED'], invalidates: [], compensation: 'EVENT_INVERSE' },
  update_clip: { ...common, operation: 'update_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP'], preconditions: ['CLIP_EXISTS', 'PROJECT_REVISION_MATCHES', 'RESULTING_CLIP_VALID'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  insert_clip: { ...common, operation: 'insert_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SEQUENCE', 'TRACK', 'CLIP', 'ASSET_VERSION'], writeSet: ['CLIP', 'CLIP_ORDER', 'SEQUENCE'], preconditions: ['SEQUENCE_EXISTS', 'TRACK_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SOURCE_VERSION_READY', 'RESULTING_CLIP_VALID'], postconditions: ['CREATED_CLIP_REFERENCE_AVAILABLE', 'TIMELINE_RECOMPUTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  delete_clip: { ...common, operation: 'delete_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED'], postconditions: ['CLIP_REFERENCE_REMOVED', 'TIMELINE_RECOMPUTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  split_clip: { ...common, operation: 'split_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'ANIMATION_BINDING'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SPLIT_POINT_INSIDE_CLIP', 'SOURCE_SPLIT_REPRESENTABLE'], postconditions: ['CLIP_REFERENCE_AVAILABLE', 'RANGES_CONSERVED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  trim_clip: { ...common, operation: 'trim_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'ASSET_VERSION', 'ANIMATION_BINDING'], writeSet: ['CLIP'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SOURCE_VERSION_READY', 'RESULTING_CLIP_VALID'], postconditions: ['TIMELINE_RECOMPUTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  move_clip: { ...common, operation: 'move_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'SEQUENCE', 'ANIMATION_BINDING'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'TARGET_TRACK_KIND_MATCHES', 'RESULTING_CLIP_VALID'], postconditions: ['TIMELINE_RECOMPUTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  duplicate_clip: { ...common, operation: 'duplicate_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'ASSET_VERSION'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SOURCE_VERSION_READY'], postconditions: ['CREATED_CLIP_REFERENCE_AVAILABLE', 'SOURCE_BINARY_UNTOUCHED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  slip_clip: { ...common, operation: 'slip_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'ASSET_VERSION'], writeSet: ['CLIP'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SOURCE_VERSION_READY', 'RESULTING_CLIP_VALID'], postconditions: ['SOURCE_IN_OUT_SLIPPED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  slide_clip: { ...common, operation: 'slide_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'ADJACENT_NEIGHBORS_EXIST', 'NEIGHBOR_HANDLES_AVAILABLE'], postconditions: ['TOTAL_DURATION_CONSERVED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  roll_clip: { ...common, operation: 'roll_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP'], preconditions: ['CLIPS_ADJACENT', 'TARGET_TRACK_UNLOCKED', 'NEIGHBOR_HANDLES_AVAILABLE'], postconditions: ['COMBINED_DURATION_CONSERVED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  ripple_clip: { ...common, operation: 'ripple_clip', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'SEQUENCE'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'EXPLICIT_RIPPLE_REQUESTED'], postconditions: ['GAP_CLOSED', 'SHIFTED_CLIPS_REPORTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  create_track: { ...common, operation: 'create_track', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SEQUENCE', 'TRACK'], writeSet: ['TRACK', 'CLIP_ORDER'], preconditions: ['SEQUENCE_EXISTS', 'TRACK_POSITION_AVAILABLE'], postconditions: ['TRACK_AVAILABLE', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  move_track: { ...common, operation: 'move_track', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['TRACK'], writeSet: ['TRACK', 'CLIP_ORDER'], preconditions: ['TRACK_EXISTS'], postconditions: ['TRACK_ORDER_UPDATED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  delete_track: { ...common, operation: 'delete_track', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['TRACK', 'CLIP'], writeSet: ['TRACK', 'CLIP', 'CLIP_ORDER'], preconditions: ['TRACK_EXISTS', 'NON_EMPTY_POLICY_SATISFIED'], postconditions: ['TRACK_REMOVED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  update_track: { ...common, operation: 'update_track', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['TRACK'], writeSet: ['TRACK'], preconditions: ['TRACK_EXISTS'], postconditions: ['TRACK_STATE_UPDATED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  set_clip_transform: { ...common, operation: 'set_clip_transform', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['CLIP'], writeSet: ['CLIP.PARAMETERS'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED'], postconditions: ['TRANSFORM_UPDATED', 'NO_REGENERATION_TRIGGERED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  set_clip_crop: { ...common, operation: 'set_clip_crop', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['CLIP'], writeSet: ['CLIP.PARAMETERS'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'CROP_AREA_NONEMPTY'], postconditions: ['CROP_UPDATED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  apply_audio_crossfade: { ...common, operation: 'apply_audio_crossfade', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['AUDIO_REGION', 'TRACK'], writeSet: ['AUDIO_REGION'], preconditions: ['REGIONS_ADJACENT', 'CROSSFADE_WITHIN_REGION_DURATION'], postconditions: ['NON_DESTRUCTIVE_CHAIN_ONLY', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  set_clip_opacity: { ...common, operation: 'set_clip_opacity', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['CLIP'], writeSet: ['CLIP.PARAMETERS'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED'], postconditions: ['OPACITY_UPDATED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  set_av_link: { ...common, operation: 'set_av_link', availability: 'ACTIVE', plannedPhase: null, structural: false, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP'], preconditions: ['CLIPS_EXIST', 'LINK_TARGETS_COMPATIBLE'], postconditions: ['AV_LINK_STATE_UPDATED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  split_av_cut: { ...common, operation: 'split_av_cut', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK'], writeSet: ['CLIP', 'CLIP_ORDER'], preconditions: ['CLIPS_AV_LINKED', 'CUT_POINTS_INSIDE_CLIPS', 'AUDIO_SOURCE_CONTINUITY'], postconditions: ['AUDIO_CLOCK_CONTINUOUS', 'SPLIT_POINTS_OFFSET_REPORTED', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  replace_clip_source: { ...common, operation: 'replace_clip_source', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['CLIP', 'TRACK', 'ASSET_VERSION', 'SEQUENCE'], writeSet: ['CLIP'], preconditions: ['CLIP_EXISTS', 'TARGET_TRACK_UNLOCKED', 'SOURCE_VERSION_READY', 'SOURCE_DURATION_MATCHES', 'RESULTING_CLIP_VALID'], postconditions: ['SOURCE_REFERENCE_SWAPPED', 'APPROVAL_STALENESS_ADVANCES', 'PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  update_animation: { ...common, operation: 'update_animation', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['ANIMATION_BINDING'], writeSet: ['ANIMATION_BINDING.KEYFRAMES'], preconditions: ['ANIMATION_EXISTS', 'TARGET_MATCHES', 'PROJECT_REVISION_MATCHES'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  update_audio_region: { ...common, operation: 'update_audio_region', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['AUDIO_REGION', 'TRACK'], writeSet: ['AUDIO_REGION'], preconditions: ['AUDIO_REGION_EXISTS', 'PROJECT_REVISION_MATCHES', 'RESULTING_AUDIO_REGION_VALID'], postconditions: ['PROJECT_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  restore_scene: { ...common, operation: 'restore_scene', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['SCENE', 'EDIT_EVENT'], writeSet: ['SCENE'], preconditions: ['SCENE_EXISTS', 'SCENE_UNLOCKED', 'TARGET_REVISION_REPLAYABLE'], postconditions: ['SCENE_REVISION_ADVANCES'], compensation: 'EVENT_INVERSE' },
  restore_project_version: { ...common, operation: 'restore_project_version', availability: 'ACTIVE', plannedPhase: null, structural: true, readSet: ['PROJECT_VERSION'], writeSet: ['PROJECT', 'SCENE', 'SCENE_ORDER'], preconditions: ['EXCLUSIVE_BATCH', 'PROJECT_VERSION_EXISTS'], postconditions: ['PROJECT_REVISION_ADVANCES', 'TIMELINE_RECOMPUTED'], compensation: 'SNAPSHOT_RESTORE' },
};

const changesSchema = z.record(z.string(), z.unknown());

/**
 * 类型化的变更补丁（§4.6：不允许客户端提交任意数据库补丁）：
 * 仅白名单字段可改；strict() 拒绝未知字段。
 */
export const projectChangesSchema = z
  .object({
    title: z.string().min(1).max(200),
    targetDurationMs: z.number().int().positive().nullable(),
  })
  .partial()
  .strict();

export type ProjectChanges = z.infer<typeof projectChangesSchema>;

export const sceneChangesSchema = z
  .object({
    narration: z.string(),
    visualIntent: z.string(),
    sceneType: z.string().min(1),
    semanticType: z.string().min(1),
    durationMs: durationMsSchema,
    componentId: z.string().nullable(),
    componentVersion: z.string().nullable(),
    props: z.record(z.string(), z.unknown()),
    providerRequirement: providerRequirementSchema.nullable(),
    transition: sceneTransitionSchema,
    sourceBindings: z.array(sourceBindingSchema),
    dataBindings: z.array(dataBindingSchema),
  })
  .partial()
  .strict();

export type SceneChanges = z.infer<typeof sceneChangesSchema>;

/** 插入场景时的草稿（可复用部分保留：组件/Provider 需求/绑定与叙事信息） */
export const sceneDraftSchema = z.object({
  sceneType: z.string().min(1),
  semanticType: z.string().min(1),
  narration: z.string().default(''),
  visualIntent: z.string().default(''),
  durationMs: durationMsSchema,
  componentId: z.string().nullable().default(null),
  componentVersion: z.string().nullable().default(null),
  props: z.record(z.string(), z.unknown()).default({}),
  providerRequirement: providerRequirementSchema.nullable().default(null),
  sourceBindings: z.array(sourceBindingSchema).default([]),
  dataBindings: z.array(dataBindingSchema).default([]),
  /** Scene 资产绑定（P02-04；撤销"删除 Scene"时一并还原） */
  assetBindings: z.array(assetBindingSchema).default([]),
  /** 来源旁白块（逻辑 ID；P04-05 Director 建立 旁白 ↔ Scene 关联，锁定旁白据此校验） */
  narrationBlockIds: z.array(opaqueIdSchema).default([]),
  /** 锁定场景（P04-05：锁定旁白 → 锁定场景；AI 不得静默修改，§4.7） */
  locked: z.boolean().default(false),
});

export const updateProjectOperationSchema = z.object({
  op: z.literal('update_project'),
  changes: projectChangesSchema,
});

export const updateScriptOperationSchema = z.object({
  op: z.literal('update_script'),
  /** 目标旁白块（null 表示整稿级变更，例如重排章节） */
  narrationBlockId: opaqueIdSchema.nullable().default(null),
  changes: changesSchema,
});

export const insertSceneOperationSchema = z.object({
  op: z.literal('insert_scene'),
  /** 插入到该 Scene 之后；null 表示插入到开头 */
  afterSceneId: opaqueIdSchema.nullable().default(null),
  sceneDraft: sceneDraftSchema,
  /**
   * 补偿专用（Undo/Redo）：复用原 Scene id，保持历史事件/引用一致；
   * 普通客户端不提供（由服务端生成）；提供且 id 已被占用时拒绝。
   */
  restoreSceneId: opaqueIdSchema.optional(),
  /** Public batch-local identity. Later operations in the same request may reference it. */
  createdSceneId: opaqueIdSchema.optional(),
}).superRefine((value, context) => {
  if (value.createdSceneId !== undefined && value.restoreSceneId !== undefined) {
    context.addIssue({ code: 'custom', message: 'createdSceneId and restoreSceneId are mutually exclusive' });
  }
});

export const updateSceneOperationSchema = z.object({
  op: z.literal('update_scene'),
  sceneId: opaqueIdSchema,
  changes: sceneChangesSchema,
});

export const deleteSceneOperationSchema = z.object({
  op: z.literal('delete_scene'),
  sceneId: opaqueIdSchema,
});

export const duplicateSceneOperationSchema = z.object({
  op: z.literal('duplicate_scene'),
  sceneId: opaqueIdSchema,
  afterSceneId: opaqueIdSchema.nullable().default(null),
  /** 补偿专用（Undo/Redo）：复用原副本 id */
  restoreSceneId: opaqueIdSchema.optional(),
  /** Public batch-local identity for the duplicate. */
  createdSceneId: opaqueIdSchema.optional(),
}).superRefine((value, context) => {
  if (value.createdSceneId !== undefined && value.restoreSceneId !== undefined) {
    context.addIssue({ code: 'custom', message: 'createdSceneId and restoreSceneId are mutually exclusive' });
  }
});

export const splitSceneOperationSchema = z.object({
  op: z.literal('split_scene'),
  sceneId: opaqueIdSchema,
  atMs: videoMsSchema,
  /** 补偿专用（Undo/Redo）：复用原尾部 Scene id */
  restoreTailSceneId: opaqueIdSchema.optional(),
  /** Public batch-local identity for the created tail Scene. */
  createdTailSceneId: opaqueIdSchema.optional(),
}).superRefine((value, context) => {
  if (value.createdTailSceneId !== undefined && value.restoreTailSceneId !== undefined) {
    context.addIssue({ code: 'custom', message: 'createdTailSceneId and restoreTailSceneId are mutually exclusive' });
  }
});

export const reorderScenesOperationSchema = z.object({
  op: z.literal('reorder_scenes'),
  /** 完整的场景顺序（必须包含当前全部场景 ID，否则由处理器拒绝） */
  orderedSceneIds: z.array(opaqueIdSchema).min(1),
});

export const replaceAssetOperationSchema = z.object({
  op: z.literal('replace_asset'),
  sceneId: opaqueIdSchema,
  /** 绑定角色（P02-04 定稿枚举） */
  role: assetRoleSchema,
  /** null = 解除该角色的绑定 */
  newAssetId: opaqueIdSchema.nullable(),
});

export const updateCaptionOperationSchema = z.object({
  op: z.literal('update_caption'),
  captionId: opaqueIdSchema,
  changes: changesSchema,
});

export const updateAudioTrackOperationSchema = z.object({
  op: z.literal('update_audio_track'),
  trackId: opaqueIdSchema,
  changes: changesSchema,
});

export const setSceneLockOperationSchema = z.object({
  op: z.literal('set_scene_lock'),
  sceneId: opaqueIdSchema,
  locked: z.boolean(),
});

export const restoreSceneOperationSchema = z.object({
  op: z.literal('restore_scene'),
  sceneId: opaqueIdSchema,
  toRevision: revisionSchema,
});

export const restoreProjectVersionOperationSchema = z.object({
  op: z.literal('restore_project_version'),
  versionId: opaqueIdSchema,
});

export const editOperationSchema = z.discriminatedUnion('op', [
  updateProjectOperationSchema,
  updateScriptOperationSchema,
  insertSceneOperationSchema,
  updateSceneOperationSchema,
  deleteSceneOperationSchema,
  duplicateSceneOperationSchema,
  splitSceneOperationSchema,
  reorderScenesOperationSchema,
  replaceAssetOperationSchema,
  updateCaptionOperationSchema,
  updateAudioTrackOperationSchema,
  setSceneLockOperationSchema,
  setObjectLockOperationSchema,
  insertClipOperationSchema,
  deleteClipOperationSchema,
  splitClipOperationSchema,
  trimClipOperationSchema,
  moveClipOperationSchema,
  duplicateClipOperationSchema,
  replaceClipSourceOperationSchema,
  rippleClipOperationSchema,
  rollClipOperationSchema,
  slideClipOperationSchema,
  slipClipOperationSchema,
  setAvLinkOperationSchema,
  setClipCropOperationSchema,
  setClipOpacityOperationSchema,
  setClipTransformOperationSchema,
  splitAvCutOperationSchema,
  applyAudioCrossfadeOperationSchema,
  createTrackOperationSchema,
  moveTrackOperationSchema,
  deleteTrackOperationSchema,
  updateTrackOperationSchema,
  updateClipOperationSchema,
  updateAnimationOperationSchema,
  updateAudioRegionOperationSchema,
  restoreSceneOperationSchema,
  restoreProjectVersionOperationSchema,
]);

export type EditOperation = z.infer<typeof editOperationSchema>;

/** 每个修改请求的公共外壳（§4.6） */
export const editRequestSchema = z.object({
  /** Omitted by legacy clients and interpreted as the current 1.0 contract. */
  schemaVersion: z.string().min(1).max(32).optional(),
  baseProjectRevision: revisionSchema,
  /** sceneId → 客户端上次见到的 revision（未涉及的 Scene 可省略） */
  expectedSceneRevisions: z.record(opaqueIdSchema, revisionSchema).default({}),
  operations: z.array(editOperationSchema).min(1),
  /** 幂等键：同一 key + 同一请求摘要返回原结果；同 key 不同请求返回 IDEMPOTENCY_CONFLICT */
  idempotencyKey: idempotencyKeySchema,
  /** 自然语言意图（可空；写入 EditEvent 供 History 展示，§5.7） */
  intent: z.string().max(500).optional(),
});

export type EditRequest = z.infer<typeof editRequestSchema>;
