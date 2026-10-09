import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { compareMediaTime, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { createTrackRequestSchema } from './composition.js';
import { VISUAL_PARAMETER_SCHEMA_VERSION, visualCropSchema, visualTransformSchema } from './visual-transform.js';
import {
  animationTargetKindSchema,
  captionWordTimingSchema,
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

/** N03-03 slip：在片段**位置不变**的前提下平移源入出点（滑移素材内容）。 */
export const slipClipOperationSchema = z.object({
  op: z.literal('slip_clip'),
  clipId: opaqueIdSchema,
  sourceRange: mediaRangeSchema,
}).strict();

export type SlipClipOperation = z.infer<typeof slipClipOperationSchema>;

/** N03-03 slide：片段左右移动，**总时长不变**（缺口由相邻片段变长/变短吸收）。 */
export const slideClipOperationSchema = z.object({
  op: z.literal('slide_clip'),
  clipId: opaqueIdSchema,
  offset: mediaTimeSchema,
}).strict().refine((value) => compareMediaTime(value.offset, { ticks: '0', timebase: value.offset.timebase }) !== 0, 'slide_clip offset must be nonzero');

export type SlideClipOperation = z.infer<typeof slideClipOperationSchema>;

/** N03-03 roll：移动相邻两段之间的剪辑点（左段出点与右段入点同时移动，合成不变）。 */
export const rollClipOperationSchema = z.object({
  op: z.literal('roll_clip'),
  leftClipId: opaqueIdSchema,
  rightClipId: opaqueIdSchema,
  at: mediaTimeSchema,
}).strict().refine((value) => value.leftClipId !== value.rightClipId, 'roll_clip requires two distinct adjacent clips');

export type RollClipOperation = z.infer<typeof rollClipOperationSchema>;

/** N03-03 ripple 的显式动作：删除收缝 / 掐头收缝 / 去尾收缝。 */
export const CLIP_RIPPLE_ACTIONS = ['DELETE', 'TRIM_HEAD', 'TRIM_TAIL'] as const;
export const clipRippleActionSchema = z.enum(CLIP_RIPPLE_ACTIONS);

export type ClipRippleAction = z.infer<typeof clipRippleActionSchema>;

/**
 * N03-03 ripple：**显式**收缝（涟漪）。只有本操作会移动其他片段——
 * 其余原语（insert/trim/move/split…）一律不隐式涟漪，避免"其他别动"被破坏。
 */
export const rippleClipOperationSchema = z.object({
  op: z.literal('ripple_clip'),
  clipId: opaqueIdSchema,
  action: clipRippleActionSchema,
  /** TRIM_HEAD／TRIM_TAIL 的收缝量；DELETE 必须为 null。 */
  amount: mediaTimeSchema.nullable().default(null),
  /** DELETE 时默认跨全序列全部轨道收缝（保持声画同步）；TRIM_* 只在同轨收缝。 */
  closeAcrossTracks: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if ((value.action === 'DELETE') !== (value.amount === null)) {
    context.addIssue({ code: 'custom', path: ['amount'], message: 'amount is required for TRIM_HEAD／TRIM_TAIL and must be null for DELETE' });
  }
});

export type RippleClipOperation = z.infer<typeof rippleClipOperationSchema>;

/** N03-03 J/L cut：视频切点与音频切点错开，切换处原音保持连续。 */
export const AV_CUT_KINDS = ['J', 'L'] as const;
export const avCutKindSchema = z.enum(AV_CUT_KINDS);

export type AvCutKind = z.infer<typeof avCutKindSchema>;

export const splitAvCutOperationSchema = z.object({
  op: z.literal('split_av_cut'),
  videoClipId: opaqueIdSchema,
  audioClipId: opaqueIdSchema,
  /** 视频切点（序列时间）。 */
  at: mediaTimeSchema,
  /** 音频切点相对视频切点的错开量（必须为正；方向由 kind 决定）。 */
  offset: mediaTimeSchema,
  /** J = 音频先入（音频切点早于视频）；L = 音频后出（音频切点晚于视频）。 */
  kind: avCutKindSchema,
  createdVideoClipId: opaqueIdSchema.optional(),
  createdAudioClipId: opaqueIdSchema.optional(),
}).strict().refine(
  (value) => compareMediaTime(value.offset, { ticks: '0', timebase: value.offset.timebase }) > 0,
  'split_av_cut offset must be positive',
);

export type SplitAvCutOperation = z.infer<typeof splitAvCutOperationSchema>;

/**
 * N03-04 轨道生命周期与轨道控制（多轨、AV 链接与同步锁）。
 * 轨道状态（muted/hidden/solo/locked/syncLocked）随版本快照与客户端投影对外可见。
 */
export const createTrackOperationSchema = z.object({
  op: z.literal('create_track'),
  sequenceId: opaqueIdSchema,
  track: createTrackRequestSchema,
  /** 精确复原（undo/redo）：按原 id 重建轨道，保持引用稳定。 */
  restoreTrackId: opaqueIdSchema.optional(),
}).strict();

export type CreateTrackOperation = z.infer<typeof createTrackOperationSchema>;

export const moveTrackOperationSchema = z.object({
  op: z.literal('move_track'),
  trackId: opaqueIdSchema,
  position: z.number().int().nonnegative(),
}).strict();

export type MoveTrackOperation = z.infer<typeof moveTrackOperationSchema>;

export const NON_EMPTY_TRACK_POLICIES = ['REJECT', 'MOVE_CLIPS'] as const;
export const nonEmptyTrackPolicySchema = z.enum(NON_EMPTY_TRACK_POLICIES);

export type NonEmptyTrackPolicy = z.infer<typeof nonEmptyTrackPolicySchema>;

export const deleteTrackOperationSchema = z.object({
  op: z.literal('delete_track'),
  trackId: opaqueIdSchema,
  nonEmptyPolicy: nonEmptyTrackPolicySchema,
  destinationTrackId: opaqueIdSchema.nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.nonEmptyPolicy === 'MOVE_CLIPS') !== (value.destinationTrackId !== null)) {
    context.addIssue({ code: 'custom', path: ['destinationTrackId'], message: 'MOVE_CLIPS requires exactly one destination track' });
  }
});

export type DeleteTrackOperation = z.infer<typeof deleteTrackOperationSchema>;

export const trackChangesSchema = z.object({
  name: z.string().min(1).max(200),
  position: z.number().int().nonnegative(),
  locked: z.boolean(),
  muted: z.boolean(),
  hidden: z.boolean(),
  solo: z.boolean(),
  syncLocked: z.boolean(),
}).partial().strict().refine((value) => Object.keys(value).length > 0, 'update_track requires at least one change');

/** 轨道控制：重命名／重排／静音／独奏／隐藏／锁定／同步锁（关闭一轨只改该轨自身状态）。 */
export const updateTrackOperationSchema = z.object({
  op: z.literal('update_track'),
  trackId: opaqueIdSchema,
  changes: trackChangesSchema,
}).strict();

export type UpdateTrackOperation = z.infer<typeof updateTrackOperationSchema>;

/**
 * N03-04 AV 链接：`linked=true` 把恰好两条片段（同一序列的视频+音频）绑成同一 `avGroupId`；
 * `linked=false` 解链（清空给定片段的 `avGroupId`），解链后各自的编辑不再联动。
 */
export const setAvLinkOperationSchema = z.object({
  op: z.literal('set_av_link'),
  linked: z.boolean(),
  clipIds: z.array(opaqueIdSchema).min(1).max(2),
}).strict().superRefine((value, context) => {
  if (value.linked && value.clipIds.length !== 2) {
    context.addIssue({ code: 'custom', path: ['clipIds'], message: 'linking requires exactly two clips' });
  }
  if (value.linked && value.clipIds[0] === value.clipIds[1]) {
    context.addIssue({ code: 'custom', path: ['clipIds'], message: 'linking requires two distinct clips' });
  }
});

export type SetAvLinkOperation = z.infer<typeof setAvLinkOperationSchema>;



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

/** N03-05 变换原语：位置/缩放/旋转/锚点（参数化修改，不触发镜头重生成）。 */
export const setClipTransformOperationSchema = z.object({
  op: z.literal('set_clip_transform'),
  clipId: opaqueIdSchema,
  transform: visualTransformSchema,
}).strict();

export type SetClipTransformOperation = z.infer<typeof setClipTransformOperationSchema>;

/** N03-05 裁切原语：归一化四边裁切（必须留出非空可见区域）。 */
export const setClipCropOperationSchema = z.object({
  op: z.literal('set_clip_crop'),
  clipId: opaqueIdSchema,
  crop: visualCropSchema,
}).strict();

export type SetClipCropOperation = z.infer<typeof setClipCropOperationSchema>;

/** N03-05 透明度原语。 */
export const setClipOpacityOperationSchema = z.object({
  op: z.literal('set_clip_opacity'),
  clipId: opaqueIdSchema,
  opacity: z.number().finite().min(0).max(1),
}).strict();

export type SetClipOpacityOperation = z.infer<typeof setClipOpacityOperationSchema>;

/** 片段参数命名空间版本（与 visualParametersSchema 对齐，供迁移与客户端校验）。 */
export { VISUAL_PARAMETER_SCHEMA_VERSION };

/** N03-06 基础 crossfade：在相邻两个音频区域的接缝处铺等功率交叉淡入淡出。 */
export const applyAudioCrossfadeOperationSchema = z.object({
  op: z.literal('apply_audio_crossfade'),
  leftRegionId: opaqueIdSchema,
  rightRegionId: opaqueIdSchema,
  duration: mediaTimeSchema,
}).strict().refine((value) => value.leftRegionId !== value.rightRegionId, 'crossfade requires two distinct regions');

export type ApplyAudioCrossfadeOperation = z.infer<typeof applyAudioCrossfadeOperationSchema>;

/** N03-07 断句：按词条边界把一个字幕拆成两条（两侧文字都按词条重建，不改保留词）。 */
export const splitCaptionOperationSchema = z.object({
  op: z.literal('split_caption'),
  captionId: opaqueIdSchema,
  atWordIndex: z.number().int().positive(),
  createdCaptionId: opaqueIdSchema.optional(),
}).strict();

export type SplitCaptionOperation = z.infer<typeof splitCaptionOperationSchema>;

/** N03-07 转写驱动剪辑：删一段转写必须明确是"只改字幕"还是"连内容一起剪"。 */
export const CAPTION_CUT_MODES = ['CAPTION_ONLY', 'CUT_CONTENT'] as const;
export const captionCutModeSchema = z.enum(CAPTION_CUT_MODES);

export type CaptionCutMode = z.infer<typeof captionCutModeSchema>;

export const cutCaptionRangeOperationSchema = z.object({
  op: z.literal('cut_caption_range'),
  captionId: opaqueIdSchema,
  /** 词条区间（半开），[wordFrom, wordTo) */
  wordFrom: z.number().int().nonnegative(),
  wordTo: z.number().int().positive(),
  mode: captionCutModeSchema,
  /** CUT_CONTENT 时的收缝范围（默认跨全序列轨道，保持声画同步） */
  closeAcrossTracks: z.boolean().default(true),
}).strict().superRefine((value, context) => {
  if (value.wordTo <= value.wordFrom) {
    context.addIssue({ code: 'custom', path: ['wordTo'], message: 'cut range must be non-empty' });
  }
});

export type CutCaptionRangeOperation = z.infer<typeof cutCaptionRangeOperationSchema>;

/** N03-07 删除字幕条目（断句/剪辑的逆操作与显式删除共用）。 */
export const deleteCaptionOperationSchema = z.object({
  op: z.literal('delete_caption'),
  captionId: opaqueIdSchema,
}).strict();

export type DeleteCaptionOperation = z.infer<typeof deleteCaptionOperationSchema>;

/** N03-07 新建字幕条目（显式创建与 undo 复原共用；复原按原 id 重建）。 */
export const createCaptionOperationSchema = z.object({
  op: z.literal('create_caption'),
  sequenceId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  timeBinding: timeBindingSchema,
  localRange: mediaRangeSchema,
  sequenceRange: mediaRangeSchema,
  text: z.string().min(1),
  languageTag: z.string().min(2).max(35),
  style: versionedParametersSchema,
  words: z.array(captionWordTimingSchema).default([]),
  speechAnchorId: opaqueIdSchema.nullable().default(null),
  /** 精确复原：按原 id 重建，保持引用稳定 */
  restoreCaptionId: opaqueIdSchema.optional(),
}).strict();

export type CreateCaptionOperation = z.infer<typeof createCaptionOperationSchema>;
