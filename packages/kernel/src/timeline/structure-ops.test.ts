import { describe, expect, it } from 'vitest';
import { ApiFailure, type EditOperation, type MediaRange } from '@ancs/contracts';
import { rangeToTicks } from '@ancs/time';
import {
  applyKernelResult,
  applyTimelineOperation,
  type KernelAudioRegion,
  type KernelCaption,
  type KernelClip,
  type KernelContext,
  type KernelTimelineOperation,
  type KernelTrack,
  type TimelineState,
} from '../index.js';

/** V5-M1 第三批：轨道、参数、AV 链接、update_clip、字幕与音频的内核行为（无数据库）。 */

const MS = { num: 1, den: 1000 };
const t = (ms: number) => ({ ticks: String(ms), timebase: MS });
const r = (start: number, end: number): MediaRange => ({ start: t(start), end: t(end) });
const IDENTITY = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };
const ctx = (extra: Partial<KernelContext> = {}): KernelContext => { let n = 0; return { newId: (prefix) => `${prefix}_${String((n += 1))}`, ...extra }; };

const track = (id: string, kind: string, position: number, extra: Partial<KernelTrack> = {}): KernelTrack => ({
  id, sequenceId: 'seq', kind, position, name: id, locked: false, muted: false, hidden: false, solo: false, syncLocked: false, ...extra,
});
const clip = (id: string, trackId: string, sequence: MediaRange, extra: Partial<KernelClip> = {}): KernelClip => ({
  id, sequenceId: 'seq', trackId, assetVersionId: 'av', nestedSequenceId: null, sourceStreamId: null,
  sourceRange: sequence, sequenceRange: sequence, timeMapping: IDENTITY, avGroupId: null, parentClipId: null, parameters: null, ...extra,
});
const region = (id: string, sequence: MediaRange, extra: Partial<KernelAudioRegion> = {}): KernelAudioRegion => ({
  id, sequenceId: 'seq', trackId: 'a1', timeBinding: { basis: 'SEQUENCE' }, localRange: r(0, Number(sequence.end.ticks) - Number(sequence.start.ticks)), sequenceRange: sequence,
  sourceStreamId: 'a:0', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: t(0), fadeOut: t(0), parameters: {}, ...extra,
});
const word = (text: string, start: number, end: number) => ({ id: `w_${text}`, text, range: r(start, end) });
const caption = (id: string, sequence: MediaRange, words: { id: string; text: string; range: MediaRange }[]): KernelCaption => ({
  id, sequenceId: 'seq', trackId: 'c1', timeBinding: { basis: 'SEQUENCE' }, localRange: r(0, Number(sequence.end.ticks) - Number(sequence.start.ticks)),
  sequenceRange: sequence, text: words.map((item) => item.text).join(''), languageTag: 'zh-CN', style: {}, words, speechAnchorId: null,
});

function state(partial: Partial<TimelineState> = {}): TimelineState {
  return {
    sequences: new Map([['seq', { id: 'seq', duration: t(60_000) }]]),
    tracks: [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1), track('c1', 'CAPTION', 2)],
    clips: [], audioRegions: [], captions: [], locks: new Map(),
    sources: { assetVersions: new Map([['av', { status: 'READY', durationMs: 30_000, checksumSha256: 'c'.repeat(64), hasAudio: true }]]) },
    policy: { preserveOriginalSpeech: false },
    ...partial,
  };
}

const apply = (s: TimelineState, operation: EditOperation, context = ctx()) => applyTimelineOperation(s, operation as KernelTimelineOperation, context);
const reasonOf = (fn: () => unknown): unknown => { try { fn(); } catch (error) { expect(error).toBeInstanceOf(ApiFailure); return (error as ApiFailure).details['reason']; } return null; };
const positions = (s: TimelineState) => Object.fromEntries(s.tracks.map((item) => [item.id, item.position]));

describe('轨道', () => {
  it('create_track 挤占位置：之后的轨道后移；事件先记后移、最后记 CREATE_TRACK', () => {
    const s = state();
    const result = apply(s, { op: 'create_track', sequenceId: 'seq', track: { kind: 'VIDEO', position: 1, name: 'V2' }, restoreTrackId: 'v2' });
    expect(positions(applyKernelResult(s, result))).toEqual({ v1: 0, v2: 1, a1: 2, c1: 3 });
    expect(result.events.map((event) => `${event.action}:${event.objectId}`)).toEqual(['UPDATE_TRACK:a1', 'UPDATE_TRACK:c1', 'CREATE_TRACK:v2']);
  });

  it('move_track：整体重排、位置连续唯一；目标轨记 MOVE_TRACK、让位轨记 UPDATE_TRACK', () => {
    const s = state();
    const result = apply(s, { op: 'move_track', trackId: 'c1', position: 0 });
    const after = applyKernelResult(s, result);
    expect(positions(after)).toEqual({ c1: 0, v1: 1, a1: 2 });
    expect(result.events.map((event) => `${event.action}:${event.objectId}`).sort()).toEqual(['MOVE_TRACK:c1', 'UPDATE_TRACK:a1', 'UPDATE_TRACK:v1']);
    // 超出范围的位置落到末尾
    expect(positions(applyKernelResult(s, apply(s, { op: 'move_track', trackId: 'v1', position: 99 })))).toEqual({ a1: 0, c1: 1, v1: 2 });
  });

  it('update_track 改 position 按重排语义落位（修复：目标轨位置不再漏写）', () => {
    const s = state();
    const result = apply(s, { op: 'update_track', trackId: 'c1', changes: { position: 0, muted: true } });
    const after = applyKernelResult(s, result);
    expect(positions(after)).toEqual({ c1: 0, v1: 1, a1: 2 });
    expect(after.tracks.find((item) => item.id === 'c1')!.muted).toBe(true);
    // 每条轨道最终位置唯一
    expect(new Set(after.tracks.map((item) => item.position)).size).toBe(3);
  });

  it('delete_track：非空 REJECT → 409；MOVE_CLIPS 迁移片段并压紧位置', () => {
    const s = state({ tracks: [track('v1', 'VIDEO', 0), track('v2', 'VIDEO', 1), track('a1', 'AUDIO', 2)], clips: [clip('x', 'v1', r(0, 1_000))] });
    expect(reasonOf(() => apply(s, { op: 'delete_track', trackId: 'v1', nonEmptyPolicy: 'REJECT', destinationTrackId: null }))).toBe('TRACK_NOT_EMPTY');
    const after = applyKernelResult(s, apply(s, { op: 'delete_track', trackId: 'v1', nonEmptyPolicy: 'MOVE_CLIPS', destinationTrackId: 'v2' }));
    expect(after.clips[0]!.trackId).toBe('v2');
    expect(positions(after)).toEqual({ v2: 0, a1: 1 });
  });

  it('delete_track：轨道上仍有字幕/音频区域/视觉对象 → 409（V5-M2 修复：不再交给外键级联静默删除）', () => {
    const withCaption = state({ captions: [caption('cap', r(0, 1_000), [word('一', 0, 1_000)])] });
    expect(reasonOf(() => apply(withCaption, { op: 'delete_track', trackId: 'c1', nonEmptyPolicy: 'REJECT', destinationTrackId: null }))).toBe('TRACK_NOT_EMPTY');
    const withRegion = state({ tracks: [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1), track('a2', 'AUDIO', 2)], audioRegions: [region('ar', r(0, 1_000))] });
    expect(reasonOf(() => apply(withRegion, { op: 'delete_track', trackId: 'a1', nonEmptyPolicy: 'MOVE_CLIPS', destinationTrackId: 'a2' }))).toBe('TRACK_NOT_EMPTY');
    const withVisual = state({ unmanagedTrackObjects: new Map([['v1', 2]]) });
    expect(reasonOf(() => apply(withVisual, { op: 'delete_track', trackId: 'v1', nonEmptyPolicy: 'REJECT', destinationTrackId: null }))).toBe('TRACK_NOT_EMPTY');
    // 空轨道照常删除
    expect(apply(state(), { op: 'delete_track', trackId: 'c1', nonEmptyPolicy: 'REJECT', destinationTrackId: null }).writes[0]).toMatchObject({ type: 'delete' });
  });
});

describe('片段参数、AV 链接与 update_clip', () => {
  it('set_clip_crop 不允许裁掉全部可见区域；set_clip_opacity 只改参数', () => {
    const s = state({ clips: [clip('x', 'v1', r(0, 1_000))] });
    // 契约层已拒绝空可见区域（请求在进入内核前校验）；内核内的显式检查是纵深防御
    expect(() => apply(s, { op: 'set_clip_crop', clipId: 'x', crop: { left: 0.6, top: 0, right: 0.4, bottom: 0 } })).toThrow();
    const after = applyKernelResult(s, apply(s, { op: 'set_clip_opacity', clipId: 'x', opacity: 0.3 }));
    expect((after.clips[0]!.parameters as { opacity: number }).opacity).toBe(0.3);
    expect(rangeToTicks(after.clips[0]!.sequenceRange, MS)).toEqual({ start: 0n, end: 1_000n });
  });

  it('set_clip_transform：合并到既有参数（保留透明度），不改时间；STYLE 锁阻止', () => {
    const s = state({ clips: [clip('x', 'v1', r(0, 1_000))] });
    const withOpacity = applyKernelResult(s, apply(s, { op: 'set_clip_opacity', clipId: 'x', opacity: 0.5 }));
    const transform = { position: { x: 0.1, y: -0.05 }, scale: { x: 1.5, y: 1.5 }, rotationDeg: 30, anchor: { x: 0.5, y: 0.5 } };
    const result = apply(withOpacity, { op: 'set_clip_transform', clipId: 'x', transform });
    expect(result.events.map((event) => event.action)).toEqual(['SET_CLIP_TRANSFORM']);
    const after = applyKernelResult(withOpacity, result);
    expect(after.clips[0]!.parameters).toMatchObject({ transform, opacity: 0.5 });
    expect(rangeToTicks(after.clips[0]!.sequenceRange, MS)).toEqual({ start: 0n, end: 1_000n });
    const locked = state({ clips: [clip('x', 'v1', r(0, 1_000))], locks: new Map([['CLIP:x', ['STYLE']]]) });
    expect(() => apply(locked, { op: 'set_clip_transform', clipId: 'x', transform })).toThrow(ApiFailure);
  });

  it('set_av_link：一视频一音频且时长相等才能关联', () => {
    const s = state({ clips: [clip('v', 'v1', r(0, 1_000)), clip('a', 'a1', r(0, 1_000)), clip('a2', 'a1', r(2_000, 2_500))] });
    const after = applyKernelResult(s, apply(s, { op: 'set_av_link', linked: true, clipIds: ['v', 'a'] }));
    expect(after.clips.find((item) => item.id === 'v')!.avGroupId).toBe(after.clips.find((item) => item.id === 'a')!.avGroupId);
    expect(reasonOf(() => apply(s, { op: 'set_av_link', linked: true, clipIds: ['v', 'a2'] }))).toBe('AV_LINK_DURATION_MISMATCH');
  });

  it('update_clip 校验速率映射与父片段', () => {
    const s = state({ clips: [clip('x', 'v1', r(0, 1_000))] });
    expect(reasonOf(() => apply(s, { op: 'update_clip', clipId: 'x', changes: { sequenceRange: r(0, 2_000) } }))).toBe('TIME_MAPPING_MISMATCH');
    expect(() => apply(s, { op: 'update_clip', clipId: 'x', changes: { parentClipId: 'missing' } })).toThrow(ApiFailure);
  });
});

describe('字幕', () => {
  const words = [word('甲', 0, 500), word('乙', 500, 1_000), word('丙', 1_000, 1_500)];

  it('split_caption 按词条拆分，事件携带 createdCaption 快照', () => {
    const s = state({ captions: [caption('cap', r(0, 1_500), words)] });
    const result = apply(s, { op: 'split_caption', captionId: 'cap', atWordIndex: 1, createdCaptionId: 'cap2' });
    const after = applyKernelResult(s, result);
    expect(after.captions.find((item) => item.id === 'cap')!.text).toBe('甲');
    expect(rangeToTicks(after.captions.find((item) => item.id === 'cap2')!.sequenceRange, MS)).toEqual({ start: 500n, end: 1_500n });
    expect(Object.keys(result.events[0]!.snapshots).sort()).toEqual(['after', 'before', 'createdCaption']);
  });

  it('cut_caption_range CAPTION_ONLY 不动时间线；CUT_CONTENT 剪掉片段内容并收缝', () => {
    const s = state({ captions: [caption('cap', r(0, 1_500), words)], clips: [clip('x', 'v1', r(0, 1_500)), clip('y', 'v1', r(1_500, 2_000))] });
    const only = applyKernelResult(s, apply(s, { op: 'cut_caption_range', captionId: 'cap', wordFrom: 1, wordTo: 2, mode: 'CAPTION_ONLY', closeAcrossTracks: true }));
    expect(only.captions[0]!.text).toBe('甲丙');
    expect(only.clips).toEqual(s.clips);
    const cut = applyKernelResult(s, apply(s, { op: 'cut_caption_range', captionId: 'cap', wordFrom: 1, wordTo: 2, mode: 'CUT_CONTENT', closeAcrossTracks: true }));
    const ranges = cut.clips.map((item) => [rangeToTicks(item.sequenceRange, MS), rangeToTicks(item.sourceRange, MS)]);
    expect(ranges).toContainEqual([{ start: 0n, end: 500n }, { start: 0n, end: 500n }]);
    expect(ranges).toContainEqual([{ start: 500n, end: 1_000n }, { start: 1_000n, end: 1_500n }]);
    expect(rangeToTicks(cut.clips.find((item) => item.id === 'y')!.sequenceRange, MS)).toEqual({ start: 1_000n, end: 1_500n });
  });
});

describe('音频', () => {
  it('apply_audio_crossfade 要求严格相邻、时长适配两侧', () => {
    const s = state({ audioRegions: [region('l', r(0, 1_000)), region('rr', r(1_000, 2_000))] });
    const after = applyKernelResult(s, apply(s, { op: 'apply_audio_crossfade', leftRegionId: 'l', rightRegionId: 'rr', duration: t(200) }));
    expect(after.audioRegions.find((item) => item.id === 'l')!.fadeOut).toEqual(t(200));
    expect(reasonOf(() => apply(s, { op: 'apply_audio_crossfade', leftRegionId: 'l', rightRegionId: 'rr', duration: t(1_500) }))).toBe('CROSSFADE_DURATION_OUT_OF_RANGE');
  });

  it('原声保护：改源时钟被拒；增益允许；补偿路径不受限', () => {
    const s = state({ audioRegions: [region('l', r(0, 1_000))], policy: { preserveOriginalSpeech: true } });
    expect(reasonOf(() => apply(s, { op: 'update_audio_region', audioRegionId: 'l', changes: { localRange: r(100, 1_100) } }))).toBe('ORIGINAL_SPEECH_PROTECTED');
    expect(() => apply(s, { op: 'update_audio_region', audioRegionId: 'l', changes: { gainDb: -6 } })).not.toThrow();
    expect(() => apply(s, { op: 'update_audio_region', audioRegionId: 'l', changes: { localRange: r(100, 1_100) } }, ctx({ compensation: true }))).not.toThrow();
  });
});

describe('CUT_CONTENT 收缝尊重锁（V5-M1 修复：旧实现不检查轨道锁与对象锁）', () => {
  const words = [word('甲', 0, 500), word('乙', 500, 1_000), word('丙', 1_000, 1_500)];
  const cut = { op: 'cut_caption_range', captionId: 'cap', wordFrom: 1, wordTo: 2, mode: 'CUT_CONTENT', closeAcrossTracks: true } as const;

  it('受影响片段所在轨道被锁 → 409 TRACK_LOCKED，不改任何内容', () => {
    const s = state({
      tracks: [track('v1', 'VIDEO', 0, { locked: true }), track('a1', 'AUDIO', 1), track('c1', 'CAPTION', 2)],
      captions: [caption('cap', r(0, 1_500), words)], clips: [clip('x', 'v1', r(0, 1_500))],
    });
    expect(reasonOf(() => apply(s, cut))).toBe('TRACK_LOCKED');
  });

  it('被剪的片段内容/时长被对象锁锁住 → 409 EDIT_IMPACT_LOCKED', () => {
    const s = state({
      captions: [caption('cap', r(0, 1_500), words)], clips: [clip('x', 'v1', r(0, 1_500))],
      locks: new Map([['CLIP:x', ['CONTENT' as const]]]),
    });
    expect(reasonOf(() => apply(s, cut))).toBe('EDIT_IMPACT_LOCKED');
  });

  it('只需平移的片段锁住位置 → 409；锁住无关维度（STYLE）不阻断', () => {
    const shiftOnly = { captions: [caption('cap', r(0, 1_500), words)], clips: [clip('y', 'v1', r(1_500, 2_000))] };
    expect(reasonOf(() => apply(state({ ...shiftOnly, locks: new Map([['CLIP:y', ['POSITION' as const]]]) }), cut))).toBe('EDIT_IMPACT_LOCKED');
    expect(() => apply(state({ ...shiftOnly, locks: new Map([['CLIP:y', ['STYLE' as const]]]) }), cut)).not.toThrow();
  });

  it('切口之前的片段不受影响，即使其轨道被锁也不阻断', () => {
    const s = state({
      tracks: [track('v1', 'VIDEO', 0), track('v2', 'VIDEO', 1, { locked: true }), track('c1', 'CAPTION', 2)],
      captions: [caption('cap', r(0, 1_500), words)], clips: [clip('early', 'v2', r(0, 400))],
    });
    expect(() => apply(s, cut)).not.toThrow();
  });
});
