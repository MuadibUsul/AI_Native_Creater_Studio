import { describe, expect, it } from 'vitest';
import { PLAYBACK_SYNC_THRESHOLDS, summarizePlaybackSyncReport, type PlaybackSyncFixtureResult, type PlaybackSyncReportEnvironment } from './index.js';

/** §20.4 要求报告必须注明环境；测试里给最小合规环境。 */
const ENV: PlaybackSyncReportEnvironment = {
  browser: 'chromium-test', platform: 'test', hardwareConcurrency: 8, deviceMemoryGb: 8,
  fixtureSpec: '1920x1080@23.976/29.97, mp4, 3s', cacheState: 'MIXED', concurrency: 1, backendVersion: 'test-1',
};

/**
 * N03-16：测量判定。关键纪律 —— 未测到记 UNKNOWN（不是 PASS）；不支持帧级不得过逐帧门；
 * 预渲染与本地实时**不得混算**。
 */
const fixture = (overrides: Partial<PlaybackSyncFixtureResult> = {}): PlaybackSyncFixtureResult => ({
  fixtureId: 'clip-b-2997', path: 'LOCAL_REALTIME', backendKind: 'HTML_MEDIA_BASELINE', precision: 'KEYFRAME_APPROXIMATE',
  frameAccurateRequired: false, coldFirstFrameMs: null, hotFirstFrameMs: null, seekSamplesMs: [], samples: [], durationMs: 10_000,
  ...overrides,
} as PlaybackSyncFixtureResult);

describe('N03-16 summarizePlaybackSyncReport', () => {
  it('未测到的指标记 UNKNOWN（缺证据不等于通过）', () => {
    const report = summarizePlaybackSyncReport({ environment: ENV, results: [fixture()] });
    const entry = report.fixtures[0]!;
    expect(entry.verdict).toBe('UNKNOWN');
    expect(entry.verdicts.filter((verdict) => verdict.verdict === 'UNKNOWN').length).toBeGreaterThan(0);
    expect(report.overall).toBe('UNKNOWN');
  });

  it('缓存 seek：p50/p95 按阈值判定（§20.4 p95 ≤1s）', () => {
    const fast = summarizePlaybackSyncReport({ environment: ENV, results: [fixture({ seekSamplesMs: [100, 200, 300, 400, 500] })] });
    const seekP95 = fast.fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'CACHED_SEEK_P95')!;
    expect(seekP95.verdict).toBe('PASS');
    expect(seekP95.threshold).toBe(PLAYBACK_SYNC_THRESHOLDS.cachedSeekP95Ms);

    const slow = summarizePlaybackSyncReport({ environment: ENV, results: [fixture({ seekSamplesMs: [900, 1_500, 2_000] })] });
    expect(slow.fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'CACHED_SEEK_P95')!.verdict).toBe('FAIL');
  });

  it('固定偏移 ≠ 持续漂移：起播落后 85ms 但全程不变 → STARTUP_OFFSET 过关、累计漂移为 0', () => {
    const stable = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({
        frameRate: { num: 30, den: 1 }, durationMs: 60_000,
        // 全程固定落后 85ms（请求 85/5085/10085 → 呈现 0/5000/10000）
        samples: [
          { requestedMs: 85, presentedMs: 0, droppedFrames: null, expectedFrames: null, memoryMb: null },
          { requestedMs: 5_085, presentedMs: 5_000, droppedFrames: null, expectedFrames: null, memoryMb: null },
          { requestedMs: 10_085, presentedMs: 10_000, droppedFrames: null, expectedFrames: null, memoryMb: null },
        ],
      })],
    });
    const entry = stable.fixtures[0]!;
    expect(entry.verdicts.find((verdict) => verdict.metric === 'STARTUP_OFFSET')!.value).toBe(85);
    expect(entry.verdicts.find((verdict) => verdict.metric === 'STARTUP_OFFSET')!.verdict).toBe('PASS');
    expect(entry.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!.value).toBe(0);
    expect(entry.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!.verdict).toBe('PASS');
  });

  it('§20.4：累计漂移阈值按夹具帧率换算为"一帧"（23.976 → ≈41.7ms）', () => {
    // 40ms 漂移：在 30fps（一帧 33.3ms）下超限 → FAIL；在 23.976fps（一帧 41.7ms）下未超 → PASS
    const build = (frameRate: { num: number; den: number }) => summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({
        frameRate, durationMs: 10_000,
        samples: [
          { requestedMs: 0, presentedMs: 0, droppedFrames: null, expectedFrames: null, memoryMb: null },
          { requestedMs: 5_000, presentedMs: 4_960, droppedFrames: null, expectedFrames: null, memoryMb: null },
        ],
      })],
    });
    const at30 = build({ num: 30, den: 1 }).fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!;
    expect(at30.threshold).toBeCloseTo(33.33, 1);
    expect(at30.verdict).toBe('FAIL');
    const at23976 = build({ num: 24_000, den: 1_001 }).fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!;
    expect(at23976.threshold).toBeCloseTo(41.71, 1);
    expect(at23976.verdict).toBe('PASS');
    // 缺帧率 → 无法按"一帧"判定 → UNKNOWN（不猜默认值）
    const noRate = summarizePlaybackSyncReport({ environment: ENV, results: [fixture({ samples: [{ requestedMs: 0, presentedMs: 0, droppedFrames: null, expectedFrames: null, memoryMb: null }] })] });
    expect(noRate.fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!.verdict).toBe('UNKNOWN');
  });

  it('§20.4：报告必须注明硬件/浏览器/素材规格/缓存状态/并发/后端版本', () => {
    const report = summarizePlaybackSyncReport({ environment: ENV, results: [fixture()] });
    expect(report.environment).toMatchObject({ browser: 'chromium-test', cacheState: 'MIXED', concurrency: 1 });
  });

  it('持续漂移：偏移量随时间变化超过"一帧"即 FAIL（§20.4 只有这一个漂移门）', () => {
    const drifting = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({
        frameRate: { num: 30, den: 1 }, durationMs: 4_000,
        samples: [
          { requestedMs: 0, presentedMs: 0, droppedFrames: null, expectedFrames: null, memoryMb: null },
          { requestedMs: 3_000, presentedMs: 2_600, droppedFrames: null, expectedFrames: null, memoryMb: null },
        ],
      })],
    });
    const entry = drifting.fixtures[0]!;
    const accumulation = entry.verdicts.find((verdict) => verdict.metric === 'DRIFT_ACCUMULATION')!;
    expect(accumulation.value).toBe(400);
    expect(accumulation.verdict).toBe('FAIL');
    // 自造的"每分钟漂移率"已删除（短夹具外推会凭空造 FAIL）
    expect(entry.verdicts.some((verdict) => String(verdict.metric).includes('PER_MINUTE'))).toBe(false);
  });

  it('启动偏移过大（超过 reseek 阈值）同样 FAIL', () => {
    const late = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({ samples: [{ requestedMs: 400, presentedMs: 0, droppedFrames: null, expectedFrames: null, memoryMb: null }] })],
    });
    expect(late.fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'STARTUP_OFFSET')!.verdict).toBe('FAIL');
  });

  it('不支持帧级精度 → 逐帧门 FAIL（不得用关键帧近似交差）', () => {
    const report = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({ precision: 'KEYFRAME_APPROXIMATE', frameAccurateRequired: true })],
    });
    const entry = report.fixtures[0]!;
    expect(entry.verdict).toBe('FAIL');
    expect(entry.failureReasons.some((reason) => reason.includes('FRAME_ACCURACY'))).toBe(true);
    // 帧级实测通过时才算 PASS
    const ok = summarizePlaybackSyncReport({ environment: ENV, results: [fixture({ precision: 'FRAME_ACCURATE', frameAccurateRequired: true })] });
    expect(ok.fixtures[0]!.verdicts.find((verdict) => verdict.metric === 'FRAME_ACCURACY')!.verdict).toBe('PASS');
  });

  it('掉帧比例与内存峰值按阈值判定', () => {
    const report = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({
        samples: [
          { requestedMs: 0, presentedMs: 0, droppedFrames: 1, expectedFrames: 1_000, memoryMb: 120 },
          { requestedMs: 1_000, presentedMs: 0, droppedFrames: 0, expectedFrames: 1_000, memoryMb: 500 },
        ],
      })],
    });
    const entry = report.fixtures[0]!;
    expect(entry.verdicts.find((verdict) => verdict.metric === 'DROPPED_FRAME_RATIO')!.value).toBeCloseTo(0.0005, 6);
    expect(entry.verdicts.find((verdict) => verdict.metric === 'DROPPED_FRAME_RATIO')!.verdict).toBe('PASS');
    expect(entry.verdicts.find((verdict) => verdict.metric === 'MEMORY_PEAK')!.value).toBe(500);
  });

  it('路径分组：预渲染与本地实时分开结论，不混算', () => {
    const report = summarizePlaybackSyncReport({
      environment: ENV,
      results: [
        fixture({ fixtureId: 'realtime', path: 'LOCAL_REALTIME', seekSamplesMs: [100] }),
        fixture({ fixtureId: 'prerender', path: 'PRERENDER', seekSamplesMs: [3_000] }),
      ],
    });
    const realtime = report.byPath.find((group) => group.path === 'LOCAL_REALTIME')!;
    const prerender = report.byPath.find((group) => group.path === 'PRERENDER')!;
    expect(realtime.fixtures).toBe(1);
    // 本地实时只有 seek 数据（其余 UNKNOWN），预渲染的慢 seek 不影响它
    expect(realtime.verdict).toBe('UNKNOWN');
    // 预渲染那一组因 p95=3000ms 超阈值而 FAIL
    expect(prerender.verdict).toBe('FAIL');
    expect(report.overall).toBe('FAIL');
  });

  it('任一 FAIL → 该夹具与总体均 FAIL；全 PASS 才 PASS', () => {
    const allPass = summarizePlaybackSyncReport({
      environment: ENV,
      results: [fixture({
        frameRate: { num: 30, den: 1 }, seekSamplesMs: [100, 200], coldFirstFrameMs: 900, hotFirstFrameMs: 300, durationMs: 60_000,
        samples: [{ requestedMs: 0, presentedMs: 10, droppedFrames: 0, expectedFrames: 1_000, memoryMb: 200 }],
      })],
    });
    expect(allPass.fixtures[0]!.verdict).toBe('PASS');
    expect(allPass.overall).toBe('PASS');
    expect(allPass.thresholdSource).toBe('SPEC_20_4_AND_20_6_START_TARGET');
  });
});
