import { describe, expect, it } from 'vitest';
import {
  PLAYBACK_SEGMENT_CACHE_LIMITS,
  applyUrlRefresh,
  createSegmentCacheState,
  findCachedSegment,
  planSegmentFetch,
  selectPlaybackSource,
  touchSegmentCache,
  urlsNeedingRefresh,
  type PlaybackSourceState,
} from './index.js';
import { legacyMillisecondsToMediaTime } from './common/media-time.js';

/**
 * N03-12：播放源选路的四条验收（无 WebCodecs/WebGPU 仍能看；精度不虚报；URL 刷新不重置选区；
 * 有界缓存与预取可区分冷/热）。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });

describe('N03-12 selectPlaybackSource：按实际能力选路 + 精度如实', () => {
  const weakEnv = { htmlMediaElement: true, mse: false, webCodecs: false, webGpu: false };

  it('无 WebCodecs/WebGPU，但 proxy 就绪 → 仍可播（HTMLMediaElement），精度如实降为关键帧级', () => {
    const plan = selectPlaybackSource({
      environment: weakEnv, proxyStatus: 'READY', profileKey: 'web-edit-video-720p-v1', requestedPrecision: 'FRAME_ACCURATE',
    });
    expect(plan.mode).toBe('HTML_MEDIA_ELEMENT');
    expect(plan.playable).toBe(true);
    expect(plan.precision).toBe('KEYFRAME_APPROXIMATE'); // 不虚报
    expect(plan.limitations).toContain('NOT_FRAME_ACCURATE');
    expect(plan.limitations).toContain('NO_WEB_CODECS');
    expect(plan.prerenderRequired).toBe(false);
  });

  it('要求帧级但达不到 → 明确不可播（不悄悄降级后照播）', () => {
    const plan = selectPlaybackSource({
      environment: weakEnv, proxyStatus: 'READY', profileKey: 'web-edit-video-720p-v1',
      requestedPrecision: 'FRAME_ACCURATE', requireFrameAccurate: true,
    });
    expect(plan.playable).toBe(false);
    expect(plan.precision).toBe('KEYFRAME_APPROXIMATE');
  });

  it('有 WebCodecs → 可给帧级；无 MSE 时按分段拉流不可用但直出仍可', () => {
    const plan = selectPlaybackSource({
      environment: { htmlMediaElement: true, mse: false, webCodecs: true, webGpu: false },
      proxyStatus: 'READY', profileKey: 'web-edit-video-720p-v1', requestedPrecision: 'FRAME_ACCURATE',
    });
    expect(plan.precision).toBe('FRAME_ACCURATE');
    expect(plan.limitations).not.toContain('NOT_FRAME_ACCURATE');
    expect(plan.limitations).toContain('NO_MSE');
  });

  it('proxy 未就绪/失败 → 不假装能播；连 HTMLMediaElement 都没有时退到局部预渲染', () => {
    const notReady = selectPlaybackSource({
      environment: weakEnv, proxyStatus: 'PROCESSING', profileKey: 'web-edit-video-720p-v1', requestedPrecision: 'KEYFRAME_APPROXIMATE',
    });
    expect(notReady.playable).toBe(false);
    expect(notReady.limitations).toContain('PROXY_NOT_READY');
    expect(notReady.mode).toBe('LOCAL_PRERENDER');

    const failed = selectPlaybackSource({
      environment: weakEnv, proxyStatus: 'FAILED', profileKey: 'web-edit-video-720p-v1', requestedPrecision: 'KEYFRAME_APPROXIMATE',
    });
    expect(failed.playable).toBe(false);
  });

  it('无需 proxy（NOT_REQUIRED）的原生素材可直接播', () => {
    const plan = selectPlaybackSource({
      environment: weakEnv, proxyStatus: 'NOT_REQUIRED', profileKey: null, requestedPrecision: 'KEYFRAME_APPROXIMATE',
    });
    expect(plan.playable).toBe(true);
    expect(plan.profileKey).toBeNull();
  });
});

describe('N03-12 签名 URL 刷新不得重置选区与时钟', () => {
  const base: PlaybackSourceState = {
    urls: [{ segmentId: 'seg_1', url: 'https://s/x?t=old', expiresAtMs: 1_000 }],
    clock: mt(4_000),
    selection: { ranges: [range(2_000, 6_000)] },
    generation: 3,
  };

  it('刷新只换 URL 并推进 generation；时钟与选区逐字段不变', () => {
    const refreshed = applyUrlRefresh(base, [{ segmentId: 'seg_1', url: 'https://s/x?t=new', expiresAtMs: 9_000 }]);
    expect(refreshed.urls[0]!.url).toBe('https://s/x?t=new');
    expect(refreshed.generation).toBe(4);
    expect(refreshed.clock).toEqual(base.clock);
    expect(refreshed.selection).toEqual(base.selection);
  });

  it('刷新只影响列出的分段；未列出的分段 URL 原样保留', () => {
    const two = { ...base, urls: [...base.urls, { segmentId: 'seg_2', url: 'https://s/y', expiresAtMs: null }] };
    const refreshed = applyUrlRefresh(two, [{ segmentId: 'seg_1', url: 'https://s/x?t=new', expiresAtMs: 9_000 }]);
    expect(refreshed.urls.find((entry) => entry.segmentId === 'seg_2')!.url).toBe('https://s/y');
  });

  it('只有临近过期的分段需要刷新（未过期的不动）', () => {
    const state: PlaybackSourceState = { ...base, urls: [
      { segmentId: 'a', url: 'u', expiresAtMs: 10_000 },
      { segmentId: 'b', url: 'u', expiresAtMs: 100_000 },
      { segmentId: 'c', url: 'u', expiresAtMs: null },
    ] };
    expect(urlsNeedingRefresh(state, 0, 30_000).map((entry) => entry.segmentId)).toEqual(['a']);
    expect(urlsNeedingRefresh(state, 95_000, 30_000).map((entry) => entry.segmentId)).toEqual(['a', 'b']);
  });
});

describe('N03-12 有界分段缓存与有限预取（可区分冷/热）', () => {
  const segments = [
    { segmentId: 's0', startMs: 0, endMs: 2_000 },
    { segmentId: 's1', startMs: 2_000, endMs: 4_000 },
    { segmentId: 's2', startMs: 4_000, endMs: 6_000 },
    { segmentId: 's3', startMs: 6_000, endMs: 8_000 },
    { segmentId: 's4', startMs: 8_000, endMs: 10_000 },
  ];

  it('冷缓存：取当前段 + 有界前向预取；热缓存：命中段不再请求', () => {
    const cold = planSegmentFetch({ segments, clockMs: 2_500, cache: createSegmentCacheState() });
    expect(cold.currentSegmentId).toBe('s1');
    expect(cold.cacheHit).toBe(false);
    expect(cold.toFetch).toEqual(['s1', 's2', 's3']); // 1 当前 + 2 预取（默认有界）

    const warm = planSegmentFetch({ segments, clockMs: 2_500, cache: touchSegmentCache(createSegmentCacheState(), { segmentId: 's1', bytes: 1024 }, 1) });
    expect(warm.cacheHit).toBe(true);
    expect(warm.toFetch).toEqual(['s2', 's3']);
  });

  it('预取窗口可调且为 0 时只取当前段（不无限预取）', () => {
    expect(planSegmentFetch({ segments, clockMs: 0, cache: createSegmentCacheState(), prefetchAheadEntries: 0 }).toFetch).toEqual(['s0']);
  });

  it('时钟落在区间之外 → 不取任何段（不乱猜）', () => {
    expect(planSegmentFetch({ segments, clockMs: 99_000, cache: createSegmentCacheState() })).toEqual({ toFetch: [], currentSegmentId: null, cacheHit: false });
  });

  it('缓存有界：条目数超限淘汰最久未用', () => {
    let cache = createSegmentCacheState();
    for (let index = 0; index < PLAYBACK_SEGMENT_CACHE_LIMITS.maxEntries + 3; index += 1) {
      cache = touchSegmentCache(cache, { segmentId: `seg_${String(index)}`, bytes: 10 }, index);
    }
    expect(cache.entries).toHaveLength(PLAYBACK_SEGMENT_CACHE_LIMITS.maxEntries);
    expect(findCachedSegment(cache, 'seg_0')).toBe(false);       // 最旧的被淘汰
    expect(findCachedSegment(cache, `seg_${String(PLAYBACK_SEGMENT_CACHE_LIMITS.maxEntries + 2)}`)).toBe(true);
  });

  it('缓存有界：字节超限同样淘汰最久未用', () => {
    const limits = { ...PLAYBACK_SEGMENT_CACHE_LIMITS, maxBytes: 1_000, maxEntries: 99 };
    let cache = createSegmentCacheState();
    cache = touchSegmentCache(cache, { segmentId: 'big_a', bytes: 800 }, 1, limits);
    cache = touchSegmentCache(cache, { segmentId: 'big_b', bytes: 800 }, 2, limits);
    expect(cache.entries.reduce((sum, entry) => sum + entry.bytes, 0)).toBeLessThanOrEqual(limits.maxBytes);
    expect(findCachedSegment(cache, 'big_a')).toBe(false);
  });
});
