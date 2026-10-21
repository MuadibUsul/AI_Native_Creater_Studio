import { describe, expect, it } from 'vitest';
import { captionLinesFromWords, findEditPoints, isFillerWord, type TimedWord } from './edit-candidates.js';

const w = (startMs: number, endMs: number, text: string, speaker: string | null = 's1'): TimedWord => ({ startMs, endMs, text, speaker });

describe('编辑候选层（AP-01）', () => {
  // 两句话：第一句"今天 我们 去 冰川"，句末后停顿 900 ms；第二句里有一个语气词"呃"和一次 350 ms 的停顿；最后换人说话
  const words = [
    w(1200, 1500, '今天'), w(1520, 1800, '我们'), w(1820, 2000, '去'), w(2020, 2400, '冰川。'),
    w(3300, 3500, '呃'), w(3520, 3900, '那里'), w(4250, 4600, '很冷。'),
    w(4700, 5100, 'Really?', 's2'),
  ];
  const sentences = [{ startMs: 1200, endMs: 2400 }, { startMs: 3300, endMs: 4600 }, { startMs: 4700, endMs: 5100 }];

  it('句末、停顿、换人说话都是剪点，安全窗口在两个词之间，不切到字', () => {
    const points = findEditPoints({ words, sentences, shotBoundariesMs: [], silencesMs: [], blacksMs: [], durationMs: 6000 });
    const sentenceEnd = points.cutPoints.find((point) => point.kind === 'SENTENCE_END' && point.before === '冰川。');
    expect(sentenceEnd).toMatchObject({ pauseMs: 900, windowMs: [2440, 3260], insideSpeech: false });
    expect(sentenceEnd!.atMs).toBeGreaterThanOrEqual(2440);
    expect(sentenceEnd!.atMs).toBeLessThanOrEqual(3260);
    const pause = points.cutPoints.find((point) => point.kind === 'PAUSE');
    expect(pause).toMatchObject({ before: '那里', pauseMs: 350, windowMs: [3940, 4210] });
    // 第二句末尾（很冷。）紧接着换人：句末优先归类；窗口很窄但仍在两个词之间
    const handOver = points.cutPoints.find((point) => point.before === '很冷。');
    expect(handOver).toMatchObject({ kind: 'SENTENCE_END', pauseMs: 100, windowMs: [4640, 4660] });
    // 词与词紧挨着（< 300 ms、非句末、同一个人）不列为剪点
    expect(points.cutPoints.some((point) => point.before === '今天')).toBe(false);
    // 每个剪点都不在任何一个词的内部
    for (const point of points.cutPoints) {
      expect(words.some((word) => word.startMs < point.atMs && point.atMs < word.endMs)).toBe(false);
    }
  });

  it('可收紧的段落：长停顿、语气词、开头空白、结尾空白、静音、黑场；只标注，不判定', () => {
    const points = findEditPoints({ words, sentences, shotBoundariesMs: [], silencesMs: [[2500, 3200]], blacksMs: [[0, 400]], durationMs: 7000 });
    expect(points.removals).toEqual([
      { rangeMs: [0, 400], kind: 'BLACK', text: null },
      { rangeMs: [0, 1160], kind: 'LEAD_IN', text: null },
      { rangeMs: [2440, 3260], kind: 'LONG_PAUSE', text: null },
      { rangeMs: [2500, 3200], kind: 'SILENCE', text: null },
      { rangeMs: [3300, 3500], kind: 'FILLER', text: '呃' },
      { rangeMs: [5140, 7000], kind: 'TAIL', text: null },
    ]);
    expect(points.keepIntact).toEqual([[1200, 2400], [3300, 4600], [4700, 5100]]);
  });

  it('镜头边界：落在说话中间时如实标出（在那里切会切断语音）', () => {
    const points = findEditPoints({ words, sentences, shotBoundariesMs: [2800, 3700, 0, 6000], silencesMs: [], blacksMs: [], durationMs: 6000 });
    const shots = points.cutPoints.filter((point) => point.kind === 'SHOT_BOUNDARY');
    expect(shots.map((point) => [point.atMs, point.insideSpeech, point.before])).toEqual([[2800, false, '冰川。'], [3700, true, '呃']]);
  });

  it('没有转写时只有镜头、静音与黑场', () => {
    const points = findEditPoints({ words: [], sentences: [], shotBoundariesMs: [1000], silencesMs: [[0, 500]], blacksMs: [], durationMs: 3000 });
    expect(points.cutPoints).toHaveLength(1);
    expect(points.removals).toEqual([{ rangeMs: [0, 500], kind: 'SILENCE', text: null }]);
    expect(points.keepIntact).toEqual([]);
  });

  it('语气词识别只收独立、无实义的', () => {
    expect(['嗯', '呃，', 'Um', 'uh...', 'Hmm', '额'].every(isFillerWord)).toBe(true);
    expect(['那个', '就是', 'like', 'so', '嗯哼好的', 'umbrella'].some(isFillerWord)).toBe(false);
  });
});

describe('原声字幕分行', () => {
  it('中文：句末换行、去掉语气词、不加空格、行尾留余量但不压下一行', () => {
    const lines = captionLinesFromWords({ words: [
      w(0, 300, '今天'), w(320, 600, '我们'), w(620, 800, '去'), w(820, 1200, '冰川。'),
      w(1300, 1500, '呃'), w(1520, 1900, '那里'), w(1950, 2300, '很冷。'),
    ] });
    expect(lines).toEqual([
      { startMs: 0, endMs: 1400, text: '今天我们去冰川。' },
      { startMs: 1520, endMs: 2500, text: '那里很冷。' },
    ]);
  });

  it('英文：按词加空格、标点不前置空格；超字数与长停顿换行；短行延长到最短显示', () => {
    const lines = captionLinesFromWords({ words: [
      w(0, 200, 'This'), w(210, 400, 'is'), w(410, 700, 'the'), w(710, 1100, 'glacier,'),
      w(2000, 2200, 'and'), w(2210, 2500, 'it'), w(2510, 2700, 'melts'), w(2710, 3000, 'fast'), w(3010, 3100, '.'),
    ] }, { maxChars: 14 });
    expect(lines.map((line) => line.text)).toEqual(['This is the', 'glacier', 'and it melts', 'fast.']);
    expect(lines[1]).toMatchObject({ startMs: 710, endMs: 1510 });
    for (let index = 0; index + 1 < lines.length; index += 1) expect(lines[index]!.endMs).toBeLessThanOrEqual(lines[index + 1]!.startMs);
  });

  it('按转写分句换行；可以保留语气词', () => {
    const lines = captionLinesFromWords({ words: [w(0, 200, 'um'), w(210, 400, 'yes'), w(410, 600, 'no')], sentenceEndAfter: new Set([1]) }, { skipFillers: false });
    expect(lines.map((line) => line.text)).toEqual(['um yes', 'no']);
  });
});
