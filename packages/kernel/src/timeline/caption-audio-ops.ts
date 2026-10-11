import {
  AUDIO_MIX_GUARD_REASONS,
  ApiFailure,
  ERROR_CODES,
  captionTextFromWords,
  captionWordTimingSchema,
  compareMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  removeWordRange,
  splitWordsAt,
  timeBindingSchema,
  type MediaTime,
} from '@ancs/contracts';
import { addFractions, subtractFractions, type Fraction } from '@ancs/time';
import {
  WorkingTimeline,
  compareFraction,
  exactTicks,
  identityForwardMapping,
  mediaTimeOf,
  rangeDuration,
  rangeOf,
  refs,
  sequenceSeconds,
  ticksInRange,
  timeFraction,
} from './support.js';
import type { KernelAudioRegion, KernelCaption, KernelClip, KernelContext, KernelTimelineOperation } from './types.js';

type Op<Name extends KernelTimelineOperation['op']> = Extract<KernelTimelineOperation, { op: Name }>;

/**
 * N03-07：把字幕的局部（词条）时间映射到序列时间。
 * 采用等速前向映射（local→sequence 线性），非等速映射的字幕不支持结构性改动（fail-closed）。
 */
function mapCaptionLocalToSequence(caption: KernelCaption, localTime: MediaTime): MediaTime {
  const localRange = mediaRangeSchema.parse(caption.localRange);
  const sequenceRange = mediaRangeSchema.parse(caption.sequenceRange);
  if (compareFraction(rangeDuration(localRange), rangeDuration(sequenceRange)) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption time mapping must be 1:1 to cut content', 422, { reason: 'CAPTION_MAPPING_UNSUPPORTED', captionId: caption.id });
  }
  const seconds = addFractions(timeFraction(sequenceRange.start), subtractFractions(timeFraction(localTime), timeFraction(localRange.start)));
  const timebase = sequenceRange.start.timebase;
  return mediaTimeOf(exactTicks(seconds, timebase), timebase);
}

function findCaption(work: WorkingTimeline, captionId: string): KernelCaption {
  const caption = work.captions.get(captionId);
  if (!caption) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'caption not found', 404);
  return caption;
}

export function createCaption(work: WorkingTimeline, operation: Op<'create_caption'>, ctx: KernelContext): void {
  const captionTrack = work.findTrackOwned(operation.trackId);
  if (captionTrack.sequenceId !== operation.sequenceId || captionTrack.kind !== 'CAPTION') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption requires a CAPTION track in the same sequence', 422, { reason: 'CAPTION_TRACK_MISMATCH' });
  }
  const localRange = mediaRangeSchema.parse(operation.localRange);
  const sequenceRange = mediaRangeSchema.parse(operation.sequenceRange);
  const words = captionWordTimingSchema.array().parse(operation.words ?? []);
  for (const word of words) {
    const wordSpan = mediaRangeSchema.parse(word.range);
    if (compareMediaTime(wordSpan.start, localRange.start) < 0 || compareMediaTime(wordSpan.end, localRange.end) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption word range exceeds the local range', 422, { reason: 'CAPTION_WORD_OUT_OF_BOUNDS' });
    }
  }
  const { durationTicks, timebase } = work.sequenceTimebase(operation.sequenceId);
  const span = ticksInRange(sequenceRange, timebase);
  if (span.start < 0n || span.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption range exceeds sequence duration', 422, { reason: 'CAPTION_OUTSIDE_SEQUENCE' });
  }
  const caption: KernelCaption = {
    id: operation.restoreCaptionId ?? ctx.newId('cap'),
    sequenceId: operation.sequenceId,
    trackId: operation.trackId,
    timeBinding: timeBindingSchema.parse(operation.timeBinding),
    localRange,
    sequenceRange,
    text: operation.text,
    languageTag: operation.languageTag,
    style: operation.style,
    words,
    speechAnchorId: operation.speechAnchorId ?? null,
  };
  work.insertCaption(caption, { action: 'CREATE_CAPTION', objectKind: 'CAPTION', objectId: caption.id, patch: { ...operation } });
}

export function updateCaption(work: WorkingTimeline, operation: Op<'update_caption'>): void {
  const caption = findCaption(work, operation.captionId);
  const changes = operation.changes as {
    text?: unknown; style?: unknown; sequenceRange?: unknown; localRange?: unknown; timeBinding?: unknown; words?: unknown;
  };
  const nextText = typeof changes.text === 'string' ? changes.text : caption.text;
  if (nextText.trim() === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption text must not be empty (delete the caption instead)', 422, { reason: 'CAPTION_TEXT_EMPTY' });
  }
  const nextSequenceRange = changes.sequenceRange === undefined ? mediaRangeSchema.parse(caption.sequenceRange) : mediaRangeSchema.parse(changes.sequenceRange);
  const { durationTicks, timebase } = work.sequenceTimebase(caption.sequenceId);
  const candidate = ticksInRange(nextSequenceRange, timebase);
  if (candidate.start < 0n || candidate.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'caption range exceeds sequence duration', 422, { reason: 'CAPTION_OUTSIDE_SEQUENCE' });
  }
  const next: KernelCaption = {
    ...caption,
    text: nextText,
    style: changes.style === undefined ? caption.style : changes.style,
    sequenceRange: nextSequenceRange,
    // 与旧实现一致：localRange 按请求原样写入（通用 changes 契约），不在此做形状转换
    localRange: changes.localRange === undefined ? caption.localRange : (changes.localRange as KernelCaption['localRange']),
    timeBinding: changes.timeBinding === undefined ? caption.timeBinding : changes.timeBinding,
    words: changes.words === undefined ? caption.words : changes.words,
  };
  work.updateCaption(caption, next, { action: 'UPDATE_CAPTION', objectKind: 'CAPTION', objectId: caption.id, patch: { ...operation } });
}

export function splitCaption(work: WorkingTimeline, operation: Op<'split_caption'>, ctx: KernelContext): void {
  const caption = findCaption(work, operation.captionId);
  const words = captionWordTimingSchema.array().parse(caption.words);
  if (operation.atWordIndex <= 0 || operation.atWordIndex >= words.length) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split index must fall strictly inside the words', 422, { reason: 'SPLIT_INDEX_OUTSIDE_WORDS' });
  }
  const { left, right } = splitWordsAt(words, operation.atWordIndex);
  const boundary = mapCaptionLocalToSequence(caption, left[left.length - 1]!.range.end);
  const sequenceRange = mediaRangeSchema.parse(caption.sequenceRange);
  const leftCaption: KernelCaption = {
    ...caption, text: captionTextFromWords(left), words: left, sequenceRange: mediaRangeSchema.parse({ start: sequenceRange.start, end: boundary }),
  };
  const rightCaption: KernelCaption = {
    ...caption, id: operation.createdCaptionId ?? ctx.newId('cap'), text: captionTextFromWords(right), words: right,
    sequenceRange: mediaRangeSchema.parse({ start: boundary, end: sequenceRange.end }),
  };
  work.updateCaption(caption, leftCaption, null);
  work.insertCaption(rightCaption, null);
  work.emit({
    action: 'SPLIT_CAPTION', objectKind: 'CAPTION', objectId: caption.id,
    patch: { ...operation, createdCaptionId: rightCaption.id },
    snapshots: { before: refs.caption(caption), after: refs.caption(leftCaption), createdCaption: refs.caption(rightCaption) },
  });
}

/**
 * cut_caption_range（N03-07）：删除转写必须明确模式——
 * CAPTION_ONLY 只改字幕文案（时间线分毫不动）；CUT_CONTENT 连内容一起剪，并收缝（字幕跟随、不越界）。
 */
export function cutCaptionRange(work: WorkingTimeline, operation: Op<'cut_caption_range'>, ctx: KernelContext): void {
  const caption = findCaption(work, operation.captionId);
  const words = captionWordTimingSchema.array().parse(caption.words);
  if (operation.wordTo > words.length || operation.wordFrom >= operation.wordTo) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cut range must be inside the words', 422, { reason: 'CUT_RANGE_OUTSIDE_WORDS' });
  }
  const removedWords = words.slice(operation.wordFrom, operation.wordTo);
  const remaining = removeWordRange(words, operation.wordFrom, operation.wordTo);
  const nextText = remaining.length === 0 ? caption.text : captionTextFromWords(remaining);
  if (operation.mode === 'CAPTION_ONLY') {
    work.updateCaption(caption, { ...caption, text: nextText, words: remaining }, {
      action: 'CUT_CAPTION_RANGE', objectKind: 'CAPTION', objectId: caption.id, patch: { ...operation, mode: 'CAPTION_ONLY' },
    });
    return;
  }
  const cutRange = mediaRangeSchema.parse({
    start: mapCaptionLocalToSequence(caption, removedWords[0]!.range.start),
    end: mapCaptionLocalToSequence(caption, removedWords[removedWords.length - 1]!.range.end),
  });
  const { durationTicks, timebase } = work.sequenceTimebase(caption.sequenceId);
  const cutSpan = ticksInRange(cutRange, timebase);
  if (cutSpan.start < 0n || cutSpan.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cut range exceeds sequence duration', 422, { reason: 'CUT_RANGE_OUTSIDE_SEQUENCE' });
  }
  const gapTicks = cutSpan.end - cutSpan.start;
  if (gapTicks <= 0n) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cut range must be non-empty', 422, { reason: 'CUT_RANGE_OUTSIDE_WORDS' });
  }
  const allTracks = work.tracksOfSequence(caption.sequenceId);
  const scopedTracks = operation.closeAcrossTracks ? allTracks : allTracks.filter((track) => track.kind === 'CAPTION' || track.syncLocked);
  assertCutRespectsLocks(work, { caption, scopedTracks, cutSpan, timebase });
  // ① 其他字幕：整体在切口之后 → 左移；被切口完全包含 → 拒绝（不静默删字幕）；与切口相交 → 裁剪 + 删词
  const otherCaptions = [...work.captions.values()].filter((candidate) => candidate.sequenceId === caption.sequenceId && candidate.id !== caption.id);
  for (const candidate of otherCaptions) {
    const span = ticksInRange(candidate.sequenceRange, timebase);
    if (span.start >= cutSpan.end) {
      work.updateCaption(candidate, { ...candidate, sequenceRange: rangeOf(span.start - gapTicks, span.end - gapTicks, timebase) }, {
        action: 'UPDATE_CAPTION', objectKind: 'CAPTION', objectId: candidate.id, patch: { op: 'update_caption', captionId: candidate.id, ripple: true },
      });
      continue;
    }
    if (span.start >= cutSpan.start && span.end <= cutSpan.end) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'cut range fully contains another caption; split or move it first', 409, { reason: 'CUT_CONTAINS_OTHER_CAPTION', captionId: candidate.id });
    }
    if (!(span.start < cutSpan.end && span.end > cutSpan.start)) continue;
    const keptWords = captionWordTimingSchema.array().parse(candidate.words).filter((word) => {
      const mappedTicks = exactTicks(timeFraction(mapCaptionLocalToSequence(candidate, word.range.start)), timebase);
      return mappedTicks < cutSpan.start || mappedTicks >= cutSpan.end;
    });
    const trimmed = rangeOf(
      span.start < cutSpan.start ? span.start : cutSpan.start - gapTicks,
      span.end > cutSpan.end ? span.end - gapTicks : span.end,
      timebase,
    );
    work.updateCaption(candidate, {
      ...candidate, text: keptWords.length === 0 ? candidate.text : captionTextFromWords(keptWords), words: keptWords, sequenceRange: trimmed,
    }, { action: 'UPDATE_CAPTION', objectKind: 'CAPTION', objectId: candidate.id, patch: { op: 'update_caption', captionId: candidate.id, ripple: true, trimmed: true } });
  }
  // ② 目标字幕写回（删词 + 时间轴随收缝左移的净效果）
  const ownSpan = ticksInRange(caption.sequenceRange, timebase);
  const targetAfter: KernelCaption = {
    ...caption, text: nextText, words: remaining,
    sequenceRange: mediaRangeSchema.parse({ start: mediaRangeSchema.parse(caption.sequenceRange).start, end: mediaTimeOf(ownSpan.end - gapTicks, timebase) }),
  };
  work.updateCaption(caption, targetAfter, {
    action: 'CUT_CAPTION_RANGE', objectKind: 'CAPTION', objectId: caption.id,
    patch: { ...operation, mode: 'CUT_CONTENT', cutRange, gapTicks: gapTicks.toString() },
  });
  // ③ 片段收缝：受影响轨道上起点晚于切口的片段整体左移；与切口相交的片段把切口剪掉
  for (const track of scopedTracks) {
    for (const clip of work.clipsOnTrack(track.id)) {
      cutClipForCaption(work, { clip, cutSpan, gapTicks, timebase }, ctx);
    }
  }
}

/**
 * CUT_CONTENT 的锁预检（V5-M1 修复：旧实现收缝时直接改写各轨片段与其它字幕，不检查锁）。
 * 在任何写入之前判定：受影响对象所在轨道被锁 → 409 TRACK_LOCKED；
 * 只需平移的对象锁住 POSITION、需被剪的对象锁住 CONTENT/DURATION/POSITION → 409 EDIT_IMPACT_LOCKED。
 * 切口之前的对象不受影响，不检查。
 */
function assertCutRespectsLocks(
  work: WorkingTimeline,
  input: { caption: KernelCaption; scopedTracks: readonly { id: string; locked: boolean }[]; cutSpan: { start: bigint; end: bigint }; timebase: { num: number; den: number } },
): void {
  const { cutSpan, timebase } = input;
  const dimensionsFor = (span: { start: bigint; end: bigint }) =>
    span.start >= cutSpan.end ? (['POSITION'] as const) : (['CONTENT', 'DURATION', 'POSITION'] as const);
  const assertTrackUnlocked = (trackId: string): void => {
    if (work.tracks.get(trackId)?.locked === true) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED', trackId });
    }
  };
  for (const other of work.captions.values()) {
    if (other.sequenceId !== input.caption.sequenceId || other.id === input.caption.id) continue;
    const span = ticksInRange(other.sequenceRange, timebase);
    if (span.end <= cutSpan.start) continue;
    assertTrackUnlocked(other.trackId);
    work.assertObjectLockAllows('CAPTION', other.id, dimensionsFor(span));
  }
  for (const track of input.scopedTracks) {
    for (const clip of work.clipsOnTrack(track.id)) {
      const span = ticksInRange(clip.sequenceRange, timebase);
      if (span.end <= cutSpan.start) continue;
      assertTrackUnlocked(track.id);
      work.assertObjectLockAllows('CLIP', clip.id, dimensionsFor(span));
    }
  }
}

/** CUT_CONTENT 收缝对单个片段的处理（1:1 前向映射假设，否则拒绝）。 */
function cutClipForCaption(
  work: WorkingTimeline,
  input: { clip: KernelClip; cutSpan: { start: bigint; end: bigint }; gapTicks: bigint; timebase: { num: number; den: number } },
  ctx: KernelContext,
): void {
  const { clip, cutSpan, gapTicks, timebase } = input;
  const clipSpan = ticksInRange(clip.sequenceRange, timebase);
  if (clipSpan.end <= cutSpan.start) return;
  if (clipSpan.start >= cutSpan.end) {
    work.updateClip(clip, { ...clip, sequenceRange: rangeOf(clipSpan.start - gapTicks, clipSpan.end - gapTicks, timebase) }, {
      action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, ripple: true },
    });
    return;
  }
  if (!identityForwardMapping(clip)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cutting content requires a 1:1 forward clip mapping', 422, { reason: 'CUT_UNSUPPORTED_MAPPING', clipId: clip.id });
  }
  const sourceSpan = mediaRangeSchema.parse(clip.sourceRange);
  const sourceTimebase = sourceSpan.start.timebase;
  const sourceStartTicks = exactTicks(timeFraction(sourceSpan.start), sourceTimebase);
  const sourceDelta = (sequenceTicks: bigint): bigint => exactTicks(sequenceSeconds(sequenceTicks, timebase), sourceTimebase);
  if (clipSpan.start >= cutSpan.start && clipSpan.end <= cutSpan.end) {
    work.deleteClip(clip, { action: 'DELETE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'delete_clip', clipId: clip.id, cutByCaption: true } });
    return;
  }
  if (clipSpan.start < cutSpan.start && clipSpan.end <= cutSpan.end) {
    // 尾部落在切口内 → 头部保留，出点裁到切点
    work.updateClip(clip, {
      ...clip,
      sequenceRange: rangeOf(clipSpan.start, cutSpan.start, timebase),
      sourceRange: mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceDelta(cutSpan.start - clipSpan.start), sourceTimebase) }),
    }, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, cutByCaption: true } });
    return;
  }
  if (clipSpan.start >= cutSpan.start && clipSpan.end > cutSpan.end) {
    // 头部落在切口内 → 尾部保留并左移收缝
    work.updateClip(clip, {
      ...clip,
      sequenceRange: rangeOf(cutSpan.start, clipSpan.end - gapTicks, timebase),
      sourceRange: mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceDelta(gapTicks), sourceTimebase), end: sourceSpan.end }),
    }, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, ripple: true, cutByCaption: true } });
    return;
  }
  // 切口落在片段内部 → 左段留原 id、右段重建并左移（源按切口切分，切换处内容连续）
  work.updateClip(clip, {
    ...clip,
    sequenceRange: rangeOf(clipSpan.start, cutSpan.start, timebase),
    sourceRange: mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceDelta(cutSpan.start - clipSpan.start), sourceTimebase) }),
  }, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, cutByCaption: true } });
  const right: KernelClip = {
    ...clip,
    id: ctx.newId('clp'),
    sequenceRange: rangeOf(cutSpan.start, clipSpan.end - gapTicks, timebase),
    sourceRange: mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceDelta(cutSpan.end - clipSpan.start), sourceTimebase), end: sourceSpan.end }),
    parentClipId: clip.id,
  };
  work.insertClip(right, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: right.id, patch: { op: 'insert_clip', clipId: right.id, cutByCaption: true } });
}

export function deleteCaption(work: WorkingTimeline, operation: Op<'delete_caption'>): void {
  const caption = findCaption(work, operation.captionId);
  work.deleteCaption(caption, { action: 'DELETE_CAPTION', objectKind: 'CAPTION', objectId: caption.id, patch: { ...operation } });
}

function findAudioRegion(work: WorkingTimeline, regionId: string): KernelAudioRegion {
  const region = work.audioRegions.get(regionId);
  if (!region) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio region not found', 404);
  return region;
}

/** N03-06：等功率交叉淡变，要求严格相邻（无缝隙、无重叠）。 */
export function applyAudioCrossfade(work: WorkingTimeline, operation: Op<'apply_audio_crossfade'>): void {
  const left = findAudioRegion(work, operation.leftRegionId);
  const right = findAudioRegion(work, operation.rightRegionId);
  if (left.sequenceId !== right.sequenceId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade requires both regions in the same sequence', 422, { reason: 'CROSSFADE_REGIONS_NOT_ADJACENT' });
  }
  const { timebase } = work.sequenceTimebase(left.sequenceId);
  const leftSpan = ticksInRange(left.sequenceRange, timebase);
  const rightSpan = ticksInRange(right.sequenceRange, timebase);
  if (leftSpan.end !== rightSpan.start) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade requires adjacent regions (no gap, no overlap)', 422, { reason: 'CROSSFADE_REGIONS_NOT_ADJACENT' });
  }
  const durationTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.duration)), timebase);
  if (durationTicks <= 0n || durationTicks > leftSpan.end - leftSpan.start || durationTicks > rightSpan.end - rightSpan.start) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade duration must fit both regions', 422, { reason: 'CROSSFADE_DURATION_OUT_OF_RANGE' });
  }
  const fade = mediaTimeOf(durationTicks, timebase);
  for (const [region, after] of [[left, { ...left, fadeOut: fade }], [right, { ...right, fadeIn: fade }]] as const) {
    work.updateAudioRegion(region, after, {
      action: 'APPLY_AUDIO_CROSSFADE', objectKind: 'AUDIO_REGION', objectId: region.id, patch: { ...operation, audioRegionId: region.id },
    });
  }
}

/**
 * update_audio_region（N03-06）：原声保护开启时，改源流或局部时间会改变语言内容 → 拒绝；
 * 增益/淡入淡出/声像不受影响。补偿路径（undo/redo）不受限（恢复此前已接受的状态）。
 */
export function updateAudioRegion(work: WorkingTimeline, operation: Op<'update_audio_region'>, ctx: KernelContext): void {
  const changes = operation.changes;
  if (ctx.compensation !== true) {
    const touchesSourceClock = changes.sourceStreamId !== undefined || changes.localRange !== undefined || changes.timeBinding !== undefined;
    if (touchesSourceClock && work.state.policy.preserveOriginalSpeech) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'original speech protection forbids changing the source clock', 409, {
        reason: AUDIO_MIX_GUARD_REASONS.ORIGINAL_SPEECH_PROTECTED,
      });
    }
  }
  const region = findAudioRegion(work, operation.audioRegionId);
  const candidate: KernelAudioRegion = {
    ...region,
    ...(changes.trackId === undefined ? {} : { trackId: changes.trackId }),
    ...(changes.timeBinding === undefined ? {} : { timeBinding: changes.timeBinding }),
    ...(changes.localRange === undefined ? {} : { localRange: mediaRangeSchema.parse(changes.localRange) }),
    ...(changes.sequenceRange === undefined ? {} : { sequenceRange: mediaRangeSchema.parse(changes.sequenceRange) }),
    ...(changes.sourceStreamId === undefined ? {} : { sourceStreamId: changes.sourceStreamId }),
    ...(changes.channelMapping === undefined ? {} : { channelMapping: changes.channelMapping }),
    ...(changes.gainDb === undefined ? {} : { gainDb: changes.gainDb }),
    ...(changes.pan === undefined ? {} : { pan: changes.pan }),
    ...(changes.fadeIn === undefined ? {} : { fadeIn: mediaTimeSchema.parse(changes.fadeIn) }),
    ...(changes.fadeOut === undefined ? {} : { fadeOut: mediaTimeSchema.parse(changes.fadeOut) }),
    ...(changes.parameters === undefined ? {} : { parameters: changes.parameters }),
  };
  const track = work.tracks.get(candidate.trackId);
  if (!track || track.sequenceId !== region.sequenceId || track.kind !== 'AUDIO') throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio track not found', 404);
  if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
  const mapping = candidate.channelMapping as { sourceChannel: number }[];
  if (new Set(mapping.map((item) => item.sourceChannel)).size !== mapping.length) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'each source channel may be mapped once', 422, { reason: 'DUPLICATE_SOURCE_CHANNEL' });
  }
  const duration = rangeDuration(mediaRangeSchema.parse(candidate.localRange));
  const fades: Fraction = addFractions(timeFraction(candidate.fadeIn), timeFraction(candidate.fadeOut));
  if (compareFraction(fades, duration) > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'audio fades exceed the local region duration', 422, { reason: 'AUDIO_FADE_OUT_OF_BOUNDS' });
  }
  work.updateAudioRegion(region, candidate, { action: 'UPDATE_AUDIO_REGION', objectKind: 'AUDIO_REGION', objectId: region.id, patch: { ...operation } });
}
