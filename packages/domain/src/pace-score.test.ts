import { describe, expect, it } from 'vitest';
import { measurePace, paceDeviations } from './pace-score.js';

describe('节奏谱 B0（切点密度 + 语速）', () => {
  it('按 5 秒窗口给出实测曲线；片头片尾不算剪辑点；短尾巴并入前一窗', () => {
    const score = measurePace({
      lengthMs: 16_000,
      cutsMs: [0, 1_000, 2_000, 3_000, 4_000, 9_000, 15_500, 16_000],
      words: [{ startMs: 500, endMs: 900 }, { startMs: 1_000, endMs: 1_400 }, { startMs: 1_500, endMs: 1_900 }, { startMs: 12_000, endMs: 12_500 }],
    });
    expect(score.windowMs).toBe(5000);
    expect(score.windows.map((window) => [window.startMs, window.endMs, window.cuts, window.cutsPerMinute, window.words, window.wordsPerSecond])).toEqual([
      [0, 5000, 4, 48, 3, 2.5],
      [5000, 10_000, 1, 12, 0, null],
      // 最后 1 秒（15–16 s，短于 2 秒）并入第三窗：10–16 s
      [10_000, 16_000, 1, 10, 1, 1],
    ]);
    expect(score.overall).toEqual({ cutsPerMinute: 22.5, wordsPerSecond: 2.35 });
  });

  it('偏差：相对目标超过阈值的窗口，分快慢；目标为空的分量不比较', () => {
    const score = measurePace({ lengthMs: 15_000, cutsMs: [1000, 2000, 3000, 4000, 12_000], words: [] });
    expect(paceDeviations(score, { cutsPerMinute: 20, wordsPerSecond: 3 })).toEqual([
      { windowIndex: 0, startMs: 0, endMs: 5000, component: 'cutDensity', measured: 48, target: 20, delta: 1.4, direction: 'FASTER' },
      { windowIndex: 1, startMs: 5000, endMs: 10_000, component: 'cutDensity', measured: 0, target: 20, delta: -1, direction: 'SLOWER' },
    ]);
    expect(paceDeviations(score, { cutsPerMinute: null, wordsPerSecond: null })).toEqual([]);
    expect(paceDeviations(score, { cutsPerMinute: 20, wordsPerSecond: null }, { threshold: 2 })).toEqual([]);
  });

  it('空时间线与无剪辑', () => {
    expect(measurePace({ lengthMs: 0, cutsMs: [], words: [] })).toEqual({ windowMs: 5000, windows: [], overall: { cutsPerMinute: 0, wordsPerSecond: null } });
    expect(measurePace({ lengthMs: 3000, cutsMs: [], words: [] }).windows).toEqual([{ startMs: 0, endMs: 3000, cuts: 0, cutsPerMinute: 0, words: 0, wordsPerSecond: null }]);
  });
});
