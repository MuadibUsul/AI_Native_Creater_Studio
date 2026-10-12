import { describe, expect, it } from 'vitest';
import type { RealtimePointerSample, RealtimeWord } from '@ancs/contracts';
import { bindAttention, findDeicticWords, isUnclosedUtterance, joinTranscript, pointerSampleAt } from './realtime-attention.js';

/** V6-2 共同注意力：指代按发话那一刻绑定（纯函数）。 */

const RATE = 16_000;
const sample = (seconds: number, pointer: Partial<RealtimePointerSample['pointer']> = {}, playhead: string | null = null, label: string | null = null): RealtimePointerSample => ({
  atSample: Math.round(seconds * RATE), pointer: { timeRange: null, clipIds: [], frameRegion: null, ...pointer }, playhead, label,
});
const words = (...items: [string, number][]): RealtimeWord[] => items.map(([text, start]) => ({ text, start, end: start + 0.2 }));

describe('realtime attention', () => {
  it('中文拼接去掉字间空格，保留英文词之间的空格；英文按空格连接', () => {
    expect(joinTranscript(['把 这 里', '剪 短 一 点'], 'zh-CN')).toBe('把这里剪短一点');
    expect(joinTranscript(['加一段 B roll', '在 开头'], 'zh-CN')).toBe('加一段B roll在开头');
    expect(joinTranscript(['make this', ' shorter '], 'en')).toBe('make this shorter');
  });

  it('未闭合的结尾先不执行：但是/不对/除了/逗号；英文 but/except/and', () => {
    expect(isUnclosedUtterance('把这段删掉……不对', 'zh-CN')).toBe(true);
    expect(isUnclosedUtterance('音乐小一点，但是', 'zh-CN')).toBe(true);
    expect(isUnclosedUtterance('把开头剪短一点，', 'zh-CN')).toBe(true);
    expect(isUnclosedUtterance('把开头剪短一点。', 'zh-CN')).toBe(false);
    expect(isUnclosedUtterance('make it shorter but', 'en')).toBe(true);
    expect(isUnclosedUtterance('keep everything except', 'en')).toBe(true);
    expect(isUnclosedUtterance('make it shorter.', 'en')).toBe(false);
    expect(isUnclosedUtterance('', 'en')).toBe(false);
  });

  it('找指代词：中文按最长匹配跨词，英文按词', () => {
    expect(findDeicticWords(words(['把', 0.1], ['这', 0.4], ['里', 0.5], ['剪短', 0.7]), 'zh-CN')).toEqual([{ word: '这里', at: 0.4 }]);
    expect(findDeicticWords(words(['从这里', 0.2], ['到', 0.8], ['这里', 1.4]), 'zh-CN')).toEqual([{ word: '这里', at: 0.2 }, { word: '这里', at: 1.4 }]);
    expect(findDeicticWords(words(['这样', 0.2], ['就好', 0.5]), 'zh-CN')).toEqual([]);
    expect(findDeicticWords(words(['move', 0.1], ['this', 0.3], ['here.', 0.9]), 'en')).toEqual([{ word: 'this', at: 0.3 }, { word: 'here', at: 0.9 }]);
  });

  it('某一刻的指向：取不晚于该时刻（含 0.3 秒宽限）的最后一个样本', () => {
    const samples = [sample(0), sample(1, { clipIds: ['clp_a'] }), sample(2.2, { clipIds: ['clp_b'] })];
    expect(pointerSampleAt(samples, 0.5, RATE)?.pointer.clipIds).toEqual([]);
    expect(pointerSampleAt(samples, 1.95, RATE)?.pointer.clipIds).toEqual(['clp_b']); // 边说边点：0.25 秒后点的仍算
    expect(pointerSampleAt(samples, 1.5, RATE)?.pointer.clipIds).toEqual(['clp_a']);
  });

  it('"这里"绑定说出那一刻的选择，而不是句末的鼠标', () => {
    const samples = [sample(0, { clipIds: ['clp_a'] }, null, '片段 a'), sample(2.5, { clipIds: ['clp_c'] }, null, '片段 c')];
    const attention = bindAttention({ words: words(['把', 0.1], ['这里', 0.6], ['剪短', 1.0], ['一点', 1.6]), samples, sampleRate: RATE, locale: 'zh-CN', utteranceStart: 0.1 });
    expect(attention).toEqual({ pointer: { timeRange: null, clipIds: ['clp_a'], frameRegion: null }, evidence: 'DEICTIC_WORD', word: '这里', atSeconds: 0.6, label: '片段 a' });
  });

  it('"从这里到这里"：两处时间点合成一个范围；没有明确选择时用当时的播放位置', () => {
    const samples = [sample(0, {}, '2.000'), sample(1.2, {}, '6.500')];
    const attention = bindAttention({ words: words(['从这里', 0.2], ['到这里', 1.3], ['删掉', 1.8]), samples, sampleRate: RATE, locale: 'zh-CN', utteranceStart: 0.2 });
    expect(attention).toMatchObject({ pointer: { timeRange: { start: '1.000', end: '7.500' }, clipIds: [] }, evidence: 'PLAYHEAD_AT_WORD', word: '这里' });
  });

  it('只框了画面区域："这里"= 这块画面 + 说话那一刻的播放位置', () => {
    const region = { x: 0.1, y: 0.2, width: 0.3, height: 0.4 };
    const samples = [sample(0, { frameRegion: region }, '5.000', '画面区域')];
    const attention = bindAttention({ words: words(['这里', 0.3], ['加个', 0.6], ['爆炸', 0.9]), samples, sampleRate: RATE, locale: 'zh-CN', utteranceStart: 0.3 });
    expect(attention.pointer).toEqual({ timeRange: { start: '4.000', end: '6.000' }, clipIds: [], frameRegion: region });
    expect(attention.evidence).toBe('DEICTIC_WORD');
  });

  it('没有指代词：用开口那一刻的明确选择；什么都没指 → 整条视频', () => {
    const selected = [sample(0, { timeRange: { start: '3.600', end: '5.000' } }, '4.000', '00:03.6–00:05.0')];
    expect(bindAttention({ words: words(['剪短', 0.5], ['一点', 0.9]), samples: selected, sampleRate: RATE, locale: 'zh-CN', utteranceStart: 0.5 }))
      .toEqual({ pointer: { timeRange: { start: '3.600', end: '5.000' }, clipIds: [], frameRegion: null }, evidence: 'SELECTION_AT_START', word: null, atSeconds: 0.5, label: '00:03.6–00:05.0' });
    expect(bindAttention({ words: words(['make', 0.2], ['it', 0.4], ['shorter', 0.6]), samples: [sample(0, {}, '1.000')], sampleRate: RATE, locale: 'en', utteranceStart: 0.2 }))
      .toEqual({ pointer: { timeRange: null, clipIds: [], frameRegion: null }, evidence: 'NONE', word: null, atSeconds: null, label: null });
  });
});
