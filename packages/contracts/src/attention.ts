import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { mediaTimeSchema } from './common/media-time.js';

/**
 * N04-05：AttentionSnapshot 本体（增量设计 §5.1、§8.4）。
 *
 * 纪律：
 * - 时钟是**本地单调时钟**（`monotonicMs`）+ 会话 `clockEpoch`，不是墙钟；不靠网络到达顺序对齐；
 * - `seq` 只在**定义的生产者/会话流内**有序（不能把不同连接序号当全局有序）；
 * - 事件缓冲**有界**（时间窗口 + 事件上限），旧事件被裁剪；
 * - 鼠标轨迹只做**最小保留**（按最小距离去样 + 上限），不默认永久保存全程轨迹；
 * - 缺少可验证词级时间时，只记录发话快照/明确点击/短时上下文，不把猜测标成逐词精确。
 */

export const ATTENTION_PRODUCERS = ['LOCAL_POINTER', 'LOCAL_PLAYBACK', 'CLIENT_CLOCK', 'SERVER', 'PROVIDER'] as const;
export const attentionProducerSchema = z.enum(ATTENTION_PRODUCERS);
export type AttentionProducer = z.infer<typeof attentionProducerSchema>;

export const attentionViewportSchema = z
  .object({ width: z.number().int().positive().max(100_000), height: z.number().int().positive().max(100_000) })
  .strict();

/** 归一化或像素坐标都可；由 viewport 解释。允许略超画面（边缘外起笔）。 */
export const attentionPointSchema = z.object({ x: z.number().finite().min(-100_000).max(100_000), y: z.number().finite().min(-100_000).max(100_000) }).strict();

const eventBase = {
  eventId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  /** 本地单调时钟（毫秒，进程/会话内单调）。 */
  monotonicMs: z.number().int().nonnegative(),
  /** 同一生产者内单调递增（重连/换连接用新 epoch，不重用序号）。 */
  seq: z.number().int().nonnegative(),
  producer: attentionProducerSchema,
  /** 会话时钟纪元（断线重连/重采样后递增）。 */
  epoch: z.number().int().nonnegative(),
};

const pointerSampleEvent = z.object({
  kind: z.literal('POINTER_SAMPLE'),
  ...eventBase,
  point: attentionPointSchema,
  viewport: attentionViewportSchema,
}).strict();

const pointerDownEvent = z.object({
  kind: z.literal('POINTER_DOWN'),
  ...eventBase,
  point: attentionPointSchema,
  viewport: attentionViewportSchema,
}).strict();

const pointerUpEvent = z.object({
  kind: z.literal('POINTER_UP'),
  ...eventBase,
  point: attentionPointSchema,
  viewport: attentionViewportSchema,
}).strict();

const hoverChangeEvent = z.object({
  kind: z.literal('HOVER_CHANGE'),
  ...eventBase,
  /** 命中的对象 id；移出为 null。 */
  objectId: opaqueIdSchema.nullable(),
}).strict();

const selectionChangeEvent = z.object({
  kind: z.literal('SELECTION_CHANGE'),
  ...eventBase,
  anchorId: opaqueIdSchema,
  selectionFingerprint: z.string().length(64).nullable().default(null),
}).strict();

export const ATTENTION_PLAYBACK_STATES = ['PLAYING', 'PAUSED'] as const;
const playbackStateEvent = z.object({
  kind: z.literal('PLAYBACK_STATE'),
  ...eventBase,
  state: z.enum(ATTENTION_PLAYBACK_STATES),
  sequenceTime: mediaTimeSchema.nullable().default(null),
}).strict();

const seekEvent = z.object({
  kind: z.literal('SEEK'),
  ...eventBase,
  sequenceTime: mediaTimeSchema,
}).strict();

const viewportChangeEvent = z.object({
  kind: z.literal('VIEWPORT_CHANGE'),
  ...eventBase,
  viewport: attentionViewportSchema,
}).strict();

/** 媒体呈现证据（`requestVideoFrameCallback` 等真实呈现时间），不是每秒几次的 React 状态。 */
const presentedFrameEvent = z.object({
  kind: z.literal('PRESENTED_FRAME'),
  ...eventBase,
  sequenceTime: mediaTimeSchema,
  presentedAtMonotonicMs: z.number().int().nonnegative(),
}).strict();

/** 语音采样时钟与本地单调时钟的对应关系（只有供应商提供可验证位置时才精确绑定词语）。 */
const voiceClockEvent = z.object({
  kind: z.literal('VOICE_CLOCK'),
  ...eventBase,
  audioContextTimeMs: z.number().finite().nonnegative(),
  /** null = 该供应商不提供可验证的词级/音频位置。 */
  wordTimingAvailable: z.boolean().default(false),
}).strict();

const transcriptRevisionEvent = z.object({
  kind: z.literal('TRANSCRIPT_REVISION'),
  ...eventBase,
  utteranceId: opaqueIdSchema,
  transcriptRevision: z.number().int().nonnegative(),
  text: z.string().max(20_000),
  isFinal: z.boolean(),
}).strict();

export const attentionEventSchema = z.discriminatedUnion('kind', [
  pointerSampleEvent,
  pointerDownEvent,
  pointerUpEvent,
  hoverChangeEvent,
  selectionChangeEvent,
  playbackStateEvent,
  seekEvent,
  viewportChangeEvent,
  presentedFrameEvent,
  voiceClockEvent,
  transcriptRevisionEvent,
]);

export type AttentionEvent = z.infer<typeof attentionEventSchema>;
export type AttentionEventKind = AttentionEvent['kind'];

export const ATTENTION_BUFFER_DEFAULT_WINDOW_MS = 8_000;
export const ATTENTION_BUFFER_MAX_EVENTS = 512;
export const ATTENTION_TRAJECTORY_MAX_POINTS = 120;
export const ATTENTION_TRAJECTORY_MIN_DISTANCE = 0.01;

export interface AttentionBuffer {
  clockEpoch: number;
  windowMs: number;
  maxEvents: number;
  events: AttentionEvent[];
}

export function createAttentionBuffer(options: { clockEpoch: number; windowMs?: number; maxEvents?: number } = { clockEpoch: 0 }): AttentionBuffer {
  return {
    clockEpoch: options.clockEpoch,
    windowMs: options.windowMs ?? ATTENTION_BUFFER_DEFAULT_WINDOW_MS,
    maxEvents: options.maxEvents ?? ATTENTION_BUFFER_MAX_EVENTS,
    events: [],
  };
}

function lastForProducer(events: readonly AttentionEvent[], producer: AttentionProducer): AttentionEvent | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.producer === producer) return events[index];
  }
  return undefined;
}

/**
 * 追加事件（不可变）。fail-closed：
 * - epoch 必须与缓冲一致（换 epoch 必须显式新建缓冲，不能静默混流）；
 * - 同生产者 monotonicMs 不得回退、seq 必须严格递增。
 */
export function appendAttentionEvent(buffer: AttentionBuffer, event: AttentionEvent): AttentionBuffer {
  const parsed = attentionEventSchema.parse(event);
  if (parsed.epoch !== buffer.clockEpoch) {
    throw new RangeError(`attention event epoch ${String(parsed.epoch)} does not match buffer epoch ${String(buffer.clockEpoch)}`);
  }
  const previous = lastForProducer(buffer.events, parsed.producer);
  if (previous !== undefined) {
    if (parsed.monotonicMs < previous.monotonicMs) {
      throw new RangeError('attention monotonic clock must not go backwards for a producer');
    }
    if (parsed.seq <= previous.seq) {
      throw new RangeError('attention seq must strictly increase for a producer');
    }
  }
  const events = pruneAttentionBuffer({ ...buffer, events: [...buffer.events, parsed] });
  return events;
}

/** 按最新事件时间窗口与事件上限裁剪（时钟回退已在上游拒绝）。 */
export function pruneAttentionBuffer(buffer: AttentionBuffer): AttentionBuffer {
  if (buffer.events.length === 0) return buffer;
  const newest = buffer.events[buffer.events.length - 1]!;
  const cutoff = newest.monotonicMs - buffer.windowMs;
  const withinWindow = buffer.events.filter((event) => event.monotonicMs >= cutoff);
  const bounded = withinWindow.length > buffer.maxEvents ? withinWindow.slice(withinWindow.length - buffer.maxEvents) : withinWindow;
  return { ...buffer, events: bounded };
}

/**
 * 鼠标轨迹最小保留：按最小距离去样并限制点数（保留首点、显著转折与末点）。
 * 输入/输出为 POINTER_SAMPLE 事件。
 */
export function decimatePointerTrajectory(
  samples: readonly Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }>[],
  options: { minDistance?: number; maxPoints?: number } = {},
): Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }>[] {
  const minDistance = options.minDistance ?? ATTENTION_TRAJECTORY_MIN_DISTANCE;
  const maxPoints = options.maxPoints ?? ATTENTION_TRAJECTORY_MAX_POINTS;
  const kept: Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }>[] = [];
  for (const sample of samples) {
    const previous = kept[kept.length - 1];
    if (previous === undefined) {
      kept.push(sample);
      continue;
    }
    const distance = Math.hypot(sample.point.x - previous.point.x, sample.point.y - previous.point.y);
    if (distance >= minDistance) kept.push(sample);
  }
  if (kept.length <= maxPoints) return kept;
  // 均匀抽稀到上限，且始终保留末点（当前指针位置）。
  const result: Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }>[] = [];
  const step = (kept.length - 1) / (maxPoints - 1);
  for (let index = 0; index < maxPoints; index += 1) result.push(kept[Math.round(index * step)]!);
  return result;
}

export const attentionSnapshotSchema = z.object({
  snapshotId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
  clockEpoch: z.number().int().nonnegative(),
  capturedAtMonotonicMs: z.number().int().nonnegative(),
  windowMs: z.number().int().positive(),
  events: z.array(attentionEventSchema).max(ATTENTION_BUFFER_MAX_EVENTS),
  pointerTrajectory: z.array(pointerSampleEvent).max(ATTENTION_TRAJECTORY_MAX_POINTS),
  /** 语音时钟映射（缺失即为 null，不假装有词级时间）。 */
  voiceClockMapping: z.object({ audioContextTimeMs: z.number().finite().nonnegative(), monotonicMs: z.number().int().nonnegative(), wordTimingAvailable: z.boolean() }).strict().nullable().default(null),
  evidenceRefs: z.array(z.string().min(1).max(200)).max(64).default([]),
}).strict();

export type AttentionSnapshot = z.infer<typeof attentionSnapshotSchema>;

export function attentionSnapshot(
  buffer: AttentionBuffer,
  input: { snapshotId: string; capturedAtMonotonicMs?: number; evidenceRefs?: string[]; trajectory?: { minDistance?: number; maxPoints?: number } },
): AttentionSnapshot {
  const newest = buffer.events[buffer.events.length - 1];
  const capturedAtMonotonicMs = input.capturedAtMonotonicMs ?? newest?.monotonicMs ?? 0;
  const pointerSamples = buffer.events.filter((event): event is Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }> => event.kind === 'POINTER_SAMPLE');
  const lastVoiceClock = [...buffer.events].reverse().find((event): event is Extract<AttentionEvent, { kind: 'VOICE_CLOCK' }> => event.kind === 'VOICE_CLOCK');
  return attentionSnapshotSchema.parse({
    snapshotId: input.snapshotId,
    sessionId: buffer.events[0]?.sessionId ?? 'session_unknown',
    clockEpoch: buffer.clockEpoch,
    capturedAtMonotonicMs,
    windowMs: buffer.windowMs,
    events: buffer.events,
    pointerTrajectory: decimatePointerTrajectory(pointerSamples, input.trajectory ?? {}),
    voiceClockMapping:
      lastVoiceClock === undefined
        ? null
        : { audioContextTimeMs: lastVoiceClock.audioContextTimeMs, monotonicMs: lastVoiceClock.monotonicMs, wordTimingAvailable: lastVoiceClock.wordTimingAvailable },
    evidenceRefs: input.evidenceRefs ?? [],
  });
}
