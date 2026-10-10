import { describe, expect, it } from 'vitest';
import {
  appendAttentionEvent,
  attentionEventSchema,
  attentionSnapshot,
  createAttentionBuffer,
  decimatePointerTrajectory,
  mediaTimeSchema,
  type AttentionEvent,
  type AttentionProducer,
} from './index.js';

type PointerSample = Extract<AttentionEvent, { kind: 'POINTER_SAMPLE' }>;

/** N04-05：AttentionSnapshot 本体（单调时钟/纪元、有界事件缓冲、鼠标轨迹最小保留）。 */

let counter = 0;
const base = (producer: AttentionProducer, monotonicMs: number, seq: number, epoch = 0) => ({
  eventId: `evt_${String(++counter)}`,
  sessionId: 'sess_1',
  monotonicMs,
  seq,
  producer,
  epoch,
});

const sample = (monotonicMs: number, x: number, y: number, seq: number, producer: AttentionProducer = 'LOCAL_POINTER', epoch = 0): PointerSample =>
  attentionEventSchema.parse({ kind: 'POINTER_SAMPLE', ...base(producer, monotonicMs, seq, epoch), point: { x, y }, viewport: { width: 1000, height: 1000 } }) as PointerSample;

describe('attention 有界缓冲与时钟纪律', () => {
  it('追加事件后快照包含事件与指针轨迹', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0 });
    buffer = appendAttentionEvent(buffer, sample(0, 0, 0, 0));
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'HOVER_CHANGE', ...base('LOCAL_POINTER', 10, 1), objectId: 'vo_1' }));
    buffer = appendAttentionEvent(buffer, sample(20, 500, 500, 2));
    const snapshot = attentionSnapshot(buffer, { snapshotId: 'snap_1' });
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.pointerTrajectory).toHaveLength(2);
    expect(snapshot.clockEpoch).toBe(0);
  });

  it('epoch 不一致 fail-closed（换纪元必须显式新建缓冲）', () => {
    const buffer = createAttentionBuffer({ clockEpoch: 1 });
    expect(() => appendAttentionEvent(buffer, sample(0, 0, 0, 0, 'LOCAL_POINTER', 2))).toThrow();
  });

  it('同生产者单调时钟不得回退、seq 必须严格递增；不同生产者相互独立', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0 });
    buffer = appendAttentionEvent(buffer, sample(100, 0, 0, 5));
    // 不同生产者可以用更低单调时钟与更低 seq
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'VIEWPORT_CHANGE', ...base('CLIENT_CLOCK', 50, 0), viewport: { width: 800, height: 600 } }));
    expect(buffer.events).toHaveLength(2);
    // 同生产者时钟回退
    expect(() => appendAttentionEvent(buffer, sample(90, 1, 1, 6))).toThrow();
    // 同生产者 seq 不递增
    expect(() => appendAttentionEvent(buffer, sample(110, 1, 1, 5))).toThrow();
  });

  it('按时间窗口裁剪旧事件', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0, windowMs: 1000 });
    buffer = appendAttentionEvent(buffer, sample(0, 0, 0, 0));
    buffer = appendAttentionEvent(buffer, sample(500, 0.1, 0, 1));
    buffer = appendAttentionEvent(buffer, sample(1500, 0.2, 0, 2));
    expect(buffer.events.map((event) => event.monotonicMs)).toEqual([500, 1500]);
  });

  it('事件数量上限生效', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0, maxEvents: 3, windowMs: 10_000 });
    for (let index = 0; index < 5; index += 1) buffer = appendAttentionEvent(buffer, sample(index * 10, index / 100, 0, index));
    expect(buffer.events).toHaveLength(3);
    expect(buffer.events[0]!.monotonicMs).toBe(20);
  });
});

describe('attention 鼠标轨迹最小保留与语音时钟', () => {
  it('按最小距离去样并保留首/末与显著转折', () => {
    const samples = [sample(0, 0, 0, 0), sample(1, 0.001, 0, 1), sample(2, 0.5, 0.5, 2), sample(3, 0.5001, 0.5, 3), sample(4, 1, 1, 4)];
    const decimated = decimatePointerTrajectory(samples, { minDistance: 0.01 });
    expect(decimated.map((event) => event.point.x)).toEqual([0, 0.5, 1]);
  });

  it('超过点数上限时均匀抽稀且保留末点', () => {
    const samples = Array.from({ length: 50 }, (_, index) => sample(index, index, index, index));
    const decimated = decimatePointerTrajectory(samples, { minDistance: 0, maxPoints: 10 });
    expect(decimated).toHaveLength(10);
    expect(decimated[decimated.length - 1]!.point.x).toBe(49);
  });

  it('语音时钟映射如实标注是否具备词级时间；缺失时快照为 null', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0 });
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'VOICE_CLOCK', ...base('CLIENT_CLOCK', 1000, 0), audioContextTimeMs: 12.5, wordTimingAvailable: false }));
    const withVoice = attentionSnapshot(buffer, { snapshotId: 'snap_v' });
    expect(withVoice.voiceClockMapping).toEqual({ audioContextTimeMs: 12.5, monotonicMs: 1000, wordTimingAvailable: false });
    const empty = attentionSnapshot(createAttentionBuffer({ clockEpoch: 0 }), { snapshotId: 'snap_e' });
    expect(empty.voiceClockMapping).toBeNull();
  });

  it('呈现帧与 seek 记录使用有理时基；转写修订保留 utterance/最终态', () => {
    let buffer = createAttentionBuffer({ clockEpoch: 0 });
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'PRESENTED_FRAME', ...base('LOCAL_PLAYBACK', 100, 0), sequenceTime: mediaTimeSchema.parse({ ticks: '1500', timebase: { num: 1, den: 1000 } }), presentedAtMonotonicMs: 95 }));
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'SEEK', ...base('LOCAL_PLAYBACK', 200, 1), sequenceTime: mediaTimeSchema.parse({ ticks: '2000', timebase: { num: 1, den: 1000 } }) }));
    buffer = appendAttentionEvent(buffer, attentionEventSchema.parse({ kind: 'TRANSCRIPT_REVISION', ...base('SERVER', 300, 0), utteranceId: 'utt_1', transcriptRevision: 2, text: '把它移到右边', isFinal: false }));
    const snapshot = attentionSnapshot(buffer, { snapshotId: 'snap_t' });
    expect(snapshot.events.filter((event) => event.kind === 'TRANSCRIPT_REVISION')[0]).toMatchObject({ utteranceId: 'utt_1', transcriptRevision: 2, isFinal: false });
  });
});
