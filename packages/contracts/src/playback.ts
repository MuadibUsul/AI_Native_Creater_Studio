import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { clipTimeMappingSchema } from './composition.js';
import { versionedParametersSchema } from './composition-objects.js';
import { mediaTimeToFrameIndex } from './common/media-time.js';
import { visualCropSchema, visualTransformSchema } from './visual-transform.js';

/**
 * N03-08 多轨媒体预览与真实合成（Playback 契约的最小落地；N03-11 会在此基础上扩成 PlaybackEngine）。
 *
 * 纪律（V04-10／V04-14）：
 * - 播放快照**只**来自同一份 ProjectDocument 投影（调用方传入 revision，快照回带该 revision），
 *   播放器/合成器都不得维护第二套工程状态（"没有浏览器 props 之外的隐藏工程"）；
 * - 能力必须**显式**：未知能力一律按不支持处理，不得展示为支持；
 * - 源不可播放、时间线为空等情形 fail-closed（报错而不是静默黑屏）；
 * - 预览（baseline）与服务端合成共用同一帧映射（frameIndexAt / frameIndexToMediaTime），
 *   因此"窗口预览与服务端合成关键帧"可逐帧对照。
 */

export const PLAYBACK_SNAPSHOT_VERSION = 'playback-snapshot/1.0';

export const PLAYBACK_BACKEND_KINDS = ['HTML_MEDIA_BASELINE', 'SERVER_PRECOMPOSED'] as const;
export const playbackBackendKindSchema = z.enum(PLAYBACK_BACKEND_KINDS);
export type PlaybackBackendKind = z.infer<typeof playbackBackendKindSchema>;

export const PLAYBACK_PRECISIONS = ['FRAME_ACCURATE', 'KEYFRAME_APPROXIMATE', 'NOT_SUPPORTED'] as const;
export const playbackPrecisionSchema = z.enum(PLAYBACK_PRECISIONS);

export const PLAYBACK_CAPABILITY_FLAGS = [
  'PER_SEGMENT_TRANSFORM',
  'PER_SEGMENT_CROP',
  'PER_SEGMENT_OPACITY',
  'AUDIO_GAIN_FADE_PAN',
  'AUDIO_CROSSFADE',
  'CAPTIONS_BURNED_IN',
  'GRAPHICS_COMPONENT_RENDER',
  'MULTI_TRACK_COMPOSITE',
  /** 关键帧动画（V5-M4：RenderPlan 显式列出；尚无后端实现时一律声明不支持） */
  'KEYFRAME_ANIMATION',
  /** 变速/倒放（源区间与序列区间非 1:1 正向） */
  'TIME_REMAP',
  /** 嵌套序列片段 */
  'NESTED_SEQUENCE',
] as const;
export const playbackCapabilityFlagSchema = z.enum(PLAYBACK_CAPABILITY_FLAGS);
export type PlaybackCapabilityFlag = z.infer<typeof playbackCapabilityFlagSchema>;

export const playbackCapabilitiesSchema = z.object({
  backend: playbackBackendKindSchema,
  videoPrecision: playbackPrecisionSchema,
  audioPrecision: playbackPrecisionSchema,
  /** 支持的标志（显式列举；未列出一律视为不支持） */
  supported: z.array(playbackCapabilityFlagSchema),
  /** 明确不支持的能力（含缺失能力的原因键） */
  unsupported: z.array(playbackCapabilityFlagSchema),
}).strict();

export type PlaybackCapabilities = z.infer<typeof playbackCapabilitiesSchema>;

export const PLAYBACK_ERROR_REASONS = {
  /** 片段源不可播放（未就绪/缺校验和/无可用 rendition） */
  SOURCE_NOT_PLAYABLE: 'PLAYBACK_SOURCE_NOT_PLAYABLE',
  /** 时间线没有任何可播放内容 */
  EMPTY_TIMELINE: 'PLAYBACK_EMPTY_TIMELINE',
  /** 请求的能力当前后端不支持 */
  UNSUPPORTED_CAPABILITY: 'PLAYBACK_UNSUPPORTED_CAPABILITY',
  /** 序列不存在或跨租户 */
  SEQUENCE_NOT_FOUND: 'PLAYBACK_SEQUENCE_NOT_FOUND',
} as const;

export type PlaybackErrorReason = (typeof PLAYBACK_ERROR_REASONS)[keyof typeof PLAYBACK_ERROR_REASONS];

export const playbackVideoSegmentSchema = z.object({
  clipId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  /** 播放源：资产与版本（URL 由客户端用 playback-url 端点签发，快照不内嵌签名材料） */
  assetId: opaqueIdSchema,
  sourceVersionId: opaqueIdSchema,
  sourceStreamId: z.string().max(200).nullable().default(null),
  sequenceRange: mediaRangeSchema,
  sourceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  /** 导出/合成需要的外观参数（与编辑参数同源） */
  transform: visualTransformSchema,
  crop: visualCropSchema,
  opacity: z.number().min(0).max(1),
  sourceHasAudio: z.boolean(),
}).strict();

export type PlaybackVideoSegment = z.infer<typeof playbackVideoSegmentSchema>;

export const playbackAudioSegmentSchema = z.object({
  kind: z.enum(['REGION', 'CLIP_AUDIO']),
  id: opaqueIdSchema,
  trackId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  sourceVersionId: opaqueIdSchema,
  sequenceRange: mediaRangeSchema,
  sourceRange: mediaRangeSchema,
  gainDb: z.number(),
  pan: z.number(),
  fadeIn: mediaTimeSchema,
  fadeOut: mediaTimeSchema,
  /** 轨道静音/独奏归一化后的可听性（false = 本次播放不发声，但仍在此列出以便对照） */
  audible: z.boolean(),
}).strict();

export type PlaybackAudioSegment = z.infer<typeof playbackAudioSegmentSchema>;

export const playbackCaptionCueSchema = z.object({
  captionId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  sequenceRange: mediaRangeSchema,
  text: z.string(),
  languageTag: z.string().min(2).max(35),
  style: versionedParametersSchema,
}).strict();

export type PlaybackCaptionCue = z.infer<typeof playbackCaptionCueSchema>;

export const playbackSnapshotSchema = z.object({
  schemaVersion: z.literal(PLAYBACK_SNAPSHOT_VERSION),
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  /** 与工程文档同一 revision（防止播放器持有隐藏状态） */
  documentRevision: z.number().int().nonnegative(),
  /** 来源 RenderPlan 的内容哈希（V5-M4：预览、服务端合成与终渲染消费同一 IR；可据此逐项对照） */
  planHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  frameRate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }).strict(),
  duration: mediaTimeSchema,
  capabilities: playbackCapabilitiesSchema,
  videoSegments: z.array(playbackVideoSegmentSchema),
  audioSegments: z.array(playbackAudioSegmentSchema),
  captions: z.array(playbackCaptionCueSchema),
  /** 被隐藏/排除的轨道（例如被隐藏的视频轨；显式列出而不是静默丢弃） */
  excludedTrackIds: z.array(opaqueIdSchema),
  warnings: z.array(z.string().max(200)),
}).strict();

export type PlaybackSnapshot = z.infer<typeof playbackSnapshotSchema>;

/** 帧映射（预览与服务端合成共用；两处必须给出同一答案）。 */
export const playbackFrameAt = (time: unknown, frameRate: { num: number; den: number }, rounding: 'floor' | 'ceil' | 'towardZero' | 'nearest' = 'floor'): string =>
  mediaTimeToFrameIndex(mediaTimeSchema.parse(time), frameRate, rounding);
