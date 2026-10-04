import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { AUDIO_TRACK_KINDS, audioTrackSchema } from './scene-graph.js';

/**
 * 混音与字幕契约（P06-06 / 规范 §58、§59；计划 §8 P06-06）。
 *
 * 混音纪律：
 * - **无重叠双人声**：旁白唯一来源 = Master Narration Alignment；混音输入只允许**非旁白**轨道
 *   （传入 NARRATION 轨 → 显式拒绝），杜绝第二人声；
 * - ducking/淡入淡出是**纯计算**（增益包络）——**音量调整不触发任何 TTS 合成**（结构上不依赖 TTS）；
 * - 字幕由 Alignment 派生（单一时间来源）；样式与烧录开关是**渲染选项**，不改变时间数据。
 */

export const MIX_ERROR_REASONS = {
  /** 输入混入 NARRATION 轨（旁白唯一来源是 Alignment；不得出现第二个"人声"） */
  MULTIPLE_NARRATION_TRACKS: 'MULTIPLE_NARRATION_TRACKS',
  /** 未生成 Master Narration（无对齐可混音） */
  NO_MASTER_NARRATION: 'NO_MASTER_NARRATION',
  /** 轨道参数非法（音量/淡入淡出） */
  INVALID_TRACK: 'INVALID_TRACK',
} as const;

export type MixErrorReason = (typeof MIX_ERROR_REASONS)[keyof typeof MIX_ERROR_REASONS];

/** 混音输入轨道（非旁白；旁白由 Alignment 提供） */
export const mixInputTrackSchema = audioTrackSchema.extend({
  kind: z.enum(AUDIO_TRACK_KINDS).refine((kind) => kind !== 'NARRATION', {
    message: '混音输入不得包含 NARRATION 轨（旁白唯一来源为 Master Narration）',
  }),
});

export type MixInputTrack = z.infer<typeof mixInputTrackSchema>;

/** 增益关键帧（线性段；startMs..endMs 内从 fromGain 到 toGain） */
export const gainKeyframeSchema = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  fromGain: z.number().min(0).max(2),
  toGain: z.number().min(0).max(2),
  reason: z.enum(['BASE', 'FADE_IN', 'FADE_OUT', 'DUCKING']),
});

export type GainKeyframe = z.infer<typeof gainKeyframeSchema>;

export const mixTrackPlanSchema = z.object({
  trackId: z.string().min(1).max(120),
  kind: z.enum(AUDIO_TRACK_KINDS),
  /** 基准音量（用户设置；音量变化只影响本计划，不触发 TTS） */
  baseVolume: z.number().min(0).max(2),
  ducking: z.boolean(),
  keyframes: z.array(gainKeyframeSchema).min(1),
});

export type MixTrackPlan = z.infer<typeof mixTrackPlanSchema>;

export const mixPlanSchema = z.object({
  projectId: opaqueIdSchema,
  durationMs: z.number().int().nonnegative(),
  /** 旁白区间（来自 Alignment cues；供预览/渲染叠加增益） */
  narrationIntervals: z.array(z.object({ startMs: z.number().int().nonnegative(), endMs: z.number().int().nonnegative() })).default([]),
  tracks: z.array(mixTrackPlanSchema).default([]),
  /** ducking 参数（可配置；默认 -9dB 等效增益 0.355） */
  ducking: z.object({
    level: z.number().min(0).max(1),
    attackMs: z.number().int().nonnegative(),
    releaseMs: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().max(300)).default([]),
});

export type MixPlan = z.infer<typeof mixPlanSchema>;

/** 默认 ducking（§59：旁白存在时压低 BGM；可配置） */
export const DEFAULT_DUCKING = { level: 0.355, attackMs: 120, releaseMs: 320 } as const;

/* ---------- 字幕 ---------- */

export const SUBTITLE_FORMATS = ['SRT', 'VTT'] as const;
export const subtitleFormatSchema = z.enum(SUBTITLE_FORMATS);
export type SubtitleFormat = z.infer<typeof subtitleFormatSchema>;

export const CAPTION_POSITIONS = ['TOP', 'CENTER', 'BOTTOM'] as const;

export const captionStyleSchema = z.object({
  fontSizePx: z.number().int().positive().max(120).default(44),
  /** 每行最大字符数（CJK 按 1 计，拉丁字符按 0.55 计——见 fit 规则） */
  maxCharsPerLine: z.number().int().positive().max(80).default(18),
  maxLines: z.number().int().positive().max(3).default(2),
  position: z.enum(CAPTION_POSITIONS).default('BOTTOM'),
  /** 背景块（提升可读性；'NONE' = 只描边） */
  background: z.enum(['NONE', 'BLOCK']).default('BLOCK'),
  /** 安全区（各边留白像素；字幕不得越界） */
  safeArea: z
    .object({
      topPx: z.number().int().nonnegative().default(60),
      bottomPx: z.number().int().nonnegative().default(90),
      leftPx: z.number().int().nonnegative().default(120),
      rightPx: z.number().int().nonnegative().default(120),
    })
    .default({ topPx: 60, bottomPx: 90, leftPx: 120, rightPx: 120 }),
});

export type CaptionStyle = z.infer<typeof captionStyleSchema>;

/** 字幕渲染选项（烧录开关属于渲染管线；预览同源消费）。 */
export const captionRenderOptionsSchema = z.object({
  /** 烧录进画面（渲染阶段；预览在画面上叠加同款样式） */
  burnIn: z.boolean().default(true),
  style: captionStyleSchema.default(() => captionStyleSchema.parse({})),
});

export type CaptionRenderOptions = z.infer<typeof captionRenderOptionsSchema>;

export const subtitleOutputSchema = z.object({
  format: subtitleFormatSchema,
  /** SRT/VTT 文本（时间码规范见 §58；行数与超界检查随附） */
  content: z.string(),
  cueCount: z.number().int().nonnegative(),
  /** 每 cue 的行数与最宽行估算（越界 → warning，绝不静默裁切） */
  stats: z.object({
    maxLines: z.number().int().nonnegative(),
    maxLineVisualWidth: z.number().nonnegative(),
    overSafeWidthCues: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().max(300)).default([]),
});

export type SubtitleOutput = z.infer<typeof subtitleOutputSchema>;

export const mixPlanRequestSchema = z.object({
  tracks: z.array(mixInputTrackSchema).default([]),
  ducking: z
    .object({
      level: z.number().min(0).max(1).default(DEFAULT_DUCKING.level),
      attackMs: z.number().int().nonnegative().default(DEFAULT_DUCKING.attackMs),
      releaseMs: z.number().int().nonnegative().default(DEFAULT_DUCKING.releaseMs),
    })
    .default(() => ({ ...DEFAULT_DUCKING })),
  captionOptions: captionRenderOptionsSchema.optional(),
});

export type MixPlanRequest = z.infer<typeof mixPlanRequestSchema>;
