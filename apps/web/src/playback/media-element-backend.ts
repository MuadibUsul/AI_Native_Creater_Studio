import {
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  type MediaRange,
  type MediaTime,
  type PlaybackBackendPort,
  type PlaybackSnapshot,
} from '@ancs/contracts';

/**
 * N03-12 浏览器侧适配器：把 N03-11 的 `PlaybackBackendPort` 接到真实 `<video>`/`<audio>` 上。
 *
 * 纪律：
 * - 只依赖**窄接口** `MediaElementLike`（不是 `HTMLMediaElement` 全量），因此可在 jsdom 用替身验证，
 *   真机只需把元素传进来；
 * - **presented 时间只来自元素的 `currentTime`**——绝不回填请求值（否则 N03-16 的同步测量失去意义）；
 * - 签名 URL 过期（403/网络错误）→ **有限次数**刷新 URL 并重试一次，仍失败才上报失败（不无限重试）；
 * - `dispose` 幂等：暂停 + 清空 src + 摘监听，重复调用无副作用。
 */

export interface MediaElementLike {
  currentTime: number;
  readonly duration: number;
  paused: boolean;
  playbackRate: number;
  src: string;
  muted: boolean;
  volume: number;
  load(): void;
  play(): Promise<void>;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface MediaElementBackendOptions {
  element: MediaElementLike;
  /** 由快照/分段解析出可播放 URL（通常带签名；过期由 `refreshSourceUrl` 换新） */
  resolveSourceUrl: (snapshot: PlaybackSnapshot) => string;
  /** 可选：URL 失效时换一个新签名 URL（返回 null 表示无法刷新） */
  refreshSourceUrl?: (snapshot: PlaybackSnapshot) => string | null;
  /** 最多刷新重试次数（默认 1；**不无限重试**） */
  maxUrlRefreshAttempts?: number;
}

export class PlaybackBackendError extends Error {
  constructor(readonly code: 'NOT_LOADED' | 'MEDIA_ERROR' | 'OUT_OF_RANGE' | 'DISPOSED', message: string) {
    super(message);
    this.name = 'PlaybackBackendError';
  }
}

export function createMediaElementBackend(options: MediaElementBackendOptions): PlaybackBackendPort {
  const { element } = options;
  const maxRefresh = options.maxUrlRefreshAttempts ?? 1;
  let snapshot: PlaybackSnapshot | null = null;
  let range: MediaRange | null = null;
  let disposed = false;
  let refreshUsed = 0;
  let lastError: string | null = null;

  const secondsOf = (time: MediaTime): number => mediaTimeToLegacyMilliseconds(time) / 1000;
  const frameRateOf = (): { num: number; den: number } => snapshot?.frameRate ?? { num: 30, den: 1 };

  const onError = (): void => {
    lastError = 'media element reported an error';
  };
  element.addEventListener('error', onError);

  /** 尝试一次"刷新 URL 并回到当前时间"；返回是否恢复成功。 */
  const tryRefreshAndRestore = (atSeconds: number): boolean => {
    if (snapshot === null || options.refreshSourceUrl === undefined || refreshUsed >= maxRefresh) return false;
    const fresh = options.refreshSourceUrl(snapshot);
    if (fresh === null) return false;
    refreshUsed += 1;
    element.src = fresh;
    element.load();
    element.currentTime = atSeconds; // **恢复位置**：刷新 URL 不改变播放位置
    lastError = null;
    return true;
  };

  const assertUsable = (): void => {
    if (disposed) throw new PlaybackBackendError('DISPOSED', '播放后端已释放');
    if (snapshot === null) throw new PlaybackBackendError('NOT_LOADED', '尚未加载播放源');
  };

  const seekSeconds = (seconds: number): void => {
    if (range !== null) {
      const start = secondsOf(range.start);
      const end = secondsOf(range.end);
      if (seconds < start || seconds > end) {
        throw new PlaybackBackendError('OUT_OF_RANGE', `目标 ${String(seconds)}s 超出播放范围`);
      }
    }
    element.currentTime = seconds;
  };

  return {
    kind: 'HTML_MEDIA_BASELINE',
    async load(next: PlaybackSnapshot): Promise<void> {
      if (disposed) throw new PlaybackBackendError('DISPOSED', '播放后端已释放');
      snapshot = next;
      refreshUsed = 0;
      lastError = null;
      element.src = options.resolveSourceUrl(next);
      element.load();
      if (lastError !== null && !tryRefreshAndRestore(0)) {
        throw new PlaybackBackendError('MEDIA_ERROR', lastError);
      }
    },
    async play(): Promise<void> {
      assertUsable();
      try {
        await element.play();
        if (lastError !== null && !tryRefreshAndRestore(element.currentTime)) {
          throw new PlaybackBackendError('MEDIA_ERROR', lastError);
        }
      } catch (error) {
        if (error instanceof PlaybackBackendError) throw error;
        throw new PlaybackBackendError('MEDIA_ERROR', error instanceof Error ? error.message : 'play failed');
      }
    },
    async pause(): Promise<void> {
      assertUsable();
      element.pause();
    },
    async seek(time: MediaTime): Promise<void> {
      assertUsable();
      seekSeconds(secondsOf(time));
    },
    async step(frames: number): Promise<void> {
      assertUsable();
      const rate = frameRateOf();
      seekSeconds(element.currentTime + (frames * rate.den) / rate.num);
    },
    async setRange(next: MediaRange | null): Promise<void> {
      assertUsable();
      range = next;
    },
    async getPresented(): Promise<{ presentedTime: MediaTime; presentedFrame: string | null }> {
      assertUsable();
      if (lastError !== null) throw new PlaybackBackendError('MEDIA_ERROR', lastError);
      const rate = frameRateOf();
      const shown = element.currentTime;
      return {
        presentedTime: legacyMillisecondsToMediaTime(Math.round(shown * 1000)),
        // 帧号由**实际呈现秒数**推出（不是由请求推出）
        presentedFrame: String(Math.floor((shown * rate.num) / rate.den)),
      };
    },
    async dispose(): Promise<void> {
      if (disposed) return; // 幂等
      disposed = true;
      element.removeEventListener('error', onError);
      element.pause();
      element.src = '';
      snapshot = null;
      range = null;
    },
  };
}
