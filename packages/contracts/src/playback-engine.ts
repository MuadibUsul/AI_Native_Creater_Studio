import { z } from 'zod';
import { compareMediaTime, mediaRangeSchema, mediaTimeSchema, type MediaRange, type MediaTime } from './common/media-time.js';
import {
  PLAYBACK_CAPABILITY_FLAGS,
  playbackBackendKindSchema,
  playbackSnapshotSchema,
  type PlaybackBackendKind,
  type PlaybackCapabilityFlag,
  type PlaybackCapabilities,
  type PlaybackSnapshot,
} from './playback.js';

/**
 * N03-11：PlaybackEngine —— 播放的**权威状态机**与后端端口（不含任何 DOM/媒体 API）。
 *
 * 纪律（方案 §1.4、§13）：
 * - 引擎只持有**同一 revision 的工程投影**（`PlaybackSnapshot`），**不维护第二套编辑状态**；
 * - 切换后端**不改变工程**：只改 `backendKind`，投影与 `documentRevision` 原样保留；
 * - 事件必须带 `requestId` + `documentRevision` + **后端如实回报的 presented 时间**——
 *   **不得**把"请求的时间"当成"实际呈现的时间"上报（这是播放同步验收的根）；
 * - **未声明的能力一律视为不支持**（`negotiatePlaybackCapabilities`），未知字符串直接丢弃；
 * - `dispose` **幂等**：重复调用不再产生任何效果与事件；
 * - 纯函数 + 显式效果列表：宿主（Web 播放器）执行 `effects` 并回灌 `applyPlaybackResult`，
 *   因此整条状态机可在**无浏览器**下验证。
 */

export const PLAYBACK_ENGINE_STATES = ['IDLE', 'LOADING', 'READY', 'PLAYING', 'PAUSED', 'DISPOSED'] as const;
export const playbackEngineStatusSchema = z.enum(PLAYBACK_ENGINE_STATES);
export type PlaybackEngineStatus = z.infer<typeof playbackEngineStatusSchema>;

export const PLAYBACK_ENGINE_ERROR_REASONS = {
  NOT_LOADED: 'PLAYBACK_ENGINE_NOT_LOADED',
  BUSY: 'PLAYBACK_ENGINE_BUSY',
  DISPOSED: 'PLAYBACK_ENGINE_DISPOSED',
  ALREADY_PLAYING: 'PLAYBACK_ENGINE_ALREADY_PLAYING',
  INVALID_COMMAND: 'PLAYBACK_ENGINE_INVALID_COMMAND',
  BACKEND_FAILED: 'PLAYBACK_ENGINE_BACKEND_FAILED',
} as const;
export const playbackEngineErrorReasonSchema = z.enum([
  PLAYBACK_ENGINE_ERROR_REASONS.NOT_LOADED,
  PLAYBACK_ENGINE_ERROR_REASONS.BUSY,
  PLAYBACK_ENGINE_ERROR_REASONS.DISPOSED,
  PLAYBACK_ENGINE_ERROR_REASONS.ALREADY_PLAYING,
  PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND,
  PLAYBACK_ENGINE_ERROR_REASONS.BACKEND_FAILED,
]);
export type PlaybackEngineErrorReason = z.infer<typeof playbackEngineErrorReasonSchema>;

/** 只保留**显式声明支持**且未被声明为不支持的能力；未知值丢弃（fail-closed）。 */
export function negotiatePlaybackCapabilities(declared: PlaybackCapabilities): PlaybackCapabilities {
  const unsupported = new Set<PlaybackCapabilityFlag>(declared.unsupported);
  const supported = PLAYBACK_CAPABILITY_FLAGS.filter(
    (flag) => declared.supported.includes(flag) && !unsupported.has(flag),
  );
  return {
    backend: declared.backend,
    videoPrecision: declared.videoPrecision,
    audioPrecision: declared.audioPrecision,
    supported,
    // 未声明的能力同样列为不支持（显式，不沉默）
    unsupported: PLAYBACK_CAPABILITY_FLAGS.filter((flag) => !supported.includes(flag)),
  };
}

export const isCapabilitySupported = (capabilities: PlaybackCapabilities, flag: PlaybackCapabilityFlag): boolean =>
  negotiatePlaybackCapabilities(capabilities).supported.includes(flag);

export const playbackEngineStateSchema = z.object({
  status: playbackEngineStatusSchema,
  /** 与工程文档同一 revision 的投影；未加载时为 null（**不是**第二套编辑状态） */
  snapshot: playbackSnapshotSchema.nullable(),
  backendKind: playbackBackendKindSchema.nullable(),
  /** 播放时钟（序列时间；presented 时间只在事件里由后端如实回报） */
  clock: mediaTimeSchema.nullable(),
  /** setRange 设定的播放范围（null = 全片） */
  range: mediaRangeSchema.nullable(),
  lastRequestId: z.string().min(1).nullable(),
  /** 最近一次错误（成功命令会清空） */
  error: z.object({ reason: playbackEngineErrorReasonSchema, message: z.string().max(300) }).strict().nullable(),
}).strict();
export type PlaybackEngineState = z.infer<typeof playbackEngineStateSchema>;

export const createPlaybackEngineState = (): PlaybackEngineState => ({
  status: 'IDLE', snapshot: null, backendKind: null, clock: null, range: null, lastRequestId: null, error: null,
});

// ── 命令（宿主 → 引擎） ────────────────────────────────────────

export const PLAYBACK_COMMAND_KINDS = ['loadDocument', 'play', 'pause', 'seek', 'step', 'setRange', 'dispose'] as const;
export const playbackCommandSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('loadDocument'),
    requestId: z.string().min(1),
    snapshot: playbackSnapshotSchema,
    backendKind: playbackBackendKindSchema,
  }).strict(),
  z.object({ kind: z.literal('play'), requestId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('pause'), requestId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('seek'), requestId: z.string().min(1), time: mediaTimeSchema }).strict(),
  z.object({ kind: z.literal('step'), requestId: z.string().min(1), frames: z.number().int() }).strict(),
  z.object({ kind: z.literal('setRange'), requestId: z.string().min(1), range: mediaRangeSchema.nullable() }).strict(),
  z.object({ kind: z.literal('dispose'), requestId: z.string().min(1) }).strict(),
]);
export type PlaybackCommand = z.infer<typeof playbackCommandSchema>;

/** 引擎交给宿主后端执行的**效果**（宿主执行后必须回灌 `applyPlaybackResult`）。 */
export const playbackEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('LOAD'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative(), snapshot: playbackSnapshotSchema }).strict(),
  z.object({ kind: z.literal('PLAY'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('PAUSE'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal('SEEK'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative(), time: mediaTimeSchema }).strict(),
  z.object({ kind: z.literal('STEP'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative(), frames: z.number().int() }).strict(),
  z.object({ kind: z.literal('SET_RANGE'), requestId: z.string().min(1), documentRevision: z.number().int().nonnegative(), range: mediaRangeSchema.nullable() }).strict(),
  z.object({ kind: z.literal('DISPOSE'), requestId: z.string().min(1) }).strict(),
]);
export type PlaybackEffect = z.infer<typeof playbackEffectSchema>;

// ── 事件（引擎 → 宿主） ───────────────────────────────────────

export const playbackEngineEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LOADED'),
    requestId: z.string().min(1),
    documentRevision: z.number().int().nonnegative(),
    backendKind: playbackBackendKindSchema,
    capabilities: z.object({ supported: z.array(z.string()), unsupported: z.array(z.string()) }).strict(),
  }).strict(),
  z.object({
    kind: z.literal('PLAYBACK'),
    action: z.enum(['PLAY', 'PAUSE', 'SEEK', 'STEP', 'RANGE']),
    requestId: z.string().min(1),
    documentRevision: z.number().int().nonnegative(),
    /** 请求的目标时间（可能为 null：播放/暂停无目标） */
    requestedTime: mediaTimeSchema.nullable(),
    /** **后端如实回报**的实际呈现时间（未回报时为 null，不得用请求值顶替） */
    presentedTime: mediaTimeSchema.nullable(),
    /** 实际呈现帧号（后端能报时给出） */
    presentedFrame: z.string().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('DISPOSED'),
    requestId: z.string().min(1),
    documentRevision: z.number().int().nonnegative().nullable(),
  }).strict(),
  z.object({
    kind: z.literal('ERROR'),
    requestId: z.string().min(1),
    reason: playbackEngineErrorReasonSchema,
    message: z.string().max(300),
  }).strict(),
]);
export type PlaybackEngineEvent = z.infer<typeof playbackEngineEventSchema>;

/** 宿主执行效果后的回灌结果。 */
export const playbackResultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('LOADED'), requestId: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal('PRESENTED'), requestId: z.string().min(1),
    /** 后端实际呈现的时间（必填：这是"真实呈现"的唯一来源） */
    presentedTime: mediaTimeSchema,
    presentedFrame: z.string().nullable().default(null),
  }).strict(),
  z.object({
    kind: z.literal('FAILED'), requestId: z.string().min(1), message: z.string().max(300),
  }).strict(),
]);
export type PlaybackResult = z.infer<typeof playbackResultSchema>;

const error = (state: PlaybackEngineState, command: PlaybackCommand, reason: PlaybackEngineErrorReason, message: string) => ({
  state: playbackEngineStateSchema.parse({ ...state, error: { reason, message } }),
  effects: [] as PlaybackEffect[],
  events: [playbackEngineEventSchema.parse({ kind: 'ERROR', requestId: command.requestId, reason, message })] as PlaybackEngineEvent[],
});

const revisionOf = (state: PlaybackEngineState): number => state.snapshot?.documentRevision ?? 0;

/** 派发一条命令（纯函数）：返回新状态、要执行的**效果**、以及即时事件。 */
export function dispatchPlayback(state: PlaybackEngineState, command: PlaybackCommand): {
  state: PlaybackEngineState; effects: PlaybackEffect[]; events: PlaybackEngineEvent[];
} {
  const parsed = playbackCommandSchema.parse(command);
  const current = playbackEngineStateSchema.parse(state);
  if (current.status === 'DISPOSED') {
    // dispose 幂等：重复 dispose 不再产生任何效果/事件
    if (parsed.kind === 'dispose') return { state: current, effects: [], events: [] };
    return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.DISPOSED, '引擎已释放');
  }
  if (parsed.kind === 'dispose') {
    return {
      state: { ...current, status: 'DISPOSED', clock: null, range: null, lastRequestId: parsed.requestId, error: null },
      effects: [{ kind: 'DISPOSE', requestId: parsed.requestId }],
      events: [playbackEngineEventSchema.parse({ kind: 'DISPOSED', requestId: parsed.requestId, documentRevision: current.snapshot?.documentRevision ?? null })],
    };
  }
  if (parsed.kind === 'loadDocument') {
    if (current.status === 'LOADING') return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.BUSY, '正在加载');
    // 切换后端只改 backendKind：投影与 revision 原样保留（不改工程）
    return {
      state: {
        ...current,
        status: 'LOADING',
        snapshot: parsed.snapshot,
        backendKind: parsed.backendKind,
        clock: parsed.snapshot.duration === undefined ? null : null,
        range: current.range,
        lastRequestId: parsed.requestId,
        error: null,
      },
      effects: [{ kind: 'LOAD', requestId: parsed.requestId, documentRevision: parsed.snapshot.documentRevision, snapshot: parsed.snapshot }],
      events: [],
    };
  }
  if (current.status === 'IDLE' || current.snapshot === null) {
    return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.NOT_LOADED, '尚未加载工程投影');
  }
  const revision = revisionOf(current);
  switch (parsed.kind) {
    case 'play': {
      if (current.status === 'PLAYING') return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.ALREADY_PLAYING, '已在播放');
      return {
        state: { ...current, status: 'PLAYING', lastRequestId: parsed.requestId, error: null },
        effects: [{ kind: 'PLAY', requestId: parsed.requestId, documentRevision: revision }],
        events: [],
      };
    }
    case 'pause': {
      return {
        state: { ...current, status: 'PAUSED', lastRequestId: parsed.requestId, error: null },
        effects: [{ kind: 'PAUSE', requestId: parsed.requestId, documentRevision: revision }],
        events: [],
      };
    }
    case 'seek': {
      const withinRange = current.range === null
        || (compareMediaTime(parsed.time, current.range.start) >= 0 && compareMediaTime(parsed.time, current.range.end) <= 0);
      if (!withinRange) {
        return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND, 'seek 目标在设定的播放范围之外');
      }
      return {
        state: { ...current, clock: parsed.time, lastRequestId: parsed.requestId, error: null },
        effects: [{ kind: 'SEEK', requestId: parsed.requestId, documentRevision: revision, time: parsed.time }],
        events: [],
      };
    }
    case 'step': {
      if (parsed.frames === 0) return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND, 'step 帧数为 0');
      return {
        state: { ...current, lastRequestId: parsed.requestId, error: null },
        effects: [{ kind: 'STEP', requestId: parsed.requestId, documentRevision: revision, frames: parsed.frames }],
        events: [],
      };
    }
    case 'setRange': {
      // 空范围在契约层已被 mediaRangeSchema 拒（fail-closed）；此处保留守卫以覆盖未来放宽 schema 的情况。
      if (parsed.range !== null && compareMediaTime(parsed.range.start, parsed.range.end) >= 0) {
        return error(current, parsed, PLAYBACK_ENGINE_ERROR_REASONS.INVALID_COMMAND, '播放范围必须非空');
      }
      return {
        state: { ...current, range: parsed.range, lastRequestId: parsed.requestId, error: null },
        effects: [{ kind: 'SET_RANGE', requestId: parsed.requestId, documentRevision: revision, range: parsed.range }],
        events: [],
      };
    }
  }
}

/** 回灌后端执行结果（纯函数）：只有这里才能产生"实际呈现时间"。 */
export function applyPlaybackResult(state: PlaybackEngineState, result: PlaybackResult): {
  state: PlaybackEngineState; events: PlaybackEngineEvent[];
} {
  const parsed = playbackResultSchema.parse(result);
  const current = playbackEngineStateSchema.parse(state);
  if (current.status === 'DISPOSED') return { state: current, events: [] };
  if (parsed.kind === 'FAILED') {
    return {
      // 后端失败 = 后端没有内容可播 → 回 IDLE（保留投影以便重试；play 会因未加载而被拒）
      state: { ...current, status: 'IDLE', clock: null, error: { reason: PLAYBACK_ENGINE_ERROR_REASONS.BACKEND_FAILED, message: parsed.message } },
      events: [playbackEngineEventSchema.parse({ kind: 'ERROR', requestId: parsed.requestId, reason: PLAYBACK_ENGINE_ERROR_REASONS.BACKEND_FAILED, message: parsed.message })],
    };
  }
  if (parsed.kind === 'LOADED') {
    if (current.snapshot === null || current.backendKind === null) return { state: current, events: [] };
    return {
      state: { ...current, status: 'READY', clock: current.clock ?? current.snapshot.duration, error: null },
      events: [playbackEngineEventSchema.parse({
        kind: 'LOADED', requestId: parsed.requestId, documentRevision: current.snapshot.documentRevision,
        backendKind: current.backendKind,
        capabilities: {
          supported: [...negotiatePlaybackCapabilities(current.snapshot.capabilities).supported],
          unsupported: [...negotiatePlaybackCapabilities(current.snapshot.capabilities).unsupported],
        },
      })],
    };
  }
  // PRESENTED：把后端如实回报的时间记入时钟，并上报 requested/presented 两者
  const requested = current.clock;
  return {
    state: { ...current, clock: parsed.presentedTime, error: null },
    events: [playbackEngineEventSchema.parse({
      kind: 'PLAYBACK', action: 'SEEK', requestId: parsed.requestId, documentRevision: revisionOf(current),
      requestedTime: requested, presentedTime: parsed.presentedTime, presentedFrame: parsed.presentedFrame,
    })],
  };
}

/** 便于宿主构造：请求时间与呈现时间的差异（用于同步验收）。 */
export function presentedDriftMs(requested: MediaTime | null, presented: MediaTime | null): number | null {
  if (requested === null || presented === null) return null;
  const toMs = (time: MediaTime): number => (Number(time.ticks) * time.timebase.num * 1000) / time.timebase.den;
  return toMs(presented) - toMs(requested);
}

/** setRange 的便捷构造（半开区间）。 */
export const playbackRange = (start: MediaTime, end: MediaTime): MediaRange => mediaRangeSchema.parse({ start, end });

// ── 后端端口（宿主/Web 播放器实现）与效果驱动器 ──────────────────

/**
 * 播放后端端口：由宿主实现（N03-12 起为 HTMLMediaElement / MSE；也可包一层现有 Remotion 预览后端）。
 * 引擎只通过它执行效果，**从不直接接触 DOM/媒体 API**，因此状态机可离线验证。
 */
export interface PlaybackBackendPort {
  readonly kind: PlaybackBackendKind;
  load(snapshot: PlaybackSnapshot): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  seek(time: MediaTime): Promise<void>;
  step(frames: number): Promise<void>;
  setRange(range: MediaRange | null): Promise<void>;
  /** 后端**如实回报**的当前呈现位置（不得回填请求值） */
  getPresented(): Promise<{ presentedTime: MediaTime; presentedFrame: string | null }>;
  dispose(): Promise<void>;
}

/** 执行一条效果并产出可回灌的结果（纯转发；异常一律转成 FAILED，不抛给调用方）。 */
export async function runPlaybackEffect(port: PlaybackBackendPort, effect: PlaybackEffect): Promise<PlaybackResult> {
  try {
    switch (effect.kind) {
      case 'LOAD':
        await port.load(effect.snapshot);
        return { kind: 'LOADED', requestId: effect.requestId };
      case 'PLAY':
        await port.play();
        break;
      case 'PAUSE':
        await port.pause();
        break;
      case 'SEEK':
        await port.seek(effect.time);
        break;
      case 'STEP':
        await port.step(effect.frames);
        break;
      case 'SET_RANGE':
        await port.setRange(effect.range);
        break;
      case 'DISPOSE':
        await port.dispose();
        return { kind: 'LOADED', requestId: effect.requestId };
    }
    const presented = await port.getPresented();
    return { kind: 'PRESENTED', requestId: effect.requestId, presentedTime: presented.presentedTime, presentedFrame: presented.presentedFrame };
  } catch (cause) {
    return { kind: 'FAILED', requestId: effect.requestId, message: cause instanceof Error ? cause.message.slice(0, 300) : 'backend-error' };
  }
}

/** `getCapabilities`：返回**协商后**的能力（未加载时为 null）。未声明的能力一律不在 supported 里。 */
export const getPlaybackCapabilities = (state: PlaybackEngineState): PlaybackCapabilities | null =>
  state.snapshot === null ? null : negotiatePlaybackCapabilities(state.snapshot.capabilities);

/** `getClock`：当前播放时钟（未加载或已释放时为 null）。 */
export const getPlaybackClock = (state: PlaybackEngineState): MediaTime | null => state.clock;
