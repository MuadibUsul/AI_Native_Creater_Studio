import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { frameRateSchema, mediaRangeSchema, mediaTimeSchema } from './common/media-time.js';
import { clipTimeMappingSchema } from './composition.js';
import { audioChannelMappingSchema, versionedParametersSchema } from './composition-objects.js';
import { playbackCapabilityFlagSchema, playbackPrecisionSchema } from './playback.js';
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

// ── 渲染语义规则（IR 的一部分：所有后端必须一致；变更须升 irVersion） ─────────────

/**
 * 音频规则：
 * - 区域淡入淡出为**等功率**曲线（淡入 sin(πt/2)、淡出 cos(πt/2)），与 `apply_audio_crossfade` 的 in² + out² = 1 一致；
 * - 声道：缺省把单声道复制到左右（增益 1）、立体声直通；`channelMapping` 显式路由时只按映射输出；
 * - 声像：WebAudio `StereoPannerNode` 的立体声公式（pan = 0 直通，-1 全左，+1 全右）；
 * - 混音：各条目直接求和、不归一化（与 WebAudio 求和一致）。
 */
export const RENDER_PLAN_AUDIO_RULES = {
  fadeCurve: 'EQUAL_POWER',
  panLaw: 'WEBAUDIO_STEREO_PANNER',
  mix: 'SUM_UNNORMALIZED',
} as const;

export interface StereoPanCoefficients {
  leftFromLeft: number;
  leftFromRight: number;
  rightFromLeft: number;
  rightFromRight: number;
}

/** WebAudio StereoPannerNode（立体声输入）：pan ≤ 0 时右声道按 cos/sin 向左并入；pan > 0 对称。 */
export function stereoPanCoefficients(pan: number): StereoPanCoefficients {
  if (!Number.isFinite(pan) || pan < -1 || pan > 1) throw new RangeError('pan must be within [-1, 1]');
  if (pan <= 0) {
    const angle = ((pan + 1) * Math.PI) / 2;
    return { leftFromLeft: 1, leftFromRight: Math.cos(angle) < 1e-12 ? 0 : Math.cos(angle), rightFromLeft: 0, rightFromRight: Math.sin(angle) };
  }
  const angle = (pan * Math.PI) / 2;
  return { leftFromLeft: Math.cos(angle) < 1e-12 ? 0 : Math.cos(angle), leftFromRight: 0, rightFromLeft: Math.sin(angle), rightFromRight: 1 };
}

// ── 终渲染档位、后端能力与执行器契约 ─────────────────────────────

export const FINAL_RENDER_CAPTION_DELIVERIES = ['SIDECAR', 'BURNED_IN'] as const;

/** 终渲染档位：画布、编码质量与字幕交付方式（SIDECAR = 侧载 SRT/VTT，不要求烧录能力）。 */
export const finalRenderProfileSchema = z.object({
  width: z.number().int().min(16).max(7680).multipleOf(2),
  height: z.number().int().min(16).max(4320).multipleOf(2),
  videoCrf: z.number().int().min(0).max(51).default(18),
  audioBitrateKbps: z.number().int().min(64).max(512).default(192),
  captionDelivery: z.enum(FINAL_RENDER_CAPTION_DELIVERIES).default('SIDECAR'),
  /** 编码速度档：终渲染 medium（缺省）；预览用 veryfast（V6-1d，换速度不换语义） */
  encoderPreset: z.enum(['medium', 'veryfast']).default('medium'),
}).strict();
export type FinalRenderProfile = z.infer<typeof finalRenderProfileSchema>;
export type FinalRenderProfileInput = z.input<typeof finalRenderProfileSchema>;

/** 渲染后端能力（播放后端与终渲染后端同一形状；未列出的需求一律不支持）。 */
export const renderBackendCapabilitiesSchema = z.object({
  backend: z.string().min(1).max(64),
  videoPrecision: playbackPrecisionSchema,
  audioPrecision: playbackPrecisionSchema,
  supported: z.array(renderRequirementSchema),
  unsupported: z.array(renderRequirementSchema),
}).strict();
export type RenderBackendCapabilities = z.infer<typeof renderBackendCapabilitiesSchema>;

export const RENDER_PLAN_EXECUTION_RESULT_VERSION = 'render-plan-exec/1.0';
export const RENDER_PLAN_EXECUTION_FILE_KINDS = ['VIDEO', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'MANIFEST'] as const;

export const renderPlanExecutionFileSchema = z.object({
  kind: z.enum(RENDER_PLAN_EXECUTION_FILE_KINDS),
  /** `workDir/out/` 下的文件名（执行器生成，非用户输入） */
  fileName: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
}).strict();
export type RenderPlanExecutionFile = z.infer<typeof renderPlanExecutionFileSchema>;

export const renderPlanExecutionResultSchema = z.object({
  schemaVersion: z.literal(RENDER_PLAN_EXECUTION_RESULT_VERSION),
  backend: z.string().min(1).max(64),
  planHash: sha256HexSchema,
  /** 后端图（如 FFmpeg argv）的哈希：同一计划 + 档位 + 输入事实 → 同一图 */
  graphHash: sha256HexSchema,
  frameCount: z.string().regex(/^\d+$/),
  sampleCount: z.string().regex(/^\d+$/),
  files: z.array(renderPlanExecutionFileSchema),
  warnings: z.array(z.string().max(200)),
}).strict();
export type RenderPlanExecutionResult = z.infer<typeof renderPlanExecutionResultSchema>;

/**
 * 终渲染执行器：**只消费 RenderPlan**（不读数据库、不取凭据）。编排层负责把冻结的源对象落到
 * `workDir/assets/<fileName>`，执行器产出 `workDir/out/*` 并返回逐文件哈希。
 */
export interface RenderPlanExecutor {
  readonly kind: string;
  readonly capabilities: RenderBackendCapabilities;
  execute(input: {
    plan: RenderPlan;
    profile: FinalRenderProfileInput;
    workDir: string;
    sources: readonly { assetVersionId: string; fileName: string }[];
  }): Promise<RenderPlanExecutionResult>;
}
