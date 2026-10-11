import { describe, expect, it } from 'vitest';
import {
  MEDIA_CLOCK_SYNC,
  createMediaClock,
  decideMediaClockSync,
  gainDbAt,
  isClockInsideRange,
  isScheduledAudioCurrent,
  resolveMediaClockPlan,
  resumeMediaClock,
  seekMediaClock,
  sequenceTimeAt,
  setMediaClockRate,
  suspendMediaClock,
} from './index.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

/**
 * N03-13：统一媒体时钟 —— seek epoch / 挂起冻结 / 变速连续 / 无音轨虚拟时钟 / 未授权提示 / 同步决策。
 * 验收对照：连续 seek 后旧音频不播放；后台恢复不快进不重复；长样例无累计漂移；未授权时清楚提示。
 */
const msRange = (startMs: number, endMs: number) => ({ start: legacyMillisecondsToMediaTime(startMs), end: legacyMillisecondsToMediaTime(endMs) });

describe('N03-13 统一媒体时钟', () => {
  it('无音轨 → 同接口的虚拟时钟；有音轨 → AUDIO_CONTEXT（上层不分叉）', () => {
    const virtual = createMediaClock({ hasAudioTrack: false, audioMs: 0, sequenceMs: 0 });
    const audio = createMediaClock({ hasAudioTrack: true, audioMs: 0, sequenceMs: 0 });
    expect(virtual.source).toBe('VIRTUAL');
    expect(audio.source).toBe('AUDIO_CONTEXT');
    // 同一接口：时间推进公式一致
    expect(sequenceTimeAt(virtual, 1_000)).toBe(1_000);
    expect(sequenceTimeAt(audio, 1_000)).toBe(1_000);
  });

  it('seek epoch：只有当前代际的已调度音频允许播放（连续 seek 后旧音频不出声）', () => {
    let clock = createMediaClock({ hasAudioTrack: true, permission: 'GRANTED', audioMs: 0, sequenceMs: 0 });
    const firstEpoch = clock.epoch;
    const scheduledOk = isScheduledAudioCurrent(clock, firstEpoch);
    expect(scheduledOk).toBe(true);

    clock = seekMediaClock(clock, 5_000, 5_000);   // 第一次 seek
    clock = seekMediaClock(clock, 9_000, 9_000);   // 连续 seek
    expect(clock.epoch).toBe(2);
    expect(isScheduledAudioCurrent(clock, firstEpoch)).toBe(false); // 旧代际一律作废
    expect(isScheduledAudioCurrent(clock, 1)).toBe(false);
    expect(isScheduledAudioCurrent(clock, clock.epoch)).toBe(true);
  });

  it('挂起期间时钟冻结：音频时间前进也不推进序列时间', () => {
    const clock = createMediaClock({ hasAudioTrack: true, permission: 'GRANTED', audioMs: 0, sequenceMs: 0 });
    const suspended = suspendMediaClock(clock, 10_000);
    expect(sequenceTimeAt(suspended, 10_000)).toBe(10_000);
    expect(sequenceTimeAt(suspended, 70_000)).toBe(10_000); // 后台 60 秒不回放
  });

  it('恢复：从挂起点继续（不快进、不跳变），且重锚到恢复时刻', () => {
    const clock = createMediaClock({ hasAudioTrack: true, permission: 'GRANTED', audioMs: 0, sequenceMs: 0 });
    const resumed = resumeMediaClock(suspendMediaClock(clock, 10_000), 70_000); // 后台 60 秒后恢复
    expect(resumed.suspended).toBe(false);
    expect(sequenceTimeAt(resumed, 70_000)).toBe(10_000);   // 从挂起点继续
    expect(sequenceTimeAt(resumed, 71_000)).toBe(11_000);   // 之后正常推进
    expect(sequenceTimeAt(resumed, 60_000)).toBe(0);        // 挂起期间的音频时间不再被计入
  });

  it('变速：切换瞬间序列时间连续，之后按新速率推进（长样例不累计跳变）', () => {
    const clock = createMediaClock({ hasAudioTrack: true, permission: 'GRANTED', audioMs: 0, sequenceMs: 0 });
    const before = sequenceTimeAt(clock, 10_000);
    const half = setMediaClockRate(clock, 10_000, 0.5);
    expect(sequenceTimeAt(half, 10_000)).toBe(before);       // 连续
    expect(sequenceTimeAt(half, 12_000)).toBe(before + 1_000); // 1 秒音频 = 0.5 秒序列
  });

  it('长样例（1 小时）在 rate=1 下无累计漂移', () => {
    const clock = createMediaClock({ hasAudioTrack: true, permission: 'GRANTED', audioMs: 0, sequenceMs: 0 });
    const oneHour = 3_600_000;
    // 逐秒采样 3600 次（模拟真实 tick），误差应为 0（线性换算，无浮点累计）
    let last = 0;
    for (let second = 1; second <= 3_600; second += 1) last = sequenceTimeAt(clock, second * 1_000);
    expect(last).toBe(oneHour);
  });

  it('音频未授权 → 明确提示且标记"只静音播画面"（不静默无声）', () => {
    const denied = resolveMediaClockPlan({ hasAudioTrack: true, audioPermission: 'DENIED' });
    expect(denied.notice).toBe('AUDIO_PERMISSION_REQUIRED');
    expect(denied.silentVideoOnly).toBe(true);
    expect(denied.source).toBe('VIRTUAL'); // 退到虚拟时钟，界面仍能走
    expect(resolveMediaClockPlan({ hasAudioTrack: true, audioPermission: 'GRANTED' })).toMatchObject({ notice: 'NONE', silentVideoOnly: false, source: 'AUDIO_CONTEXT' });
    expect(resolveMediaClockPlan({ hasAudioTrack: false, audioPermission: 'DENIED' })).toMatchObject({ notice: 'NO_AUDIO_TRACK', silentVideoOnly: false });
  });
});

describe('N03-13 音画同步决策（容差带内不修正）', () => {
  it('容差带内 → 不修正（避免抖动/颤音）', () => {
    for (const drift of [-39, -1, 0, 1, 39]) {
      expect(decideMediaClockSync({ masterSequenceMs: 1_000, followerSequenceMs: 1_000 + drift }).action).toBe('NONE');
    }
  });

  it('超出容差但在微调范围 → 按比例微调速率且限幅', () => {
    const ahead = decideMediaClockSync({ masterSequenceMs: 1_000, followerSequenceMs: 1_120 }); // 画面超前 120ms
    expect(ahead.action).toBe('NUDGE_RATE');
    expect(ahead.suggestedRate).toBeLessThan(1);
    expect(ahead.suggestedRate!).toBeGreaterThanOrEqual(1 - MEDIA_CLOCK_SYNC.maxRateNudge);
    const behind = decideMediaClockSync({ masterSequenceMs: 1_000, followerSequenceMs: 880 });
    expect(behind.suggestedRate).toBeGreaterThan(1);
  });

  it('漂移超过重定位阈值 → RESEEK（继续微调已无意义）', () => {
    const decision = decideMediaClockSync({ masterSequenceMs: 1_000, followerSequenceMs: 1_400 });
    expect(decision.action).toBe('RESEEK');
    expect(decision.driftMs).toBe(400);
  });

  it('阈值可注入（不同素材/设备用不同门槛），且边界行为明确（等于容差 = 不修正）', () => {
    expect(decideMediaClockSync({ masterSequenceMs: 0, followerSequenceMs: 50, toleranceMs: 50 }).action).toBe('NONE');
    expect(decideMediaClockSync({ masterSequenceMs: 0, followerSequenceMs: 51, toleranceMs: 50 }).action).toBe('NUDGE_RATE');
    expect(decideMediaClockSync({ masterSequenceMs: 0, followerSequenceMs: 51, toleranceMs: 50, reseekThresholdMs: 50 }).action).toBe('RESEEK');
  });

  it('音量淡变：淡入线性爬升、淡出回落、中段为目标增益；重叠时取较小者', () => {
    const envelope = { gainDb: 0, fadeInMs: 1_000, fadeOutMs: 1_000 };
    expect(gainDbAt({ envelope, localMs: 0, durationMs: 5_000 })).toBeCloseTo(-96, 6);   // 起点静音
    expect(gainDbAt({ envelope, localMs: 1_000, durationMs: 5_000 })).toBeCloseTo(0, 6); // 淡入结束 = 目标
    expect(gainDbAt({ envelope, localMs: 3_000, durationMs: 5_000 })).toBeCloseTo(0, 6); // 中段目标
    expect(gainDbAt({ envelope, localMs: 5_000, durationMs: 5_000 })).toBeCloseTo(-96, 6); // 结束静音
    const mid = gainDbAt({ envelope, localMs: 500, durationMs: 5_000 });
    expect(mid).toBeGreaterThan(-96);
    expect(mid).toBeLessThan(0);
    // 无淡变 → 恒为目标增益
    expect(gainDbAt({ envelope: { gainDb: -6, fadeInMs: 0, fadeOutMs: 0 }, localMs: 100, durationMs: 5_000 })).toBe(-6);
  });

  it('片段边界判定（半开区间）：结束边界不算在内', () => {
    const range = msRange(2_000, 5_000);
    expect(isClockInsideRange(2_000, range)).toBe(true);
    expect(isClockInsideRange(4_999, range)).toBe(true);
    expect(isClockInsideRange(5_000, range)).toBe(false);
    expect(isClockInsideRange(1_999, range)).toBe(false);
  });
});
