import { describe, expect, it } from 'vitest';
import { ApiFailure, type EditOperation, type MediaRange } from '@ancs/contracts';
import { rangeToTicks } from '@ancs/time';
import { applyKernelResult, applyTimelineOperation, lockKey, type KernelClip, type KernelContext, type KernelTimelineOperation, type TimelineState } from '../index.js';

/**
 * V5-M1 编辑内核：片段原语的纯函数行为。
 * 这些用例不需要数据库——与 apps/api 的集成用例（真实 PostgreSQL）共同证明"规则在内核、领域只做持久化"。
 */

const MS = { num: 1, den: 1000 };
const NTSC = { num: 1, den: 30_000 }; // 29.97fps：一帧 = 1001 ticks
const t = (ticks: number | bigint, timebase = MS) => ({ ticks: String(ticks), timebase });
const r = (start: number | bigint, end: number | bigint, timebase = MS): MediaRange => ({ start: t(start, timebase), end: t(end, timebase) });
const IDENTITY = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };

function idSequence(): KernelContext {
  let next = 0;
  return { newId: (prefix) => `${prefix}_${String((next += 1)).padStart(4, '0')}` };
}

function clip(id: string, trackId: string, sequence: MediaRange, source: MediaRange = sequence, extra: Partial<KernelClip> = {}): KernelClip {
  return {
    id, sequenceId: 'seq_1', trackId, assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
    sourceRange: source, sequenceRange: sequence, timeMapping: IDENTITY, avGroupId: null, parentClipId: null, parameters: null, ...extra,
  };
}

function baseState(overrides: Partial<TimelineState> = {}): TimelineState {
  return {
    sequences: new Map([['seq_1', { id: 'seq_1', duration: t(60_000) }]]),
    tracks: [
      { id: 'trk_v1', sequenceId: 'seq_1', kind: 'VIDEO', position: 0, name: 'V1', locked: false, muted: false, hidden: false, solo: false, syncLocked: false },
      { id: 'trk_a1', sequenceId: 'seq_1', kind: 'AUDIO', position: 1, name: 'A1', locked: false, muted: false, hidden: false, solo: false, syncLocked: false },
    ],
    clips: [],
    audioRegions: [],
    captions: [],
    locks: new Map(),
    sources: {
      assetVersions: new Map([['av_1', { status: 'READY', durationMs: 30_000, checksumSha256: 'a'.repeat(64), hasAudio: true }]]),
    },
    policy: { preserveOriginalSpeech: false },
    ...overrides,
  };
}

const apply = (state: TimelineState, operation: EditOperation, ctx = idSequence()) =>
  applyTimelineOperation(state, operation as KernelTimelineOperation, ctx);

function expectFailure(fn: () => unknown, reason: string, status?: number): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiFailure);
    expect((error as ApiFailure).details['reason']).toBe(reason);
    if (status !== undefined) expect((error as ApiFailure).httpStatus).toBe(status);
    return;
  }
  throw new Error(`expected failure ${reason}`);
}

function deepFreeze<T>(value: T): T {
  if (value instanceof Map) {
    for (const entry of value.values()) deepFreeze(entry);
  } else if (typeof value === 'object' && value !== null) {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

describe('insert_clip', () => {
  it('INSERT：起点之后整体右移，跨入点的片段切开；源含音频时在首个音频轨放置关联片段', () => {
    const state = baseState({ clips: [clip('clp_a', 'trk_v1', r(0, 4_000)), clip('clp_b', 'trk_v1', r(4_000, 6_000))] });
    const result = apply(state, {
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange: r(10_000, 12_000), mode: 'INSERT', sequenceStart: t(1_000), linkAudio: true, audioTrackId: null, createdClipId: 'clp_new',
    });
    const after = applyKernelResult(state, result);
    const byId = new Map(after.clips.map((item) => [item.id, item]));
    expect(rangeToTicks(byId.get('clp_a')!.sequenceRange, MS)).toEqual({ start: 0n, end: 1_000n });
    expect(rangeToTicks(byId.get('clp_b')!.sequenceRange, MS)).toEqual({ start: 6_000n, end: 8_000n });
    expect(rangeToTicks(byId.get('clp_new')!.sequenceRange, MS)).toEqual({ start: 1_000n, end: 3_000n });
    const rightPart = after.clips.find((item) => item.trackId === 'trk_v1' && item.id.startsWith('clp_0'))!;
    expect(rangeToTicks(rightPart.sequenceRange, MS)).toEqual({ start: 3_000n, end: 6_000n });
    expect(rangeToTicks(rightPart.sourceRange, MS)).toEqual({ start: 1_000n, end: 4_000n });
    const audio = after.clips.find((item) => item.trackId === 'trk_a1')!;
    expect(audio.avGroupId).toBe(byId.get('clp_new')!.avGroupId);
    expect(result.events.map((event) => event.action)).toEqual(['UPDATE_CLIP', 'INSERT_CLIP', 'UPDATE_CLIP', 'INSERT_CLIP', 'INSERT_CLIP']);
  });

  it('OVERWRITE：区间内片段删除、边缘片段裁剪，后续位置不变', () => {
    const state = baseState({ clips: [clip('clp_a', 'trk_v1', r(0, 3_000)), clip('clp_b', 'trk_v1', r(3_000, 4_000)), clip('clp_c', 'trk_v1', r(4_000, 8_000))] });
    const result = apply(state, {
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange: r(0, 3_000), mode: 'OVERWRITE', sequenceStart: t(2_000), linkAudio: false, audioTrackId: null, createdClipId: 'clp_new',
    });
    const after = applyKernelResult(state, result);
    const ranges = Object.fromEntries(after.clips.map((item) => [item.id, rangeToTicks(item.sequenceRange, MS)]));
    expect(ranges['clp_a']).toEqual({ start: 0n, end: 2_000n });
    expect(ranges['clp_b']).toBeUndefined();
    expect(ranges['clp_c']).toEqual({ start: 5_000n, end: 8_000n });
    // clp_c 源与序列同起点（4000），被覆盖掉的 1000ms 从源头部切除
    expect(rangeToTicks(after.clips.find((item) => item.id === 'clp_c')!.sourceRange, MS)).toEqual({ start: 5_000n, end: 8_000n });
  });

  it('锁定片段被涟漪触碰 → 409 CLIP_LOCKED；锁定目标轨 → 409 TRACK_LOCKED', () => {
    const locked = baseState({ clips: [clip('clp_a', 'trk_v1', r(2_000, 4_000))], locks: new Map([[lockKey('CLIP', 'clp_a'), ['POSITION']]]) });
    const insert = {
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange: r(0, 1_000), mode: 'INSERT', sequenceStart: t(0), linkAudio: false, audioTrackId: null,
    } as const;
    expectFailure(() => apply(locked, insert), 'CLIP_LOCKED', 409);
    const trackLocked = baseState({ tracks: baseState().tracks.map((track) => ({ ...track, locked: track.id === 'trk_v1' })) });
    expectFailure(() => apply(trackLocked, insert), 'TRACK_LOCKED', 409);
  });

  it('源越界 / 未就绪 / 缺校验和 分别 422 / 409 / 409', () => {
    const insert = (sourceRange: MediaRange) => ({
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange, mode: 'APPEND', sequenceStart: null, linkAudio: false, audioTrackId: null,
    }) as EditOperation;
    expectFailure(() => apply(baseState(), insert(r(29_000, 31_000))), 'SOURCE_RANGE_OUT_OF_BOUNDS', 422);
    const noChecksum = baseState({ sources: { ...baseState().sources, assetVersions: new Map([['av_1', { status: 'READY', durationMs: 30_000, checksumSha256: null, hasAudio: false }]]) } });
    expectFailure(() => apply(noChecksum, insert(r(0, 1_000))), 'SOURCE_CHECKSUM_MISSING', 409);
  });

  it('没有音频轨时自动创建（写入 track，但不记事件）', () => {
    const state = baseState({ tracks: [baseState().tracks[0]!] });
    const result = apply(state, {
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange: r(0, 1_000), mode: 'APPEND', sequenceStart: null, linkAudio: true, audioTrackId: null,
    });
    const trackWrite = result.writes.find((write) => write.type === 'insert' && write.after.entity === 'track')!;
    expect(trackWrite.type === 'insert' && trackWrite.after.entity === 'track' && trackWrite.after.value.kind).toBe('AUDIO');
    expect(result.events.some((event) => event.objectKind === 'TRACK')).toBe(false);
  });
});

describe('split / trim / move / duplicate / replace / delete', () => {
  it('split_clip 切开视频与关联音频，右段为子片段并继承参数', () => {
    const params = { schemaVersion: '1.0', opacity: 0.5 };
    const state = baseState({ clips: [
      clip('clp_v', 'trk_v1', r(0, 4_000), r(0, 4_000), { avGroupId: 'avgp_1', parameters: params }),
      clip('clp_a', 'trk_a1', r(0, 4_000), r(0, 4_000), { avGroupId: 'avgp_1' }),
    ] });
    const result = apply(state, { op: 'split_clip', clipId: 'clp_v', at: t(1_500), createdClipId: 'clp_vr', createdAudioClipId: 'clp_ar' });
    const after = applyKernelResult(state, result);
    const right = after.clips.find((item) => item.id === 'clp_vr')!;
    expect(right.parentClipId).toBe('clp_v');
    expect(right.parameters).toEqual(params);
    expect(rangeToTicks(right.sourceRange, MS)).toEqual({ start: 1_500n, end: 4_000n });
    expect(rangeToTicks(after.clips.find((item) => item.id === 'clp_ar')!.sequenceRange, MS)).toEqual({ start: 1_500n, end: 4_000n });
    expect(result.events.map((event) => event.action)).toEqual(['SPLIT_CLIP', 'INSERT_CLIP', 'UPDATE_CLIP', 'INSERT_CLIP']);
  });

  it('split_clip 切点必须在片段内部；对象锁命中 → EDIT_IMPACT_LOCKED', () => {
    const state = baseState({ clips: [clip('clp_v', 'trk_v1', r(0, 4_000))] });
    expectFailure(() => apply(state, { op: 'split_clip', clipId: 'clp_v', at: t(4_000) }), 'SPLIT_POINT_OUTSIDE_CLIP', 422);
    const locked = { ...state, locks: new Map([[lockKey('CLIP', 'clp_v'), ['DURATION' as const]]]) };
    expectFailure(() => apply(locked, { op: 'split_clip', clipId: 'clp_v', at: t(1_000) }), 'EDIT_IMPACT_LOCKED', 409);
  });

  it('trim_clip：时长必须相等、不得与同轨重叠；关联片段同步', () => {
    const state = baseState({ clips: [
      clip('clp_v', 'trk_v1', r(0, 4_000), r(0, 4_000), { avGroupId: 'avgp_1' }),
      clip('clp_a', 'trk_a1', r(0, 4_000), r(0, 4_000), { avGroupId: 'avgp_1' }),
      clip('clp_next', 'trk_v1', r(5_000, 6_000)),
    ] });
    expectFailure(() => apply(state, { op: 'trim_clip', clipId: 'clp_v', sourceRange: r(0, 3_000), sequenceRange: r(0, 2_000) }), 'TRIM_RANGE_DURATION_MISMATCH', 422);
    expectFailure(() => apply(state, { op: 'trim_clip', clipId: 'clp_v', sourceRange: r(0, 5_500), sequenceRange: r(0, 5_500) }), 'CLIP_OVERLAP', 409);
    const after = applyKernelResult(state, apply(state, { op: 'trim_clip', clipId: 'clp_v', sourceRange: r(1_000, 3_000), sequenceRange: r(0, 2_000) }));
    expect(rangeToTicks(after.clips.find((item) => item.id === 'clp_a')!.sourceRange, MS)).toEqual({ start: 0n, end: 2_000n });
  });

  it('move_clip：保持时长、平移 CLIP_LOCAL 音频区域与关联片段；轨道类型必须一致', () => {
    const state = baseState({
      clips: [
        clip('clp_v', 'trk_v1', r(0, 2_000), r(0, 2_000), { avGroupId: 'avgp_1' }),
        clip('clp_a', 'trk_a1', r(0, 2_000), r(0, 2_000), { avGroupId: 'avgp_1' }),
      ],
      audioRegions: [{
        id: 'ar_1', sequenceId: 'seq_1', trackId: 'trk_a1', timeBinding: { basis: 'CLIP_LOCAL', clipId: 'clp_v' }, localRange: r(0, 1_000), sequenceRange: r(500, 1_500),
        sourceStreamId: 'a:0', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: t(0), fadeOut: t(0), parameters: {},
      }],
    });
    const after = applyKernelResult(state, apply(state, { op: 'move_clip', clipId: 'clp_v', sequenceRange: r(3_000, 5_000) }));
    expect(rangeToTicks(after.audioRegions[0]!.sequenceRange, MS)).toEqual({ start: 3_500n, end: 4_500n });
    expect(rangeToTicks(after.clips.find((item) => item.id === 'clp_a')!.sequenceRange, MS)).toEqual({ start: 3_000n, end: 5_000n });
    expectFailure(() => apply(state, { op: 'move_clip', clipId: 'clp_v', sequenceRange: r(3_000, 6_000) }), 'MOVE_REQUIRES_EQUAL_DURATION', 422);
    expectFailure(() => apply(state, { op: 'move_clip', clipId: 'clp_v', trackId: 'trk_a1' }), 'TRACK_KIND_MISMATCH', 422);
  });

  it('duplicate_clip 只复制引用（同一源），新建关联组', () => {
    const state = baseState({ clips: [
      clip('clp_v', 'trk_v1', r(0, 2_000), r(0, 2_000), { avGroupId: 'avgp_1' }),
      clip('clp_a', 'trk_a1', r(0, 2_000), r(0, 2_000), { avGroupId: 'avgp_1' }),
    ] });
    const after = applyKernelResult(state, apply(state, { op: 'duplicate_clip', clipId: 'clp_v', afterClipId: null, createdClipId: 'clp_copy' }));
    const copy = after.clips.find((item) => item.id === 'clp_copy')!;
    expect(copy.assetVersionId).toBe('av_1');
    expect(copy.avGroupId).not.toBe('avgp_1');
    expect(after.clips.filter((item) => item.avGroupId === copy.avGroupId)).toHaveLength(2);
  });

  it('replace_clip_source 时长必须匹配；delete_clip 受轨道锁约束', () => {
    const state = baseState({ clips: [clip('clp_v', 'trk_v1', r(0, 2_000))] });
    expectFailure(() => apply(state, { op: 'replace_clip_source', clipId: 'clp_v', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null, sourceRange: r(0, 1_000) }), 'SOURCE_DURATION_MISMATCH', 422);
    const trackLocked = baseState({ clips: state.clips, tracks: baseState().tracks.map((track) => ({ ...track, locked: true })) });
    expectFailure(() => apply(trackLocked, { op: 'delete_clip', clipId: 'clp_v' }), 'TRACK_LOCKED', 409);
  });
});

describe('内核纯度与确定性', () => {
  it('不修改输入状态（深度冻结后仍可运行）且同输入同输出', () => {
    const state = deepFreeze(baseState({ clips: [clip('clp_a', 'trk_v1', r(0, 4_000)), clip('clp_b', 'trk_v1', r(4_000, 6_000))] }));
    const operation: EditOperation = {
      op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
      sourceRange: r(0, 1_000), mode: 'INSERT', sequenceStart: t(2_000), linkAudio: true, audioTrackId: null,
    };
    const first = apply(state, operation, idSequence());
    const second = apply(state, operation, idSequence());
    expect(second).toEqual(first);
  });

  it('时基不能精确表示的边界 → 422 TIME_NOT_REPRESENTABLE（不静默取整）', () => {
    const state = baseState({ sequences: new Map([['seq_1', { id: 'seq_1', duration: t(300 * 1001, NTSC) }]]), clips: [clip('clp_v', 'trk_v1', r(0, 90 * 1001, NTSC))] });
    // 1/7 秒在 1/30000 时基下不是整数 ticks
    expectFailure(() => apply(state, { op: 'split_clip', clipId: 'clp_v', at: { ticks: '1', timebase: { num: 1, den: 7 } } }), 'TIME_NOT_REPRESENTABLE', 422);
  });
});

/** 线性同余 PRNG（可复现种子；避免引入额外依赖）。 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe('属性测试：随机原语序列在 29.97fps 下保持时间线不变量', () => {
  const FRAME = 1001n;
  const durationFrames = 600n;

  function invariants(state: TimelineState): void {
    const seqEnd = durationFrames * FRAME;
    const byTrack = new Map<string, { start: bigint; end: bigint }[]>();
    for (const item of state.clips) {
      const span = rangeToTicks(item.sequenceRange, NTSC);
      const source = rangeToTicks(item.sourceRange, NTSC);
      expect(span.start).toBeGreaterThanOrEqual(0n);
      expect(span.end).toBeLessThanOrEqual(seqEnd);
      expect(span.end - span.start).toBe(source.end - source.start); // 1:1 映射：源/序列时长相等
      expect(span.start % FRAME).toBe(0n); // 编辑边界落在帧上
      byTrack.set(item.trackId, [...(byTrack.get(item.trackId) ?? []), span]);
    }
    for (const spans of byTrack.values()) {
      const sorted = [...spans].sort((a, b) => (a.start < b.start ? -1 : 1));
      for (let index = 1; index < sorted.length; index += 1) {
        expect(sorted[index]!.start).toBeGreaterThanOrEqual(sorted[index - 1]!.end); // 同轨不重叠
      }
    }
  }

  for (const seed of [1, 7, 42, 1337, 2026]) {
    it(`seed=${String(seed)}：200 步后不变量成立，失败只以 ApiFailure 出现且不改变状态`, () => {
      const random = prng(seed);
      const ctx = idSequence();
      const frames = (n: bigint) => t(n * FRAME, NTSC);
      let state = baseState({
        sequences: new Map([['seq_1', { id: 'seq_1', duration: frames(durationFrames) }]]),
        sources: {
          assetVersions: new Map([['av_1', { status: 'READY', durationMs: 60_000, checksumSha256: 'a'.repeat(64), hasAudio: false }]]),
        },
      });
      let applied = 0;
      for (let step = 0; step < 200; step += 1) {
        const pick = random();
        const frameAt = (max: bigint) => BigInt(Math.floor(random() * Number(max)));
        let operation: EditOperation;
        const existing = state.clips;
        const target = existing[Math.floor(random() * existing.length)];
        if (pick < 0.35 || target === undefined) {
          const length = 1n + frameAt(60n);
          const sourceStart = frameAt(400n);
          operation = {
            op: 'insert_clip', sequenceId: 'seq_1', trackId: 'trk_v1', assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
            sourceRange: { start: frames(sourceStart), end: frames(sourceStart + length) },
            mode: random() < 0.5 ? 'INSERT' : 'OVERWRITE', sequenceStart: frames(frameAt(durationFrames - 60n)), linkAudio: false, audioTrackId: null,
          };
        } else if (pick < 0.6) {
          const span = rangeToTicks(target.sequenceRange, NTSC);
          const lengthFrames = (span.end - span.start) / FRAME;
          operation = { op: 'split_clip', clipId: target.id, at: frames(span.start / FRAME + 1n + frameAt(lengthFrames)) };
        } else if (pick < 0.8) {
          const span = rangeToTicks(target.sequenceRange, NTSC);
          const start = frameAt(durationFrames);
          operation = { op: 'move_clip', clipId: target.id, sequenceRange: { start: frames(start), end: frames(start + (span.end - span.start) / FRAME) } };
        } else if (pick < 0.9) {
          const span = rangeToTicks(target.sequenceRange, NTSC);
          const source = rangeToTicks(target.sourceRange, NTSC);
          const keep = 1n + frameAt((span.end - span.start) / FRAME);
          operation = {
            op: 'trim_clip', clipId: target.id,
            sourceRange: { start: t(source.start, NTSC), end: t(source.start + keep * FRAME, NTSC) },
            sequenceRange: { start: t(span.start, NTSC), end: t(span.start + keep * FRAME, NTSC) },
          };
        } else {
          operation = { op: 'delete_clip', clipId: target.id };
        }
        let result;
        try {
          result = apply(state, operation, ctx);
        } catch (error) {
          expect(error).toBeInstanceOf(ApiFailure); // 规则拒绝必须是领域错误，不能是崩溃
          continue;
        }
        state = applyKernelResult(state, result);
        applied += 1;
        invariants(state);
      }
      expect(applied).toBeGreaterThan(40);
    });
  }
});
