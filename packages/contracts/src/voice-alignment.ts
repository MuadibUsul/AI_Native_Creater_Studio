import { z } from 'zod';
import { addMediaTime, compareMediaTime, mediaRangeSchema, mediaTimeSchema, subtractMediaTime, type MediaRange, type MediaTime } from './common/media-time.js';
import { opaqueIdSchema } from './common/ids.js';
import {
  VOICE_CAPABILITY_FLAGS,
  voiceCapabilitiesSchema,
  voiceCapabilityFlagSchema,
  voiceSupports,
  voiceTransportSchema,
  type VoiceCapabilities,
  type VoiceCapabilityFlag,
  type VoiceTransport,
} from './voice-stream.js';

/**
 * N05-02 语音采集、转写与时间对齐（增量设计 §5.1、§6、§8.4）。
 *
 * 纪律：
 * - 只有供应商给出**可验证的词级/音频位置**时才把词语精确绑到序列时间；
 *   否则退回"发话快照 + 明确点击"，并如实标注精度（`UTTERANCE_SNAPSHOT`），**不把猜测标成逐词精确**；
 * - 音频时钟与本地单调时钟分离：`VOICE_CLOCK` 采样只描述二者的对应关系；
 * - 能力协商 fail-closed：请求了声明不支持的能力必须明确不支持，未知能力一律视为不支持；
 * - 录音开关可见、结束会话停止采集（最小保留，不默认永久保存全程录音）。
 */

export const VOICE_ALIGNMENT_ACCURACIES = ['WORD_EXACT', 'AUDIO_RANGE', 'UTTERANCE_SNAPSHOT', 'UNAVAILABLE'] as const;
export const voiceAlignmentAccuracySchema = z.enum(VOICE_ALIGNMENT_ACCURACIES);
export type VoiceAlignmentAccuracy = z.infer<typeof voiceAlignmentAccuracySchema>;

export const VOICE_CAPTURE_STATES = ['IDLE', 'REQUESTING_PERMISSION', 'CAPTURING', 'DENIED', 'UNAVAILABLE', 'ERROR'] as const;
export const voiceCaptureStateSchema = z.enum(VOICE_CAPTURE_STATES);
export type VoiceCaptureState = z.infer<typeof voiceCaptureStateSchema>;

/** 采集状态读面：监听开关可见、错误可辨（离开/结束会话必须停止采集）。 */
export const voiceCaptureStatusSchema = z.object({
  state: voiceCaptureStateSchema,
  listening: z.boolean(),
  /** 可见开关：用户必须能看到麦克风是否在采集 */
  visible: z.boolean().default(true),
  startedAtMonotonicMs: z.number().int().nonnegative().nullable().default(null),
  lastErrorCode: z.string().min(1).max(120).nullable().default(null),
}).strict();
export type VoiceCaptureStatus = z.infer<typeof voiceCaptureStatusSchema>;

/** 请求的采集约束（客户端声明，不等于权限，也不等于服务端适配器能力）。 */
export const voiceCaptureConstraintsSchema = z.object({
  sampleRate: z.number().int().positive().max(96_000).default(16_000),
  channelCount: z.literal(1).default(1),
}).strict();
export type VoiceCaptureConstraints = z.infer<typeof voiceCaptureConstraintsSchema>;

/* ------------------------------------------------------------------ */
/* 能力协商（按适配器真实能力裁决；未知一律不支持）                        */
/* ------------------------------------------------------------------ */

export const voiceNegotiationRequestSchema = z.object({
  preferredTransport: voiceTransportSchema.optional(),
  required: z.array(voiceCapabilityFlagSchema).max(VOICE_CAPABILITY_FLAGS.length).default([]),
}).strict();
export type VoiceNegotiationRequest = z.infer<typeof voiceNegotiationRequestSchema>;

export const voiceNegotiationResultSchema = z.object({
  capabilities: voiceCapabilitiesSchema,
  /** 请求但声明不支持的标志（非空即 fail-closed，调用方必须拒绝） */
  unsupported: z.array(voiceCapabilityFlagSchema),
}).strict();
export type VoiceNegotiationResult = z.infer<typeof voiceNegotiationResultSchema>;

/** 协商入参（`required` 可省略）。 */
export interface VoiceNegotiationInput {
  preferredTransport?: VoiceTransport;
  required?: readonly VoiceCapabilityFlag[];
}

/**
 * 按**声明的真实能力**协商：优先 `preferredTransport`，否则取第一个；请求的能力若未声明支持，进 `unsupported`。
 * 没有任何适配器时抛错（fail-closed），不会返回虚假能力。
 */
export function negotiateVoiceCapabilities(
  declared: readonly VoiceCapabilities[],
  request: VoiceNegotiationInput = {},
): VoiceNegotiationResult {
  if (declared.length === 0) throw new RangeError('no voice adapter declared');
  const chosen = request.preferredTransport === undefined
    ? declared[0]!
    : declared.find((capabilities) => capabilities.transport === request.preferredTransport);
  if (chosen === undefined) {
    throw new RangeError(`no voice adapter supports transport ${request.preferredTransport ?? 'unknown'}`);
  }
  const required = request.required ?? [];
  const unsupported = required.filter((flag) => !voiceSupports(chosen, flag));
  return voiceNegotiationResultSchema.parse({ capabilities: chosen, unsupported });
}

/* ------------------------------------------------------------------ */
/* 音频/单调/序列时间对齐                                                  */
/* ------------------------------------------------------------------ */

/** 一次音频时钟采样：audioContext 时间 ↔ 本地单调时钟的对应关系。 */
export const voiceClockSampleSchema = z.object({
  audioContextTimeMs: z.number().finite().nonnegative(),
  monotonicMs: z.number().int().nonnegative(),
}).strict();
export type VoiceClockSample = z.infer<typeof voiceClockSampleSchema>;

/** 播放锚点：某单调时刻序列处于什么位置、是否在播放（用于把单调时间映射回序列时间）。 */
export const voicePlaybackAnchorSchema = z.object({
  monotonicMs: z.number().int().nonnegative(),
  sequenceTime: mediaTimeSchema,
  state: z.enum(['PLAYING', 'PAUSED']),
}).strict();
export type VoicePlaybackAnchor = z.infer<typeof voicePlaybackAnchorSchema>;

export const voiceTranscriptAlignmentSchema = z.object({
  utteranceId: opaqueIdSchema,
  transcriptRevision: z.number().int().nonnegative(),
  /** 供应商给出的音频位置（无则不填） */
  audioRange: mediaRangeSchema.nullable().default(null),
  /** 精确到区间的序列定位（AUDIO_RANGE/WORD_EXACT 才填） */
  sequenceRange: mediaRangeSchema.nullable().default(null),
  /** 发话快照点（无音频位置时使用） */
  sequencePoint: mediaTimeSchema.nullable().default(null),
  accuracy: voiceAlignmentAccuracySchema,
  /** 诊断用漂移（音频推导点 − 发话快照点，毫秒）；不是修正值 */
  driftMs: z.number().finite().nullable().default(null),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();
export type VoiceTranscriptAlignment = z.infer<typeof voiceTranscriptAlignmentSchema>;

/** 音频时间 → 本地单调时间（按采样线性插值；单采样按速率 1 外推）。 */
export function mapAudioTimeToMonotonicMs(audioContextTimeMs: number, samples: readonly VoiceClockSample[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left.audioContextTimeMs - right.audioContextTimeMs);
  if (audioContextTimeMs < sorted[0]!.audioContextTimeMs) return null;
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1]!;
    const current = sorted[index]!;
    if (audioContextTimeMs <= current.audioContextTimeMs) {
      const span = current.audioContextTimeMs - previous.audioContextTimeMs;
      if (span <= 0) return current.monotonicMs;
      const fraction = (audioContextTimeMs - previous.audioContextTimeMs) / span;
      return previous.monotonicMs + fraction * (current.monotonicMs - previous.monotonicMs);
    }
  }
  const last = sorted[sorted.length - 1]!;
  return last.monotonicMs + (audioContextTimeMs - last.audioContextTimeMs);
}

const mediaTimeToMs = (time: MediaTime): number => (Number(time.ticks) * time.timebase.num * 1000) / time.timebase.den;

const msToMediaTime = (milliseconds: number): MediaTime =>
  mediaTimeSchema.parse({ ticks: String(Math.round(milliseconds)), timebase: { num: 1, den: 1000 } });

/** 本地单调时间 → 序列时间（用不晚于目标时刻的播放锚点；播放中按 1x 推进，暂停则保持）。 */
export function mapMonotonicToSequenceTime(monotonicMs: number, anchors: readonly VoicePlaybackAnchor[]): MediaTime | null {
  if (anchors.length === 0) return null;
  const sorted = [...anchors].sort((left, right) => left.monotonicMs - right.monotonicMs);
  const first = sorted[0]!;
  if (monotonicMs < first.monotonicMs) return null;
  let anchor = first;
  for (const candidate of sorted) {
    if (candidate.monotonicMs <= monotonicMs) anchor = candidate;
    else break;
  }
  if (anchor.state === 'PAUSED') return anchor.sequenceTime;
  const offsetMs = monotonicMs - anchor.monotonicMs;
  return addMediaTime(anchor.sequenceTime, msToMediaTime(offsetMs));
}

/**
 * 把一段音频位置对齐到序列区间。
 * 只有时钟采样 + 播放锚点齐备时才能得到 `AUDIO_RANGE`/`WORD_EXACT`；否则返回 null（不猜）。
 */
export function alignVoiceAudioRange(input: {
  audioRange: MediaRange;
  clockSamples: readonly VoiceClockSample[];
  playbackAnchors: readonly VoicePlaybackAnchor[];
  wordTiming: boolean;
}): { sequenceRange: MediaRange; accuracy: Extract<VoiceAlignmentAccuracy, 'WORD_EXACT' | 'AUDIO_RANGE'>; driftMs: number | null } | null {
  const audioRange = mediaRangeSchema.parse(input.audioRange);
  const audioStartMs = mediaTimeToMs(audioRange.start);
  const audioEndMs = mediaTimeToMs(audioRange.end);
  const startMono = mapAudioTimeToMonotonicMs(audioStartMs, input.clockSamples);
  const endMono = mapAudioTimeToMonotonicMs(audioEndMs, input.clockSamples);
  if (startMono === null || endMono === null) return null;
  const startSequence = mapMonotonicToSequenceTime(startMono, input.playbackAnchors);
  const endSequence = mapMonotonicToSequenceTime(endMono, input.playbackAnchors);
  if (startSequence === null || endSequence === null) return null;
  const [start, end] = compareMediaTime(startSequence, endSequence) <= 0 ? [startSequence, endSequence] : [endSequence, startSequence];
  if (compareMediaTime(start, end) === 0) return null;
  return {
    sequenceRange: mediaRangeSchema.parse({ start, end }),
    accuracy: input.wordTiming ? 'WORD_EXACT' : 'AUDIO_RANGE',
    driftMs: null,
  };
}

/** 漂移诊断：音频推导的起点与发话快照点的差（毫秒）；用于显示不确定性，不用于改写锚点。 */
export function alignmentDriftMs(derived: MediaTime, snapshot: MediaTime): number {
  return mediaTimeToMs(subtractMediaTime(derived, snapshot));
}
