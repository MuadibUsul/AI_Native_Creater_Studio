import { describe, expect, it } from 'vitest';
import { ApiFailure, type EditOperation, type MediaRange } from '@ancs/contracts';
import { rangeToTicks } from '@ancs/time';
import { applyKernelResult, applyTimelineOperation, type KernelClip, type KernelContext, type KernelTimelineOperation, type TimelineState } from '../index.js';

/** V5-M1 第二批：slip / slide / roll / ripple / J·L cut 的内核行为（无数据库）。 */

const MS = { num: 1, den: 1000 };
const t = (ms: number) => ({ ticks: String(ms), timebase: MS });
const r = (start: number, end: number): MediaRange => ({ start: t(start), end: t(end) });
const IDENTITY = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };
const ctx = (): KernelContext => { let n = 0; return { newId: (prefix) => `${prefix}_${String((n += 1))}` }; };

const clip = (id: string, trackId: string, sequence: MediaRange, source: MediaRange, avGroupId: string | null = null): KernelClip => ({
  id, sequenceId: 'seq', trackId, assetVersionId: 'av', nestedSequenceId: null, sourceStreamId: null,
  sourceRange: source, sequenceRange: sequence, timeMapping: IDENTITY, avGroupId, parentClipId: null, parameters: null,
});

const track = (id: string, kind: string, position: number, syncLocked = false) => ({
  id, sequenceId: 'seq', kind, position, name: id, locked: false, muted: false, hidden: false, solo: false, syncLocked,
});

function state(clips: KernelClip[], tracks = [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1)]): TimelineState {
  return {
    sequence: { id: 'seq', duration: t(60_000) }, tracks, clips, audioRegions: [], locks: new Map(),
    sources: { assetVersions: new Map([['av', { status: 'READY', durationMs: 30_000, checksumSha256: 'c'.repeat(64), hasAudio: true }]]), sequenceDurations: new Map() },
  };
}

const run = (s: TimelineState, operation: EditOperation) => applyKernelResult(s, applyTimelineOperation(s, operation as KernelTimelineOperation, ctx()));
const ticksOf = (s: TimelineState, id: string, field: 'sequenceRange' | 'sourceRange') => rangeToTicks(s.clips.find((item) => item.id === id)![field], MS);
const reasonOf = (fn: () => unknown): unknown => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(ApiFailure); return (error as ApiFailure).details['reason']; } return null; };

describe('slip / slide / roll', () => {
  it('slip 只改源窗口并同步关联音频；越过源头 → HANDLE_UNAVAILABLE', () => {
    const s = state([clip('v', 'v1', r(0, 2_000), r(1_000, 3_000), 'g'), clip('a', 'a1', r(0, 2_000), r(1_000, 3_000), 'g')]);
    const after = run(s, { op: 'slip_clip', clipId: 'v', sourceRange: r(1_500, 3_500) });
    expect(ticksOf(after, 'v', 'sourceRange')).toEqual({ start: 1_500n, end: 3_500n });
    expect(ticksOf(after, 'a', 'sourceRange')).toEqual({ start: 1_500n, end: 3_500n });
    expect(ticksOf(after, 'v', 'sequenceRange')).toEqual({ start: 0n, end: 2_000n });
    const skewed = state([clip('v', 'v1', r(0, 2_000), r(1_000, 3_000), 'g'), clip('a', 'a1', r(0, 2_000), r(200, 2_200), 'g')]);
    expect(reasonOf(() => run(skewed, { op: 'slip_clip', clipId: 'v', sourceRange: r(0, 2_000) }))).toBe('HANDLE_UNAVAILABLE');
  });

  it('slide 由左右邻居吸收位移，总时长不变；缺邻居 → SLIDE_REQUIRES_ADJACENT_NEIGHBORS', () => {
    const s = state([clip('p', 'v1', r(0, 2_000), r(0, 2_000)), clip('m', 'v1', r(2_000, 3_000), r(5_000, 6_000)), clip('n', 'v1', r(3_000, 5_000), r(10_000, 12_000))]);
    const after = run(s, { op: 'slide_clip', clipId: 'm', offset: t(500) });
    expect(ticksOf(after, 'p', 'sequenceRange')).toEqual({ start: 0n, end: 2_500n });
    expect(ticksOf(after, 'm', 'sequenceRange')).toEqual({ start: 2_500n, end: 3_500n });
    expect(ticksOf(after, 'n', 'sequenceRange')).toEqual({ start: 3_500n, end: 5_000n });
    expect(ticksOf(after, 'n', 'sourceRange')).toEqual({ start: 10_500n, end: 12_000n });
    expect(reasonOf(() => run(state([clip('m', 'v1', r(0, 1_000), r(0, 1_000))]), { op: 'slide_clip', clipId: 'm', offset: t(100) }))).toBe('SLIDE_REQUIRES_ADJACENT_NEIGHBORS');
  });

  it('roll 同步移动左出点与右入点；不相邻 → ROLL_REQUIRES_ADJACENT_CLIPS', () => {
    const s = state([clip('l', 'v1', r(0, 2_000), r(0, 2_000)), clip('rr', 'v1', r(2_000, 4_000), r(5_000, 7_000))]);
    const after = run(s, { op: 'roll_clip', leftClipId: 'l', rightClipId: 'rr', at: t(1_500) });
    expect(ticksOf(after, 'l', 'sourceRange')).toEqual({ start: 0n, end: 1_500n });
    expect(ticksOf(after, 'rr', 'sourceRange')).toEqual({ start: 4_500n, end: 7_000n });
    const gap = state([clip('l', 'v1', r(0, 2_000), r(0, 2_000)), clip('rr', 'v1', r(2_100, 4_000), r(5_000, 6_900))]);
    expect(reasonOf(() => run(gap, { op: 'roll_clip', leftClipId: 'l', rightClipId: 'rr', at: t(1_500) }))).toBe('ROLL_REQUIRES_ADJACENT_CLIPS');
  });
});

describe('ripple / J·L cut', () => {
  it('ripple DELETE 删除并跨同步锁轨收缝；未纳入范围的关联音频 → 409', () => {
    const tracks = [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1, true)];
    const s = state([
      clip('x', 'v1', r(0, 1_000), r(0, 1_000), 'g'), clip('xa', 'a1', r(0, 1_000), r(0, 1_000), 'g'),
      clip('y', 'v1', r(1_000, 3_000), r(1_000, 3_000)), clip('ya', 'a1', r(1_000, 3_000), r(1_000, 3_000)),
    ], tracks);
    const after = run(s, { op: 'ripple_clip', clipId: 'x', action: 'DELETE', amount: null, closeAcrossTracks: false });
    expect(after.clips.map((item) => item.id).sort()).toEqual(['y', 'ya']);
    expect(ticksOf(after, 'y', 'sequenceRange')).toEqual({ start: 0n, end: 2_000n });
    expect(ticksOf(after, 'ya', 'sequenceRange')).toEqual({ start: 0n, end: 2_000n });
    const unsynced = state(s.clips as KernelClip[], [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1, false)]);
    expect(reasonOf(() => run(unsynced, { op: 'ripple_clip', clipId: 'x', action: 'DELETE', amount: null, closeAcrossTracks: false }))).toBe('AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE');
  });

  it('ripple TRIM_HEAD 推进源入点、片段停在原位、后续片段左移', () => {
    const s = state([clip('x', 'v1', r(0, 2_000), r(0, 2_000)), clip('y', 'v1', r(2_000, 3_000), r(0, 1_000))]);
    const after = run(s, { op: 'ripple_clip', clipId: 'x', action: 'TRIM_HEAD', amount: t(500), closeAcrossTracks: false });
    expect(ticksOf(after, 'x', 'sequenceRange')).toEqual({ start: 0n, end: 1_500n });
    expect(ticksOf(after, 'x', 'sourceRange')).toEqual({ start: 500n, end: 2_000n });
    expect(ticksOf(after, 'y', 'sequenceRange')).toEqual({ start: 1_500n, end: 2_500n });
  });

  it('J cut：音频切点早于视频，源范围连续', () => {
    const s = state([clip('v', 'v1', r(0, 4_000), r(0, 4_000), 'g'), clip('a', 'a1', r(0, 4_000), r(0, 4_000), 'g')]);
    const result = applyTimelineOperation(s, { op: 'split_av_cut', videoClipId: 'v', audioClipId: 'a', at: t(2_000), offset: t(500), kind: 'J', createdVideoClipId: 'v2', createdAudioClipId: 'a2' } as KernelTimelineOperation, ctx());
    const after = applyKernelResult(s, result);
    expect(ticksOf(after, 'v', 'sequenceRange')).toEqual({ start: 0n, end: 2_000n });
    expect(ticksOf(after, 'a', 'sequenceRange')).toEqual({ start: 0n, end: 1_500n });
    expect(ticksOf(after, 'a2', 'sourceRange')).toEqual({ start: 1_500n, end: 4_000n });
    expect(result.changes.map((change) => change.event?.action)).toEqual(['SPLIT_AV_CUT', 'INSERT_CLIP', 'UPDATE_CLIP', 'INSERT_CLIP']);
  });
});
