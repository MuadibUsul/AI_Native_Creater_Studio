import { ApiFailure, ERROR_CODES, mediaRangeSchema, visualParametersSchema, type EditOperation, type MediaRange, type MediaTime } from '@ancs/contracts';
import { exactTicks, identityForwardMapping, mediaTimeOf, rangeOf, ticksInRange, timeFraction } from './support.js';
import type { KernelCaption, KernelClip, KernelContext, KernelTrack, TimelineState } from './types.js';

/**
 * V6-10（AP-06，`docs/V06/milestones/V6-10.md`）：把分章剪好的子序列按成片顺序拼进主序列。
 *
 * - 只读 `state`，产出普通编辑操作（由同一内核验证、走同一提案与采用），不直接改状态；
 * - 各章紧接着排：第一章从主序列现有内容的末尾开始，每章占它的内容长度，不留空档、不重叠；
 * - 复制片段（随画面的声音按原样重新关联，含长度不同的 J / L 剪辑对）、片段参数（变换 / 裁切 / 透明度）、字幕；
 *   轨道按"种类 + 名称"对应到主序列（没有就新建），所以特效轨、讲述轨各自归位；
 * - 拼装器不认识的内容（变速片段、嵌套序列、独立音频区域、组件自定义参数、按语义点定时的字幕）
 *   直接报错，不悄悄丢掉：调用方据此把这一章记为没拼进去，并如实说明。
 */
export interface ChapterAssemblyRequest {
  mainSequenceId: string;
  /** 按成片顺序 */
  chapters: readonly { id: string; sequenceId: string }[];
}

export interface AssembledChapter {
  id: string;
  /** 本章在主序列上的位置（主序列时基）；空章的起止相同 */
  start: MediaTime;
  end: MediaTime;
  videoClips: number;
  captions: number;
}

export interface ChapterAssembly {
  operations: EditOperation[];
  chapters: AssembledChapter[];
}

export const CHAPTER_ASSEMBLY_ERROR_REASONS = {
  SEQUENCE_NOT_FOUND: 'CHAPTER_SEQUENCE_NOT_FOUND',
  TIMEBASE_MISMATCH: 'CHAPTER_TIMEBASE_MISMATCH',
  UNSUPPORTED_CONTENT: 'CHAPTER_CONTENT_UNSUPPORTED',
} as const;

const unsupported = (chapterId: string, what: string, objectId: string): ApiFailure =>
  new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `chapter ${chapterId}: ${what} cannot be assembled yet`, 422, {
    reason: CHAPTER_ASSEMBLY_ERROR_REASONS.UNSUPPORTED_CONTENT, chapterId, objectId, what,
  });

const sameRange = (left: MediaRange, right: MediaRange, timebase: { num: number; den: number }): boolean => {
  const a = ticksInRange(left, timebase);
  const b = ticksInRange(right, timebase);
  return a.start === b.start && a.end === b.end;
};

const DEFAULT_PARAMETERS = visualParametersSchema.parse({});

export function assembleChapters(state: TimelineState, request: ChapterAssemblyRequest, ctx: KernelContext): ChapterAssembly {
  const main = state.sequences.get(request.mainSequenceId);
  if (main === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'main sequence not found', 404, { reason: CHAPTER_ASSEMBLY_ERROR_REASONS.SEQUENCE_NOT_FOUND, sequenceId: request.mainSequenceId });
  }
  const timebase = main.duration.timebase;
  const sameTimebase = (time: MediaTime): boolean => time.timebase.num * timebase.den === timebase.num * time.timebase.den;
  const contentEnd = (sequenceId: string): bigint => {
    let end = 0n;
    for (const item of [...state.clips, ...state.captions, ...state.audioRegions]) {
      if (item.sequenceId !== sequenceId) continue;
      const span = ticksInRange(mediaRangeSchema.parse(item.sequenceRange), timebase);
      if (span.end > end) end = span.end;
    }
    return end;
  };

  const operations: EditOperation[] = [];
  const contentOps: EditOperation[] = [];
  // 轨道：种类 + 名称 → 主序列轨道 id（已有的直接用，没有的新建一次，各章共用）
  const mainTracks = state.tracks.filter((track) => track.sequenceId === main.id);
  const trackByKey = new Map(mainTracks.map((track) => [`${track.kind}\u0000${track.name}`, track.id]));
  let nextPosition = mainTracks.reduce((max, track) => Math.max(max, track.position), -1) + 1;
  const mainTrackFor = (track: KernelTrack): string => {
    const key = `${track.kind}\u0000${track.name}`;
    const existing = trackByKey.get(key);
    if (existing !== undefined) return existing;
    const id = ctx.newId('trk');
    operations.push({
      op: 'create_track', sequenceId: main.id, restoreTrackId: id,
      track: { kind: track.kind, position: nextPosition, name: track.name, ...(track.muted ? { muted: true } : {}), ...(track.hidden ? { hidden: true } : {}) },
    } as EditOperation);
    nextPosition += 1;
    trackByKey.set(key, id);
    return id;
  };

  let offset = contentEnd(main.id);
  const chapters: AssembledChapter[] = [];
  for (const chapter of request.chapters) {
    const sequence = state.sequences.get(chapter.sequenceId);
    if (sequence === undefined) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, `chapter ${chapter.id}: sequence not found`, 404, { reason: CHAPTER_ASSEMBLY_ERROR_REASONS.SEQUENCE_NOT_FOUND, chapterId: chapter.id, sequenceId: chapter.sequenceId });
    }
    if (!sameTimebase(sequence.duration)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `chapter ${chapter.id}: timebase differs from the main sequence`, 422, { reason: CHAPTER_ASSEMBLY_ERROR_REASONS.TIMEBASE_MISMATCH, chapterId: chapter.id });
    }
    if (state.audioRegions.some((region) => region.sequenceId === sequence.id)) {
      throw unsupported(chapter.id, 'audio region', state.audioRegions.find((region) => region.sequenceId === sequence.id)!.id);
    }
    const tracks = new Map(state.tracks.filter((track) => track.sequenceId === sequence.id).map((track) => [track.id, track]));
    const clips = state.clips.filter((clip) => clip.sequenceId === sequence.id);
    const captions = state.captions.filter((caption) => caption.sequenceId === sequence.id);
    const shift = (range: MediaRange): MediaRange => {
      const span = ticksInRange(mediaRangeSchema.parse(range), timebase);
      return rangeOf(span.start + offset, span.end + offset, timebase);
    };
    const startOf = (clip: KernelClip): bigint => ticksInRange(mediaRangeSchema.parse(clip.sequenceRange), timebase).start;
    const trackPosition = (clip: KernelClip): number => tracks.get(clip.trackId)?.position ?? 0;
    const ordered = [...clips].sort((left, right) => trackPosition(left) - trackPosition(right) || Number(startOf(left) - startOf(right)) || left.id.localeCompare(right.id));

    for (const clip of ordered) {
      if (clip.nestedSequenceId !== null || clip.assetVersionId === null) throw unsupported(chapter.id, 'nested sequence clip', clip.id);
      if (!identityForwardMapping(clip)) throw unsupported(chapter.id, 'speed-changed clip', clip.id);
      if (Object.keys(visualParametersSchema.parse(clip.parameters ?? {}).values).length > 0) throw unsupported(chapter.id, 'component parameters', clip.id);
    }
    const copied = new Map<string, string>();
    const audioOf = (video: KernelClip): KernelClip | undefined => video.avGroupId === null ? undefined
      : clips.find((other) => other.id !== video.id && other.avGroupId === video.avGroupId && tracks.get(other.trackId)?.kind === 'AUDIO');
    let videoClips = 0;
    for (const clip of ordered) {
      if (copied.has(clip.id)) continue;
      const track = tracks.get(clip.trackId);
      if (track === undefined) throw unsupported(chapter.id, 'clip on an unknown track', clip.id);
      if (track.kind === 'VIDEO') videoClips += 1;
      const sequenceRange = shift(clip.sequenceRange);
      const base = {
        op: 'insert_clip' as const, sequenceId: main.id, trackId: mainTrackFor(track), assetVersionId: clip.assetVersionId, nestedSequenceId: null,
        sourceStreamId: clip.sourceStreamId, sourceRange: mediaRangeSchema.parse(clip.sourceRange), mode: 'OVERWRITE' as const, sequenceStart: sequenceRange.start,
      };
      const id = ctx.newId('clp');
      copied.set(clip.id, id);
      const audio = track.kind === 'VIDEO' ? audioOf(clip) : undefined;
      const audioTrack = audio === undefined ? undefined : tracks.get(audio.trackId);
      if (audio !== undefined && audioTrack !== undefined && !copied.has(audio.id) && audio.assetVersionId === clip.assetVersionId
        && sameRange(mediaRangeSchema.parse(audio.sourceRange), mediaRangeSchema.parse(clip.sourceRange), timebase)
        && sameRange(mediaRangeSchema.parse(audio.sequenceRange), mediaRangeSchema.parse(clip.sequenceRange), timebase)
        && (state.sources.assetVersions.get(clip.assetVersionId!)?.hasAudio ?? false)) {
        // 画面与随画面的声音一模一样：一条插入同时重建这一对（内核新建关联）
        const audioId = ctx.newId('clp');
        copied.set(audio.id, audioId);
        contentOps.push({ ...base, linkAudio: true, audioTrackId: mainTrackFor(audioTrack), createdClipId: id, createdAudioClipId: audioId } as EditOperation);
      } else {
        contentOps.push({ ...base, linkAudio: false, audioTrackId: null, createdClipId: id } as EditOperation);
      }
      contentOps.push(...parameterOperations(clip, id));
    }
    // 没能一条插入重建的一对（画面与声音分别剪过，如 J / L 剪辑，长度可以不同）：分别插入后按原样恢复关联。
    // set_av_link 要求等长，所以和撤销一样用底层的 update_clip 写回同一个 avGroupId。
    for (const clip of ordered) {
      const audio = tracks.get(clip.trackId)?.kind === 'VIDEO' ? audioOf(clip) : undefined;
      if (audio === undefined) continue;
      const videoId = copied.get(clip.id)!;
      const audioId = copied.get(audio.id)!;
      const pairedInOneInsert = contentOps.some((op) => op.op === 'insert_clip' && (op as { createdAudioClipId?: string }).createdAudioClipId === audioId);
      if (pairedInOneInsert) continue;
      const groupId = ctx.newId('avgp');
      contentOps.push({ op: 'update_clip', clipId: videoId, changes: { avGroupId: groupId } } as EditOperation, { op: 'update_clip', clipId: audioId, changes: { avGroupId: groupId } } as EditOperation);
    }
    for (const caption of [...captions].sort((left, right) => compareCaption(left, right, timebase))) {
      const track = tracks.get(caption.trackId);
      if (track === undefined) throw unsupported(chapter.id, 'caption on an unknown track', caption.id);
      const binding = caption.timeBinding as { basis: string; clipId: string | null; semanticCueId: string | null };
      if (binding.basis === 'SEMANTIC_CUE') throw unsupported(chapter.id, 'caption timed to a semantic cue', caption.id);
      const boundClip = binding.clipId === null ? null : copied.get(binding.clipId) ?? null;
      if (binding.clipId !== null && boundClip === null) throw unsupported(chapter.id, 'caption bound to a clip outside the chapter', caption.id);
      contentOps.push({
        op: 'create_caption', sequenceId: main.id, trackId: mainTrackFor(track),
        timeBinding: { basis: binding.basis, clipId: boundClip, semanticCueId: null },
        localRange: mediaRangeSchema.parse(caption.localRange), sequenceRange: shift(caption.sequenceRange),
        text: caption.text, languageTag: caption.languageTag, style: caption.style, words: caption.words, speechAnchorId: caption.speechAnchorId,
        restoreCaptionId: ctx.newId('cap'),
      } as EditOperation);
    }
    const length = contentEnd(sequence.id);
    chapters.push({ id: chapter.id, start: mediaTimeOf(offset, timebase), end: mediaTimeOf(offset + length, timebase), videoClips, captions: captions.length });
    offset += length;
  }

  if (offset > exactTicks(timeFraction(main.duration), timebase)) {
    operations.push({ op: 'set_sequence_duration', sequenceId: main.id, duration: mediaTimeOf(offset, timebase) } as EditOperation);
  }
  return { operations: [...operations, ...contentOps], chapters };
}

/** 片段的变换 / 裁切 / 透明度：只为与缺省值不同的那几项发操作 */
function parameterOperations(clip: KernelClip, clipId: string): EditOperation[] {
  const value = visualParametersSchema.parse(clip.parameters ?? {});
  const differs = (left: unknown, right: unknown): boolean => JSON.stringify(left) !== JSON.stringify(right);
  return [
    ...(differs(value.transform, DEFAULT_PARAMETERS.transform) ? [{ op: 'set_clip_transform', clipId, transform: value.transform } as EditOperation] : []),
    ...(differs(value.crop, DEFAULT_PARAMETERS.crop) ? [{ op: 'set_clip_crop', clipId, crop: value.crop } as EditOperation] : []),
    ...(value.opacity === DEFAULT_PARAMETERS.opacity ? [] : [{ op: 'set_clip_opacity', clipId, opacity: value.opacity } as EditOperation]),
  ];
}

function compareCaption(left: KernelCaption, right: KernelCaption, timebase: { num: number; den: number }): number {
  const a = ticksInRange(mediaRangeSchema.parse(left.sequenceRange), timebase).start;
  const b = ticksInRange(mediaRangeSchema.parse(right.sequenceRange), timebase).start;
  return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
}
