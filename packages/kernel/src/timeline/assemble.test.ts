import { describe, expect, it } from 'vitest';
import { ApiFailure, type EditOperation, type MediaRange } from '@ancs/contracts';
import { applyKernelResult, applyTimelineOperation, assembleChapters, type KernelCaption, type KernelClip, type KernelContext, type KernelTimelineOperation, type KernelTrack, type TimelineState } from '../index.js';

/** V6-10 S1：分章拼装是纯函数；产出的操作再交给同一内核执行，所以测试同时证明"内核接受这些操作"。 */

const MS = { num: 1, den: 1000 };
const t = (ticks: number) => ({ ticks: String(ticks), timebase: MS });
const r = (start: number, end: number): MediaRange => ({ start: t(start), end: t(end) });
const IDENTITY = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };

function ids(prefix: string): KernelContext {
  let next = 0;
  return { newId: (kind) => `${kind}_${prefix}${String((next += 1)).padStart(3, '0')}` };
}

const track = (id: string, sequenceId: string, kind: string, position: number, name: string): KernelTrack =>
  ({ id, sequenceId, kind, position, name, locked: false, muted: false, hidden: false, solo: false, syncLocked: false });

const clip = (id: string, sequenceId: string, trackId: string, sequence: MediaRange, source: MediaRange, extra: Partial<KernelClip> = {}): KernelClip => ({
  id, sequenceId, trackId, assetVersionId: 'av_1', nestedSequenceId: null, sourceStreamId: null,
  sourceRange: source, sequenceRange: sequence, timeMapping: IDENTITY, avGroupId: null, parentClipId: null, parameters: null, ...extra,
});

const caption = (id: string, sequenceId: string, trackId: string, sequence: MediaRange, text: string, binding: { basis: string; clipId: string | null } = { basis: 'SEQUENCE', clipId: null }): KernelCaption => ({
  id, sequenceId, trackId, timeBinding: { ...binding, semanticCueId: null }, localRange: r(0, Number(sequence.end.ticks) - Number(sequence.start.ticks)),
  sequenceRange: sequence, text, languageTag: 'zh-CN', style: { schemaVersion: '1.0', values: {} }, words: [], speechAnchorId: null,
});

const FX_TRANSFORM = { position: { x: 0.25, y: -0.1 }, scale: { x: 0.5, y: 0.5 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } };

/** 主序列 + 三章：第一章是一对完全一致的画面与声音 + 字幕；第二章画面与声音长度不同、一条特效、绑在片段上的字幕；第三章是空的 */
function state(extra: { mainClips?: KernelClip[]; chapterClips?: KernelClip[] } = {}): TimelineState {
  return {
    sequences: new Map([
      ['seq_main', { id: 'seq_main', duration: t(1_000) }],
      ['seq_c1', { id: 'seq_c1', duration: t(10_000) }],
      ['seq_c2', { id: 'seq_c2', duration: t(10_000) }],
      ['seq_c3', { id: 'seq_c3', duration: t(10_000) }],
    ]),
    tracks: [
      track('trk_mv', 'seq_main', 'VIDEO', 0, 'V1'), track('trk_ma', 'seq_main', 'AUDIO', 1, 'A1'), track('trk_mc', 'seq_main', 'CAPTION', 2, 'C1'),
      track('trk_1v', 'seq_c1', 'VIDEO', 0, 'V1'), track('trk_1a', 'seq_c1', 'AUDIO', 1, 'A1'), track('trk_1c', 'seq_c1', 'CAPTION', 2, 'C1'),
      track('trk_2v', 'seq_c2', 'VIDEO', 0, 'V1'), track('trk_2a', 'seq_c2', 'AUDIO', 1, 'A1'), track('trk_2c', 'seq_c2', 'CAPTION', 2, 'C1'),
      track('trk_2fx', 'seq_c2', 'VIDEO', 3, 'FX1'),
    ],
    clips: [
      ...(extra.mainClips ?? []),
      clip('clp_1v', 'seq_c1', 'trk_1v', r(0, 3_000), r(5_000, 8_000), { avGroupId: 'g1' }),
      clip('clp_1a', 'seq_c1', 'trk_1a', r(0, 3_000), r(5_000, 8_000), { avGroupId: 'g1' }),
      clip('clp_2v', 'seq_c2', 'trk_2v', r(0, 2_000), r(10_000, 12_000), { avGroupId: 'g2' }),
      clip('clp_2a', 'seq_c2', 'trk_2a', r(0, 1_500), r(10_000, 11_500), { avGroupId: 'g2' }),
      clip('clp_2fx', 'seq_c2', 'trk_2fx', r(500, 1_500), r(0, 1_000), { assetVersionId: 'av_fx', parameters: { schemaVersion: '1.0', transform: FX_TRANSFORM, opacity: 0.8 } }),
      ...(extra.chapterClips ?? []),
    ],
    audioRegions: [],
    captions: [
      caption('cap_1', 'seq_c1', 'trk_1c', r(500, 2_000), '出发'),
      caption('cap_2', 'seq_c2', 'trk_2c', r(200, 1_800), '冰川', { basis: 'CLIP_LOCAL', clipId: 'clp_2v' }),
    ],
    locks: new Map(),
    sources: {
      assetVersions: new Map([
        ['av_1', { status: 'READY', durationMs: 60_000, checksumSha256: 'a'.repeat(64), hasAudio: true }],
        ['av_fx', { status: 'READY', durationMs: 5_000, checksumSha256: 'b'.repeat(64), hasAudio: false }],
      ]),
    },
    policy: { preserveOriginalSpeech: false },
  };
}

const CHAPTERS = [{ id: 'c1', sequenceId: 'seq_c1' }, { id: 'c2', sequenceId: 'seq_c2' }, { id: 'c3', sequenceId: 'seq_c3' }];

function applyAll(start: TimelineState, operations: EditOperation[]): TimelineState {
  const ctx = ids('apply');
  return operations.reduce((current, operation) => applyKernelResult(current, applyTimelineOperation(current, operation as KernelTimelineOperation, ctx)), start);
}

const span = (range: unknown) => { const value = range as MediaRange; return [Number(value.start.ticks), Number(value.end.ticks)]; };
const onMain = <T extends { sequenceId: string }>(items: readonly T[]) => items.filter((item) => item.sequenceId === 'seq_main');

describe('V6-10 S1 分章拼装（assembleChapters）', () => {
  it('按顺序紧接着拼进主序列；随画面的声音、长度不同的一对、特效轨与参数、字幕都原样归位；空章长度为 0', () => {
    const before = state();
    const assembly = assembleChapters(before, { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('asm'));
    expect(assembly.chapters.map((chapter) => [chapter.id, Number(chapter.start.ticks), Number(chapter.end.ticks), chapter.videoClips, chapter.captions]))
      .toEqual([['c1', 0, 3_000, 1, 1], ['c2', 3_000, 5_000, 2, 1], ['c3', 5_000, 5_000, 0, 0]]);

    const after = applyAll(before, assembly.operations);
    expect(Number(after.sequences.get('seq_main')!.duration.ticks)).toBe(5_000);
    const clips = onMain(after.clips);
    const trackName = (id: string) => after.tracks.find((item) => item.id === id)!.name;
    expect(clips.map((item) => [trackName(item.trackId), item.assetVersionId, span(item.sequenceRange), span(item.sourceRange)]).sort())
      .toEqual([
        ['A1', 'av_1', [0, 3_000], [5_000, 8_000]],
        ['A1', 'av_1', [3_000, 4_500], [10_000, 11_500]],
        ['FX1', 'av_fx', [3_500, 4_500], [0, 1_000]],
        ['V1', 'av_1', [0, 3_000], [5_000, 8_000]],
        ['V1', 'av_1', [3_000, 5_000], [10_000, 12_000]],
      ].sort());
    // 两对画面与声音都关联着（一对由插入重建；长度不同的一对分别插入后恢复关联）
    const groupOf = (trackKind: string, start: number) => clips.find((item) => after.tracks.find((tr) => tr.id === item.trackId)!.kind === trackKind && span(item.sequenceRange)[0] === start)!.avGroupId;
    expect(groupOf('VIDEO', 0)).not.toBeNull();
    expect(groupOf('VIDEO', 0)).toBe(groupOf('AUDIO', 0));
    expect(groupOf('VIDEO', 3_000)).not.toBeNull();
    expect(groupOf('VIDEO', 3_000)).toBe(groupOf('AUDIO', 3_000));
    // 特效轨按名称新建在主序列，变换与透明度保留
    const fxTrack = onMain(after.tracks).find((item) => item.name === 'FX1')!;
    expect([fxTrack.kind, fxTrack.position]).toEqual(['VIDEO', 3]);
    expect(clips.find((item) => item.trackId === fxTrack.id)!.parameters).toMatchObject({ transform: FX_TRANSFORM, opacity: 0.8 });
    // 字幕：时间平移、文字保留；绑在片段上的字幕改绑到复制出来的那条片段
    const captions = onMain(after.captions);
    expect(captions.map((item) => [item.text, span(item.sequenceRange)])).toEqual([['出发', [500, 2_000]], ['冰川', [3_200, 4_800]]]);
    const glacier = captions.find((item) => item.text === '冰川')!;
    const glacierClip = clips.find((item) => item.id === (glacier.timeBinding as { clipId: string }).clipId)!;
    expect(span(glacierClip.sequenceRange)).toEqual([3_000, 5_000]);
    // 各章子序列原样不动（拼装只读状态）
    expect(after.clips.filter((item) => item.sequenceId !== 'seq_main')).toEqual(before.clips);
  });

  it('主序列已有内容时从它的末尾接着排；主序列已有的同名轨道直接复用，不重复新建', () => {
    const existing = clip('clp_m', 'seq_main', 'trk_mv', r(0, 1_000), r(0, 1_000));
    const before = state({ mainClips: [existing] });
    const assembly = assembleChapters(before, { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1) }, ids('asm'));
    expect(assembly.chapters.map((chapter) => [Number(chapter.start.ticks), Number(chapter.end.ticks)])).toEqual([[1_000, 4_000]]);
    expect(assembly.operations.filter((operation) => operation.op === 'create_track')).toEqual([]);
    const after = applyAll(before, assembly.operations);
    expect(onMain(after.clips).map((item) => span(item.sequenceRange)).sort()).toEqual([[0, 1_000], [1_000, 4_000], [1_000, 4_000]].sort());
  });

  it('不认识的内容直接报错而不是悄悄丢掉：变速片段、独立音频区域、时基不同的章节', () => {
    const reasonOf = (fn: () => unknown): unknown => { try { fn(); } catch (error) { return error instanceof ApiFailure ? [error.details['reason'], error.details['chapterId']] : error; } return null; };
    const fast = clip('clp_fast', 'seq_c1', 'trk_1v', r(5_000, 6_000), r(20_000, 22_000), { timeMapping: { ...IDENTITY, rate: { num: 2, den: 1 } } });
    expect(reasonOf(() => assembleChapters(state({ chapterClips: [fast] }), { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('x')))).toEqual(['CHAPTER_CONTENT_UNSUPPORTED', 'c1']);
    const withRegion: TimelineState = { ...state(), audioRegions: [{ id: 'ar_1', sequenceId: 'seq_c2', trackId: 'trk_2a', timeBinding: {}, localRange: r(0, 100), sequenceRange: r(0, 100), sourceStreamId: 's', channelMapping: {}, gainDb: 0, pan: 0, fadeIn: t(0), fadeOut: t(0), parameters: null }] };
    expect(reasonOf(() => assembleChapters(withRegion, { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('x')))).toEqual(['CHAPTER_CONTENT_UNSUPPORTED', 'c2']);
    const otherBase = state();
    const sequences = new Map(otherBase.sequences);
    sequences.set('seq_c3', { id: 'seq_c3', duration: { ticks: '300', timebase: { num: 1, den: 30 } } });
    expect(reasonOf(() => assembleChapters({ ...otherBase, sequences }, { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('x')))).toEqual(['CHAPTER_TIMEBASE_MISMATCH', 'c3']);
  });

  it('S5 插在中间：位置之后的片段（连同随画面的声音）与字幕整体后移，章节放进空出来的位置；返回复制出来的片段 id', () => {
    // 主序列：前一章 [0, 1000)（一对画面与声音）、后一章 [1000, 2500)（一对画面与声音 + 绑在片段上的字幕 + 一条独立字幕）
    const before = state({
      mainClips: [
        clip('clp_pv', 'seq_main', 'trk_mv', r(0, 1_000), r(0, 1_000), { avGroupId: 'gp' }),
        clip('clp_pa', 'seq_main', 'trk_ma', r(0, 1_000), r(0, 1_000), { avGroupId: 'gp' }),
        clip('clp_nv', 'seq_main', 'trk_mv', r(1_000, 2_500), r(30_000, 31_500), { avGroupId: 'gn' }),
        clip('clp_na', 'seq_main', 'trk_ma', r(1_000, 2_500), r(30_000, 31_500), { avGroupId: 'gn' }),
      ],
    });
    const sequences = new Map(before.sequences);
    sequences.set('seq_main', { id: 'seq_main', duration: t(2_500) });
    const withCaptions: TimelineState = {
      ...before,
      sequences,
      captions: [
        ...before.captions,
        caption('cap_n', 'seq_main', 'trk_mc', r(1_200, 2_000), '湖边', { basis: 'CLIP_LOCAL', clipId: 'clp_nv' }),
        caption('cap_end', 'seq_main', 'trk_mc', r(2_100, 2_400), '完'),
      ],
    };
    const assembly = assembleChapters(withCaptions, { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1), at: t(1_000) }, ids('asm'));
    expect(assembly.chapters.map((chapter) => [chapter.id, Number(chapter.start.ticks), Number(chapter.end.ticks), chapter.clipIds.length])).toEqual([['c1', 1_000, 4_000, 2]]);
    // 关联的一对只移一条（另一条由内核跟着移）
    expect(assembly.operations.filter((operation) => operation.op === 'move_clip')).toHaveLength(1);

    const after = applyAll(withCaptions, assembly.operations);
    expect(Number(after.sequences.get('seq_main')!.duration.ticks)).toBe(5_500);
    const placed = onMain(after.clips).map((item) => [item.id, item.trackId, span(item.sequenceRange), span(item.sourceRange)]);
    expect(placed.filter(([id]) => id === 'clp_pv' || id === 'clp_pa').map(([, , at]) => at)).toEqual([[0, 1_000], [0, 1_000]]);
    expect(placed.filter(([id]) => id === 'clp_nv' || id === 'clp_na').map(([, , at, source]) => [at, source])).toEqual([[[4_000, 5_500], [30_000, 31_500]], [[4_000, 5_500], [30_000, 31_500]]]);
    const inserted = placed.filter(([id]) => assembly.chapters[0]!.clipIds.includes(id as string));
    expect(inserted.map(([, , at, source]) => [at, source])).toEqual([[[1_000, 4_000], [5_000, 8_000]], [[1_000, 4_000], [5_000, 8_000]]]);
    expect(onMain(after.captions).map((item) => [item.text, span(item.sequenceRange)]).sort()).toEqual([['出发', [1_500, 3_000]], ['完', [5_100, 5_400]], ['湖边', [4_200, 5_000]]].sort());
  });

  it('S5 插在中间：位置落在片段中间、或画面与声音分在两边时报错（不切开用户的内容）', () => {
    const reasonOf = (fn: () => unknown): unknown => { try { fn(); } catch (error) { return error instanceof ApiFailure ? [error.details['reason'], error.details['objectId']] : error; } return null; };
    const long = clip('clp_long', 'seq_main', 'trk_mv', r(0, 1_000), r(0, 1_000));
    expect(reasonOf(() => assembleChapters(state({ mainClips: [long] }), { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1), at: t(500) }, ids('x')))).toEqual(['CHAPTER_POSITION_UNSUPPORTED', 'clp_long']);
    const jCut = [
      clip('clp_jv', 'seq_main', 'trk_mv', r(500, 1_000), r(0, 500), { avGroupId: 'gj' }),
      clip('clp_ja', 'seq_main', 'trk_ma', r(0, 500), r(0, 500), { avGroupId: 'gj' }),
    ];
    expect(reasonOf(() => assembleChapters(state({ mainClips: jCut }), { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1), at: t(500) }, ids('x')))).toEqual(['CHAPTER_POSITION_UNSUPPORTED', 'clp_jv']);
    expect(reasonOf(() => assembleChapters(state({ mainClips: [long] }), { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1), at: t(2_000) }, ids('x')))).toEqual(['CHAPTER_POSITION_UNSUPPORTED', null]);
    // 正好在末尾 = 接在末尾
    const atEnd = assembleChapters(state({ mainClips: [long] }), { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1), at: t(1_000) }, ids('x'));
    expect(atEnd).toEqual(assembleChapters(state({ mainClips: [long] }), { mainSequenceId: 'seq_main', chapters: CHAPTERS.slice(0, 1) }, ids('x')));
  });

  it('确定性：同样的状态与 id 序列得到同样的操作', () => {
    const one = assembleChapters(state(), { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('asm'));
    const two = assembleChapters(state(), { mainSequenceId: 'seq_main', chapters: CHAPTERS }, ids('asm'));
    expect(two).toEqual(one);
  });
});
