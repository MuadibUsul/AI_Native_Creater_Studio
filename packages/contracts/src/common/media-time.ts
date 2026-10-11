import { z } from 'zod';

/** Signed 64-bit ticks are serialized as decimal strings; arithmetic stays in bigint. */
const MIN_TICKS = -(1n << 63n);
const MAX_TICKS = (1n << 63n) - 1n;
const MAX_COMPONENT = 2_147_483_647;

function gcd(left: number, right: number): number {
  let a = left;
  let b = right;
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

const componentSchema = z.number().int().min(1).max(MAX_COMPONENT);

export const rationalSchema = z.object({
  num: componentSchema,
  den: componentSchema,
}).strict().refine(({ num, den }) => gcd(num, den) === 1, 'Rational must be reduced');

export const frameRateSchema = rationalSchema;

export const mediaTicksSchema = z.string().min(1).max(20)
  .regex(/^(?:0|-?[1-9]\d*)$/, 'Canonical signed decimal ticks required')
  .refine((ticks) => {
    try {
      const value = BigInt(ticks);
      return value >= MIN_TICKS && value <= MAX_TICKS;
    } catch {
      return false;
    }
  }, 'Ticks exceed signed 64-bit range');

export const mediaTimeSchema = z.object({
  ticks: mediaTicksSchema,
  timebase: rationalSchema,
}).strict();

export type Rational = z.infer<typeof rationalSchema>;
export type FrameRate = z.infer<typeof frameRateSchema>;
export type MediaTime = z.infer<typeof mediaTimeSchema>;

function seconds(time: MediaTime): { num: bigint; den: bigint } {
  return {
    num: BigInt(time.ticks) * BigInt(time.timebase.num),
    den: BigInt(time.timebase.den),
  };
}

/** Exact comparison; works across timebases and for negative source PTS. */
export function compareMediaTime(left: MediaTime, right: MediaTime): -1 | 0 | 1 {
  const a = seconds(mediaTimeSchema.parse(left));
  const b = seconds(mediaTimeSchema.parse(right));
  const difference = a.num * b.den - b.num * a.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export const mediaRangeSchema = z.object({
  start: mediaTimeSchema,
  end: mediaTimeSchema,
}).strict().refine(({ start, end }) => compareMediaTime(start, end) < 0, 'Range must be nonempty and half-open');

export type MediaRange = z.infer<typeof mediaRangeSchema>;

/** Range contents are [start, end); the end may only be used as a boundary. */
export function isMediaTimeInRange(time: MediaTime, range: MediaRange): boolean {
  const input = mediaTimeSchema.parse(time);
  const span = mediaRangeSchema.parse(range);
  return compareMediaTime(input, span.start) >= 0 && compareMediaTime(input, span.end) < 0;
}

export const MEDIA_ROUNDING_MODES = ['floor', 'ceil', 'towardZero', 'nearest'] as const;
export const mediaRoundingSchema = z.enum(MEDIA_ROUNDING_MODES);
export type MediaRounding = z.infer<typeof mediaRoundingSchema>;

/** nearest uses ties away from zero. Rounding is required at every boundary. */
function divideRounded(numerator: bigint, denominator: bigint, mode: MediaRounding): bigint {
  if (denominator <= 0n) throw new RangeError('Denominator must be positive');
  mediaRoundingSchema.parse(mode);
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder === 0n) return quotient;
  switch (mode) {
    case 'floor': return numerator < 0n ? quotient - 1n : quotient;
    case 'ceil': return numerator > 0n ? quotient + 1n : quotient;
    case 'towardZero': return quotient;
    case 'nearest': {
      const magnitude = remainder < 0n ? -remainder : remainder;
      return magnitude * 2n >= denominator ? quotient + (numerator < 0n ? -1n : 1n) : quotient;
    }
  }
}

function checkedTime(ticks: bigint, timebase: Rational): MediaTime {
  if (ticks < MIN_TICKS || ticks > MAX_TICKS) throw new RangeError('Ticks exceed signed 64-bit range');
  return mediaTimeSchema.parse({ ticks: ticks.toString(), timebase });
}

export function normalizeRational(num: number, den: number): Rational {
  componentSchema.parse(num);
  componentSchema.parse(den);
  const divisor = gcd(num, den);
  return rationalSchema.parse({ num: num / divisor, den: den / divisor });
}

/** Convert once at an output boundary; never accumulate individually rounded segments. */
export function rescaleMediaTime(time: MediaTime, target: Rational, rounding: MediaRounding): MediaTime {
  const source = mediaTimeSchema.parse(time);
  const base = rationalSchema.parse(target);
  const numerator = BigInt(source.ticks) * BigInt(source.timebase.num) * BigInt(base.den);
  const denominator = BigInt(source.timebase.den) * BigInt(base.num);
  return checkedTime(divideRounded(numerator, denominator, rounding), base);
}

export function frameIndexToMediaTime(frameIndex: string, frameRate: FrameRate): MediaTime {
  const rate = frameRateSchema.parse(frameRate);
  return mediaTimeSchema.parse({ ticks: mediaTicksSchema.parse(frameIndex), timebase: normalizeRational(rate.den, rate.num) });
}

export function mediaTimeToFrameIndex(time: MediaTime, frameRate: FrameRate, rounding: MediaRounding): string {
  const rate = frameRateSchema.parse(frameRate);
  return rescaleMediaTime(time, normalizeRational(rate.den, rate.num), rounding).ticks;
}

/** Sequence edit boundaries must land on an output frame, without rounding first. */
export function isMediaTimeFrameAligned(time: MediaTime, frameRate: FrameRate): boolean {
  const value = seconds(mediaTimeSchema.parse(time));
  const rate = frameRateSchema.parse(frameRate);
  return (value.num * BigInt(rate.num)) % (value.den * BigInt(rate.den)) === 0n;
}

export function sampleIndexToMediaTime(sampleIndex: string, sampleRate: number): MediaTime {
  componentSchema.parse(sampleRate);
  return mediaTimeSchema.parse({ ticks: mediaTicksSchema.parse(sampleIndex), timebase: { num: 1, den: sampleRate } });
}

export function mediaTimeToSampleIndex(time: MediaTime, sampleRate: number, rounding: MediaRounding): string {
  componentSchema.parse(sampleRate);
  return rescaleMediaTime(time, { num: 1, den: sampleRate }, rounding).ticks;
}

/** Old integer-ms values remain exact, but new times are not silently written back as ms. */
export function legacyMillisecondsToMediaTime(milliseconds: number): MediaTime {
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) throw new RangeError('Legacy milliseconds must be a nonnegative safe integer');
  return checkedTime(BigInt(milliseconds), { num: 1, den: 1000 });
}

/** Projection into old fields is allowed only when no time precision is lost. */
export function mediaTimeToLegacyMilliseconds(time: MediaTime): number {
  const value = seconds(mediaTimeSchema.parse(time));
  const numerator = value.num * 1000n;
  if (numerator % value.den !== 0n) throw new RangeError('Time cannot be represented in whole legacy milliseconds');
  const milliseconds = numerator / value.den;
  if (milliseconds < 0n || milliseconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('Legacy milliseconds must be a nonnegative safe integer');
  }
  return Number(milliseconds);
}

/**
 * 显示/日志/提示词用的毫秒近似值（V5 §7：毫秒只出现在显示边界）。
 * 与 `mediaTimeToLegacyMilliseconds` 不同：非整毫秒时间按显式舍入给出近似值，不抛异常；
 * 返回值不得再写回权威时间字段（权威计算一律使用 MediaTime）。
 */
export function mediaTimeToDisplayMilliseconds(time: MediaTime, rounding: MediaRounding = 'nearest'): number {
  const value = seconds(mediaTimeSchema.parse(time));
  const milliseconds = divideRounded(value.num * 1000n, value.den, rounding);
  if (milliseconds > BigInt(Number.MAX_SAFE_INTEGER) || milliseconds < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new RangeError('Display milliseconds exceed safe integer range');
  }
  return Number(milliseconds);
}

/** 显示/播放器 API（如 HTMLMediaElement.currentTime）用的浮点秒近似值；不得回写权威字段。 */
export function mediaTimeToDisplaySeconds(time: MediaTime): number {
  const value = seconds(mediaTimeSchema.parse(time));
  // 先在整数域取到微秒，再转浮点，避免 ticks 很大时 Number(ticks) 先丢精度
  return Number(divideRounded(value.num * 1_000_000n, value.den, 'nearest')) / 1_000_000;
}

/** 精确相等（跨时基）。 */
export function mediaTimesEqual(left: MediaTime, right: MediaTime): boolean {
  return compareMediaTime(left, right) === 0;
}

export function legacyFpsToFrameRate(fps: number): FrameRate {
  return frameRateSchema.parse({ num: fps, den: 1 });
}

type Fraction = { num: bigint; den: bigint };
function subtract(left: Fraction, right: Fraction): Fraction {
  return { num: left.num * right.den - right.num * left.den, den: left.den * right.den };
}
function add(left: Fraction, right: Fraction): Fraction {
  return { num: left.num * right.den + right.num * left.den, den: left.den * right.den };
}

function outputTimebase(range: MediaRange): Rational {
  const start = range.start.timebase;
  const end = range.end.timebase;
  if (start.num === end.num && start.den === end.den) return start;
  // Reduce the actual endpoint values first: 0 and 1 second need no fine-grained common base.
  const reducedDenominator = (time: MediaTime): bigint => {
    const value = seconds(time);
    let numerator = value.num < 0n ? -value.num : value.num;
    let denominator = value.den;
    while (denominator !== 0n) [numerator, denominator] = [denominator, numerator % denominator];
    return value.den / numerator;
  };
  const startDen = reducedDenominator(range.start);
  const endDen = reducedDenominator(range.end);
  const bigintGcd = (left: bigint, right: bigint): bigint => {
    while (right !== 0n) [left, right] = [right, left % right];
    return left;
  };
  const denominator = (startDen / bigintGcd(startDen, endDen)) * endDen;
  if (denominator > BigInt(MAX_COMPONENT)) throw new RangeError('No supported common output timebase for range');
  return { num: 1, den: Number(denominator) };
}

/** Exact half-open range duration expressed in a lossless supported timebase. */
export function mediaRangeDuration(range: MediaRange): MediaTime {
  const span = mediaRangeSchema.parse(range);
  const duration = subtract(seconds(span.end), seconds(span.start));
  const base = outputTimebase(span);
  const numerator = duration.num * BigInt(base.den);
  const denominator = duration.den * BigInt(base.num);
  if (numerator % denominator !== 0n) throw new RangeError('Range duration cannot be represented exactly');
  return checkedTime(numerator / denominator, base);
}

/** Linear source↔sequence boundary mapping. The end boundary is allowed; content remains [start,end). */
export function mapRangeBoundary(
  time: MediaTime,
  from: MediaRange,
  to: MediaRange,
  rounding: MediaRounding,
): MediaTime {
  const input = mediaTimeSchema.parse(time);
  const source = mediaRangeSchema.parse(from);
  const target = mediaRangeSchema.parse(to);
  if (compareMediaTime(input, source.start) < 0 || compareMediaTime(input, source.end) > 0) {
    throw new RangeError('Boundary lies outside source range');
  }
  const offset = subtract(seconds(input), seconds(source.start));
  const sourceDuration = subtract(seconds(source.end), seconds(source.start));
  const targetDuration = subtract(seconds(target.end), seconds(target.start));
  const scaled: Fraction = {
    num: offset.num * sourceDuration.den * targetDuration.num,
    den: offset.den * sourceDuration.num * targetDuration.den,
  };
  const position = add(seconds(target.start), scaled);
  const base = outputTimebase(target);
  const ticks = divideRounded(position.num * BigInt(base.den), position.den * BigInt(base.num), rounding);
  return checkedTime(ticks, base);
}

export function sourcePtsToSequenceTime(
  pts: MediaTime, sourceRange: MediaRange, sequenceRange: MediaRange, rounding: MediaRounding,
): MediaTime {
  return mapRangeBoundary(pts, sourceRange, sequenceRange, rounding);
}

export function sequenceTimeToSourcePts(
  time: MediaTime, sequenceRange: MediaRange, sourceRange: MediaRange, rounding: MediaRounding,
): MediaTime {
  return mapRangeBoundary(time, sequenceRange, sourceRange, rounding);
}

/** 精确有理时基（纳秒）——线性和的结果不落在浮点毫秒上。 */
const NANOSECOND_TIME_BASE: Rational = { num: 1, den: 1_000_000_000 };

function linearCombine(left: MediaTime, right: MediaTime, subtractRight: boolean, rounding: MediaRounding): MediaTime {
  const a = mediaTimeSchema.parse(left);
  const b = mediaTimeSchema.parse(right);
  const aNum = BigInt(a.ticks) * BigInt(a.timebase.num);
  const aDen = BigInt(a.timebase.den);
  const bNum = BigInt(b.ticks) * BigInt(b.timebase.num);
  const bDen = BigInt(b.timebase.den);
  const combined = subtractRight ? aNum * bDen - bNum * aDen : aNum * bDen + bNum * aDen;
  const numerator = combined * BigInt(NANOSECOND_TIME_BASE.den);
  const denominator = aDen * bDen;
  return checkedTime(divideRounded(numerator, denominator, rounding), NANOSECOND_TIME_BASE);
}

/** 有理时间相加（结果落在纳秒时基）；用于“跟随对象/跟随源”的时移重投影。 */
export function addMediaTime(left: MediaTime, right: MediaTime, rounding: MediaRounding = 'nearest'): MediaTime {
  return linearCombine(left, right, false, rounding);
}

/** 有理时间相减（结果落在纳秒时基）。 */
export function subtractMediaTime(left: MediaTime, right: MediaTime, rounding: MediaRounding = 'nearest'): MediaTime {
  return linearCombine(left, right, true, rounding);
}
