import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { frameRateSchema, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { clipTimeMappingSchema } from './composition.js';
import { audioChannelMappingSchema, versionedParametersSchema } from './composition-objects.js';
import { playbackCapabilityFlagSchema } from './playback.js';
import { visualCropSchema, visualTransformSchema } from './visual-transform.js';

/**
 * V5-M4（§13）：**RenderPlan IR** —— 编辑内核从一份序列状态编译出的唯一可校验渲染计划。
 *
 * 三个消费者共用同一 IR：浏览器播放快照（baseline）、服务端合成计划、终渲染后端。
 * 任何消费者都不得绕过 IR 自行读取工程表拼装画面（"没有第二套工程状态"）。
 *
 * 纪律：
 * - 时间全部为 `MediaTime`（BigInt ticks + 有理时基）；不含毫秒/浮点秒；
 * - 层序**自下而上**：同为视频轨时 `position` 越大越靠上（V1 在底，V2 叠在其上）；
 * - `requirements` 由内容推导（例如有字幕 → `CAPTIONS_BURNED_IN`）。后端只能在**声明支持全部需求**时消费，
 *   否则显式拒绝（不得静默省略效果）；
 * - `planHash` = 规范 JSON（键排序）的 SHA-256，只覆盖**渲染内容**（不含 revision、项目/序列 ID、warnings），
 *   同一内容在撤销/重做后哈希不变，可作缓存键与一致性对照键。
 */

export const RENDER_PLAN_IR_VERSION = 'render-plan/1.0';

/** 渲染需求与后端能力共用同一词表（未知需求一律视为不支持）。 */
export const renderRequirementSchema = playbackCapabilityFlagSchema;
export type RenderRequirement = z.infer<typeof renderRequirementSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** 计划引用的源素材版本（不可变事实；终渲染据此冻结与校验字节）。 */
export const renderPlanSourceSchema = z.object({
  assetVersionId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  checksumSha256: z.string().min(1).max(128),
  hasAudio: z.boolean(),
}).strict();
export type RenderPlanSource = z.infer<typeof renderPlanSourceSchema>;

export const renderPlanVideoSegmentSchema = z.object({
  clipId: opaqueIdSchema,
  sourceVersionId: opaqueIdSchema,
  sourceStreamId: z.string().max(200).nullable(),
  sequenceRange: mediaRangeSchema,
  sourceRange: mediaRangeSchema,
  timeMapping: clipTimeMappingSchema,
  transform: visualTransformSchema,
  crop: visualCropSchema,
  opacity: z.number().min(0).max(1),
}).strict();
export type RenderPlanVideoSegment = z.infer<typeof renderPlanVideoSegmentSchema>;

/** 一条可见视频轨 = 一层；段按序列起点排序，同层不重叠（编辑内核保证）。 */
export const renderPlanVideoLayerSchema = z.object({
  trackId: opaqueIdSchema,
  trackPosition: z.number().int().nonnegative(),
  segments: z.array(renderPlanVideoSegmentSchema),
}).strict();
export type RenderPlanVideoLayer = z.infer<typeof renderPlanVideoLayerSchema>;

/**
 * 音频条目：`REGION` = 音频区域（增益/声像/淡变）；`CLIP_AUDIO` = 音频轨上的片段原声。
 * 绑定到某 AV 组任一片段的区域接管该组的音频，此时组内音频片段不再单独发声（避免同源叠声）。
 * `sourceRange` 为**源时间**（CLIP_LOCAL 区域已按所绑片段映射到源时钟）。
 */
export const renderPlanAudioEntrySchema = z.object({
  kind: z.enum(['REGION', 'CLIP_AUDIO']),
  id: opaqueIdSchema,
  trackId: opaqueIdSchema,
  sourceVersionId: opaqueIdSchema,
  sourceStreamId: z.string().max(200).nullable(),
  sequenceRange: mediaRangeSchema,
  sourceRange: mediaRangeSchema,
  /** null = 源声道布局原样 */
  channelMapping: z.array(audioChannelMappingSchema).nullable(),
  gainDb: z.number(),
  pan: z.number().min(-1).max(1),
  fadeIn: mediaTimeSchema,
  fadeOut: mediaTimeSchema,
  /** 轨道静音/独奏归一化后的可听性（不可听条目仍列出以便对照，但不发声） */
  audible: z.boolean(),
}).strict();
export type RenderPlanAudioEntry = z.infer<typeof renderPlanAudioEntrySchema>;

export const renderPlanCaptionSchema = z.object({
  captionId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  sequenceRange: mediaRangeSchema,
  text: z.string(),
  languageTag: z.string().min(2).max(35),
  style: versionedParametersSchema,
}).strict();
export type RenderPlanCaption = z.infer<typeof renderPlanCaptionSchema>;

export const renderPlanAnimatedTargetSchema = z.object({
  bindingId: opaqueIdSchema,
  targetKind: z.string().min(1).max(64),
  targetId: opaqueIdSchema,
  propertyPath: z.string().min(1).max(200),
}).strict();

export const renderPlanSchema = z.object({
  irVersion: z.literal(RENDER_PLAN_IR_VERSION),
  planHash: sha256HexSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  /** 编译时的工程 revision（溯源；不进入 planHash） */
  documentRevision: z.number().int().nonnegative(),
  frameRate: frameRateSchema,
  duration: mediaTimeSchema,
  sources: z.array(renderPlanSourceSchema),
  /** 自下而上 */
  videoLayers: z.array(renderPlanVideoLayerSchema),
  audio: z.array(renderPlanAudioEntrySchema),
  captions: z.array(renderPlanCaptionSchema),
  /** 需要逐帧组件渲染的元素（视觉对象、图形轨片段） */
  graphicsElementIds: z.array(opaqueIdSchema),
  animatedTargets: z.array(renderPlanAnimatedTargetSchema),
  requirements: z.array(renderRequirementSchema),
  /** 被隐藏的轨道（显式列出而不是静默丢弃） */
  excludedTrackIds: z.array(opaqueIdSchema),
  warnings: z.array(z.string().max(200)),
}).strict();
export type RenderPlan = z.infer<typeof renderPlanSchema>;

/** planHash 覆盖的字段（其余为溯源/派生信息）。 */
export const RENDER_PLAN_HASHED_FIELDS = [
  'irVersion',
  'frameRate',
  'duration',
  'sources',
  'videoLayers',
  'audio',
  'captions',
  'graphicsElementIds',
  'animatedTargets',
  'requirements',
  'excludedTrackIds',
] as const satisfies readonly (keyof RenderPlan)[];
