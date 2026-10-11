import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_ENGINE_ERROR_REASONS,
  PLAYBACK_SNAPSHOT_VERSION,
  applyPlaybackResult,
  createPlaybackEngineState,
  dispatchPlayback,
  getPlaybackCapabilities,
  getPlaybackClock,
  isCapabilitySupported,
  negotiatePlaybackCapabilities,
  presentedDriftMs,
  runPlaybackEffect,
  type MediaTime,
  type PlaybackBackendPort,
  type PlaybackCapabilities,
  type PlaybackSnapshot,
} from './index.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

/**
 * N03-11：PlaybackEngine 状态机（无浏览器，纯函数验证）。
 * 验收对照：切换后端不改工程；事件带 requestId/revision/**实际呈现**时间；
 * 未声明能力不得展示为支持；dispose 幂等。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });

const capabilities = (supported: string[], unsupported: string[] = []): PlaybackCapabilities => ({
  backend: 'HTML_MEDIA_BASELINE', videoPrecision: 'KEYFRAME_APPROXIMATE', audioPrecision: 'FRAME_ACCURATE',
  supported: supported as never, unsupported: unsupported as never,
});

const snapshot = (overrides: Partial<PlaybackSnapshot> = {}): PlaybackSnapshot => ({
  schemaVersion: PLAYBACK_SNAPSHOT_VERSION,
  projectId: 'proj_1', sequenceId: 'seq_1', documentRevision: 7,
  frameRate: { num: 30, den: 1 }, duration: mt(10_000),
  capabilities: capabilities(['PER_SEGMENT_OPACITY']),
  videoSegments: [], audioSegments: [], captions: [], excludedTrackIds: [], warnings: [],
  ...overrides,
} as PlaybackSnapshot);

const load = (state = createPlaybackEngineState(), backend: 'HTML_MEDIA_BASELINE' | 'SERVER_PRECOMPOSED' = 'HTML_MEDIA_BASELINE') =>
  dispatchPlayback(state, { kind: 'loadDocument', requestId: 'req_load', snapshot: snapshot(), backendKind: backend });

describe('N03-11 PlaybackEngine 状态机', () => {
  it('loadDocument → LOADING + LOAD 效果；回灌 LOADED → READY 且事件带 revision 与协商后的能力', () => {
    const loaded = load();
    expect(loaded.state.status).toBe('LOADING');
    expect(loaded.effects[0]).toMatchObject({ kind: 'LOAD', documentRevision: 7 });

    const ready = applyPlaybackResult(loaded.state, { kind: 'LOADED', requestId: 'req_load' });
    expect(ready.state.status).toBe('READY');
    const event = ready.events[0]!;
    expect(event).toMatchObject({ kind: 'LOADED', requestId: 'req_load', documentRevision: 7, backendKind: 'HTML_MEDIA_BASELINE' });
    expect((event as { capabilities: { supported: string[] } }).capabilities.supported).toEqual(['PER_SEGMENT_OPACITY']);
  });

  it('未加载就 play → ERROR(NOT_LOADED)，且不产生任何效果', () => {
    const result = dispatchPlayback(createPlaybackEngineState(), { kind: 'play', requestId: 'req_1' });
    expect(result.effects).toEqual([]);
    expect(result.events[0]).toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.NOT_LOADED, requestId: 'req_1' });
  });

  it('播放/暂停/seek/step 产生对应效果；事件里的**实际呈现时间**只能来自后端回灌', () => {
    let state = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    const play = dispatchPlayback(state, { kind: 'play', requestId: 'req_play' });
    expect(play.state.status).toBe('PLAYING');
    expect(play.effects[0]).toMatchObject({ kind: 'PLAY', documentRevision: 7 });
    // 播放命令本身**不**产生"已呈现"事件（不能把请求当呈现）
    expect(play.events).toEqual([]);

    state = play.state;
    const seek = dispatchPlayback(state, { kind: 'seek', requestId: 'req_seek', time: mt(3_000) });
    expect(seek.effects[0]).toMatchObject({ kind: 'SEEK', time: mt(3_000) });
    // 后端回报"实际呈现 3.2s"（与请求不同）→ 事件必须如实分别上报
    const presented = applyPlaybackResult(seek.state, { kind: 'PRESENTED', requestId: 'req_seek', presentedTime: mt(3_200), presentedFrame: '96' });
    const event = presented.events[0]! as { kind: string; requestedTime: unknown; presentedTime: unknown; presentedFrame: string; documentRevision: number };
    expect(event.kind).toBe('PLAYBACK');
    expect(event.requestedTime).toEqual(mt(3_000));
    expect(event.presentedTime).toEqual(mt(3_200));
    expect(event.presentedFrame).toBe('96');
    expect(event.documentRevision).toBe(7);
    expect(presented.state.clock).toEqual(mt(3_200));
    expect(presentedDriftMs(mt(3_000), mt(3_200))).toBeCloseTo(200, 6);
  });

  it('切换后端不改变工程：投影与 revision 原样保留，只有 backendKind 变化', () => {
    const first = load(createPlaybackEngineState(), 'HTML_MEDIA_BASELINE');
    const second = load(createPlaybackEngineState(), 'SERVER_PRECOMPOSED');
    expect(second.state.snapshot).toEqual(first.state.snapshot);
    expect(second.state.snapshot!.documentRevision).toBe(7);
    expect(second.state.backendKind).toBe('SERVER_PRECOMPOSED');
    // 效果里的 revision 也一致 → 后端切换不会写入新工程状态
    expect(second.effects[0]).toMatchObject({ documentRevision: 7 });
  });

  it('未声明/未知能力不得展示为支持（fail-closed）', () => {
    const declared = capabilities(['PER_SEGMENT_OPACITY', 'NOT_A_REAL_FLAG'], ['PER_SEGMENT_CROP']);
    const negotiated = negotiatePlaybackCapabilities(declared);
    expect(negotiated.supported).toEqual(['PER_SEGMENT_OPACITY']);
    expect(negotiated.unsupported).toContain('PER_SEGMENT_CROP');
    expect(negotiated.unsupported).toContain('AUDIO_CROSSFADE'); // 未声明 → 不支持
    expect(negotiated.unsupported).not.toContain('NOT_A_REAL_FLAG'); // 未知值直接丢弃
    expect(isCapabilitySupported(declared, 'PER_SEGMENT_OPACITY')).toBe(true);
    expect(isCapabilitySupported(declared, 'PER_SEGMENT_CROP')).toBe(false);
  });

  it('dispose 幂等：重复调用不再产生效果与事件；释放后其他命令一律 ERROR', () => {
    const state = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    const first = dispatchPlayback(state, { kind: 'dispose', requestId: 'req_dispose' });
    expect(first.state.status).toBe('DISPOSED');
    expect(first.effects[0]).toMatchObject({ kind: 'DISPOSE' });
    expect(first.events[0]).toMatchObject({ kind: 'DISPOSED', documentRevision: 7 });

    const again = dispatchPlayback(first.state, { kind: 'dispose', requestId: 'req_dispose_2' });
    expect(again.effects).toEqual([]);
    expect(again.events).toEqual([]);
    expect(again.state.status).toBe('DISPOSED');

    const play = dispatchPlayback(first.state, { kind: 'play', requestId: 'req_play' });
    expect(play.events[0]).toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.DISPOSED });
  });

  it('setRange 后 seek 越界被拒；非法范围被拒；step 0 帧被拒（不静默忽略）', () => {
    let state = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    const ranged = dispatchPlayback(state, { kind: 'setRange', requestId: 'req_range', range: range(2_000, 5_000) });
    expect(ranged.state.range).toEqual(range(2_000, 5_000));
    state = ranged.state;

    expect(dispatchPlayback(state, { kind: 'seek', requestId: 'req_x', time: mt(6_000) }).events[0])
      .toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND });
    // 空范围在契约层就被拒（fail-closed）：连命令都构造不出来
    expect(() => dispatchPlayback(state, { kind: 'setRange', requestId: 'req_y', range: range(5_000, 5_000) })).toThrow();
    expect(dispatchPlayback(state, { kind: 'step', requestId: 'req_z', frames: 0 }).events[0])
      .toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND });
    // 合法 seek 在范围内成功
    expect(dispatchPlayback(state, { kind: 'seek', requestId: 'req_ok', time: mt(3_000) }).effects[0]).toMatchObject({ kind: 'SEEK' });
  });

  it('后端失败 → ERROR(BACKEND_FAILED) 且引擎回到可重试状态（不假装成功）', () => {
    const loading = load().state;
    const failed = applyPlaybackResult(loading, { kind: 'FAILED', requestId: 'req_load', message: 'media decode error' });
    expect(failed.state.status).toBe('IDLE'); // 后端没加载成功 → 回到 IDLE（不是 READY）
    // 投影保留下来可重试；但 play 必须被拒（后端没有内容）
    expect(failed.state.snapshot).not.toBeNull();
    expect(dispatchPlayback(failed.state, { kind: 'play', requestId: 'req_after' }).events[0])
      .toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.NOT_LOADED });
    expect(failed.events[0]).toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.BACKEND_FAILED });
  });

  it('已加载时重复 play → ERROR(ALREADY_PLAYING)（不重复下发 PLAY 效果）', () => {
    let state = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    state = dispatchPlayback(state, { kind: 'play', requestId: 'req_play' }).state;
    const twice = dispatchPlayback(state, { kind: 'play', requestId: 'req_play2' });
    expect(twice.effects).toEqual([]);
    expect(twice.events[0]).toMatchObject({ kind: 'ERROR', reason: PLAYBACK_ENGINE_ERROR_REASONS.ALREADY_PLAYING });
  });

  it('getCapabilities / getClock：未加载时为 null，加载后返回协商结果与时钟', () => {
    expect(getPlaybackCapabilities(createPlaybackEngineState())).toBeNull();
    expect(getPlaybackClock(createPlaybackEngineState())).toBeNull();
    const ready = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    expect(getPlaybackCapabilities(ready)!.supported).toEqual(['PER_SEGMENT_OPACITY']);
    expect(getPlaybackClock(ready)).not.toBeNull();
  });

  it('pause 进入 PAUSED 并可再次 play（状态机可逆）', () => {
    let state = applyPlaybackResult(load().state, { kind: 'LOADED', requestId: 'req_load' }).state;
    state = dispatchPlayback(state, { kind: 'play', requestId: 'p1' }).state;
    const paused = dispatchPlayback(state, { kind: 'pause', requestId: 'p2' });
    expect(paused.state.status).toBe('PAUSED');
    expect(dispatchPlayback(paused.state, { kind: 'play', requestId: 'p3' }).state.status).toBe('PLAYING');
  });
});

describe('N03-11 后端端口与效果驱动（用假后端跑通整场会话）', () => {
  class FakeBackend implements PlaybackBackendPortTestDouble {
    readonly kind = 'HTML_MEDIA_BASELINE' as const;
    readonly calls: string[] = [];
    private presentedMs = 0;
    /** 用于模拟"后端实际呈现与请求不同"（真实媒体必然如此） */
    constructor(private readonly presentationLagMs = 0) {}
    async load(): Promise<void> { this.calls.push('load'); }
    async play(): Promise<void> { this.calls.push('play'); }
    async pause(): Promise<void> { this.calls.push('pause'); }
    async seek(time: MediaTime): Promise<void> {
      this.presentedMs = (Number(time.ticks) * time.timebase.num * 1000) / time.timebase.den + this.presentationLagMs;
      this.calls.push('seek');
    }
    async step(frames: number): Promise<void> { this.presentedMs += (frames * 1000) / 30; this.calls.push('step'); }
    async setRange(): Promise<void> { this.calls.push('setRange'); }
    async getPresented(): Promise<{ presentedTime: MediaTime; presentedFrame: string | null }> {
      return { presentedTime: legacyMillisecondsToMediaTime(Math.round(this.presentedMs)), presentedFrame: String(Math.round((this.presentedMs / 1000) * 30)) };
    }
    async dispose(): Promise<void> { this.calls.push('dispose'); }
  }
  type PlaybackBackendPortTestDouble = PlaybackBackendPort;

  it('效果按类型转发到端口；seek 后回灌的是**后端呈现值**（含真实滞后）', async () => {
    const port = new FakeBackend(80); // 后端比请求慢 80ms
    const loading = load();
    for (const effect of loading.effects) await runPlaybackEffect(port, effect); // 先真的把 LOAD 交给后端
    let state = applyPlaybackResult(loading.state, { kind: 'LOADED', requestId: 'req_load' }).state;
    expect(port.calls).toEqual(['load']);

    const seek = dispatchPlayback(state, { kind: 'seek', requestId: 'req_seek', time: mt(2_000) });
    const result = await runPlaybackEffect(port, seek.effects[0]!);
    expect(result).toMatchObject({ kind: 'PRESENTED', requestId: 'req_seek' });
    state = applyPlaybackResult(seek.state, result).state;
    expect(presentedDriftMs(mt(2_000), state.clock)).toBeCloseTo(80, 3);
  });

  it('dispose 效果驱动端口释放；整场会话的命令序列与状态迁移一致', async () => {
    const port = new FakeBackend();
    const loading = load();
    for (const effect of loading.effects) await runPlaybackEffect(port, effect);
    let state = applyPlaybackResult(loading.state, { kind: 'LOADED', requestId: 'r0' }).state;
    for (const command of [
      { kind: 'play' as const, requestId: 'r1' },
      { kind: 'step' as const, requestId: 'r2', frames: 2 },
      { kind: 'pause' as const, requestId: 'r3' },
      { kind: 'setRange' as const, requestId: 'r4', range: range(0, 5_000) },
    ]) {
      const dispatched = dispatchPlayback(state, command);
      for (const effect of dispatched.effects) await runPlaybackEffect(port, effect);
      state = dispatched.state;
    }
    const disposed = dispatchPlayback(state, { kind: 'dispose', requestId: 'r5' });
    await runPlaybackEffect(port, disposed.effects[0]!);
    expect(port.calls).toEqual(['load', 'play', 'step', 'pause', 'setRange', 'dispose']);
    expect(disposed.state.status).toBe('DISPOSED');
  });

  it('后端抛错 → FAILED 结果（不向调用方抛异常），引擎记 BACKEND_FAILED', async () => {
    const broken: PlaybackBackendPortTestDouble = {
      kind: 'SERVER_PRECOMPOSED',
      load: () => Promise.reject(new Error('decoder crashed')),
      play: () => Promise.resolve(), pause: () => Promise.resolve(), seek: () => Promise.resolve(),
      step: () => Promise.resolve(), setRange: () => Promise.resolve(), dispose: () => Promise.resolve(),
      getPresented: () => Promise.resolve({ presentedTime: mt(0), presentedFrame: null }),
    };
    const loading = load().state;
    const result = await runPlaybackEffect(broken, loading.snapshot === null ? undefined as never : { kind: 'LOAD', requestId: 'req_load', documentRevision: 7, snapshot: loading.snapshot });
    expect(result.kind).toBe('FAILED');
    expect(applyPlaybackResult(loading, result).state.error?.reason).toBe(PLAYBACK_ENGINE_ERROR_REASONS.BACKEND_FAILED);
  });
});
