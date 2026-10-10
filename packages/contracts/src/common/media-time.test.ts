import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addMediaTime,
  compareMediaTime,
  frameIndexToMediaTime,
  frameRateSchema,
  isMediaTimeFrameAligned,
  isMediaTimeInRange,
  legacyFpsToFrameRate,
  legacyMillisecondsToMediaTime,
  mapRangeBoundary,
  mediaRangeDuration,
  mediaTimeToLegacyMilliseconds,
  mediaRangeSchema,
  mediaRoundingSchema,
  mediaTimeSchema,
  mediaTimeToFrameIndex,
  mediaTimeToSampleIndex,
  normalizeRational,
  rescaleMediaTime,
  sampleIndexToMediaTime,
  sequenceTimeToSourcePts,
  sourcePtsToSequenceTime,
  subtractMediaTime,
  type FrameRate,
  type MediaTime,
} from './media-time.js';

const msBase = { num: 1, den: 1000 };
const audioBase = { num: 1, den: 48000 };

describe('v0.4 MediaTime contract', () => {
  it('accepts signed canonical int64 PTS and reduced positive rational bases', () => {
    expect(mediaTimeSchema.parse({ ticks: '-48000', timebase: audioBase }).ticks).toBe('-48000');
    for (const ticks of ['-0', '01', '1.5', 'abc', '9223372036854775808', '-9223372036854775809']) {
      expect(mediaTimeSchema.safeParse({ ticks, timebase: audioBase }).success, ticks).toBe(false);
    }
    expect(mediaTimeSchema.safeParse({ ticks: '1', timebase: { num: 2, den: 4 } }).success).toBe(false);
    expect(mediaTimeSchema.safeParse({ ticks: '1', timebase: { num: 1, den: 0 } }).success).toBe(false);
    expect(mediaTimeSchema.safeParse({ ticks: '1', timebase: { num: 1.5, den: 1000 } }).success).toBe(false);
    expect(normalizeRational(2002, 60000)).toEqual({ num: 1001, den: 30000 });
  });

  it('compares across timebases exactly and enforces nonempty half-open ranges', () => {
    const oneSecond = { ticks: '48000', timebase: audioBase };
    expect(compareMediaTime(oneSecond, { ticks: '1000', timebase: msBase })).toBe(0);
    expect(compareMediaTime({ ticks: '-1', timebase: audioBase }, oneSecond)).toBe(-1);
    expect(mediaRangeSchema.safeParse({ start: oneSecond, end: oneSecond }).success).toBe(false);
    expect(mediaRangeSchema.safeParse({ start: oneSecond, end: { ticks: '999', timebase: msBase } }).success).toBe(false);
    expect(mediaRangeSchema.parse({ start: { ticks: '-48000', timebase: audioBase }, end: oneSecond })).toBeDefined();
    const range = { start: { ticks: '0', timebase: audioBase }, end: oneSecond };
    expect(isMediaTimeInRange(range.start, range)).toBe(true);
    expect(isMediaTimeInRange({ ticks: '999', timebase: msBase }, range)).toBe(true);
    expect(isMediaTimeInRange({ ticks: '1000', timebase: msBase }, range)).toBe(false);
    expect(isMediaTimeInRange({ ticks: '-1', timebase: audioBase }, range)).toBe(false);
    expect(mediaRangeDuration({
      start: { ticks: '24000', timebase: audioBase },
      end: { ticks: '1500', timebase: msBase },
    })).toEqual({ ticks: '2', timebase: { num: 1, den: 2 } });
  });

  it('makes boundary rounding explicit, including negative ties', () => {
    const negativeHalf = { ticks: '-1', timebase: { num: 1, den: 2 } };
    const secondBase = { num: 1, den: 1 };
    expect(rescaleMediaTime(negativeHalf, secondBase, 'floor').ticks).toBe('-1');
    expect(rescaleMediaTime(negativeHalf, secondBase, 'ceil').ticks).toBe('0');
    expect(rescaleMediaTime(negativeHalf, secondBase, 'towardZero').ticks).toBe('0');
    expect(rescaleMediaTime(negativeHalf, secondBase, 'nearest').ticks).toBe('-1');
    expect(rescaleMediaTime({ ticks: '1', timebase: { num: 1, den: 2 } }, secondBase, 'nearest').ticks).toBe('1');
    expect(mediaRoundingSchema.safeParse('bankers').success).toBe(false);
  });

  it('round-trips integer and fractional frame rates without floating seconds', () => {
    const rates: FrameRate[] = [
      { num: 24, den: 1 }, { num: 25, den: 1 }, { num: 30, den: 1 },
      { num: 50, den: 1 }, { num: 60, den: 1 },
      { num: 24000, den: 1001 }, { num: 30000, den: 1001 }, { num: 60000, den: 1001 },
    ];
    for (const rate of rates) {
      const time = frameIndexToMediaTime('2592000', rate);
      expect(frameRateSchema.safeParse(rate).success).toBe(true);
      expect(mediaTimeToFrameIndex(time, rate, 'nearest')).toBe('2592000');
    }
    expect(frameIndexToMediaTime('1', { num: 30000, den: 1001 }).timebase).toEqual({ num: 1001, den: 30000 });
    expect(frameRateSchema.safeParse({ num: 30000, den: 0 }).success).toBe(false);
    const rate = { num: 30000, den: 1001 };
    expect(isMediaTimeFrameAligned(frameIndexToMediaTime('1', rate), rate)).toBe(true);
    expect(isMediaTimeFrameAligned({ ticks: '48048', timebase: audioBase }, rate)).toBe(true);
    expect(isMediaTimeFrameAligned({ ticks: '-48048', timebase: audioBase }, rate)).toBe(true);
    expect(isMediaTimeFrameAligned({ ticks: '1601', timebase: audioBase }, rate)).toBe(false);
  });

  it('keeps 48 kHz audio sample positions exact against fractional frames', () => {
    const thousandOneSeconds = frameIndexToMediaTime('30000', { num: 30000, den: 1001 });
    expect(mediaTimeToSampleIndex(thousandOneSeconds, 48000, 'nearest')).toBe('48048000');
    expect(compareMediaTime(sampleIndexToMediaTime('48048000', 48000), thousandOneSeconds)).toBe(0);
    const oneFrame = frameIndexToMediaTime('1', { num: 30000, den: 1001 });
    expect(mediaTimeToSampleIndex(oneFrame, 48000, 'floor')).toBe('1601');
    expect(mediaTimeToSampleIndex(oneFrame, 48000, 'ceil')).toBe('1602');
  });

  it('maps actual signed source PTS to sequence time and back, including end boundaries', () => {
    const sourceRange = {
      start: { ticks: '-48000', timebase: audioBase },
      end: { ticks: '48000', timebase: audioBase },
    };
    const sequenceRange = {
      start: { ticks: '0', timebase: msBase },
      end: { ticks: '4000', timebase: msBase },
    };
    const zeroPts = { ticks: '0', timebase: audioBase };
    expect(sourcePtsToSequenceTime(zeroPts, sourceRange, sequenceRange, 'nearest').ticks).toBe('2000');
    expect(sequenceTimeToSourcePts({ ticks: '2000', timebase: msBase }, sequenceRange, sourceRange, 'nearest')).toEqual(zeroPts);
    expect(sourcePtsToSequenceTime(sourceRange.end, sourceRange, sequenceRange, 'nearest').ticks).toBe('4000');
    expect(() => mapRangeBoundary({ ticks: '48001', timebase: audioBase }, sourceRange, sequenceRange, 'floor')).toThrow(RangeError);
  });

  it('keeps mixed target timebases exact instead of rounding past the target end', () => {
    const second = { num: 1, den: 1 };
    const source = { start: { ticks: '0', timebase: second }, end: { ticks: '1', timebase: second } };
    const target = { start: { ticks: '0', timebase: second }, end: { ticks: '1', timebase: { num: 1, den: 2 } } };
    const mapped = mapRangeBoundary(source.end, source, target, 'nearest');
    expect(mapped).toEqual({ ticks: '1', timebase: { num: 1, den: 2 } });
    expect(compareMediaTime(mapped, target.end)).toBe(0);
    const wholeSecond = mapRangeBoundary(source.end, source, {
      start: { ticks: '0', timebase: { num: 1, den: 2_147_483_647 } },
      end: { ticks: '2147483629', timebase: { num: 1, den: 2_147_483_629 } },
    }, 'nearest');
    expect(wholeSecond).toEqual({ ticks: '1', timebase: second });
    expect(() => mapRangeBoundary(source.end, source, {
      start: { ticks: '1', timebase: { num: 1, den: 2_147_483_647 } },
      end: { ticks: '1', timebase: { num: 1, den: 2_147_483_629 } },
    }, 'nearest')).toThrow(RangeError);
  });

  it('maps VFR boundaries by PTS instead of frame index divided by average fps', () => {
    const ptsBase = { num: 1, den: 15360 };
    const source = { start: { ticks: '512', timebase: ptsBase }, end: { ticks: '72704', timebase: ptsBase } };
    const sequence = { start: { ticks: '0', timebase: ptsBase }, end: { ticks: '72192', timebase: ptsBase } };
    expect(sourcePtsToSequenceTime({ ticks: '1024', timebase: ptsBase }, source, sequence, 'nearest').ticks).toBe('512');
    expect(sourcePtsToSequenceTime({ ticks: '2048', timebase: ptsBase }, source, sequence, 'nearest').ticks).toBe('1536');
  });

  it('uses the synthetic 24-hour fixture without accumulated frame/sample drift', () => {
    const fixturePath = join(import.meta.dirname, '..', '..', '..', 'testing', 'fixtures', 'media-v04', 'long-timeline.json');
    const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      duration: MediaTime;
      fractionalFrameRate: FrameRate;
      expectedSeconds: number;
    };
    expect(compareMediaTime(fixture.duration, { ticks: String(fixture.expectedSeconds * 1000), timebase: msBase })).toBe(0);
    expect(mediaTimeToSampleIndex(fixture.duration, 48000, 'nearest')).toBe('4147200000');
    const longFrames = frameIndexToMediaTime('2592000', fixture.fractionalFrameRate);
    expect(rescaleMediaTime(longFrames, msBase, 'nearest').ticks).toBe('86486400');
  });

  it('preserves old ms/fps exactly and refuses precision loss or overflow', () => {
    expect(legacyMillisecondsToMediaTime(1234)).toEqual({ ticks: '1234', timebase: msBase });
    expect(mediaTimeToLegacyMilliseconds({ ticks: '48048', timebase: audioBase })).toBe(1001);
    expect(() => mediaTimeToLegacyMilliseconds(frameIndexToMediaTime('1', { num: 30000, den: 1001 }))).toThrow(RangeError);
    expect(() => mediaTimeToLegacyMilliseconds({ ticks: '-1', timebase: msBase })).toThrow(RangeError);
    expect(() => mediaTimeToLegacyMilliseconds({ ticks: '9007199254740992', timebase: msBase })).toThrow(RangeError);
    expect(legacyFpsToFrameRate(30)).toEqual({ num: 30, den: 1 });
    expect(() => legacyMillisecondsToMediaTime(0.5)).toThrow(RangeError);
    expect(() => legacyMillisecondsToMediaTime(-1)).toThrow(RangeError);
    expect(() => legacyFpsToFrameRate(29.97)).toThrow();
    expect(() => rescaleMediaTime({ ticks: '9223372036854775807', timebase: { num: 1, den: 1 } }, msBase, 'nearest')).toThrow(RangeError);
  });
});

describe('media-time 线性和（N04-10 时序重投影）', () => {
  it('相加/相减结果落在纳秒有理时基，且可跨时基比较', () => {
    const sum = addMediaTime(legacyMillisecondsToMediaTime(1_000), legacyMillisecondsToMediaTime(500));
    expect(sum.timebase).toEqual({ num: 1, den: 1_000_000_000 });
    expect(compareMediaTime(sum, legacyMillisecondsToMediaTime(1_500))).toBe(0);
    const diff = subtractMediaTime(legacyMillisecondsToMediaTime(1_000), legacyMillisecondsToMediaTime(2_500));
    expect(compareMediaTime(diff, { ticks: '-1500', timebase: { num: 1, den: 1000 } })).toBe(0);
    expect(compareMediaTime(subtractMediaTime(legacyMillisecondsToMediaTime(2_000), legacyMillisecondsToMediaTime(2_000)), { ticks: '0', timebase: { num: 1, den: 1 } })).toBe(0);
  });
});
