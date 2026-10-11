import { describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, mediaTimeSchema, type FrameRate } from './common/media-time.js';
import { dualTimecode, formatFrameTimecode, resolveMusicRegionTarget, resolveUtteranceTarget, stepFrames } from './timeline-targeting.js';

/**
 * N04-04（收尾）：逐帧步进 / 源序列双时间码 / "这句话·这里的音乐"语义指向。
 * 易错点：分数帧率累计漂移、源时间映射方向（REVERSE）、半开区间边界、指不到时不猜。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
/** 精确把 MediaTime 换成毫秒（timebase 不一定是纳秒，别拿 ticks 当秒用）。 */
const toMs = (time: { ticks: string; timebase: { num: number; den: number } }): number =>
  (Number(time.ticks) * time.timebase.num * 1000) / time.timebase.den;
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });
const FPS_30: FrameRate = { num: 30, den: 1 };
const FPS_2997: FrameRate = { num: 30_000, den: 1_001 }; // 经典分数帧率

describe('N04-04 逐帧步进（分数帧率不累计漂移）', () => {
  it('整帧率：前进 1 帧 = 1/30 秒；连续 30 次回到整秒', () => {
    let time = mt(0);
    for (let index = 0; index < 30; index += 1) time = stepFrames({ time, frameRate: FPS_30, delta: 1 });
    expect(toMs(time)).toBe(1_000); // 恰好 1 秒
    expect(formatFrameTimecode(time, FPS_30)).toBe('00:00:01:00');
  });

  it('分数帧率 29.97：步进 30000 帧后恰好到 1001 秒（无漂移）', () => {
    let time = mt(0);
    for (let index = 0; index < 30_000; index += 1) time = stepFrames({ time, frameRate: FPS_2997, delta: 1 });
    // 30000 帧 @30000/1001 = 1001 秒
    // 真实时间恰好 1001 秒（无漂移）
    expect(Math.round(toMs(time) / 1000)).toBe(1_001);
    // 帧时间码是**非 drop-frame**：按标称 30 帧/秒计数 → 30000 帧 = 1000 个"时间码秒" = 16:40。
    // 它与真实时间（1001s）的差值正是非 drop-frame 的固有特性（drop-frame 未实现，见交接文档）。
    expect(formatFrameTimecode(time, FPS_2997)).toBe('00:16:40:00');
  });

  it('回退与边界：负 delta 不为负；给 bounds 时夹在帧边界内', () => {
    expect(toMs(mediaTimeSchema.parse(stepFrames({ time: mt(1_000), frameRate: FPS_30, delta: -100 })))).toBe(0);
    const bounded = stepFrames({ time: mt(0), frameRate: FPS_30, delta: 999, bounds: range(0, 1_000) });
    expect(toMs(bounded)).toBe(1_000);
  });

  it('帧时间码逐帧不丢帧（33ms 一帧连续显示，帧号单调）', () => {
    const seen = new Set<string>();
    let time = mt(0);
    for (let index = 0; index < 60; index += 1) {
      seen.add(formatFrameTimecode(time, FPS_30));
      time = stepFrames({ time, frameRate: FPS_30, delta: 1 });
    }
    expect(seen.size).toBe(60);
  });
});

describe('N04-04 源 / 序列双时间码', () => {
  const clip = {
    clipId: 'clip_a',
    sequenceRange: range(2_000, 4_000),   // 序列上占 2s
    sourceRange: range(10_000, 14_000),   // 源侧取 4s → rate = 2（源比序列长一倍）
    timeMapping: { rate: { num: 2, den: 1 }, direction: 'FORWARD' as const },
  };

  it('正向：序列时间映射到源时间（含速率差）', () => {
    const result = dualTimecode({ sequenceTime: mt(3_000), clip, frameRate: FPS_30 })!;
    // 序列偏移 1s × rate 2 = 源偏移 2s → 10s + 2s = 12s
    expect(Math.round(toMs(result.sourceTime))).toBe(12_000);
    expect(result.sequenceTimecode).toBe('00:00:03:00');
  });

  it('反向（REVERSE）：源时间方向相反', () => {
    const reversed = { ...clip, timeMapping: { rate: { num: 2, den: 1 }, direction: 'REVERSE' as const } };
    const result = dualTimecode({ sequenceTime: mt(2_000), clip: reversed, frameRate: FPS_30 })!;
    // 序列起点 → 源终点方向：镜像到末尾再映射 → 源 14s
    expect(Math.round(toMs(result.sourceTime))).toBe(14_000);
  });

  it('播放头不在该片段区间内 → null（不假装属于它）', () => {
    expect(dualTimecode({ sequenceTime: mt(5_000), clip, frameRate: FPS_30 })).toBeNull();
    expect(dualTimecode({ sequenceTime: mt(1_999), clip, frameRate: FPS_30 })).toBeNull();
  });
});

describe('N04-04 语义指向：这句话 / 这里的音乐', () => {
  const captions = [
    { captionId: 'cap_1', sequenceRange: range(0, 3_000), text: '去掉前面废话', trackId: 'trk_cap', words: [
      { text: '去掉', range: range(0, 1_000) },
      { text: '前面', range: range(1_000, 2_000) },
      { text: '废话', range: range(2_000, 3_000) },
    ] },
    { captionId: 'cap_2', sequenceRange: range(4_000, 6_000), text: '保留原音', trackId: 'trk_cap', words: [] },
  ];
  const regions = [
    { regionId: 'reg_bgm', sequenceRange: range(0, 8_000), trackId: 'trk_music', label: '背景音乐' },
    { regionId: 'reg_sfx', sequenceRange: range(3_000, 4_000), trackId: 'trk_sfx', label: '音效' },
  ];

  it('"这句话"→ 命中的字幕 + 词级定位', () => {
    const target = resolveUtteranceTarget({ captions, at: mt(1_500) });
    expect(target.kind).toBe('UTTERANCE');
    expect(target.targets).toHaveLength(1);
    expect(target.targets[0]).toMatchObject({ objectKind: 'CAPTION', objectId: 'cap_1', wordText: '前面' });
  });

  it('半开区间：3.000s 是 cap_1 的结束边界 → 不属于它', () => {
    expect(resolveUtteranceTarget({ captions, at: mt(3_000) }).targets).toEqual([]);
    expect(resolveUtteranceTarget({ captions, at: mt(2_999) }).targets[0]!.objectId).toBe('cap_1');
  });

  it('"这里的音乐"→ 命中的音频区域；重叠时全部返回而不擅自选一个', () => {
    const overlapping = resolveMusicRegionTarget({ regions, at: mt(3_500) });
    expect(overlapping.targets.map((target) => target.objectId).sort()).toEqual(['reg_bgm', 'reg_sfx']);
    const single = resolveMusicRegionTarget({ regions, at: mt(5_000) });
    expect(single.targets.map((target) => target.objectId)).toEqual(['reg_bgm']);
  });

  it('轨道作用域：只看音乐轨时音效轨不参与', () => {
    const scoped = resolveMusicRegionTarget({ regions, at: mt(3_500), trackIds: ['trk_music'] });
    expect(scoped.targets.map((target) => target.objectId)).toEqual(['reg_bgm']);
  });

  it('指不到就返回空（调用方应追问，不得猜最近的一条）', () => {
    expect(resolveUtteranceTarget({ captions, at: mt(3_500) }).targets).toEqual([]);
    expect(resolveMusicRegionTarget({ regions, at: mt(9_000) }).targets).toEqual([]);
  });
});
