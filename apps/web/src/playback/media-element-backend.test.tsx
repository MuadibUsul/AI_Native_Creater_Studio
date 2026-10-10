import { describe, expect, it, vi } from 'vitest';
import {
  PLAYBACK_SNAPSHOT_VERSION,
  legacyMillisecondsToMediaTime,
  presentedDriftMs,
  type PlaybackSnapshot,
} from '@ancs/contracts';
import { PlaybackBackendError, createMediaElementBackend, type MediaElementLike } from './media-element-backend';

/**
 * N03-12 浏览器适配器（jsdom + 元素替身）：
 * presented 时间只来自元素、URL 失效有限重试并**保持位置**、dispose 幂等、范围外 seek 被拒。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });

const snapshot: PlaybackSnapshot = {
  schemaVersion: PLAYBACK_SNAPSHOT_VERSION,
  projectId: 'p', sequenceId: 's', documentRevision: 3,
  frameRate: { num: 30, den: 1 }, duration: mt(10_000),
  capabilities: { backend: 'HTML_MEDIA_BASELINE', videoPrecision: 'KEYFRAME_APPROXIMATE', audioPrecision: 'KEYFRAME_APPROXIMATE', supported: [], unsupported: [] },
  videoSegments: [], audioSegments: [], captions: [], excludedTrackIds: [], warnings: [],
} as PlaybackSnapshot;

/** 最小元素替身：模拟"元素实际呈现的位置与请求不同"（真实媒体必然如此）。 */
class FakeElement implements MediaElementLike {
  currentTime = 0;
  readonly duration = 10;
  paused = true;
  playbackRate = 1;
  src = '';
  muted = false;
  volume = 1;
  loadCount = 0;
  playCount = 0;
  pauseCount = 0;
  /** 模拟呈现滞后：元素停在 currentTime + lag（用于验证"presented 只来自元素"） */
  presentationLagSeconds = 0;
  private listeners = new Map<string, Set<() => void>>();
  load(): void { this.loadCount += 1; }
  play(): Promise<void> { this.playCount += 1; this.paused = false; return Promise.resolve(); }
  pause(): void { this.pauseCount += 1; this.paused = true; }
  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set(); set.add(listener); this.listeners.set(type, set);
  }
  removeEventListener(type: string, listener: () => void): void { this.listeners.get(type)?.delete(listener); }
  emit(type: string): void { for (const listener of this.listeners.get(type) ?? []) listener(); }
  /** 供测试：元素真正呈现的时间 */
  presented(): number { return this.currentTime + this.presentationLagSeconds; }
}

describe('N03-12 media-element 后端：presented 只来自元素', () => {
  it('load 设置 src 并 load()；play/pause 委托元素；dispose 清空 src 且幂等', async () => {
    const element = new FakeElement();
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'https://cdn/proxy.mp4?sig=1' });
    await backend.load(snapshot);
    expect(element.src).toBe('https://cdn/proxy.mp4?sig=1');
    expect(element.loadCount).toBe(1);

    await backend.play();
    expect(element.playCount).toBe(1);
    await backend.pause();
    expect(element.pauseCount).toBe(1);

    await backend.dispose();
    expect(element.src).toBe('');
    const pauseAfterDispose = element.pauseCount;
    await backend.dispose(); // 幂等
    expect(element.pauseCount).toBe(pauseAfterDispose);
    await expect(backend.play()).rejects.toBeInstanceOf(PlaybackBackendError);
  });

  it('getPresented 取元素**实际**位置（与请求不同），并据此给出帧号', async () => {
    const element = new FakeElement();
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'u' });
    await backend.load(snapshot);
    await backend.seek(mt(2_000));
    element.presentationLagSeconds = 0.08; // 元素滞后 80ms
    element.currentTime = 2.08;
    const presented = await backend.getPresented();
    expect(presented.presentedTime).toEqual(mt(2_080));
    expect(presented.presentedFrame).toBe('62'); // floor(2.08 × 30)
    // 与请求的 2000ms 相差 80ms —— 如实可测（N03-16 的漂移来源）
    expect(presentedDriftMs(mt(2_000), presented.presentedTime)).toBeCloseTo(80, 3);
  });

  it('step 按帧率推进（分数帧率同样精确到有理换算）', async () => {
    const element = new FakeElement();
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'u' });
    await backend.load({ ...snapshot, frameRate: { num: 30_000, den: 1_001 } } as PlaybackSnapshot);
    await backend.seek(mt(1_000));
    await backend.step(1);
    expect(element.currentTime).toBeCloseTo(1_000 / 1000 + 1_001 / 30_000, 8);
    await backend.step(-1);
    expect(element.currentTime).toBeCloseTo(1.0, 8);
  });

  it('设定播放范围后，范围外 seek 被明确拒绝（不静默夹断）', async () => {
    const element = new FakeElement();
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'u' });
    await backend.load(snapshot);
    await backend.setRange(range(2_000, 5_000));
    await backend.seek(mt(3_000));
    expect(element.currentTime).toBe(3);
    await expect(backend.seek(mt(6_000))).rejects.toMatchObject({ code: 'OUT_OF_RANGE' });
  });

  it('URL 失效 → 有限次刷新并**保持播放位置**；超过次数才失败（不无限重试）', async () => {
    const element = new FakeElement();
    let refreshCalls = 0;
    const backend = createMediaElementBackend({
      element,
      resolveSourceUrl: () => 'https://cdn/expired.mp4',
      refreshSourceUrl: () => { refreshCalls += 1; return `https://cdn/fresh-${String(refreshCalls)}.mp4`; },
    });
    await backend.load(snapshot);
    await backend.seek(mt(4_000));

    element.emit('error');            // 模拟签名过期/网络错误
    element.presentationLagSeconds = 0;
    await backend.play();             // 触发刷新 + 重试
    expect(refreshCalls).toBe(1);
    expect(element.src).toBe('https://cdn/fresh-1.mp4');
    expect(element.currentTime).toBe(4); // **位置未重置**（选区/播放位置不受刷新影响）

    element.emit('error');            // 第二次失败：已达上限 → 报告失败
    element.emit('error');
    await expect(backend.getPresented()).rejects.toMatchObject({ code: 'MEDIA_ERROR' });
    expect(refreshCalls).toBe(1);     // 没有第二次刷新
  });

  it('未加载就操作 → NOT_LOADED（不假装已加载）', async () => {
    const element = new FakeElement();
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'u' });
    await expect(backend.play()).rejects.toMatchObject({ code: 'NOT_LOADED' });
    await expect(backend.getPresented()).rejects.toMatchObject({ code: 'NOT_LOADED' });
  });

  it('元素播放失败 → 转成 MEDIA_ERROR（不吞掉）', async () => {
    const element = new FakeElement();
    element.play = vi.fn(() => Promise.reject(new Error('NotAllowedError: autoplay blocked')));
    const backend = createMediaElementBackend({ element, resolveSourceUrl: () => 'u' });
    await backend.load(snapshot);
    await expect(backend.play()).rejects.toMatchObject({ code: 'MEDIA_ERROR' });
  });
});
