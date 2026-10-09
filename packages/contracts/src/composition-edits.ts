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

/**
 * N03-01 插入语义（原素材到序列）：
 * - `INSERT`：在 `sequenceStart` 处插入，目标轨上起点之后的片段整体右移插入时长（不保留间隙）；
 * - `OVERWRITE`：覆盖 `[sequenceStart, sequenceStart+时长)`，区间内片段被裁剪/切分/删除，后续片段位置不变
 *   （保留间隙）；区间内容位于锁定轨道时失败；
 * - `APPEND`：追加到目标轨末尾（忽略 `sequenceStart`），保留轨内既有间隙。
 * `linkAudio` 默认按源素材是否含音频流自动建立 AV 关联（视频/音频片段共用 `avGroupId`，
 * 音轨默认取同序列首个 AUDIO 轨，不存在则自动创建）。
 */
export const CLIP_INSERT_MODES = ['INSERT', 'OVERWRITE', 'APPEND'] as const;
export const clipInsertModeSchema = z.enum(CLIP_INSERT_MODES);
export type ClipInsertMode = z.infer<typeof clipInsertModeSchema>;

export const insertClipOperationSchema = z.object({
  op: z.literal('insert_clip'),
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema.nullable().default(null),
  nestedSequenceId: opaqueIdSchema.nullable().default(null),
  sourceStreamId: z.string().max(200).nullable().default(null),
  sourceRange: mediaRangeSchema,
  mode: clipInsertModeSchema.default('INSERT'),
  /** INSERT / OVERWRITE 的序列起点（APPEND 必须为 null） */
  sequenceStart: mediaTimeSchema.nullable().default(null),
  /** 源含音频流时自动建立 AV 关联（同一 avGroupId 的视频/音频片段对） */
  linkAudio: z.boolean().default(true),
  /** 关联音轨（null = 同序列首个 AUDIO 轨；不存在则自动创建一条） */
  audioTrackId: opaqueIdSchema.nullable().default(null),
  createdClipId: opaqueIdSchema.optional(),
  createdAudioClipId: opaqueIdSchema.optional(),
  /** 精确复原（undo/redo）：设置后不执行任何重排/覆盖，只按给定范围与 id 原样重建片段。 */
  restoreClipId: opaqueIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.assetVersionId === null) === (value.nestedSequenceId === null)) {
    context.addIssue({ code: 'custom', path: ['assetVersionId'], message: 'insert_clip requires exactly one assetVersionId or nestedSequenceId' });
  }
  if (value.mode === 'APPEND' && value.sequenceStart !== null) {
    context.addIssue({ code: 'custom', path: ['sequenceStart'], message: 'APPEND inserts at the track end and must not set sequenceStart' });
  }
  if (value.mode !== 'APPEND' && value.sequenceStart === null) {
    context.addIssue({ code: 'custom', path: ['sequenceStart'], message: `${value.mode} requires sequenceStart` });
  }
  if (value.linkAudio === false && value.audioTrackId !== null) {
    context.addIssue({ code: 'custom', path: ['audioTrackId'], message: 'audioTrackId requires linkAudio' });
  }
  if (value.restoreClipId !== undefined && value.linkAudio) {
    context.addIssue({ code: 'custom', path: ['linkAudio'], message: 'restoreClipId reconstructs a single clip and requires linkAudio=false' });
  }
});

export type InsertClipOperation = z.infer<typeof insertClipOperationSchema>;

/** N03-01 删除原语：OVERWRITE 覆盖区间与 undo/redo 反演共用（用户可见的 v2 面由 N03-02 开放）。 */
export const deleteClipOperationSchema = z.object({
  op: z.literal('delete_clip'),
  clipId: opaqueIdSchema,
}).strict();

export type DeleteClipOperation = z.infer<typeof deleteClipOperationSchema>;

/**
 * N03-02 拆分原语：在序列时间 `at` 处把片段切成左右两段。
 * 左段保留原 id（序列/源出点前移到 `at`），右段按 `createdClipId` 新建；
 * AV 关联的音频片段按同样方式切分（`createdAudioClipId`）。
 */
export const splitClipOperationSchema = z.object({
  op: z.literal('split_clip'),
  clipId: opaqueIdSchema,
  at: mediaTimeSchema,
  createdClipId: opaqueIdSchema.optional(),
  createdAudioClipId: opaqueIdSchema.optional(),
}).strict();

export type SplitClipOperation = z.infer<typeof splitClipOperationSchema>;

/** N03-02 入出点裁剪：源范围与序列范围一并给出，必须保持 1:1 前向映射（时长相等）。 */
export const trimClipOperationSchema = z.object({
  op: z.literal('trim_clip'),
  clipId: opaqueIdSchema,
  sourceRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
}).strict();

export type TrimClipOperation = z.infer<typeof trimClipOperationSchema>;

/** N03-02 移动：改目标轨与／或改序列位置（至少其一）。 */
export const moveClipOperationSchema = z.object({
  op: z.literal('move_clip'),
  clipId: opaqueIdSchema,
  trackId: opaqueIdSchema.optional(),
  sequenceRange: mediaRangeSchema.optional(),
}).strict().refine(
  (value) => value.trackId !== undefined || value.sequenceRange !== undefined,
  'move_clip requires a destination track, a sequence range, or both',
);

export type MoveClipOperation = z.infer<typeof moveClipOperationSchema>;

/** N03-02 复制：只复制时间线引用，**不复制源二进制**（同一 assetVersionId）。 */
export const duplicateClipOperationSchema = z.object({
  op: z.literal('duplicate_clip'),
  clipId: opaqueIdSchema,
  afterClipId: opaqueIdSchema.nullable().default(null),
  createdClipId: opaqueIdSchema.optional(),
  createdAudioClipId: opaqueIdSchema.optional(),
}).strict();

export type DuplicateClipOperation = z.infer<typeof duplicateClipOperationSchema>;

/** N03-02 替换源：换用另一源版本／嵌套序列，保持片段序列区间（新源范围时长必须相等）。 */
export const replaceClipSourceOperationSchema = z.object({
  op: z.literal('replace_clip_source'),
  clipId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema.nullable().default(null),
  nestedSequenceId: opaqueIdSchema.nullable().default(null),
  sourceStreamId: z.string().max(200).nullable().default(null),
  sourceRange: mediaRangeSchema,
  createdClipId: opaqueIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if ((value.assetVersionId === null) === (value.nestedSequenceId === null)) {
    context.addIssue({ code: 'custom', path: ['assetVersionId'], message: 'replace_clip_source requires exactly one assetVersionId or nestedSequenceId' });
  }
});

export type ReplaceClipSourceOperation = z.infer<typeof replaceClipSourceOperationSchema>;

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
