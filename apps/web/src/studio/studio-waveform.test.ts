import { describe, expect, it } from 'vitest';
import { mergeWaveformEntries, waveformBars } from './studio-waveform';

/**
 * 时间带波形：只用媒体索引里的实测峰值。条目按源时间拼接；没有测量值的位置保持未知（null），不插值、不补零。
 */

const entry = (sourceStartMs: number, peaks: number[], sampleIntervalMs = 10) => ({ payload: { sourceStartMs, sourceEndMs: sourceStartMs + peaks.length * sampleIntervalMs, sampleIntervalMs, peaks } });

describe('时间带波形', () => {
  it('按源时间拼接条目；缺口保持未知，异常条目忽略', () => {
    const wave = mergeWaveformEntries([entry(0, [100, 200]), entry(40, [900]), { payload: { sourceStartMs: 0, peaks: 'x' } }, entry(0, [5], 20)]);
    expect(wave).toEqual({ intervalMs: 10, peaks: [100, 200, null, null, 900] });
    expect(mergeWaveformEntries([])).toBeNull();
  });

  it('每根柱子取源区间内的最大峰值；倒放左右翻转；没有测量值的柱子为 null', () => {
    const wave = { intervalMs: 10, peaks: [0, 500, 1000, 250, null, null, 100, 100] };
    // 0–0.04 秒分两根：[0, 500] 与 [1000, 250]
    expect(waveformBars(wave, 0, 0.04, 2)).toEqual([0.5, 1]);
    expect(waveformBars(wave, 0, 0.04, 2, true)).toEqual([1, 0.5]);
    // 0.04–0.06 秒没有测量值
    expect(waveformBars(wave, 0.04, 0.06, 1)).toEqual([null]);
    // 超出已测范围也是未知
    expect(waveformBars(wave, 0.1, 0.2, 2)).toEqual([null, null]);
    expect(waveformBars(wave, 0.02, 0.02, 3)).toEqual([]);
  });
});
