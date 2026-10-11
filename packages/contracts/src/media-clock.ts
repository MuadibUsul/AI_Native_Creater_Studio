import { z } from 'zod';
import { mediaRangeSchema, mediaTimeToApproxMilliseconds, type MediaRange } from './common/media-time.js';

/**
 * N03-13：**统一媒体时钟**与音画同步调度（纯逻辑；不含任何 WebAudio/DOM API）。
 *
 * 纪律（方案 §13；§20.6 E19）：
 * - 一个**统一媒体时钟**调度音频／画面／字幕；**无音轨时用同接口的虚拟时钟**——
 *   上层代码不因"有没有声音"分叉；
 * - **seek epoch**：每次 seek 递增 epoch；任何"按旧 epoch 调度"的音频一律**不得播放**
 *   （连续 seek 后旧音频不许出声）；
 * - **挂起/恢复**：挂起期间时钟**冻结**（音频时间前进也不推进序列时间）；恢复时**重锚**，
 *   不跳变、不快进、不重复音轨；
 * - **播放许可**：音频未授权时给出**明确提示**，不得静默无声当没事；
 * - 同步修正：容差带内**不修正**（避免抖动/颤音），超出容差按比例微调速率，超出上限才重定位。
 */

export const MEDIA_CLOCK_SOURCES = ['AUDIO_CONTEXT', 'VIRTUAL'] as const;
export const mediaClockSourceSchema = z.enum(MEDIA_CLOCK_SOURCES);
export type MediaClockSource = z.infer<typeof mediaClockSourceSchema>;

export const AUDIO_PLAYBACK_PERMISSIONS = ['GRANTED', 'DENIED', 'UNKNOWN'] as const;
export const audioPlaybackPermissionSchema = z.enum(AUDIO_PLAYBACK_PERMISSIONS);
export type AudioPlaybackPermission = z.infer<typeof audioPlaybackPermissionSchema>;

export const MEDIA_CLOCK_NOTICES = ['NONE', 'NO_AUDIO_TRACK', 'AUDIO_PERMISSION_REQUIRED', 'AUDIO_CONTEXT_SUSPENDED'] as const;
export const mediaClockNoticeSchema = z.enum(MEDIA_CLOCK_NOTICES);
export type MediaClockNotice = z.infer<typeof mediaClockNoticeSchema>;

/** 音画同步阈值（§20：容差内不修正；超上限重定位）。 */
export const MEDIA_CLOCK_SYNC = {
  /** 容差带（±ms）：带内不修正，避免抖动与颤音 */
  toleranceMs: 40,
  /** 超过此漂移直接重定位（而不是继续微调速率） */
  reseekThresholdMs: 250,
  /** 速率微调范围（±比例） */
  maxRateNudge: 0.05,
} as const;

export const mediaClockStateSchema = z.object({
  source: mediaClockSourceSchema,
  permission: audioPlaybackPermissionSchema,
  /** 锚点：`sequenceTime = anchorSequenceMs + (audioMs - anchorAudioMs) * rate` */
  anchorAudioMs: z.number().finite(),
  anchorSequenceMs: z.number().finite(),
  rate: z.number().finite().positive(),
  suspended: z.boolean(),
  /** seek 代际：每次 seek/重定位递增；旧代际的已调度音频一律丢弃 */
  epoch: z.number().int().min(0),
  /** 挂起时刻的音频时间（恢复时据此重锚，不许把挂起期间的时间算进序列） */
  suspendedAtAudioMs: z.number().finite().nullable(),
}).strict();
export type MediaClockState = z.infer<typeof mediaClockStateSchema>;

export const createMediaClock = (input: {
  hasAudioTrack: boolean;
  permission?: AudioPlaybackPermission;
  audioMs: number;
  sequenceMs: number;
}): MediaClockState => mediaClockStateSchema.parse({
  source: input.hasAudioTrack ? 'AUDIO_CONTEXT' : 'VIRTUAL',
  permission: input.permission ?? 'UNKNOWN',
  anchorAudioMs: input.audioMs,
  anchorSequenceMs: input.sequenceMs,
  rate: 1,
  suspended: false,
  epoch: 0,
  suspendedAtAudioMs: null,
});

/** 当前序列时间；**挂起时冻结**在挂起点（音频时间继续走也不推进）。 */
export function sequenceTimeAt(state: MediaClockState, audioMs: number): number {
  const clock = mediaClockStateSchema.parse(state);
  if (clock.suspended) return clock.anchorSequenceMs;
  return clock.anchorSequenceMs + (audioMs - clock.anchorAudioMs) * clock.rate;
}

/** 变速：**在给定音频时刻重锚**，保证序列时间连续（不跳变），之后按新速率推进。 */
export function setMediaClockRate(state: MediaClockState, audioMs: number, rate: number): MediaClockState {
  const clock = mediaClockStateSchema.parse(state);
  const sequenceNow = sequenceTimeAt(clock, audioMs);
  return mediaClockStateSchema.parse({ ...clock, rate, anchorAudioMs: audioMs, anchorSequenceMs: sequenceNow });
}

/** 挂起（如切后台/系统抢占音频）：冻结时钟并记录挂起点。 */
export function suspendMediaClock(state: MediaClockState, audioMs: number): MediaClockState {
  const clock = mediaClockStateSchema.parse(state);
  if (clock.suspended) return clock;
  return mediaClockStateSchema.parse({
    ...clock, suspended: true, suspendedAtAudioMs: audioMs,
    anchorSequenceMs: sequenceTimeAt(clock, audioMs), anchorAudioMs: audioMs,
  });
}

/**
 * 恢复：把锚点移到**恢复时刻的音频时间**，序列时间停在挂起点。
 * 因此挂起期间流逝的音频时间**不会**被算进序列时间（后台恢复不快进）。
 */
export function resumeMediaClock(state: MediaClockState, audioMs: number): MediaClockState {
  const clock = mediaClockStateSchema.parse(state);
  if (!clock.suspended) return clock;
  return mediaClockStateSchema.parse({
    ...clock, suspended: false, anchorAudioMs: audioMs,
    anchorSequenceMs: clock.anchorSequenceMs, // 停在挂起点
    suspendedAtAudioMs: null,
  });
}

/** seek／重定位：重锚到新时间并**递增 epoch**（旧代际的已调度音频随之作废）。 */
export function seekMediaClock(state: MediaClockState, audioMs: number, sequenceMs: number): MediaClockState {
  const clock = mediaClockStateSchema.parse(state);
  return mediaClockStateSchema.parse({
    ...clock, anchorAudioMs: audioMs, anchorSequenceMs: sequenceMs, epoch: clock.epoch + 1, suspendedAtAudioMs: null,
  });
}

/** 该条已调度音频是否允许播放（**只有当前 epoch** 允许）。 */
export const isScheduledAudioCurrent = (state: MediaClockState, scheduledEpoch: number): boolean =>
  mediaClockStateSchema.parse(state).epoch === scheduledEpoch;

// ── 播放许可与无音轨：同接口的虚拟时钟 ────────────────────────────

export const mediaClockPlanSchema = z.object({
  source: mediaClockSourceSchema,
  notice: mediaClockNoticeSchema,
  /** 只能静音播画面（宿主必须把提示显式呈现给用户） */
  silentVideoOnly: z.boolean(),
}).strict();
export type MediaClockPlan = z.infer<typeof mediaClockPlanSchema>;

/**
 * 决定用哪套时钟并给出**必须呈现给用户**的提示。
 * 音频被拒时不能"当没事静音播"——必须给出 `AUDIO_PERMISSION_REQUIRED` 并标记只静音播画面。
 */
export function resolveMediaClockPlan(input: {
  hasAudioTrack: boolean;
  audioPermission: AudioPlaybackPermission;
}): MediaClockPlan {
  if (!input.hasAudioTrack) {
    return mediaClockPlanSchema.parse({ source: 'VIRTUAL', notice: 'NO_AUDIO_TRACK', silentVideoOnly: false });
  }
  if (input.audioPermission === 'DENIED') {
    return mediaClockPlanSchema.parse({ source: 'VIRTUAL', notice: 'AUDIO_PERMISSION_REQUIRED', silentVideoOnly: true });
  }
  return mediaClockPlanSchema.parse({ source: 'AUDIO_CONTEXT', notice: 'NONE', silentVideoOnly: false });
}

// ── 音画同步修正决策（容差带内不修正） ──────────────────────────

export const MEDIA_CLOCK_SYNC_ACTIONS = ['NONE', 'NUDGE_RATE', 'RESEEK'] as const;
export const mediaClockSyncActionSchema = z.enum(MEDIA_CLOCK_SYNC_ACTIONS);
export type MediaClockSyncAction = z.infer<typeof mediaClockSyncActionSchema>;

export const mediaClockSyncDecisionSchema = z.object({
  action: mediaClockSyncActionSchema,
  driftMs: z.number().finite(),
  /** 建议的速率（仅 NUDGE_RATE 时有意义） */
  suggestedRate: z.number().finite().positive().nullable(),
  reason: z.string().min(1).max(80),
}).strict();
export type MediaClockSyncDecision = z.infer<typeof mediaClockSyncDecisionSchema>;

/**
 * 以**主时钟**（音频或虚拟）为基准，比较另一路（画面）呈现的序列时间，决定是否修正。
 * - `|drift| ≤ toleranceMs` → **NONE**（带内不修正，避免抖动/颤音）；
 * - `toleranceMs < |drift| ≤ reseekThresholdMs` → 按比例微调速率（限幅 ±maxRateNudge）；
 * - `|drift| > reseekThresholdMs` → **RESEEK**（继续微调已无意义）。
 */
export function decideMediaClockSync(input: {
  masterSequenceMs: number;
  followerSequenceMs: number;
  toleranceMs?: number;
  reseekThresholdMs?: number;
  maxRateNudge?: number;
}): MediaClockSyncDecision {
  const driftMs = input.followerSequenceMs - input.masterSequenceMs;
  const tolerance = input.toleranceMs ?? MEDIA_CLOCK_SYNC.toleranceMs;
  const reseek = input.reseekThresholdMs ?? MEDIA_CLOCK_SYNC.reseekThresholdMs;
  const maxNudge = input.maxRateNudge ?? MEDIA_CLOCK_SYNC.maxRateNudge;
  const magnitude = Math.abs(driftMs);

  if (magnitude <= tolerance) {
    return mediaClockSyncDecisionSchema.parse({ action: 'NONE', driftMs, suggestedRate: null, reason: 'WITHIN_TOLERANCE' });
  }
  if (magnitude > reseek) {
    return mediaClockSyncDecisionSchema.parse({ action: 'RESEEK', driftMs, suggestedRate: null, reason: 'DRIFT_OVER_RESEEK_THRESHOLD' });
  }
  // 画面超前（drift>0）→ 音画需让画面"慢下来"：按比例给出略小于 1 的速率，反之亦然。
  const proportion = magnitude / reseek;
  const nudge = Math.min(maxNudge, proportion * maxNudge);
  const suggestedRate = driftMs > 0 ? 1 - nudge : 1 + nudge;
  return mediaClockSyncDecisionSchema.parse({ action: 'NUDGE_RATE', driftMs, suggestedRate, reason: 'DRIFT_WITHIN_NUDGE_RANGE' });
}

/** 便捷：当前时钟是否覆盖某个片段序列区间（clip 边界调度用）。 */
export const isClockInsideRange = (sequenceMs: number, range: MediaRange): boolean => {
  const span = mediaRangeSchema.parse(range);
  return sequenceMs >= mediaTimeToApproxMilliseconds(span.start) && sequenceMs < mediaTimeToApproxMilliseconds(span.end);
};

// ── 音量淡变（clip 边界的增益包络） ─────────────────────────────

export const audioGainEnvelopeSchema = z.object({
  gainDb: z.number().finite().min(-96).max(24),
  fadeInMs: z.number().finite().nonnegative(),
  fadeOutMs: z.number().finite().nonnegative(),
}).strict();
export type AudioGainEnvelope = z.infer<typeof audioGainEnvelopeSchema>;

/**
 * 片段内某时刻的线性增益（dB）：淡入/淡出各自线性爬升/回落，其余为 `gainDb`。
 * 淡入淡出重叠时取**较小者**（不会因为重叠而超过目标增益）。
 */
export function gainDbAt(input: {
  envelope: AudioGainEnvelope;
  localMs: number;
  /** 片段时长（算淡出起点；必须给出才启用淡出） */
  durationMs: number;
}): number {
  const envelope = audioGainEnvelopeSchema.parse(input.envelope);
  const target = envelope.gainDb;
  const local = Math.max(0, input.localMs);
  const duration = Math.max(0, input.durationMs);
  let factor = 1;
  if (envelope.fadeInMs > 0 && local < envelope.fadeInMs) factor = Math.min(factor, local / envelope.fadeInMs);
  const fadeOutStart = duration - envelope.fadeOutMs;
  if (envelope.fadeOutMs > 0 && local > fadeOutStart) {
    factor = Math.min(factor, Math.max(0, (duration - local) / envelope.fadeOutMs));
  }
  // 线性因子作用于**dB 到静音的插值**：factor=0 → -96dB（视为静音）
  const silenceDb = -96;
  return factor >= 1 ? target : silenceDb + (target - silenceDb) * factor;
}
