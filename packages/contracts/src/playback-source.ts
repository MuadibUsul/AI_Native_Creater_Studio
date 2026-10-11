import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaTimeSchema, mediaTimeToApproxMilliseconds, type MediaTime } from './common/media-time.js';
import { PLAYBACK_PRECISIONS, type PlaybackBackendKind } from './playback.js';
import { MEDIA_PROXY_PLAYBACK_STATUSES, mediaProxyProfileKeySchema } from './media-proxy.js';

/**
 * N03-12：**播放源选路与韧性**（纯策略层；不含任何 DOM/媒体 API）。
 *
 * 纪律（方案 §13）：
 * - 按**实际可用能力**选路：HTMLMediaElement → MSE → 局部预渲染；**没有** WebCodecs/WebGPU 也必须能看并剪
 *   受支持的 proxy（这是验收硬要求，不是"降级安慰"）；
 * - **精度不许虚报**：拿不到帧级精度就如实报 `KEYFRAME_APPROXIMATE` 并给出 `limitations`，
 *   绝不在事件或能力表里声称 `FRAME_ACCURATE`；
 * - **签名 URL 过期刷新不得重置选区/时钟**：刷新只换 URL，不碰选择与播放位置；
 * - 分段缓存与预取**有界**：条目数/字节/预取窗口都封顶，冷/热命中可观测（供 N03-16 分别测首帧）。
 */

export const PLAYBACK_SOURCE_MODES = ['HTML_MEDIA_ELEMENT', 'MSE', 'LOCAL_PRERENDER'] as const;
export const playbackSourceModeSchema = z.enum(PLAYBACK_SOURCE_MODES);
export type PlaybackSourceMode = z.infer<typeof playbackSourceModeSchema>;

export const PLAYBACK_SOURCE_LIMITATIONS = [
  /** 该路径无法逐帧定位（seek 落在关键帧上） */
  'NOT_FRAME_ACCURATE',
  /** proxy 尚未就绪 → 只能用更高代价的局部预渲染，或先看原素材（若不支持则不可播） */
  'PROXY_NOT_READY',
  /** 浏览器不支持 MSE，无法按分段拉流 */
  'NO_MSE',
  /** 浏览器不支持 WebCodecs，无法本地解码到帧 */
  'NO_WEB_CODECS',
  /** 浏览器不支持 WebGPU，无法做实时合成 */
  'NO_WEB_GPU',
] as const;
export const playbackSourceLimitationSchema = z.enum(PLAYBACK_SOURCE_LIMITATIONS);
export type PlaybackSourceLimitation = z.infer<typeof playbackSourceLimitationSchema>;

/** 浏览器侧**实际探测到**的能力（由宿主探测后传入；不猜） */
export const playbackEnvironmentSchema = z.object({
  htmlMediaElement: z.boolean(),
  mse: z.boolean(),
  webCodecs: z.boolean(),
  webGpu: z.boolean(),
}).strict();
export type PlaybackEnvironment = z.infer<typeof playbackEnvironmentSchema>;

export const playbackSourcePlanSchema = z.object({
  mode: playbackSourceModeSchema,
  /** 后端标签（交给 N03-11 的 PlaybackBackendPort） */
  backendKind: z.enum(['HTML_MEDIA_BASELINE', 'SERVER_PRECOMPOSED']),
  profileKey: mediaProxyProfileKeySchema.nullable(),
  /** **如实**的精度：不得在拿不到帧级时声称 FRAME_ACCURATE */
  precision: z.enum(PLAYBACK_PRECISIONS),
  /** 是否可播（false 时 `limitations` 说明原因；不得"假装能播"） */
  playable: z.boolean(),
  limitations: z.array(playbackSourceLimitationSchema),
  /** 需要局部预渲染的区间（为空 = 全片直出） */
  prerenderRequired: z.boolean(),
}).strict();
export type PlaybackSourcePlan = z.infer<typeof playbackSourcePlanSchema>;

/**
 * 选路：proxy 就绪且浏览器有 HTMLMediaElement → 直接播（**不需要** WebCodecs/WebGPU）；
 * 需要按分段拉流时走 MSE；否则局部预渲染。精度只在确实具备帧级能力时才报 FRAME_ACCURATE。
 */
export function selectPlaybackSource(input: {
  environment: PlaybackEnvironment;
  proxyStatus: (typeof MEDIA_PROXY_PLAYBACK_STATUSES)[number];
  profileKey: string | null;
  /** 调用方**期望**的精度；实际精度取二者更弱的一个 */
  requestedPrecision: (typeof PLAYBACK_PRECISIONS)[number];
  /** 是否要求帧级（例如逐帧门）；true 时若达不到则不可播而不是"悄悄降级" */
  requireFrameAccurate?: boolean;
}): PlaybackSourcePlan {
  const env = playbackEnvironmentSchema.parse(input.environment);
  const limitations: PlaybackSourceLimitation[] = [];
  if (!env.mse) limitations.push('NO_MSE');
  if (!env.webCodecs) limitations.push('NO_WEB_CODECS');
  if (!env.webGpu) limitations.push('NO_WEB_GPU');

  const profileKey = mediaProxyProfileKeySchema.safeParse(input.profileKey);
  const proxyReady = input.proxyStatus === 'READY';
  const proxyNotRequired = input.proxyStatus === 'NOT_REQUIRED';
  if (!proxyReady && !proxyNotRequired) limitations.push('PROXY_NOT_READY');

  // 帧级精度只有"有 WebCodecs（本地解码到帧）"才算数；否则最高只能给 KEYFRAME_APPROXIMATE。
  const frameAccurateCapable = env.webCodecs;
  const precision = !frameAccurateCapable
    ? 'KEYFRAME_APPROXIMATE'
    : input.requestedPrecision;

  // 无 WebCodecs/WebGPU 仍可播受支持 proxy（HTMLMediaElement）；只有连它也拿不到时才预渲染。
  let mode: PlaybackSourceMode;
  let backendKind: PlaybackBackendKind;
  if (proxyReady && env.htmlMediaElement) {
    mode = 'HTML_MEDIA_ELEMENT';
    backendKind = 'HTML_MEDIA_BASELINE';
  } else if (env.mse && proxyReady) {
    mode = 'MSE';
    backendKind = 'HTML_MEDIA_BASELINE';
  } else {
    mode = 'LOCAL_PRERENDER';
    backendKind = 'SERVER_PRECOMPOSED';
  }

  if (precision !== 'FRAME_ACCURATE') limitations.push('NOT_FRAME_ACCURATE');
  const playable = (proxyReady || proxyNotRequired) && input.proxyStatus !== 'FAILED' && input.proxyStatus !== 'MISSING';

  return playbackSourcePlanSchema.parse({
    mode,
    backendKind,
    profileKey: profileKey.success ? profileKey.data : null,
    precision,
    // 要求帧级但达不到 → 明确不可播（把限制交给上层提示），不"悄悄降级后照播"
    playable: playable && (!(input.requireFrameAccurate ?? false) || precision === 'FRAME_ACCURATE'),
    limitations: [...new Set(limitations)],
    prerenderRequired: mode === 'LOCAL_PRERENDER',
  });
}

// ── 签名 URL 刷新：只换 URL，不碰选区与时钟 ────────────────────────

export const playbackSourceUrlSchema = z.object({
  segmentId: opaqueIdSchema,
  url: z.string().min(1).max(2048),
  /** 过期时刻（毫秒时间戳；null = 不过期） */
  expiresAtMs: z.number().int().nullable(),
}).strict();
export type PlaybackSourceUrl = z.infer<typeof playbackSourceUrlSchema>;

export const playbackSourceStateSchema = z.object({
  urls: z.array(playbackSourceUrlSchema),
  /** 播放时钟与选择**不属于** URL；刷新绝不允许改动它们 */
  clock: mediaTimeSchema.nullable(),
  selection: z.object({ ranges: z.array(z.object({ start: mediaTimeSchema, end: mediaTimeSchema }).strict()) }).strict().nullable(),
  generation: z.number().int().min(0),
}).strict();
export type PlaybackSourceState = z.infer<typeof playbackSourceStateSchema>;

/** 刷新签名 URL（过期/临近过期时调用）：**只**替换 URL 并推进 generation，选区与时钟原样保留。 */
export function applyUrlRefresh(state: PlaybackSourceState, refreshed: readonly PlaybackSourceUrl[]): PlaybackSourceState {
  const current = playbackSourceStateSchema.parse(state);
  const byId = new Map(current.urls.map((entry) => [entry.segmentId, entry]));
  for (const entry of refreshed) {
    byId.set(entry.segmentId, playbackSourceUrlSchema.parse(entry));
  }
  return playbackSourceStateSchema.parse({
    urls: [...byId.values()],
    clock: current.clock,          // 不变
    selection: current.selection,  // 不变（验收：过期 URL 刷新不重置选区）
    generation: current.generation + 1,
  });
}

/** 找出需要刷新的 URL（已过期或将在 `withinMs` 内过期）。 */
export function urlsNeedingRefresh(state: PlaybackSourceState, nowMs: number, withinMs = 30_000): PlaybackSourceUrl[] {
  return state.urls.filter((entry) => entry.expiresAtMs !== null && entry.expiresAtMs - nowMs <= withinMs);
}

// ── 分段缓存与有限预取（有界） ──────────────────────────────────

export interface PlaybackSegmentCacheLimits {
  maxEntries: number;
  maxBytes: number;
  prefetchAheadEntries: number;
}
export const PLAYBACK_SEGMENT_CACHE_LIMITS: PlaybackSegmentCacheLimits = {
  maxEntries: 12,
  maxBytes: 192 * 1024 * 1024,
  prefetchAheadEntries: 2,
};

export const segmentCacheStateSchema = z.object({
  entries: z.array(z.object({
    segmentId: opaqueIdSchema,
    bytes: z.number().int().nonnegative(),
    lastUsedAtMs: z.number().int(),
  }).strict()),
}).strict();
export type SegmentCacheState = z.infer<typeof segmentCacheStateSchema>;

export const createSegmentCacheState = (): SegmentCacheState => ({ entries: [] });

/** 写入/命中一个分段（LRU 更新），并按**条目数与字节**双上限淘汰最久未用者。 */
export function touchSegmentCache(
  state: SegmentCacheState,
  segment: { segmentId: string; bytes: number },
  nowMs: number,
  limits: PlaybackSegmentCacheLimits = PLAYBACK_SEGMENT_CACHE_LIMITS,
): SegmentCacheState {
  const current = segmentCacheStateSchema.parse(state);
  const others = current.entries.filter((entry) => entry.segmentId !== segment.segmentId);
  const entries = [...others, { segmentId: segment.segmentId, bytes: Math.max(0, segment.bytes), lastUsedAtMs: nowMs }];
  // 先按条目数淘汰，再按字节淘汰（都从最久未用开始）
  const byLru = (left: { lastUsedAtMs: number }, right: { lastUsedAtMs: number }): number => left.lastUsedAtMs - right.lastUsedAtMs;
  entries.sort(byLru);
  while (entries.length > limits.maxEntries) entries.shift();
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  while (total > limits.maxBytes && entries.length > 1) {
    total -= entries[0]!.bytes;
    entries.shift();
  }
  return segmentCacheStateSchema.parse({ entries });
}

/** 命中的分段（含当前时钟所在分段；用于区分冷/热缓存的"首帧"测量）。 */
export function findCachedSegment(state: SegmentCacheState, segmentId: string): boolean {
  return segmentCacheStateSchema.parse(state).entries.some((entry) => entry.segmentId === segmentId);
}

/**
 * 计划要取的片段：当前时钟所在段 + **有界**的前向预取窗口。
 * 返回顺序即建议的取用顺序（当前段优先），不返回已缓存的段。
 */
export function planSegmentFetch(input: {
  segments: readonly { segmentId: string; startMs: number; endMs: number }[];
  clockMs: number;
  cache: SegmentCacheState;
  prefetchAheadEntries?: number;
}): { toFetch: string[]; currentSegmentId: string | null; cacheHit: boolean } {
  const ahead = Math.max(0, input.prefetchAheadEntries ?? PLAYBACK_SEGMENT_CACHE_LIMITS.prefetchAheadEntries);
  const sorted = [...input.segments].sort((left, right) => left.startMs - right.startMs);
  const index = sorted.findIndex((entry) => input.clockMs >= entry.startMs && input.clockMs < entry.endMs);
  if (index === -1) return { toFetch: [], currentSegmentId: null, cacheHit: false };
  const window = sorted.slice(index, index + 1 + ahead);
  const currentSegmentId = sorted[index]!.segmentId;
  return {
    toFetch: window.filter((entry) => !findCachedSegment(input.cache, entry.segmentId)).map((entry) => entry.segmentId),
    currentSegmentId,
    cacheHit: findCachedSegment(input.cache, currentSegmentId),
  };
}

/** 便于宿主构造：从 MediaTime 取毫秒近似值（不引入浮点权威）。实现见唯一时间库 `@ancs/time`。 */
export const mediaTimeToMs = (time: MediaTime): number => mediaTimeToApproxMilliseconds(time);
