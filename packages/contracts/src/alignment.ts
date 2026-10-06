import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Master Narration 与 Alignment 契约（P06-03 / 规范 §5.1、§58）。
 *
 * Audio-First 纪律（§5.1）：
 * - 旁白块 → 逐段合成（带**字符/词级时间戳**）→ 拼接 Master Narration → 全局 Alignment；
 * - 实际 timestamps 是**画面、字幕、Avatar、Motion 的唯一时间基础**（后续一切 timing 由它驱动）；
 * - **Provider 不返回时间戳时进入 AlignmentProvider；首期不接受"仅按字数估计"的 Final 对齐**
 *   （缺时间戳且未配置对齐器 → 明确失败，不产生假对齐）。
 */

export const ALIGNMENT_METHODS = ['PROVIDER_TIMESTAMPS', 'ALIGNMENT_PROVIDER'] as const;
export const alignmentMethodSchema = z.enum(ALIGNMENT_METHODS);
export type AlignmentMethod = z.infer<typeof alignmentMethodSchema>;

export const ALIGNMENT_ERROR_REASONS = {
  /** 未配置 TTS 适配器（fail-closed） */
  TTS_UNAVAILABLE: 'TTS_UNAVAILABLE',
  /** 未绑定声音身份：合成必须有确定身份（§95） */
  VOICE_IDENTITY_REQUIRED: 'VOICE_IDENTITY_REQUIRED',
  /** Provider 无时间戳且未配置 AlignmentProvider（§5.1：不接受按字数估计的 Final 对齐） */
  TIMESTAMPS_UNAVAILABLE: 'TIMESTAMPS_UNAVAILABLE',
  /** 叙事计划没有旁白块 */
  NO_NARRATION_BLOCKS: 'NO_NARRATION_BLOCKS',
  /** 指定旁白块不存在于当前计划 */
  SEGMENT_NOT_FOUND: 'SEGMENT_NOT_FOUND',
  /** 分段音频为非 WAV：不在域内拼接（留给渲染管线 ffmpeg） */
  MASTER_AUDIO_UNSUPPORTED_FORMAT: 'MASTER_AUDIO_UNSUPPORTED_FORMAT',
  /** 未配置对象存储（分段音频必须落自有存储） */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type AlignmentErrorReason = (typeof ALIGNMENT_ERROR_REASONS)[keyof typeof ALIGNMENT_ERROR_REASONS];

/** 词/短语级时间戳（相对段首；毫秒） */
export const alignmentWordSchema = z.object({
  word: z.string().min(1).max(200),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
});

export type AlignmentWord = z.infer<typeof alignmentWordSchema>;

/** 段级对齐（绝对时间轴） */
export const alignmentSegmentSchema = z.object({
  /** 旁白块的逻辑 ID（跨版本稳定） */
  narrationBlockId: opaqueIdSchema,
  text: z.string(),
  charCount: z.number().int().nonnegative(),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  endMs: z.number().int().nonnegative(),
  words: z.array(alignmentWordSchema).default([]),
  /** 分段音频缓存键（内容+声音+风格派生；命中即复用，不重复合成） */
  cacheKey: z.string().min(1),
  /** 该段是否来自缓存（改一句话时其余段应命中缓存） */
  reused: z.boolean().default(false),
});

export type AlignmentSegment = z.infer<typeof alignmentSegmentSchema>;

/** narration cue（驱动画面/字幕/ Avatar；§5.1 第 6 步） */
export const narrationCueSchema = z.object({
  narrationBlockId: opaqueIdSchema,
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});

export type NarrationCue = z.infer<typeof narrationCueSchema>;

export const masterNarrationSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  narrativePlanId: opaqueIdSchema,
  narrativePlanRevision: z.number().int().positive(),
  /** 拼接后的 Master 音频资产（WAV 可拼接时；否则为 null，交由渲染管线） */
  assetId: opaqueIdSchema.nullable().default(null),
  /** Master 音频的**具体资产版本**（P07-04：渲染按版本级引用冻结，绝不指向"当前版本"） */
  assetVersionId: opaqueIdSchema.nullable().default(null),
  mimeType: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  checksumSha256: z.string().nullable().default(null),
  totalDurationMs: z.number().int().nonnegative(),
  alignmentMethod: alignmentMethodSchema,
  segments: z.array(alignmentSegmentSchema).default([]),
  cues: z.array(narrationCueSchema).default([]),
  voice: z.object({
    voiceIdentityId: opaqueIdSchema.nullable().default(null),
    voiceIdentityVersion: z.number().int().positive().nullable().default(null),
  }),
  /** 旁白语言（null = 源语言/未标注；多语言派生版 = 目标语言，如 'en'——P12-04） */
  language: z.string().min(2).max(20).nullable().default(null),
  cacheStats: z.object({
    segments: z.number().int().nonnegative(),
    reused: z.number().int().nonnegative(),
    synthesized: z.number().int().nonnegative(),
  }),
  warnings: z.array(z.string().max(300)).default([]),
  createdAt: isoDateTimeSchema,
});

export type MasterNarration = z.infer<typeof masterNarrationSchema>;

/** 声音引用（合成时交给 Adapter 映射为 Provider 私有参数——映射层只在此处出现，§94） */
export const synthesisVoiceRefSchema = z.object({
  voiceIdentityId: opaqueIdSchema.nullable().default(null),
  provider: z.string().nullable().default(null),
  providerVoiceId: z.string().nullable().default(null),
  languageProfile: z.string().nullable().default(null),
});

export type SynthesisVoiceRef = z.infer<typeof synthesisVoiceRefSchema>;

/** 单段合成结果（Provider 返回；wordTimestamps=null 表示无时间戳 → 需 AlignmentProvider） */
export interface SynthesizedAudio {
  bytes: Uint8Array;
  mimeType: string;
  durationMs: number;
  wordTimestamps: AlignmentWord[] | null;
}

/**
 * TTS 适配器（真实 Provider 与 Mock 共用；domain 只依赖本接口）。
 * 真实实现：调用 Provider 的"带时间戳"接口；**返回的 Secret 只存在于调用瞬间，绝不记录**。
 */
export interface AudioSynthesisAdapter {
  readonly kind: string;
  synthesize(input: {
    text: string;
    voiceRef: SynthesisVoiceRef;
    speed: number;
    styleInstruction: string | null;
  }): Promise<SynthesizedAudio>;
}

/** 强制对齐器（Provider 无时间戳时使用；首期不接受按字数估计） */
export interface AlignmentProvider {
  readonly kind: string;
  align(input: { bytes: Uint8Array; mimeType: string; text: string }): Promise<{ words: AlignmentWord[]; durationMs: number }>;
}
