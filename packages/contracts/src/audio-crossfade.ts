/**
 * N03-06 基础混音的共享判据（平台中立纯函数）。
 *
 * - 等功率 crossfade：交叉点两侧的增益按 cos/sin 曲线互补，交叉段内功率恒定（避免中段凹陷）；
 * - 削波判据：以"源峰值 + 增益"作为该轨估计峰值，超过 0 dBFS 即判削波（fail-closed，绝不静默削波）；
 * - 意外静音判据：存在音频区域但可听轨数为 0（全部被静音或未被独奏命中）即判静音。
 */

export const AUDIO_MIX_GUARD_REASONS = {
  /** 估计峰值超过 0 dBFS：拒绝而不是静默削波 */
  CLIPPING: 'MIX_CLIPPING_DETECTED',
  /** 有音频内容但输出可听轨为 0：拒绝而不是意外静音 */
  EMPTY_OUTPUT: 'MIX_EMPTY_OUTPUT',
  /** 原声保护模式：改动会改变语言内容（源流/局部时间/时间绑定） */
  ORIGINAL_SPEECH_PROTECTED: 'ORIGINAL_SPEECH_PROTECTED',
} as const;

export type AudioMixGuardReason = (typeof AUDIO_MIX_GUARD_REASONS)[keyof typeof AUDIO_MIX_GUARD_REASONS];

/** 源峰值缺省参考（保守）：未测量时按 -1 dBFS 估计，任何正向增益都会被提示/拒绝。 */
export const DEFAULT_SOURCE_PEAK_DB = -1;

/** 等功率 crossfade：progress ∈ [0,1] → { out, in }（in² + out² = 1）。 */
export function equalPowerFadeGains(progress: number): { out: number; in: number } {
  if (!Number.isFinite(progress)) throw new RangeError('progress must be finite');
  const clamped = Math.min(1, Math.max(0, progress));
  const angle = (clamped * Math.PI) / 2;
  return { out: Math.cos(angle), in: Math.sin(angle) };
}

/** 采样等功率曲线：把 [0,1] 均匀切成 steps+1 个点（供 UI 预览与测试使用）。 */
export function sampleEqualPowerCurve(steps: number): { progress: number; out: number; in: number }[] {
  if (!Number.isInteger(steps) || steps < 1) throw new RangeError('steps must be a positive integer');
  const points: { progress: number; out: number; in: number }[] = [];
  for (let index = 0; index <= steps; index += 1) {
    const progress = index / steps;
    const gains = equalPowerFadeGains(progress);
    points.push({ progress, out: gains.out, in: gains.in });
  }
  return points;
}

/** 线性增益 ↔ dB 换算（混音判据统一走 dB）。 */
export const dbToLinear = (decibels: number): number => 10 ** (decibels / 20);
export const linearToDb = (linear: number): number => (linear <= 0 ? Number.NEGATIVE_INFINITY : 20 * Math.log10(linear));
