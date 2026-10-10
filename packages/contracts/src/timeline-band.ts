import { z } from 'zod';
import {
  compareMediaTime,
  frameIndexToMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  mediaTimeToFrameIndex,
  type FrameRate,
  type MediaRange,
  type MediaTime,
} from './common/media-time.js';
import { temporalSelectionSchema, type TemporalSelection } from './selection.js';

/**
 * N04-04-s1：横向时间带的**权威换算层**（增量设计 §4）。
 *
 * 纪律：
 * - 横向坐标先按时间带**可视窗口**换算，再进入项目有理时基；**不直接以浮点毫秒作为新工程权威时间**；
 * - 播放头（scrub）与时间选区是**两个独立模型**：标尺拖动改播放头，选择带拖动改 `temporalSelection`；
 * - POINT 与 RANGES 是不同形状：单击（位移小于阈值）得到 POINT，拖动得到半开区间 `[start,end)`，
 *   零长度拖动**不得**伪装成 RANGE；
 * - 多区间保留显式区间，不合并成中间整段（§4.1）。
 */

/** 拖动位移小于该像素阈值视为"时间点"而不是区间。 */
export const TIMELINE_DRAG_POINT_THRESHOLD_PX = 3;
/** 时间选择最多保留的区间数（与 `temporalSelectionSchema` 上限一致）。 */
export const MAX_TIMELINE_RANGES = 64;

/** 横向时间带可视窗口：`[start, end)` 映射到 `[0, widthPx]`。 */
export const timelineViewportSchema = z
  .object({
    start: mediaTimeSchema,
    end: mediaTimeSchema,
    widthPx: z.number().finite().positive().max(1_000_000),
  })
  .strict()
  .refine((value) => compareMediaTime(value.start, value.end) < 0, 'timeline viewport window must be nonempty (start < end)');

export type TimelineViewport = z.infer<typeof timelineViewportSchema>;

/** 换算结果时基：纳秒（精确有理，非浮点毫秒）。 */
const NANOSECOND_TIMEBASE = { num: 1, den: 1_000_000_000 } as const;

type Fraction = { num: bigint; den: bigint };

function seconds(time: MediaTime): Fraction {
  return {
    num: BigInt(time.ticks) * BigInt(time.timebase.num),
    den: BigInt(time.timebase.den),
  };
}

function divideRounded(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  const magnitude = remainder < 0n ? -remainder : remainder;
  return magnitude * 2n >= denominator ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
}

/** 以纳秒有理时基构造 MediaTime（拒绝越界）。 */
function nanosecondsToMediaTime(ticks: bigint): MediaTime {
  return mediaTimeSchema.parse({ ticks: ticks.toString(), timebase: NANOSECOND_TIMEBASE });
}

/**
 * 时间带上横向像素坐标 → 序列有理时间。
 * 允许 x 略微超出 `[0, widthPx]`（横向滚动/边缘外绘制），但必须有限。
 * 提供 `frameRate` 时吸附到最近帧边界（编辑边界必须帧对齐）。
 */
export function sequenceTimeAtX(
  viewport: TimelineViewport,
  xPx: number,
  options: { frameRate?: FrameRate } = {},
): MediaTime {
  const window = timelineViewportSchema.parse(viewport);
  if (!Number.isFinite(xPx)) throw new RangeError('x must be finite');
  const width = window.widthPx;

  const start = seconds(window.start);
  const end = seconds(window.end);
  // span = end - start（秒）
  const spanNum = end.num * start.den - start.num * end.den;
  const spanDen = end.den * start.den;

  // fraction = x / width，放大 1e6 保留亚像素精度（bigint 精确）
  const xNum = BigInt(Math.round(xPx * 1_000_000));
  const xDen = BigInt(Math.round(width * 1_000_000));

  // time = start + fraction * span
  // 公共分母 D = startDen * xDen * spanDen
  // 分子 N = startNum * xDen * spanDen + xNum * spanNum * startDen
  const denominator = start.den * xDen * spanDen;
  const numerator = start.num * xDen * spanDen + xNum * spanNum * start.den;
  const nanos = divideRounded(numerator * BigInt(NANOSECOND_TIMEBASE.den), denominator);
  const raw = nanosecondsToMediaTime(nanos);

  if (options.frameRate !== undefined) {
    const frameIndex = mediaTimeToFrameIndex(raw, options.frameRate, 'nearest');
    return frameIndexToMediaTime(frameIndex, options.frameRate);
  }
  return raw;
}

/** 序列有理时间 → 时间带横向像素坐标（仅用于呈现；返回浮点像素，不作为工程权威时间）。 */
export function xAtSequenceTime(viewport: TimelineViewport, time: MediaTime): number {
  const window = timelineViewportSchema.parse(viewport);
  const input = mediaTimeSchema.parse(time);
  const start = seconds(window.start);
  const end = seconds(window.end);
  const value = seconds(input);
  const spanNum = end.num * start.den - start.num * end.den;
  const spanDen = end.den * start.den;
  // fraction = (time - start) / span
  const offsetNum = value.num * start.den - start.num * value.den;
  const offsetDen = value.den * start.den;
  const numerator = Number(offsetNum) * Number(spanDen);
  const denominator = Number(offsetDen) * Number(spanNum);
  if (denominator === 0) throw new RangeError('timeline viewport has zero span');
  return (numerator / denominator) * window.widthPx;
}

/** 拖动（或点击）→ 规范时间选择。同一时间点用 POINT 表示，绝不压成零长度 RANGE。 */
export function temporalSelectionFromDrag(input: {
  viewport: TimelineViewport;
  anchorXPx: number;
  focusXPx: number;
  frameRate?: FrameRate;
  pointThresholdPx?: number;
}): TemporalSelection {
  const window = timelineViewportSchema.parse(input.viewport);
  if (!Number.isFinite(input.anchorXPx) || !Number.isFinite(input.focusXPx)) {
    throw new RangeError('drag coordinates must be finite');
  }
  const threshold = input.pointThresholdPx ?? TIMELINE_DRAG_POINT_THRESHOLD_PX;
  const options = input.frameRate === undefined ? {} : { frameRate: input.frameRate };
  if (Math.abs(input.focusXPx - input.anchorXPx) < threshold) {
    return temporalSelectionSchema.parse({
      kind: 'POINT',
      at: sequenceTimeAtX(window, input.anchorXPx, options),
      boundaryDirection: 'AT',
    });
  }
  const first = sequenceTimeAtX(window, input.anchorXPx, options);
  const second = sequenceTimeAtX(window, input.focusXPx, options);
  const start = compareMediaTime(first, second) <= 0 ? first : second;
  const end = compareMediaTime(first, second) <= 0 ? second : first;
  if (compareMediaTime(start, end) === 0) {
    // 帧吸附后坍缩为同一点：如实降级为 POINT，而不是制造非法空区间。
    return temporalSelectionSchema.parse({ kind: 'POINT', at: start, boundaryDirection: 'AT' });
  }
  return temporalSelectionSchema.parse({ kind: 'RANGES', ranges: [mediaRangeSchema.parse({ start, end })] });
}

/** 时间选择包含的区间列表（POINT 返回空数组——点不是零长度区间）。 */
export function temporalSelectionRanges(selection: TemporalSelection): MediaRange[] {
  return selection.kind === 'RANGES' ? selection.ranges.map((range) => mediaRangeSchema.parse(range)) : [];
}

/** 多区间叠加：保留显式区间（不合并中间整段），按 start 排序并去重，超出上限 fail-closed。 */
export function addTemporalRange(selection: TemporalSelection | null, range: MediaRange): TemporalSelection {
  const next = mediaRangeSchema.parse(range);
  const existing = selection === null ? [] : temporalSelectionRanges(selection);
  const merged: MediaRange[] = [...existing, next];
  const sorted = merged.slice().sort((left, right) => compareMediaTime(left.start, right.start));
  const deduped = sorted.filter((candidate, index) => {
    const first = sorted.findIndex(
      (other) => compareMediaTime(other.start, candidate.start) === 0 && compareMediaTime(other.end, candidate.end) === 0,
    );
    return first === index;
  });
  if (deduped.length > MAX_TIMELINE_RANGES) {
    throw new RangeError(`temporal selection exceeds ${String(MAX_TIMELINE_RANGES)} ranges`);
  }
  return temporalSelectionSchema.parse({ kind: 'RANGES', ranges: deduped });
}

export function temporalSelectionEquals(left: TemporalSelection | null, right: TemporalSelection | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind === 'POINT' && right.kind === 'POINT') {
    return left.boundaryDirection === right.boundaryDirection && compareMediaTime(left.at, right.at) === 0;
  }
  if (left.kind === 'RANGES' && right.kind === 'RANGES') {
    if (left.ranges.length !== right.ranges.length) return false;
    return left.ranges.every((range, index) => {
      const other = right.ranges[index]!;
      return compareMediaTime(range.start, other.start) === 0 && compareMediaTime(range.end, other.end) === 0;
    });
  }
  return false;
}

/** 人类可读摘要（UI 标签使用；不参与任何工程权威判定）。 */
export function describeTemporalSelection(selection: TemporalSelection | null, format: (time: MediaTime) => string): string | null {
  if (selection === null) return null;
  if (selection.kind === 'POINT') return format(selection.at);
  return selection.ranges.map((range) => `${format(range.start)}–${format(range.end)}`).join(' · ');
}
