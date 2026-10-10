'use client';

import { useCallback, useMemo, useReducer, useState } from 'react';
import {
  MEDIA_CLOCK_SYNC,
  applyPlaybackResult,
  createMediaClock,
  createPlaybackEngineState,
  decideMediaClockSync,
  dispatchPlayback,
  getPlaybackCapabilities,
  negotiatePlaybackCapabilities,
  mediaTimeToMs,
  resolveMediaClockPlan,
  runPlaybackEffect,
  sequenceTimeAt,
  type AudioPlaybackPermission,
  type MediaClockState,
  type MediaTime,
  type PlaybackBackendPort,
  type PlaybackEngineState,
  type PlaybackSnapshot,
} from '@ancs/contracts';
import ui from '../ui/Monochrome.module.css';

/**
 * N03-12／N03-13 浏览器接线面：把 PlaybackEngine（权威状态机）＋ 后端端口（真实 `<video>`）＋
 * 统一媒体时钟 串成一条链，并把**必须外露**的状态显示给用户。
 *
 * - 事件里的 presented 时间只来自后端；这里把 **请求 vs 实际** 的差值显示出来（同步可见）；
 * - 音频未授权 / 无音轨 → 显示 `notice`，不静默无声；
 * - 组件本身不写工程、不改选择：只驱动播放。
 */

const MINUS_ONE_SECOND_MS = -1_000;

type Action =
  | { kind: 'state'; next: PlaybackEngineState }
  | { kind: 'clock'; next: MediaClockState };

interface ReducerState { engine: PlaybackEngineState; clock: MediaClockState }

export interface PlaybackSurfaceProps {
  snapshot: PlaybackSnapshot;
  backend: PlaybackBackendPort;
  hasAudioTrack?: boolean;
  audioPermission?: AudioPlaybackPermission;
  /** 可注入（测试用）；默认用 performance.now 作为音频时钟 */
  readAudioMs?: () => number;
}

export function PlaybackSurface({ snapshot, backend, hasAudioTrack = true, audioPermission = 'GRANTED', readAudioMs }: PlaybackSurfaceProps) {
  const clockPlan = useMemo(() => resolveMediaClockPlan({ hasAudioTrack, audioPermission }), [hasAudioTrack, audioPermission]);
  const [engine, dispatch] = useReducer(
    (state: ReducerState, action: Action): ReducerState =>
      action.kind === 'state' ? { ...state, engine: action.next } : { ...state, clock: action.next },
    {
      engine: createPlaybackEngineState(),
      clock: createMediaClock({
        hasAudioTrack: hasAudioTrack && clockPlan.source === 'AUDIO_CONTEXT',
        permission: audioPermission,
        audioMs: 0,
        sequenceMs: 0,
      }),
    },
  );
  const [lastPresented, setLastPresented] = useState<MediaTime | null>(null);
  const now = readAudioMs ?? ((): number => (typeof performance === 'undefined' ? 0 : performance.now()));

  /** 派发命令 → 执行效果 → 回灌结果（引擎的"实际呈现"只能从回灌进来）。 */
  const run = useCallback(async (command: Parameters<typeof dispatchPlayback>[1]) => {
    const result = dispatchPlayback(engine.engine, command);
    dispatch({ kind: 'state', next: result.state });
    for (const event of result.events) {
      if (event.kind === 'DISPOSED') dispatch({ kind: 'clock', next: { ...engine.clock, suspended: true } });
    }
    for (const effect of result.effects) {
      const outcome = await runPlaybackEffect(backend, effect);
      const applied = applyPlaybackResult(result.state, outcome);
      dispatch({ kind: 'state', next: applied.state });
      for (const event of applied.events) {
        if (event.kind === 'PLAYBACK' && event.presentedTime !== null) setLastPresented(event.presentedTime);
      }
    }
  }, [backend, engine.engine, engine.clock]);

  const [loaded, setLoaded] = useState(false);
  const load = async (): Promise<void> => {
    await run({ kind: 'loadDocument', requestId: `load_${String(Date.now())}`, snapshot, backendKind: backend.kind });
    setLoaded(true);
  };

  const sequenceMs = sequenceTimeAt(engine.clock.suspended ? { ...engine.clock, suspended: true } : engine.clock, now());
  const syncDecision = lastPresented === null
    ? null
    : decideMediaClockSync({ masterSequenceMs: sequenceMs, followerSequenceMs: mediaTimeToMs(lastPresented) });
  // 能力来自同一份快照；加载前也可展示（来源一致，不是第二份状态）
  const capabilities = getPlaybackCapabilities(engine.engine) ?? negotiatePlaybackCapabilities(snapshot.capabilities);

  return (
    <div data-testid="playback-surface" className={`flex flex-col gap-2 p-2 text-xs ${ui['panel']}`}>
      <div className="flex items-center justify-between">
        <span className={ui['primaryText']}>播放</span>
        <span data-testid="playback-status" className={ui['mutedText']}>{engine.engine.status}</span>
      </div>

      {clockPlan.notice !== 'NONE' ? (
        <div data-testid="playback-notice" className={ui['mutedText']}>
          {clockPlan.notice === 'AUDIO_PERMISSION_REQUIRED'
            ? '需要允许播放音频才能听到声音；当前仅静音播放画面。'
            : clockPlan.notice === 'NO_AUDIO_TRACK'
              ? '本片段没有音轨（使用虚拟时钟）。'
              : '音频上下文已挂起。'}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" data-testid="playback-load" onClick={() => { void load(); }} className={`px-2 ${ui['button']}`} disabled={loaded}>加载</button>
        <button type="button" data-testid="playback-play" onClick={() => { void run({ kind: 'play', requestId: `play_${String(Date.now())}` }); }} className={`px-2 ${ui['button']}`}>播放</button>
        <button type="button" data-testid="playback-pause" onClick={() => { void run({ kind: 'pause', requestId: `pause_${String(Date.now())}` }); }} className={`px-2 ${ui['button']}`}>暂停</button>
        <button type="button" data-testid="playback-step-prev" onClick={() => { void run({ kind: 'step', requestId: `step_${String(Date.now())}`, frames: -1 }); }} className={`px-2 ${ui['button']}`}>◀|</button>
        <button type="button" data-testid="playback-step-next" onClick={() => { void run({ kind: 'step', requestId: `step_${String(Date.now())}`, frames: 1 }); }} className={`px-2 ${ui['button']}`}>|▶</button>
        <button type="button" data-testid="playback-back-1s" onClick={() => { void run({ kind: 'seek', requestId: `seek_${String(Date.now())}`, time: { ticks: String(Math.max(0, sequenceMs + MINUS_ONE_SECOND_MS)), timebase: { num: 1, den: 1000 } } }); }} className={`px-2 ${ui['button']}`}>−1s</button>
      </div>

      <div className={ui['mutedText']}>
        <span data-testid="playback-sequence-ms">{Math.round(sequenceMs)}</span>
        {' / 实际呈现 '}
        <span data-testid="playback-presented-ms">{lastPresented === null ? '—' : String(Math.round(mediaTimeToMs(lastPresented)))}</span>
        {syncDecision !== null && syncDecision.action !== 'NONE' ? (
          <span data-testid="playback-sync-action">（同步修正：{syncDecision.action}，漂移 {Math.round(syncDecision.driftMs)}ms）</span>
        ) : null}
      </div>

      <div data-testid="playback-capabilities" className={ui['mutedText']}>
        支持的能力：{capabilities === null || capabilities.supported.length === 0 ? '（无）' : capabilities.supported.join('、')}
        {`（容差 ±${String(MEDIA_CLOCK_SYNC.toleranceMs)}ms）`}
      </div>
    </div>
  );
}
