import { describe, expect, it } from 'vitest';
import { compareMediaTime, isDecimalSecondsText, mediaTimeToDisplaySecondsText, parseDecimalSeconds } from './index.js';

describe('@ancs/time 十进制秒边界', () => {
  it('解析是精确的（不经浮点）', () => {
    expect(parseDecimalSeconds('12')).toEqual({ ticks: '12', timebase: { num: 1, den: 1 } });
    expect(parseDecimalSeconds('12.345')).toEqual({ ticks: '12345', timebase: { num: 1, den: 1000 } });
    expect(parseDecimalSeconds('0.000001')).toEqual({ ticks: '1', timebase: { num: 1, den: 1_000_000 } });
    // 0.1 + 0.2 在浮点里不等于 0.3，这里按有理数比较必须相等
    expect(compareMediaTime(parseDecimalSeconds('0.30'), parseDecimalSeconds('0.3'))).toBe(0);
  });

  it('拒绝负数、指数、多余前导零与超过 6 位小数', () => {
    for (const text of ['-1', '1e3', '01.5', '1.', '.5', '1.2345678', 'NaN', '']) {
      expect(isDecimalSecondsText(text)).toBe(false);
      expect(() => parseDecimalSeconds(text)).toThrow(RangeError);
    }
  });

  it('显示格式化按显式舍入，往返一致', () => {
    const ntscFrame = { ticks: '1001', timebase: { num: 1, den: 30_000 } };
    expect(mediaTimeToDisplaySecondsText(ntscFrame)).toBe('0.033');
    expect(mediaTimeToDisplaySecondsText(ntscFrame, 6)).toBe('0.033367');
    expect(mediaTimeToDisplaySecondsText({ ticks: '5', timebase: { num: 1, den: 2 } }, 0)).toBe('3');
    expect(mediaTimeToDisplaySecondsText({ ticks: '5', timebase: { num: 1, den: 2 } }, 0, 'floor')).toBe('2');
    expect(mediaTimeToDisplaySecondsText({ ticks: '-3', timebase: { num: 1, den: 2 } }, 1)).toBe('-1.5');
    const text = mediaTimeToDisplaySecondsText(parseDecimalSeconds('75.25'));
    expect(text).toBe('75.250');
    expect(compareMediaTime(parseDecimalSeconds(text), parseDecimalSeconds('75.25'))).toBe(0);
  });
});
