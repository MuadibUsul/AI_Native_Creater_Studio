import { z } from 'zod';
import {
  addMediaTime,
  compareMediaTime,
  frameIndexToMediaTime,
  frameRateSchema,
  mediaRangeSchema,
  mediaTimeSchema,
  mediaTimeToFrameIndex,
  sequenceTimeToSourcePts,
  subtractMediaTime,
  type FrameRate,
  type MediaRange,
  type MediaTime,
} from './common/media-time.js';

/**
 * N04-04（收尾）：逐帧步进、源/序列**双时间码**、以及"这句话 / 这里的音乐"的**语义指向**。
 *
 * 纪律：
 * - 逐帧步进走 `frameIndexToMediaTime`（有理时基），**分数帧率（如 29.97）不累计漂移**；
 * - 双时间码用既有 `sequenceTimeToSourcePts` 做线性映射（不新写一套换算），并如实处理 REVERSE；
 * - 语义指向是**纯函数**：只在给定字幕/音频区域上做半开区间判定，指不到就返回 null，**不猜**。
 */

// ── 1) 逐帧步进 ────────────────────────────────────────────────

/**
 * 步进 N 帧（delta 可负）。`bounds` 给定时夹在区间内的帧边界上（不越界）。
 * 分数帧率下从帧边界出发仍是帧边界（有理运算，无浮点累计误差）。
 */
export function stepFrames(input: {
  time: MediaTime;
  frameRate: FrameRate;
  delta: number;
  bounds?: MediaRange;
}): MediaTime {
  const rate = frameRateSchema.parse(input.frameRate);
  const current = BigInt(mediaTimeToFrameIndex(input.time, rate, 'floor'));
  let target = current + BigInt(Math.trunc(input.delta));
  if (target < 0n) target = 0n;
  if (input.bounds !== undefined) {
    const lower = BigInt(mediaTimeToFrameIndex(input.bounds.start, rate, 'ceil'));
    // 区间**结束**在非帧边界时，可取的最大帧边界是其下一帧（与 `frameIndexToMediaTime` 一致）
    const upper = BigInt(mediaTimeToFrameIndex(input.bounds.end, rate, 'floor'));
    if (target < lower) target = lower;
    if (target > upper) target = upper;
  }
  return frameIndexToMediaTime(target.toString(), rate);
}

/**
 * 帧时间码 `HH:MM:SS:FF`（**非** drop-frame；分数帧率按标称整帧计数显示，即 29.97 → 30 帧/秒的分段）。
 * 规范只要求"分数帧率显示不丢帧"，本函数保证**每个帧号都能被表示**且单调。
 */
export function formatFrameTimecode(time: MediaTime, frameRate: FrameRate): string {
  const rate = frameRateSchema.parse(frameRate);
  const framesPerSecond = Math.max(1, Math.round(rate.num / rate.den));
  const frameIndex = Number(mediaTimeToFrameIndex(time, rate, 'floor'));
  const sign = frameIndex < 0 ? '-' : '';
  const absolute = Math.abs(frameIndex);
  const ff = absolute % framesPerSecond;
  const totalSeconds = Math.floor(absolute / framesPerSecond);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  return `${sign}${pad(hours)}:${pad(minutes)}:${pad(seconds)}:${pad(ff)}`;
}

// ── 2) 源 / 序列双时间码 ───────────────────────────────────────

export const dualTimecodeClipSchema = z.object({
  clipId: z.string().min(1),
  sequenceRange: mediaRangeSchema,
  sourceRange: mediaRangeSchema,
  timeMapping: z.object({
    rate: z.object({ num: z.number().int().positive(), den: z.number().int().positive() }),
    direction: z.enum(['FORWARD', 'REVERSE']),
  }).strict(),
}).strict();
export type DualTimecodeClip = z.infer<typeof dualTimecodeClipSchema>;

export const dualTimecodeSchema = z.object({
  sequenceTime: mediaTimeSchema,
  sourceTime: mediaTimeSchema,
  /** 序列时间码（帧） */
  sequenceTimecode: z.string().min(1),
  /** 源时间码（帧） */
  sourceTimecode: z.string().min(1),
}).strict();
export type DualTimecode = z.infer<typeof dualTimecodeSchema>;

/**
 * 同时给出**序列时间**与**映射后的源时间**（同一播放头两套时间码）。
 * 播放头不在该片段的序列区间内 → 返回 null（不假装属于它）。
 */
export function dualTimecode(input: { sequenceTime: MediaTime; clip: DualTimecodeClip; frameRate: FrameRate }): DualTimecode | null {
  const clip = dualTimecodeClipSchema.parse(input.clip);
  const time = mediaTimeSchema.parse(input.sequenceTime);
  if (compareMediaTime(time, clip.sequenceRange.start) < 0 || compareMediaTime(time, clip.sequenceRange.end) > 0) {
    return null;
  }
  // REVERSE：把序列时间镜像到"正向等价位置"再映射，保证源时间方向正确。
  const mirrored = clip.timeMapping.direction === 'REVERSE'
    ? addMediaTime(clip.sequenceRange.start, subtractMediaTime(clip.sequenceRange.end, time))
    : time;
  const sourceTime = sequenceTimeToSourcePts(mirrored, clip.sequenceRange, clip.sourceRange, 'nearest');
  return dualTimecodeSchema.parse({
    sequenceTime: time,
    sourceTime,
    sequenceTimecode: formatFrameTimecode(time, input.frameRate),
    sourceTimecode: formatFrameTimecode(sourceTime, input.frameRate),
  });
}

// ── 3) "这句话 / 这里的音乐" 语义指向 ────────────────────────────

export const utteranceSourceSchema = z.object({
  captionId: z.string().min(1),
  sequenceRange: mediaRangeSchema,
  text: z.string().default(''),
  trackId: z.string().min(1).nullable().default(null),
  words: z.array(z.object({ text: z.string(), range: mediaRangeSchema }).strict()).default([]),
}).strict();
export type UtteranceSource = z.infer<typeof utteranceSourceSchema>;

export const musicRegionSourceSchema = z.object({
  regionId: z.string().min(1),
  sequenceRange: mediaRangeSchema,
  trackId: z.string().min(1).nullable().default(null),
  label: z.string().default(''),
}).strict();
export type MusicRegionSource = z.infer<typeof musicRegionSourceSchema>;

export const TEMPORAL_TARGET_KINDS = ['UTTERANCE', 'MUSIC_REGION'] as const;
export const temporalTargetSchema = z.object({
  kind: z.enum(TEMPORAL_TARGET_KINDS),
  at: mediaTimeSchema,
  /** 命中的目标（半开区间 `[start,end)`；可能多个——重叠时全部返回，不擅自选一个） */
  targets: z.array(z.object({
    objectKind: z.enum(['CAPTION', 'AUDIO_REGION']),
    objectId: z.string().min(1),
    sequenceRange: mediaRangeSchema,
    text: z.string().default(''),
    /** 该时刻落在哪个词上（字幕有词级 timing 时给出；无则 null） */
    wordText: z.string().nullable().default(null),
  }).strict()),
}).strict();
export type TemporalTarget = z.infer<typeof temporalTargetSchema>;

const containsTime = (range: MediaRange, time: MediaTime): boolean =>
  compareMediaTime(range.start, time) <= 0 && compareMediaTime(time, range.end) < 0;

/**
 * "这句话" → 命中该时刻的**字幕**（含词级定位）。
 * 指不到任何字幕 → `targets` 为空（调用方应追问，不得猜最近的一条）。
 */
export function resolveUtteranceTarget(input: { captions: readonly UtteranceSource[]; at: MediaTime; trackIds?: readonly string[] }): TemporalTarget {
  const at = mediaTimeSchema.parse(input.at);
  const scoped = input.trackIds === undefined
    ? input.captions
    : input.captions.filter((caption) => caption.trackId !== null && input.trackIds!.includes(caption.trackId));
  const targets = scoped.filter((caption) => containsTime(caption.sequenceRange, at)).map((caption) => {
    const word = caption.words.find((entry) => containsTime(entry.range, at));
    return {
      objectKind: 'CAPTION' as const,
      objectId: caption.captionId,
      sequenceRange: caption.sequenceRange,
      text: caption.text,
      wordText: word?.text ?? null,
    };
  });
  return temporalTargetSchema.parse({ kind: 'UTTERANCE', at, targets });
}

/** "这里的音乐" → 命中该时刻的**音频区域**（多个重叠时全部返回）。 */
export function resolveMusicRegionTarget(input: { regions: readonly MusicRegionSource[]; at: MediaTime; trackIds?: readonly string[] }): TemporalTarget {
  const at = mediaTimeSchema.parse(input.at);
  const scoped = input.trackIds === undefined
    ? input.regions
    : input.regions.filter((region) => region.trackId !== null && input.trackIds!.includes(region.trackId));
  const targets = scoped.filter((region) => containsTime(region.sequenceRange, at)).map((region) => ({
    objectKind: 'AUDIO_REGION' as const,
    objectId: region.regionId,
    sequenceRange: region.sequenceRange,
    text: region.label,
    wordText: null,
  }));
  return temporalTargetSchema.parse({ kind: 'MUSIC_REGION', at, targets });
}
