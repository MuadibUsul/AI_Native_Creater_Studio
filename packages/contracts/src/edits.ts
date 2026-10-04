import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { revisionSchema } from './common/revision.js';
import { durationMsSchema, videoMsSchema } from './common/time.js';
import { dataBindingSchema, providerRequirementSchema, sourceBindingSchema } from './scene-graph.js';

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
  'restore_scene',
  'restore_project_version',
] as const;

export type EditOperationType = (typeof EDIT_OPERATION_TYPES)[number];

const changesSchema = z.record(z.string(), z.unknown());

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
});

export const updateProjectOperationSchema = z.object({
  op: z.literal('update_project'),
  changes: changesSchema,
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
});

export const updateSceneOperationSchema = z.object({
  op: z.literal('update_scene'),
  sceneId: opaqueIdSchema,
  changes: changesSchema,
});

export const deleteSceneOperationSchema = z.object({
  op: z.literal('delete_scene'),
  sceneId: opaqueIdSchema,
});

export const duplicateSceneOperationSchema = z.object({
  op: z.literal('duplicate_scene'),
  sceneId: opaqueIdSchema,
  afterSceneId: opaqueIdSchema.nullable().default(null),
});

export const splitSceneOperationSchema = z.object({
  op: z.literal('split_scene'),
  sceneId: opaqueIdSchema,
  atMs: videoMsSchema,
});

export const reorderScenesOperationSchema = z.object({
  op: z.literal('reorder_scenes'),
  /** 完整的场景顺序（必须包含当前全部场景 ID，否则由处理器拒绝） */
  orderedSceneIds: z.array(opaqueIdSchema).min(1),
});

export const replaceAssetOperationSchema = z.object({
  op: z.literal('replace_asset'),
  sceneId: opaqueIdSchema,
  role: z.string().min(1),
  newAssetId: opaqueIdSchema,
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
  restoreSceneOperationSchema,
  restoreProjectVersionOperationSchema,
]);

export type EditOperation = z.infer<typeof editOperationSchema>;

/** 每个修改请求的公共外壳（§4.6） */
export const editRequestSchema = z.object({
  baseProjectRevision: revisionSchema,
  /** sceneId → 客户端上次见到的 revision（未涉及的 Scene 可省略） */
  expectedSceneRevisions: z.record(opaqueIdSchema, revisionSchema).default({}),
  operations: z.array(editOperationSchema).min(1),
  /** 幂等键：同一 key + 同一请求摘要返回原结果；同 key 不同请求返回 IDEMPOTENCY_CONFLICT */
  idempotencyKey: z.string().min(8).max(200),
});

export type EditRequest = z.infer<typeof editRequestSchema>;
