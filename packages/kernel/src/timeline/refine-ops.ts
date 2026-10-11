import { ApiFailure, ERROR_CODES, mediaRangeSchema, mediaTimeSchema, type MediaRange } from '@ancs/contracts';
import { addFractions, negateFraction, subtractFractions } from '@ancs/time';
import { splitClipAt } from './clip-ops.js';
import {
  WorkingTimeline,
  compareFraction,
  exactTicks,
  identityForwardMapping,
  mediaTimeOf,
  rangeDuration,
  rangeOf,
  sequenceSeconds,
  sequenceTimebase,
  ticksInRange,
  timeFraction,
} from './support.js';
import type { KernelClip, KernelContext, KernelTimelineOperation } from './types.js';

type Op<Name extends KernelTimelineOperation['op']> = Extract<KernelTimelineOperation, { op: Name }>;

/** slip（N03-03）：滑移素材内容——源窗口改变，序列位置与时长不变；AV 关联片段同步滑移。 */
export function slipClip(work: WorkingTimeline, operation: Op<'slip_clip'>): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT']);
  const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
  const sequenceDuration = rangeDuration(mediaRangeSchema.parse(clip.sequenceRange));
  if (compareFraction(rangeDuration(sourceRange), sequenceDuration) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slip keeps the clip position and duration', 422, { reason: 'SLIP_DURATION_MISMATCH' });
  }
  work.assertSourceRangeUsable({ assetVersionId: clip.assetVersionId, nestedSequenceId: clip.nestedSequenceId, range: sourceRange });
  // 源侧滑移量用于把 AV 关联片段同步滑移，保持声画一致。
  const slipSeconds = subtractFractions(timeFraction(sourceRange.start), timeFraction(mediaRangeSchema.parse(clip.sourceRange).start));
  const targets: { clip: KernelClip; range: MediaRange }[] = [{ clip, range: sourceRange }];
  for (const sibling of work.avSiblingsOf(clip)) {
    const siblingSource = mediaRangeSchema.parse(sibling.sourceRange);
    if (compareFraction(rangeDuration(siblingSource), sequenceDuration) !== 0) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'linked clip duration mismatch prevents slip sync', 409, { reason: 'AV_LINK_DURATION_MISMATCH', clipId: sibling.id });
    }
    const siblingTimebase = siblingSource.start.timebase;
    const nextStart = exactTicks(timeFraction(siblingSource.start), siblingTimebase) + exactTicks(slipSeconds, siblingTimebase);
    if (nextStart < 0n) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slip exceeds available source handles', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: sibling.id });
    targets.push({ clip: sibling, range: rangeOf(nextStart, nextStart + exactTicks(rangeDuration(siblingSource), siblingTimebase), siblingTimebase) });
  }
  for (const target of targets) {
    work.updateClip(target.clip, { ...target.clip, sourceRange: target.range }, {
      action: target.clip.id === clip.id ? 'SLIP_CLIP' : 'UPDATE_CLIP', objectKind: 'CLIP', objectId: target.clip.id, patch: { ...operation, clipId: target.clip.id },
    });
  }
}

/** slide（N03-03）：片段整体位移，左右相邻片段按相反方向伸缩吸收（合成总时长不变）。 */
export function slideClip(work: WorkingTimeline, operation: Op<'slide_clip'>): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['POSITION']);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  const offsetTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.offset)), timebase);
  const span = ticksInRange(clip.sequenceRange, timebase);
  const trackClips = work.clipsOnTrack(clip.trackId).filter((candidate) => candidate.id !== clip.id);
  // slide 需要左右都有相邻片段来吸收位移（否则总时长会变，那属于 trim/move）。
  const prev = trackClips.find((candidate) => ticksInRange(candidate.sequenceRange, timebase).end === span.start);
  const next = trackClips.find((candidate) => ticksInRange(candidate.sequenceRange, timebase).start === span.end);
  if (prev === undefined || next === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide requires adjacent neighbors on both sides', 422, { reason: 'SLIDE_REQUIRES_ADJACENT_NEIGHBORS' });
  }
  for (const neighbor of [prev, next]) {
    work.assertObjectLockAllows('CLIP', neighbor.id, ['CONTENT', 'DURATION', 'POSITION']);
    if (!identityForwardMapping(neighbor)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide requires 1:1 forward mapping on neighbors', 422, { reason: 'SLIDE_UNSUPPORTED_MAPPING', clipId: neighbor.id });
    }
  }
  if (span.start + offsetTicks < 0n || span.end + offsetTicks > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide exceeds sequence bounds', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  const offsetSeconds = sequenceSeconds(offsetTicks, timebase);
  // 邻居按相反方向伸缩；伸缩量必须落在可用源 handle 内。
  const prevSpan = ticksInRange(prev.sequenceRange, timebase);
  const prevSource = mediaRangeSchema.parse(prev.sourceRange);
  const prevTargetSeconds = addFractions(rangeDuration(prevSource), offsetSeconds);
  if (prevTargetSeconds.num <= 0n) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide would collapse the previous clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: prev.id });
  }
  const prevSourceEndTicks = exactTicks(timeFraction(prevSource.start), prevSource.start.timebase) + exactTicks(prevTargetSeconds, prevSource.start.timebase);
  const nextSpan = ticksInRange(next.sequenceRange, timebase);
  const nextSource = mediaRangeSchema.parse(next.sourceRange);
  const nextTargetSeconds = addFractions(rangeDuration(nextSource), negateFraction(offsetSeconds));
  if (nextTargetSeconds.num <= 0n) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide would collapse the next clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: next.id });
  }
  const nextSourceStartTicks = exactTicks(timeFraction(nextSource.start), nextSource.start.timebase) + exactTicks(offsetSeconds, nextSource.start.timebase);
  if (nextSourceStartTicks < 0n) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide needs source handles before the next clip in-point', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: next.id });
  }
  const edits: { clip: KernelClip; sequenceRange: MediaRange; sourceRange: MediaRange; action: string }[] = [
    { clip: prev, sequenceRange: rangeOf(prevSpan.start, prevSpan.end + offsetTicks, timebase), sourceRange: mediaRangeSchema.parse({ start: prevSource.start, end: mediaTimeOf(prevSourceEndTicks, prevSource.start.timebase) }), action: 'UPDATE_CLIP' },
    // 邻居内容在时间线上保持不动：next 只推进源入点（出点不变，时长自然缩短）。
    { clip: next, sequenceRange: rangeOf(nextSpan.start + offsetTicks, nextSpan.end, timebase), sourceRange: mediaRangeSchema.parse({ start: mediaTimeOf(nextSourceStartTicks, nextSource.start.timebase), end: nextSource.end }), action: 'UPDATE_CLIP' },
    { clip, sequenceRange: rangeOf(span.start + offsetTicks, span.end + offsetTicks, timebase), sourceRange: mediaRangeSchema.parse(clip.sourceRange), action: 'SLIDE_CLIP' },
  ];
  // AV 关联片段按同一位移移动（留在各自轨道；若因此重叠则拒绝）。重叠以**编辑前**状态判定。
  for (const sibling of work.avSiblingsOf(clip)) {
    const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
    const candidate = { start: siblingSpan.start + offsetTicks, end: siblingSpan.end + offsetTicks };
    work.assertNoTrackOverlap(sibling.trackId, timebase, candidate, [sibling.id]);
    edits.push({ clip: sibling, sequenceRange: rangeOf(candidate.start, candidate.end, timebase), sourceRange: mediaRangeSchema.parse(sibling.sourceRange), action: 'UPDATE_CLIP' });
  }
  for (const edit of edits) {
    work.updateClip(edit.clip, { ...edit.clip, sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange }, {
      action: edit.action, objectKind: 'CLIP', objectId: edit.clip.id, patch: { ...operation, clipId: edit.clip.id },
    });
  }
}

/** roll（N03-03）：卷动两段相邻片段之间的剪辑点（左出点与右入点同步移动）。 */
export function rollClip(work: WorkingTimeline, operation: Op<'roll_clip'>): void {
  const left = work.editableClip(operation.leftClipId).clip;
  const right = work.editableClip(operation.rightClipId).clip;
  for (const target of [left, right]) {
    work.assertObjectLockAllows('CLIP', target.id, ['CONTENT', 'DURATION', 'POSITION']);
    if (!identityForwardMapping(target)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires 1:1 forward mapping', 422, { reason: 'ROLL_UNSUPPORTED_MAPPING', clipId: target.id });
    }
  }
  if (left.trackId !== right.trackId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires both clips on the same track', 422, { reason: 'ROLL_REQUIRES_SAME_TRACK' });
  }
  const { timebase } = sequenceTimebase(work.state);
  const leftSpan = ticksInRange(left.sequenceRange, timebase);
  const rightSpan = ticksInRange(right.sequenceRange, timebase);
  if (leftSpan.end !== rightSpan.start) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires adjacent clips', 422, { reason: 'ROLL_REQUIRES_ADJACENT_CLIPS' });
  }
  const atTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
  if (atTicks <= leftSpan.start || atTicks >= rightSpan.end) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll point must fall inside the combined span', 422, { reason: 'ROLL_POINT_OUTSIDE_SPAN' });
  }
  const leftSource = mediaRangeSchema.parse(left.sourceRange);
  const rightSource = mediaRangeSchema.parse(right.sourceRange);
  const leftTimebase = leftSource.start.timebase;
  const rightTimebase = rightSource.start.timebase;
  const leftSourceStart = exactTicks(timeFraction(leftSource.start), leftTimebase);
  const leftSourceEnd = leftSourceStart + exactTicks(rangeDuration(leftSource), leftTimebase) + exactTicks(sequenceSeconds(atTicks - leftSpan.end, timebase), leftTimebase);
  const rightSourceStart = exactTicks(timeFraction(rightSource.start), rightTimebase) + exactTicks(sequenceSeconds(atTicks - rightSpan.start, timebase), rightTimebase);
  const rightSourceEnd = exactTicks(timeFraction(rightSource.end), rightSource.end.timebase);
  if (leftSourceEnd <= leftSourceStart) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll would collapse the left clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: left.id });
  }
  if (rightSourceStart < 0n || rightSourceStart >= rightSourceEnd) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll needs source handles before the right clip in-point', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: right.id });
  }
  const edits = [
    { clip: left, sequenceRange: rangeOf(leftSpan.start, atTicks, timebase), sourceRange: mediaRangeSchema.parse({ start: leftSource.start, end: mediaTimeOf(leftSourceEnd, leftTimebase) }) },
    { clip: right, sequenceRange: rangeOf(atTicks, rightSpan.end, timebase), sourceRange: mediaRangeSchema.parse({ start: mediaTimeOf(rightSourceStart, rightTimebase), end: rightSource.end }) },
  ];
  for (const edit of edits) {
    work.updateClip(edit.clip, { ...edit.clip, sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange }, {
      action: 'ROLL_CLIP', objectKind: 'CLIP', objectId: edit.clip.id, patch: { ...operation, clipId: edit.clip.id },
    });
  }
}

/**
 * ripple（N03-03）：**显式**涟漪收缝。DELETE 删除片段并收缝；TRIM_HEAD/TRIM_TAIL 掐头/去尾并收缝。
 * 收缝范围：显式跨轨 = 全部轨道；否则 = 本轨 + 同步锁打开的轨道（N03-04 同步锁语义）。
 */
export function rippleClip(work: WorkingTimeline, operation: Op<'ripple_clip'>): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT', 'DURATION', 'POSITION']);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  const span = ticksInRange(clip.sequenceRange, timebase);
  const siblings = work.avSiblingsOf(clip);
  let gapTicks: bigint;
  if (operation.action === 'DELETE') {
    if (!identityForwardMapping(clip)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple delete requires 1:1 forward mapping', 422, { reason: 'RIPPLE_UNSUPPORTED_MAPPING' });
    }
    gapTicks = span.end - span.start;
  } else {
    const amountTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.amount)), timebase);
    if (amountTicks <= 0n || amountTicks >= span.end - span.start) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple amount must be smaller than the clip duration', 422, { reason: 'RIPPLE_AMOUNT_OUT_OF_RANGE' });
    }
    if (amountTicks > durationTicks) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple amount exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
    }
    gapTicks = amountTicks;
  }
  // 掐头/去尾收缝后，片段自身停在原位、时长缩短 gap；差别在源侧：掐头推进源入点、去尾回收源出点。
  const shiftFrom = span.end;
  const allTracks = [...work.tracks.values()].sort((left, right) => left.position - right.position);
  const scopedTracks = operation.closeAcrossTracks ? allTracks : allTracks.filter((track) => track.id === clip.trackId || track.syncLocked);
  const scopedTrackIds = new Set(scopedTracks.map((track) => track.id));
  for (const sibling of siblings) {
    if (!scopedTrackIds.has(sibling.trackId)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'ripple scope would desync linked audio; enable sync lock or closeAcrossTracks', 409, { reason: 'AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE' });
    }
  }
  const removedIds = new Set<string>([clip.id, ...siblings.map((sibling) => sibling.id)]);
  const gapSeconds = sequenceSeconds(gapTicks, timebase);
  if (operation.action === 'DELETE') {
    for (const target of [clip, ...siblings]) {
      const targetSpan = ticksInRange(target.sequenceRange, timebase);
      work.deleteClip(target, {
        action: target.id === clip.id ? 'RIPPLE_CLIP' : 'DELETE_CLIP', objectKind: 'CLIP', objectId: target.id,
        patch: { ...operation, clipId: target.id, deletedRange: { start: mediaTimeOf(targetSpan.start, timebase), end: mediaTimeOf(targetSpan.end, timebase) } },
      });
    }
  } else {
    const shortened = (target: KernelClip): KernelClip => {
      const targetSpan = ticksInRange(target.sequenceRange, timebase);
      const source = mediaRangeSchema.parse(target.sourceRange);
      const sourceTimebase = source.start.timebase;
      const sourceStart = exactTicks(timeFraction(source.start), sourceTimebase);
      const amountSourceTicks = exactTicks(gapSeconds, sourceTimebase);
      const nextSource = operation.action === 'TRIM_HEAD'
        ? mediaRangeSchema.parse({ start: mediaTimeOf(sourceStart + amountSourceTicks, sourceTimebase), end: source.end })
        : mediaRangeSchema.parse({ start: source.start, end: mediaTimeOf(sourceStart + exactTicks(rangeDuration(source), sourceTimebase) - amountSourceTicks, sourceTimebase) });
      return { ...target, sequenceRange: rangeOf(targetSpan.start, targetSpan.end - gapTicks, timebase), sourceRange: nextSource };
    };
    work.updateClip(clip, shortened(clip), { action: 'RIPPLE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation, clipId: clip.id } });
    // AV 关联片段按同一序列区间收缝（保持同步）。
    for (const sibling of siblings) {
      work.updateClip(sibling, shortened(sibling), { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id } });
    }
  }
  // 收缝：受影响轨道上起点不早于缝隙的片段整体左移（每段都落 UPDATE_CLIP，位置变化对用户可见/可撤销）。
  for (const track of scopedTracks) {
    const candidates = work.clipsOnTrack(track.id)
      .filter((candidate) => !removedIds.has(candidate.id))
      .sort((left, right) => {
        const a = ticksInRange(left.sequenceRange, timebase).start;
        const b = ticksInRange(right.sequenceRange, timebase).start;
        return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
      });
    for (const candidate of candidates) {
      const candidateSpan = ticksInRange(candidate.sequenceRange, timebase);
      if (candidateSpan.start < shiftFrom) continue;
      if (candidateSpan.start - gapTicks < 0n) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple would move a clip before sequence start', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS', clipId: candidate.id });
      }
      work.updateClip(candidate, { ...candidate, sequenceRange: rangeOf(candidateSpan.start - gapTicks, candidateSpan.end - gapTicks, timebase) }, {
        action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: candidate.id, patch: { op: 'update_clip', clipId: candidate.id, ripple: true },
      });
    }
  }
}

/** J/L cut（N03-03）：视频在 at 处切开，音频切点错开 offset（J 先入、L 后出），源范围连续、原音不跳。 */
export function splitAvCut(work: WorkingTimeline, operation: Op<'split_av_cut'>, ctx: KernelContext): void {
  const video = work.editableClip(operation.videoClipId).clip;
  const audio = work.editableClip(operation.audioClipId).clip;
  if (video.avGroupId === null || video.avGroupId !== audio.avGroupId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_av_cut requires an AV-linked clip pair', 422, { reason: 'CLIPS_NOT_AV_LINKED' });
  }
  const { timebase } = sequenceTimebase(work.state);
  const offsetTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.offset)), timebase);
  const videoAt = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
  const audioAt = operation.kind === 'J' ? videoAt - offsetTicks : videoAt + offsetTicks;
  const videoSpan = ticksInRange(video.sequenceRange, timebase);
  const audioSpan = ticksInRange(audio.sequenceRange, timebase);
  for (const target of [
    { clip: video, at: videoAt, span: videoSpan, role: 'video' },
    { clip: audio, at: audioAt, span: audioSpan, role: 'audio' },
  ]) {
    work.assertObjectLockAllows('CLIP', target.clip.id, ['CONTENT', 'DURATION', 'POSITION']);
    if (!identityForwardMapping(target.clip)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_av_cut requires 1:1 forward mapping', 422, { reason: 'AV_CUT_UNSUPPORTED_MAPPING', clipId: target.clip.id });
    }
    if (target.at <= target.span.start || target.at >= target.span.end) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cut point must fall inside the clip', 422, { reason: 'CUT_POINT_OUTSIDE_CLIP', clipId: target.clip.id, role: target.role });
    }
  }
  splitClipAt(work, {
    clip: video, leftRange: rangeOf(videoSpan.start, videoAt, timebase), rightRange: rangeOf(videoAt, videoSpan.end, timebase),
    leftSeconds: sequenceSeconds(videoAt - videoSpan.start, timebase), leftAction: 'SPLIT_AV_CUT',
    createdId: operation.createdVideoClipId ?? ctx.newId('clp'), patchBase: { ...operation },
  });
  splitClipAt(work, {
    clip: audio, leftRange: rangeOf(audioSpan.start, audioAt, timebase), rightRange: rangeOf(audioAt, audioSpan.end, timebase),
    leftSeconds: sequenceSeconds(audioAt - audioSpan.start, timebase), leftAction: 'UPDATE_CLIP',
    createdId: operation.createdAudioClipId ?? ctx.newId('clp'), patchBase: { ...operation },
  });
}
