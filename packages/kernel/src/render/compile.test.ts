import { describe, expect, it } from 'vitest';
import { ApiFailure, PLAYBACK_ERROR_REASONS, type MediaRange, type PlaybackCapabilities } from '@ancs/contracts';
import {
  assertRenderPlanSupported,
  compileRenderPlan,
  playbackSnapshotFromRenderPlan,
  serverSynthesisPlanFromSnapshot,
  unsupportedRenderRequirements,
  type KernelAudioRegion,
  type KernelCaption,
  type KernelClip,
  type KernelTrack,
  type RenderPlanInput,
  type RenderSourceFacts,
} from '../index.js';

/** V5-M4（§13）：RenderPlan IR 由内核纯编译——确定性、层序、音频接管、源时钟映射、fail-closed 与后端裁决。 */

const MS = { num: 1, den: 1000 };
const t = (ms: number) => ({ ticks: String(ms), timebase: MS });
const r = (start: number, end: number): MediaRange => ({ start: t(start), end: t(end) });
const IDENTITY = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };

const track = (id: string, kind: string, position: number, extra: Partial<KernelTrack> = {}): KernelTrack => ({
  id, sequenceId: 'seq', kind, position, name: id, locked: false, muted: false, hidden: false, solo: false, syncLocked: false, ...extra,
});
const clip = (id: string, trackId: string, sequence: MediaRange, extra: Partial<KernelClip> = {}): KernelClip => ({
  id, sequenceId: 'seq', trackId, assetVersionId: 'av1', nestedSequenceId: null, sourceStreamId: null,
  sourceRange: sequence, sequenceRange: sequence, timeMapping: IDENTITY, avGroupId: null, parentClipId: null, parameters: null, ...extra,
});
const region = (id: string, clipId: string, local: MediaRange, sequence: MediaRange, extra: Partial<KernelAudioRegion> = {}): KernelAudioRegion => ({
  id, sequenceId: 'seq', trackId: 'a1', timeBinding: { basis: 'CLIP_LOCAL', clipId, semanticCueId: null }, localRange: local, sequenceRange: sequence,
  sourceStreamId: 'a:0', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: t(0), fadeOut: t(0), parameters: {}, ...extra,
});
const caption = (id: string, sequence: MediaRange, extra: Partial<KernelCaption> = {}): KernelCaption => ({
  id, sequenceId: 'seq', trackId: 'c1', timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null }, localRange: sequence,
  sequenceRange: sequence, text: id, languageTag: 'zh-CN', style: { schemaVersion: '1.0', values: {} }, words: [], speechAnchorId: null, ...extra,
});
const ready = (assetId: string, extra: Partial<RenderSourceFacts> = {}): RenderSourceFacts => ({
  assetId, status: 'READY', checksumSha256: 'c'.repeat(64), stored: true, durationKnown: true, hasAudio: true, ...extra,
});

function input(partial: Partial<RenderPlanInput> = {}): RenderPlanInput {
  return {
    projectId: 'prj',
    documentRevision: 7,
    sequence: { id: 'seq', duration: t(60_000), frameRate: { num: 30, den: 1 } },
    tracks: [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1), track('c1', 'CAPTION', 2)],
    clips: [clip('vc1', 'v1', r(0, 2_000))],
    audioRegions: [],
    captions: [],
    visualObjects: [],
    animationBindings: [],
    sources: new Map([['av1', ready('ast1')], ['av2', ready('ast2', { hasAudio: false })]]),
    ...partial,
  };
}

const failure = (fn: () => unknown): ApiFailure => {
  try { fn(); } catch (error) { expect(error).toBeInstanceOf(ApiFailure); return error as ApiFailure; }
  throw new Error('expected ApiFailure');
};

/** 确定性伪随机（不用 Math.random：失败可复现） */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index -= 1) {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    const other = state % (index + 1);
    [out[index], out[other]] = [out[other] as T, out[index] as T];
  }
  return out;
}

describe('compileRenderPlan：确定性与 planHash', () => {
  it('输入实体顺序打乱 50 次 → 计划逐字节一致；revision 不进入 planHash；内容变化改变哈希', () => {
    const base = input({
      tracks: [track('v1', 'VIDEO', 0), track('v2', 'VIDEO', 3), track('a1', 'AUDIO', 1), track('c1', 'CAPTION', 2)],
      clips: [clip('vc1', 'v1', r(0, 2_000)), clip('vc2', 'v1', r(2_000, 4_000)), clip('vc3', 'v2', r(500, 1_500), { assetVersionId: 'av2' })],
      captions: [caption('cap2', r(1_000, 2_000)), caption('cap1', r(0, 1_000))],
    });
    const plan = compileRenderPlan(base);
    for (let seed = 1; seed <= 50; seed += 1) {
      const again = compileRenderPlan({ ...base, tracks: shuffled(base.tracks, seed), clips: shuffled(base.clips, seed * 7), captions: shuffled(base.captions, seed * 13) });
      expect(again).toEqual(plan);
    }
    expect(plan.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(compileRenderPlan({ ...base, documentRevision: 99 }).planHash).toBe(plan.planHash);
    const faded = compileRenderPlan({ ...base, clips: base.clips.map((item) => (item.id === 'vc1' ? { ...item, parameters: { opacity: 0.5 } } : item)) });
    expect(faded.planHash).not.toBe(plan.planHash);
    expect(faded.requirements).toContain('PER_SEGMENT_OPACITY');
  });

  it('视频层自下而上（position 升序），层内按序列起点排序；多层 → MULTI_TRACK_COMPOSITE；源事实只列被用到的版本', () => {
    const plan = compileRenderPlan(input({
      tracks: [track('v2', 'VIDEO', 3), track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1)],
      clips: [clip('late', 'v1', r(3_000, 4_000)), clip('early', 'v1', r(0, 1_000)), clip('top', 'v2', r(0, 1_000))],
    }));
    expect(plan.videoLayers.map((layer) => layer.trackId)).toEqual(['v1', 'v2']);
    expect(plan.videoLayers[0]!.segments.map((segment) => segment.clipId)).toEqual(['early', 'late']);
    expect(plan.requirements).toEqual(['MULTI_TRACK_COMPOSITE']);
    expect(plan.sources).toEqual([{ assetVersionId: 'av1', assetId: 'ast1', checksumSha256: 'c'.repeat(64), hasAudio: true }]);
  });

  it('隐藏视频轨/字幕轨被排除并显式列出（不静默丢弃）', () => {
    const plan = compileRenderPlan(input({
      tracks: [track('v1', 'VIDEO', 0), track('v2', 'VIDEO', 1, { hidden: true }), track('c1', 'CAPTION', 2, { hidden: true })],
      clips: [clip('vc1', 'v1', r(0, 1_000)), clip('hiddenClip', 'v2', r(0, 1_000))],
      captions: [caption('cap1', r(0, 1_000))],
    }));
    expect(plan.excludedTrackIds).toEqual(['v2', 'c1']);
    expect(plan.warnings).toEqual(['hidden video tracks excluded: v2', 'hidden caption tracks excluded: c1']);
    expect(plan.videoLayers.flatMap((layer) => layer.segments.map((segment) => segment.clipId))).toEqual(['vc1']);
    expect(plan.captions).toEqual([]);
  });
});

describe('compileRenderPlan：音频', () => {
  it('音频轨片段 → CLIP_AUDIO；绑定到 AV 组任一片段的区域接管整组音频（不叠声）', () => {
    const av = { avGroupId: 'grp1' };
    const withoutRegion = compileRenderPlan(input({ clips: [clip('vc1', 'v1', r(0, 2_000), av), clip('ac1', 'a1', r(0, 2_000), av)] }));
    expect(withoutRegion.audio.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['CLIP_AUDIO:ac1']);
    expect(withoutRegion.requirements).toEqual([]);

    const withRegion = compileRenderPlan(input({
      clips: [clip('vc1', 'v1', r(0, 2_000), av), clip('ac1', 'a1', r(0, 2_000), av)],
      audioRegions: [region('reg1', 'vc1', r(0, 2_000), r(0, 2_000), { gainDb: -6 })],
    }));
    expect(withRegion.audio.map((entry) => `${entry.kind}:${entry.id}`)).toEqual(['REGION:reg1']);
    expect(withRegion.requirements).toEqual(['AUDIO_GAIN_FADE_PAN']);
  });

  it('CLIP_LOCAL 区域的 sourceRange 是**源时钟**（按所绑片段映射），不是片段局部时间', () => {
    const plan = compileRenderPlan(input({
      clips: [clip('vc1', 'v1', r(10_000, 14_000), { sourceRange: r(5_000, 9_000) })],
      audioRegions: [region('reg1', 'vc1', r(1_000, 3_000), r(11_000, 13_000))],
    }));
    const entry = plan.audio[0]!;
    expect(entry.sequenceRange).toEqual(r(11_000, 13_000));
    expect(entry.sourceRange.start).toEqual(t(6_000));
    expect(entry.sourceRange.end).toEqual(t(8_000));
    expect(entry.sourceVersionId).toBe('av1');
  });

  it('静音/独奏归一化可听性；不可听条目的源不可播放不阻断，可听条目的源不可播放 fail-closed', () => {
    const tracks = [track('v1', 'VIDEO', 0), track('a1', 'AUDIO', 1, { muted: true }), track('a2', 'AUDIO', 2)];
    const clips = [clip('vc1', 'v1', r(0, 1_000)), clip('ac1', 'a1', r(0, 1_000), { assetVersionId: 'broken' }), clip('ac2', 'a2', r(0, 1_000))];
    const sources = new Map([['av1', ready('ast1')], ['broken', ready('astB', { status: 'PROCESSING' })]]);
    const plan = compileRenderPlan(input({ tracks, clips, sources }));
    expect(plan.audio.map((entry) => [entry.id, entry.audible])).toEqual([['ac1', false], ['ac2', true]]);

    const solo = compileRenderPlan(input({ tracks: tracks.map((item) => (item.id === 'a2' ? { ...item, solo: true } : item)), clips, sources }));
    expect(solo.audio.map((entry) => [entry.id, entry.audible])).toEqual([['ac1', false], ['ac2', true]]);

    const unmuted = failure(() => compileRenderPlan(input({ tracks: tracks.map((item) => ({ ...item, muted: false })), clips, sources })));
    expect(unmuted.details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE, clipId: 'ac1', assetVersionId: 'broken' });
  });

  it('区域绑定的片段不存在 → SOURCE_NOT_PLAYABLE（不输出空源 ID）', () => {
    const error = failure(() => compileRenderPlan(input({ audioRegions: [region('orphan', 'missing', r(0, 1_000), r(0, 1_000))] })));
    expect(error.httpStatus).toBe(409);
    expect(error.details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE, audioRegionId: 'orphan', cause: 'AUDIO_SOURCE_UNRESOLVED' });
  });

  it('同轨可听条目重叠 → AUDIO_CROSSFADE', () => {
    const plan = compileRenderPlan(input({
      clips: [clip('vc1', 'v1', r(0, 2_000)), clip('vc2', 'v1', r(2_000, 4_000))],
      audioRegions: [
        region('left', 'vc1', r(0, 2_000), r(0, 2_000), { fadeOut: t(500) }),
        region('right', 'vc2', r(0, 2_000), r(2_000, 4_000), { fadeIn: t(500) }),
        region('overlap', 'vc2', r(0, 500), r(2_000, 2_500)),
      ],
    }));
    expect(plan.requirements).toEqual(['AUDIO_CROSSFADE', 'AUDIO_GAIN_FADE_PAN']);
  });
});

describe('compileRenderPlan：需求推导与 fail-closed', () => {
  it('空时间线 409 EMPTY_TIMELINE；视频源不可播放 409 SOURCE_NOT_PLAYABLE', () => {
    expect(failure(() => compileRenderPlan(input({ clips: [] }))).details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.EMPTY_TIMELINE });
    for (const facts of [ready('x', { status: 'PROCESSING' }), ready('x', { checksumSha256: null }), ready('x', { stored: false }), ready('x', { durationKnown: false })]) {
      const error = failure(() => compileRenderPlan(input({ sources: new Map([['av1', facts]]) })));
      expect(error.details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE, clipId: 'vc1' });
    }
    // 不属于本工作区（不在源事实表中）同样不可播放
    expect(failure(() => compileRenderPlan(input({ sources: new Map() }))).details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE });
  });

  it('字幕、图形元素、关键帧（只计本计划内元素）、变速、嵌套序列都进入 requirements', () => {
    const plan = compileRenderPlan(input({
      tracks: [track('v1', 'VIDEO', 0), track('g1', 'GRAPHIC', 1), track('c1', 'CAPTION', 2)],
      clips: [
        clip('vc1', 'v1', r(0, 2_000), { sourceRange: r(0, 4_000), timeMapping: { ...IDENTITY, rate: { num: 2, den: 1 } } }),
        clip('nested', 'v1', r(2_000, 3_000), { assetVersionId: null, nestedSequenceId: 'seq2' }),
      ],
      captions: [caption('cap1', r(0, 1_000))],
      visualObjects: [{ id: 'vo1', sequenceId: 'seq', trackId: 'g1' }, { id: 'other-seq', sequenceId: 'seq9', trackId: 'g1' }],
      animationBindings: [
        { id: 'anim1', sequenceId: 'seq', targetKind: 'CLIP', targetId: 'vc1', propertyPath: 'opacity' },
        { id: 'stale', sequenceId: 'seq', targetKind: 'CLIP', targetId: 'deleted', propertyPath: 'opacity' },
      ],
    }));
    expect(plan.requirements).toEqual(['CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER', 'KEYFRAME_ANIMATION', 'NESTED_SEQUENCE', 'TIME_REMAP']);
    expect(plan.graphicsElementIds).toEqual(['vo1']);
    expect(plan.animatedTargets.map((target) => target.bindingId)).toEqual(['anim1']);
    expect(plan.warnings).toContain('nested sequence clip not compiled: nested');
  });

  it('后端裁决：未声明支持的需求一律视为不支持 → 501，列出全部缺失项', () => {
    const plan = compileRenderPlan(input({
      tracks: [track('v1', 'VIDEO', 0), track('g1', 'GRAPHIC', 1), track('c1', 'CAPTION', 2)],
      captions: [caption('cap1', r(0, 1_000))],
      visualObjects: [{ id: 'vo1', sequenceId: 'seq', trackId: 'g1' }],
    }));
    const baseline: PlaybackCapabilities = { backend: 'HTML_MEDIA_BASELINE', videoPrecision: 'KEYFRAME_APPROXIMATE', audioPrecision: 'FRAME_ACCURATE', supported: ['CAPTIONS_BURNED_IN'], unsupported: ['GRAPHICS_COMPONENT_RENDER'] };
    expect(unsupportedRenderRequirements(plan, baseline)).toEqual(['GRAPHICS_COMPONENT_RENDER']);
    const error = failure(() => assertRenderPlanSupported(plan, baseline));
    expect(error.httpStatus).toBe(501);
    expect(error.details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY, capability: 'GRAPHICS_COMPONENT_RENDER', capabilities: ['GRAPHICS_COMPONENT_RENDER'], objectCount: 1 });
    // 声明为支持但同时列入 unsupported → 仍不支持
    expect(unsupportedRenderRequirements(plan, { ...baseline, supported: ['CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER'] })).toEqual(['GRAPHICS_COMPONENT_RENDER']);
    // 什么都不声明 → 全部不支持
    expect(unsupportedRenderRequirements(plan, { ...baseline, supported: [], unsupported: [] })).toEqual(['CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER']);
  });
});

describe('RenderPlan 消费者投影', () => {
  const capabilities: PlaybackCapabilities = {
    backend: 'SERVER_PRECOMPOSED', videoPrecision: 'FRAME_ACCURATE', audioPrecision: 'FRAME_ACCURATE',
    supported: ['PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE', 'CAPTIONS_BURNED_IN', 'MULTI_TRACK_COMPOSITE'],
    unsupported: [],
  };

  it('播放快照回带 planHash 与 revision，资产 ID/源含音频取自计划的源事实', () => {
    const plan = compileRenderPlan(input({ clips: [clip('vc1', 'v1', r(0, 1_000)), clip('vc2', 'v1', r(1_000, 2_000), { assetVersionId: 'av2' })] }));
    const snapshot = playbackSnapshotFromRenderPlan(plan, capabilities);
    expect(snapshot.planHash).toBe(plan.planHash);
    expect(snapshot.documentRevision).toBe(7);
    expect(snapshot.videoSegments.map((segment) => [segment.clipId, segment.assetId, segment.sourceHasAudio])).toEqual([['vc1', 'ast1', true], ['vc2', 'ast2', false]]);
    expect(serverSynthesisPlanFromSnapshot(snapshot).planHash).toBe(plan.planHash);
  });

  it('服务端合成计划按精确 BigInt ticks 排序（超过 2^53 的 ticks 不丢精度）', () => {
    const NS = { num: 1, den: 1_000_000_000 };
    const big = (ticks: bigint) => ({ ticks: String(ticks), timebase: NS });
    const base = 9_007_199_254_740_992n; // 2^53：Number 无法区分 base 与 base + 1
    const plan = compileRenderPlan(input({
      sequence: { id: 'seq', duration: big(base * 2n), frameRate: { num: 30, den: 1 } },
      tracks: [track('v1', 'VIDEO', 0), track('v2', 'VIDEO', 1)],
      clips: [
        clip('second', 'v1', { start: big(base + 1n), end: big(base + 1_000_000_001n) }),
        clip('first', 'v2', { start: big(base), end: big(base + 1_000_000_000n) }),
      ],
    }));
    const synthesis = serverSynthesisPlanFromSnapshot(playbackSnapshotFromRenderPlan(plan, capabilities));
    expect(synthesis.segments.map((segment) => segment.clipId)).toEqual(['first', 'second']);
  });
});
