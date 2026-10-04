import { describe, expect, it } from 'vitest';
import { buildSubtitles, planAudioMix, toSrtTime, toVttTime, visualWidthOf, wrapCaption } from './mix-compute.js';
import { captionStyleSchema } from './mixdown.js';

/**
 * P06-06 单元验收（混音与字幕的纯计算；平台中立）：
 * - ducking/淡入淡出的增益包络（旁白区间内压低非旁白轨）；
 * - **无重叠双人声**：混音输入不得含 NARRATION 轨（运行时双保险拦截）；
 * - 字幕断行（视觉宽度、标点不在行首、maxLines 合并）+ SRT/VTT 时间码与时序；
 * - 越界只报 warning（不静默裁切）。
 */

const style = (overrides: Record<string, unknown> = {}) => captionStyleSchema.parse(overrides);

describe('planAudioMix（增益包络）', () => {
  const cues = [{ narrationBlockId: 'nbr_1', startMs: 1000, durationMs: 2000 }];

  it('旁白轨恒存在且恒定增益（旁白唯一来源）；音乐轨淡入淡出按区间生成关键帧', () => {
    const plan = planAudioMix({
      projectId: 'prj_1',
      durationMs: 10_000,
      cues,
      tracks: [{ id: 'trk_music', kind: 'MUSIC', assetId: 'ast_1', volume: 0.8, fadeInMs: 500, fadeOutMs: 1000, ducking: false }],
    });
    expect(plan.narrationIntervals).toEqual([{ startMs: 1000, endMs: 3000 }]);
    const narrationTrack = plan.tracks.find((track) => track.kind === 'NARRATION');
    expect(narrationTrack).toMatchObject({ trackId: 'narration:master', baseVolume: 1 });
    const music = plan.tracks.find((track) => track.kind === 'MUSIC');
    expect(music?.keyframes.map((frame) => [frame.startMs, frame.endMs, frame.fromGain, frame.toGain, frame.reason])).toEqual([
      [0, 500, 0, 0.8, 'FADE_IN'],
      [500, 9000, 0.8, 0.8, 'BASE'],
      [9000, 10_000, 0.8, 0, 'FADE_OUT'],
    ]);
  });

  it('ducking：旁白区间前 attack、区间内压至 level×base、区间后 release 恢复', () => {
    const plan = planAudioMix({
      projectId: 'prj_1',
      durationMs: 10_000,
      cues,
      tracks: [{ id: 'trk_music', kind: 'MUSIC', assetId: null, volume: 1, fadeInMs: 0, fadeOutMs: 0, ducking: true }],
      ducking: { level: 0.5, attackMs: 100, releaseMs: 200 },
    });
    const music = plan.tracks.find((track) => track.kind === 'MUSIC');
    const duckingFrames = music?.keyframes.filter((frame) => frame.reason === 'DUCKING') ?? [];
    expect(duckingFrames).toEqual([
      { startMs: 900, endMs: 1000, fromGain: 1, toGain: 0.5, reason: 'DUCKING' },
      { startMs: 1000, endMs: 3000, fromGain: 0.5, toGain: 0.5, reason: 'DUCKING' },
      { startMs: 3000, endMs: 3200, fromGain: 0.5, toGain: 1, reason: 'DUCKING' },
    ]);
  });

  it('音量只影响包络（纯计算）：改变 volume → 计划变化，但函数没有任何 TTS 依赖', () => {
    const make = (volume: number) =>
      planAudioMix({ projectId: 'prj_1', durationMs: 5000, cues, tracks: [{ id: 'trk_music', kind: 'MUSIC', assetId: null, volume, fadeInMs: 0, fadeOutMs: 0, ducking: false }] });
    expect(make(0.3).tracks.find((track) => track.kind === 'MUSIC')?.baseVolume).toBe(0.3);
    expect(make(1.2).tracks.find((track) => track.kind === 'MUSIC')?.baseVolume).toBe(1.2);
  });

  it('含 NARRATION 轨 → 运行时拒绝（无重叠双人声双保险）', () => {
    expect(() =>
      planAudioMix({
        projectId: 'prj_1',
        durationMs: 1000,
        cues: [],
        tracks: [{ id: 'trk_narr', kind: 'NARRATION', assetId: null, volume: 1, fadeInMs: 0, fadeOutMs: 0, ducking: false } as never],
      }),
    ).toThrowError(/NARRATION/);
  });
});

describe('字幕断行与 SRT/VTT', () => {
  it('视觉宽度：CJK=1、拉丁≈0.55', () => {
    expect(visualWidthOf('中文四字')).toBe(4);
    expect(visualWidthOf('abcd')).toBeCloseTo(2.2, 5);
  });

  it('断行：不超过 maxCharsPerLine；标点不出现在行首；超 maxLines 合并并标记', () => {
    const wrapped = wrapCaption('联邦基金利率维持在百分之五点二五不变。', style({ maxCharsPerLine: 8, maxLines: 3 }));
    expect(wrapped.lines.length).toBeLessThanOrEqual(3);
    for (const line of wrapped.lines) expect(visualWidthOf(line)).toBeLessThanOrEqual(8);
    for (const line of wrapped.lines) expect(['，', '。', '、', '；']).not.toContain(line[0]);

    const overflow = wrapCaption('这是一段非常长的字幕文本需要多行显示并且会超过最大行数上限', style({ maxCharsPerLine: 8, maxLines: 2 }));
    expect(overflow.truncated).toBe(true);
    expect(overflow.lines.length).toBe(2);
    // 合并末行不丢字
    expect(overflow.lines.join('')).toBe('这是一段非常长的字幕文本需要多行显示并且会超过最大行数上限');
  });

  it('SRT/VTT 时间码与结构（规范化输出）', () => {
    const cues = [
      { startMs: 0, durationMs: 1500, text: '第一句。' },
      { startMs: 1500, durationMs: 2000, text: '第二句。' },
    ];
    const srt = buildSubtitles({ format: 'SRT', cues, style: style() });
    expect(srt.content).toBe('1\n00:00:00,000 --> 00:00:01,500\n第一句。\n\n2\n00:00:01,500 --> 00:00:03,500\n第二句。\n');
    expect(srt.cueCount).toBe(2);

    const vtt = buildSubtitles({ format: 'VTT', cues, style: style() });
    expect(vtt.content.startsWith('WEBVTT\n\n')).toBe(true);
    expect(vtt.content).toContain('00:00:00.000 --> 00:00:01.500');
    expect(vtt.content).toContain('00:00:01.500 --> 00:00:03.500');

    expect(toSrtTime(3_661_007)).toBe('01:01:01,007');
    expect(toVttTime(3_661_007)).toBe('01:01:01.007');
  });

  it('越界只报 warning（不静默裁切）：超 maxLines 与超安全宽度均给出提示', () => {
    const long = '这是一段超过两行的超长字幕文本用于验证越界提示与安全宽度警告';
    const output = buildSubtitles({ format: 'SRT', cues: [{ startMs: 0, durationMs: 4000, text: long }], style: style({ maxCharsPerLine: 8, maxLines: 2 }) });
    expect(output.stats.overSafeWidthCues).toBe(1);
    expect(output.warnings.length).toBeGreaterThan(0);
    expect(output.warnings.join(' ')).toContain('超出');
    // 内容仍完整（合并行不丢字：去掉序号与时间码行后，文本逐字保留）
    const textLines = output.content
      .split(String.fromCharCode(10))
      .filter((line) => line !== '' && !line.includes('-->') && !/^\d+$/.test(line));
    expect(textLines.join('')).toBe(long);
  });
});
