import { describe, expect, it } from 'vitest';
import {
  TimeNotRepresentableError,
  compareFractions,
  exactTicks,
  rangeDurationFraction,
  rangeFromTicks,
  rangeToTicks,
  timeToFraction,
} from './index.js';

const ntsc = { num: 1, den: 30_000 };

describe('@ancs/time Fraction', () => {
  it('跨时基的时长与比较是精确的', () => {
    const range = { start: { ticks: '1001', timebase: ntsc }, end: { ticks: '3003', timebase: ntsc } };
    const duration = rangeDurationFraction(range);
    expect(compareFractions(duration, { num: 2002n, den: 30_000n })).toBe(0);
    expect(compareFractions(duration, timeToFraction({ ticks: '67', timebase: { num: 1, den: 1000 } }))).toBe(-1);
  });

  it('exactTicks 不能整除时抛 TimeNotRepresentableError（携带稳定 reason）', () => {
    expect(exactTicks({ num: 1001n, den: 30_000n }, ntsc)).toBe(1001n);
    try {
      exactTicks({ num: 1001n, den: 30_000n }, { num: 1, den: 1000 });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(TimeNotRepresentableError);
      expect((error as TimeNotRepresentableError).reason).toBe('TIME_NOT_REPRESENTABLE');
    }
  });

  it('区间 ↔ ticks 往返', () => {
    const range = rangeFromTicks(3003n, 6006n, ntsc);
    expect(rangeToTicks(range, ntsc)).toEqual({ start: 3003n, end: 6006n });
    expect(rangeToTicks(range, { num: 1001, den: 30_000 })).toEqual({ start: 3n, end: 6n });
  });
});

describe('@ancs/time 播放度量换算', () => {
  it('mediaTimeToApproxMilliseconds 保留小数（29.97fps 一帧 ≈ 33.367ms），大 ticks 不失精度', async () => {
    const { mediaTimeToApproxMilliseconds } = await import('./index.js');
    expect(mediaTimeToApproxMilliseconds({ ticks: '1001', timebase: { num: 1, den: 30_000 } })).toBeCloseTo(33.367, 3);
    expect(mediaTimeToApproxMilliseconds({ ticks: '9000000000000', timebase: { num: 1, den: 90_000 } })).toBe(100_000_000_000);
  });
});
