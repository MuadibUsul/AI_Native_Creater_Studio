import { mediaRangeSchema, mediaTimeSchema, type MediaRange, type MediaTime, type Rational } from './media-time.js';

/**
 * 精确有理数（单位：秒）。`den` 恒为正；不约分（比较与换算都按交叉相乘，结果精确）。
 * 编辑内核与领域代码的所有时长/偏移运算都应经过这里，禁止退化成浮点秒或整数毫秒（V5 §7）。
 */
export interface Fraction {
  num: bigint;
  den: bigint;
}

/** 时间无法在目标时基中精确表示（编辑边界必须精确，禁止静默取整）。 */
export class TimeNotRepresentableError extends RangeError {
  readonly reason = 'TIME_NOT_REPRESENTABLE' as const;
  constructor(message = 'time cannot be represented exactly in the target timebase') {
    super(message);
    this.name = 'TimeNotRepresentableError';
  }
}

export const ZERO_FRACTION: Fraction = { num: 0n, den: 1n };

export function timeToFraction(time: MediaTime): Fraction {
  const parsed = mediaTimeSchema.parse(time);
  return { num: BigInt(parsed.ticks) * BigInt(parsed.timebase.num), den: BigInt(parsed.timebase.den) };
}

export function ticksToFraction(ticks: bigint, timebase: Rational): Fraction {
  return { num: ticks * BigInt(timebase.num), den: BigInt(timebase.den) };
}

/** 半开区间 [start, end) 的精确时长。 */
export function rangeDurationFraction(range: MediaRange): Fraction {
  const parsed = mediaRangeSchema.parse(range);
  const start = timeToFraction(parsed.start);
  const end = timeToFraction(parsed.end);
  return { num: end.num * start.den - start.num * end.den, den: end.den * start.den };
}

export function compareFractions(left: Fraction, right: Fraction): -1 | 0 | 1 {
  const difference = left.num * right.den - right.num * left.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function addFractions(left: Fraction, right: Fraction): Fraction {
  return { num: left.num * right.den + right.num * left.den, den: left.den * right.den };
}

export function subtractFractions(left: Fraction, right: Fraction): Fraction {
  return { num: left.num * right.den - right.num * left.den, den: left.den * right.den };
}

export function negateFraction(value: Fraction): Fraction {
  return { num: -value.num, den: value.den };
}

/** 有理秒 → 目标时基的精确 ticks；不能整除即抛 `TimeNotRepresentableError`（禁止静默取整）。 */
export function exactTicks(value: Fraction, timebase: Rational): bigint {
  const numerator = value.num * BigInt(timebase.den);
  const denominator = value.den * BigInt(timebase.num);
  if (denominator === 0n) throw new TimeNotRepresentableError('invalid timebase');
  if (numerator % denominator !== 0n) throw new TimeNotRepresentableError();
  return numerator / denominator;
}

export function mediaTimeFromTicks(ticks: bigint, timebase: Rational): MediaTime {
  return mediaTimeSchema.parse({ ticks: ticks.toString(), timebase });
}

/** 区间端点在给定时基中的精确 ticks（半开区间）。 */
export function rangeToTicks(range: MediaRange, timebase: Rational): { start: bigint; end: bigint } {
  const parsed = mediaRangeSchema.parse(range);
  return {
    start: exactTicks(timeToFraction(parsed.start), timebase),
    end: exactTicks(timeToFraction(parsed.end), timebase),
  };
}

export function rangeFromTicks(start: bigint, end: bigint, timebase: Rational): MediaRange {
  return mediaRangeSchema.parse({ start: mediaTimeFromTicks(start, timebase), end: mediaTimeFromTicks(end, timebase) });
}
