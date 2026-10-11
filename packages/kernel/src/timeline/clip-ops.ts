import { ApiFailure, ERROR_CODES, compareMediaTime, mediaRangeSchema, mediaTimeSchema } from '@ancs/contracts';
import {
  CLIP_IDENTITY_MAPPING,
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

const BLOCKING_INSERT_DIMENSIONS = new Set(['POSITION', 'DURATION', 'CONTENT']);

/**
 * insert_clip（N03-01）：INSERT（起点之后整体右移，跨入点的片段切开）/ OVERWRITE（区间内片段裁剪/切分/删除）/
 * APPEND（追加到轨末）。`restoreClipId` = 精确复原（undo/redo），不做任何重排。
 * 源含音频且 linkAudio → 在首个音频轨（或自动新建）放置同 avGroupId 的音频片段。
 */
export function insertClip(work: WorkingTimeline, operation: Op<'insert_clip'>, ctx: KernelContext): void {
  if (work.state.sequence.id !== operation.sequenceId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const targetTrack = work.tracks.get(operation.trackId);
  if (!targetTrack) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'target track not found', 404);
  if (targetTrack.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target track is locked', 409, { reason: 'TRACK_LOCKED' });

  const insertSourceRange = mediaRangeSchema.parse(operation.sourceRange);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  let sourceHasAudio = false;
  if (operation.assetVersionId !== null) {
    // 存在性 / READY / 校验和 / 源边界（同一判据，见 WorkingTimeline.assertSourceRangeUsable）
    work.assertSourceRangeUsable({ assetVersionId: operation.assetVersionId, nestedSequenceId: null, range: insertSourceRange });
    sourceHasAudio = work.state.sources.assetVersions.get(operation.assetVersionId)?.hasAudio ?? false;
  } else if (operation.nestedSequenceId !== null) {
    const nested = work.state.sources.sequenceDurations.get(operation.nestedSequenceId);
    if (!nested || compareMediaTime(insertSourceRange.end, nested) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
  }

  const clipTicks = exactTicks(rangeDuration(insertSourceRange), timebase);
  const trackClips = sortBySequenceStart(work.clipsOnTrack(operation.trackId), timebase);
  const isRestore = operation.restoreClipId !== undefined;
  const startTicks = operation.mode === 'APPEND'
    ? trackClips.reduce((max, clip) => {
      const span = ticksInRange(clip.sequenceRange, timebase);
      return span.end > max ? span.end : max;
    }, 0n)
    : exactTicks(timeFraction(mediaTimeSchema.parse(operation.sequenceStart)), timebase);
  const endTicks = startTicks + clipTicks;
  const placement = rangeOf(startTicks, endTicks, timebase);
  if (endTicks > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'insert range exceeds sequence duration（序列长度扩展属 N03-04 轨道/序列控制）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }

  // 触碰既有片段（平移/裁切/切分/删除）前先查对象锁：POSITION/DURATION/CONTENT 任一被锁即拒绝。
  const assertTouchable = (clip: KernelClip, message: string): void => {
    const dimensions = work.lockDimensions('CLIP', clip.id);
    if (dimensions !== null && dimensions.some((dimension) => BLOCKING_INSERT_DIMENSIONS.has(dimension))) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, message, 409, { reason: 'CLIP_LOCKED', clipId: clip.id });
    }
  };
  const assertShiftFitsSequence = (candidateEndTicks: bigint): void => {
    if (candidateEndTicks > durationTicks) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple exceeds sequence duration（序列长度扩展属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
    }
  };
  /** 1:1 前向映射片段在序列 ticks 处切开时的源切点。 */
  const sourceCut = (clip: KernelClip, sequenceOffsetTicks: bigint): { source: ReturnType<typeof mediaRangeSchema.parse>; cut: ReturnType<typeof mediaTimeOf> } => {
    const source = mediaRangeSchema.parse(clip.sourceRange);
    const sourceTimebase = source.start.timebase;
    const sourceStartTicks = exactTicks(timeFraction(source.start), sourceTimebase);
    const cutTicks = exactTicks(sequenceSeconds(sequenceOffsetTicks, timebase), sourceTimebase);
    return { source, cut: mediaTimeOf(sourceStartTicks + cutTicks, sourceTimebase) };
  };
  const updated = (clip: KernelClip, changes: Partial<KernelClip>): KernelClip => ({ ...clip, ...changes });

  if (!isRestore && operation.mode === 'INSERT') {
    for (const clip of trackClips) {
      const span = ticksInRange(clip.sequenceRange, timebase);
      if (span.end <= startTicks) continue;
      assertTouchable(clip, 'insert ripple touches a locked clip');
      if (span.start >= startTicks) {
        assertShiftFitsSequence(span.end + clipTicks);
        const after = updated(clip, { sequenceRange: rangeOf(span.start + clipTicks, span.end + clipTicks, timebase) });
        work.updateClip(clip, after, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip' } });
        continue;
      }
      // 插入点落在片段内部：左段留在原位、右段整体右移 clipTicks（标准插入剪辑语义，避免重叠）。
      assertShiftFitsSequence(span.end + clipTicks);
      if (!identityForwardMapping(clip)) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'insert splitting requires a 1:1 forward clip mapping', 422, { reason: 'INSERT_SPLIT_UNSUPPORTED_MAPPING', clipId: clip.id });
      }
      const { source, cut } = sourceCut(clip, startTicks - span.start);
      const left = updated(clip, { sequenceRange: rangeOf(span.start, startTicks, timebase), sourceRange: mediaRangeSchema.parse({ start: source.start, end: cut }) });
      work.updateClip(clip, left, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip' } });
      const right: KernelClip = {
        ...clip,
        id: ctx.newId('clp'),
        sourceRange: mediaRangeSchema.parse({ start: cut, end: source.end }),
        sequenceRange: rangeOf(startTicks + clipTicks, span.end + clipTicks, timebase),
      };
      work.insertClip(right, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: right.id, patch: { op: 'insert_clip' } });
    }
  } else if (!isRestore && operation.mode === 'OVERWRITE') {
    for (const clip of trackClips) {
      const span = ticksInRange(clip.sequenceRange, timebase);
      if (span.start >= endTicks || span.end <= startTicks) continue;
      assertTouchable(clip, 'overwrite range contains a locked clip');
      if (span.start >= startTicks && span.end <= endTicks) {
        work.deleteClip(clip, { action: 'DELETE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'delete_clip' } });
        continue;
      }
      if (!identityForwardMapping(clip)) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'overwrite trimming requires a 1:1 forward clip mapping', 422, { reason: 'OVERWRITE_TRIM_UNSUPPORTED_MAPPING', clipId: clip.id });
      }
      if (span.start < startTicks && span.end <= endTicks) {
        const { source, cut } = sourceCut(clip, startTicks - span.start);
        const after = updated(clip, { sequenceRange: rangeOf(span.start, startTicks, timebase), sourceRange: mediaRangeSchema.parse({ start: source.start, end: cut }) });
        work.updateClip(clip, after, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip' } });
      } else if (span.start >= startTicks && span.end > endTicks) {
        const { source, cut } = sourceCut(clip, endTicks - span.start);
        const after = updated(clip, { sequenceRange: rangeOf(endTicks, span.end, timebase), sourceRange: mediaRangeSchema.parse({ start: cut, end: source.end }) });
        work.updateClip(clip, after, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip' } });
      } else {
        // 覆盖区间落在片段内部 → 左段保留、右段重建（源范围同步切分，保持源对齐）
        const leftCut = sourceCut(clip, startTicks - span.start);
        const left = updated(clip, { sequenceRange: rangeOf(span.start, startTicks, timebase), sourceRange: mediaRangeSchema.parse({ start: leftCut.source.start, end: leftCut.cut }) });
        work.updateClip(clip, left, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip' } });
        const rightCut = sourceCut(clip, endTicks - span.start);
        const right: KernelClip = {
          ...clip,
          id: ctx.newId('clp'),
          sourceRange: mediaRangeSchema.parse({ start: rightCut.cut, end: rightCut.source.end }),
          sequenceRange: rangeOf(endTicks, span.end, timebase),
        };
        work.insertClip(right, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: right.id, patch: { op: 'insert_clip' } });
      }
    }
  }

  const clipId = operation.restoreClipId ?? operation.createdClipId ?? ctx.newId('clp');
  const audioGroupId = operation.linkAudio && sourceHasAudio ? ctx.newId('avgp') : null;
  const inserted: KernelClip = {
    id: clipId,
    sequenceId: operation.sequenceId,
    trackId: operation.trackId,
    assetVersionId: operation.assetVersionId ?? null,
    nestedSequenceId: operation.nestedSequenceId ?? null,
    sourceStreamId: operation.sourceStreamId ?? null,
    sourceRange: insertSourceRange,
    sequenceRange: placement,
    timeMapping: CLIP_IDENTITY_MAPPING,
    avGroupId: audioGroupId,
    parentClipId: null,
    parameters: null,
  };
  work.insertClip(inserted, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: clipId, patch: { ...operation } });

  if (audioGroupId !== null) {
    let audioTrackId = operation.audioTrackId;
    if (audioTrackId === null) {
      const audioTracks = [...work.tracks.values()].filter((track) => track.kind === 'AUDIO').sort((left, right) => left.position - right.position);
      const firstAudio = audioTracks[0];
      if (firstAudio) {
        audioTrackId = firstAudio.id;
      } else {
        // 自动创建音频轨（不记事件；undo 只删除片段、保留空轨——见 N03-04 轨道生命周期）
        const position = [...work.tracks.values()].reduce((max, track) => Math.max(max, track.position), -1) + 1;
        const createdTrackId = ctx.newId('trk');
        work.insertTrack({
          id: createdTrackId, sequenceId: operation.sequenceId, kind: 'AUDIO', position, name: '音频',
          locked: false, muted: false, hidden: false, solo: false, syncLocked: false,
        });
        audioTrackId = createdTrackId;
      }
    } else {
      const audioTrack = work.tracks.get(audioTrackId);
      if (!audioTrack) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio track not found', 404);
      if (audioTrack.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'audio track is locked', 409, { reason: 'TRACK_LOCKED' });
    }
    const audioClip: KernelClip = { ...inserted, id: operation.createdAudioClipId ?? ctx.newId('clp'), trackId: audioTrackId };
    work.insertClip(audioClip, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: audioClip.id, patch: { op: 'insert_clip' } });
  }
}

/** delete_clip：只受轨道锁约束（对象锁由影响面门处理，与旧实现一致）。 */
export function deleteClip(work: WorkingTimeline, operation: Op<'delete_clip'>): void {
  const clip = work.findClip(operation.clipId);
  if (work.tracks.get(clip.trackId)?.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
  work.deleteClip(clip, { action: 'DELETE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
}

/** 在给定序列时间切开片段：左段留原 id、右段新建为子片段（N03-02／N03-03 共用）。 */
export function splitClipAt(
  work: WorkingTimeline,
  input: {
    clip: KernelClip;
    leftRange: ReturnType<typeof rangeOf>;
    rightRange: ReturnType<typeof rangeOf>;
    leftSeconds: ReturnType<typeof sequenceSeconds>;
    leftAction: string;
    createdId: string;
    patchBase: Record<string, unknown>;
  },
): void {
  const source = mediaRangeSchema.parse(input.clip.sourceRange);
  const sourceTimebase = source.start.timebase;
  const sourceStartTicks = exactTicks(timeFraction(source.start), sourceTimebase);
  const sourceLeftTicks = exactTicks(input.leftSeconds, sourceTimebase);
  const leftSource = mediaRangeSchema.parse({ start: source.start, end: mediaTimeOf(sourceStartTicks + sourceLeftTicks, sourceTimebase) });
  const rightSource = mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceLeftTicks, sourceTimebase), end: source.end });
  const left: KernelClip = { ...input.clip, sequenceRange: input.leftRange, sourceRange: leftSource };
  work.updateClip(input.clip, left, {
    action: input.leftAction, objectKind: 'CLIP', objectId: input.clip.id, patch: { ...input.patchBase, clipId: input.clip.id },
  });
  // 右段是原片段的子片段（血缘可追溯）。
  const right: KernelClip = { ...input.clip, id: input.createdId, sourceRange: rightSource, sequenceRange: input.rightRange, parentClipId: input.clip.id };
  work.insertClip(right, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: right.id, patch: { op: 'insert_clip', clipId: right.id } });
}

export function splitClip(work: WorkingTimeline, operation: Op<'split_clip'>, ctx: KernelContext): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT', 'DURATION', 'POSITION']);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  const span = ticksInRange(clip.sequenceRange, timebase);
  const atTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
  if (atTicks <= span.start || atTicks >= span.end) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split point must fall inside the clip', 422, { reason: 'SPLIT_POINT_OUTSIDE_CLIP' });
  }
  if (!identityForwardMapping(clip)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split requires a 1:1 forward clip mapping', 422, { reason: 'SPLIT_UNSUPPORTED_MAPPING' });
  }
  const leftDuration = atTicks - span.start;
  if (span.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  const leftSeconds = sequenceSeconds(leftDuration, timebase);
  // 绑定到该片段的音频区域：局部时钟落在右段或跨越切点 → 需要区域级切分（N03-06），fail-closed 不静默改时钟。
  for (const region of work.boundAudioRegions(clip.id)) {
    if (compareFraction(rangeDuration(mediaRangeSchema.parse(region.localRange)), leftSeconds) > 0) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region spans the split point', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
    }
  }
  // 视频/音频对：同一 avGroupId 的关联片段按同一方式切分（保持声画同步）。
  const targets = [
    { clip, leftRange: rangeOf(span.start, atTicks, timebase), rightRange: rangeOf(atTicks, span.end, timebase), createdId: operation.createdClipId ?? ctx.newId('clp') },
    ...work.avSiblingsOf(clip).map((sibling) => {
      if (!identityForwardMapping(sibling)) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split requires a 1:1 forward clip mapping', 422, { reason: 'SPLIT_UNSUPPORTED_MAPPING', clipId: sibling.id });
      }
      const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
      return {
        clip: sibling,
        leftRange: rangeOf(siblingSpan.start, siblingSpan.start + leftDuration, timebase),
        rightRange: rangeOf(siblingSpan.start + leftDuration, siblingSpan.end, timebase),
        createdId: operation.createdAudioClipId ?? ctx.newId('clp'),
      };
    }),
  ];
  for (const target of targets) {
    splitClipAt(work, {
      clip: target.clip, leftRange: target.leftRange, rightRange: target.rightRange, leftSeconds,
      leftAction: target.clip.id === clip.id ? 'SPLIT_CLIP' : 'UPDATE_CLIP',
      createdId: target.createdId, patchBase: { ...operation },
    });
  }
}

export function trimClip(work: WorkingTimeline, operation: Op<'trim_clip'>): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT', 'DURATION', 'POSITION']);
  const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
  const sequenceRange = mediaRangeSchema.parse(operation.sequenceRange);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  if (!identityForwardMapping(clip)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trim requires a 1:1 forward clip mapping', 422, { reason: 'TRIM_UNSUPPORTED_MAPPING' });
  }
  if (compareFraction(rangeDuration(sourceRange), rangeDuration(sequenceRange)) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trim must keep source and sequence durations equal', 422, { reason: 'TRIM_RANGE_DURATION_MISMATCH' });
  }
  work.assertSourceRangeUsable({ assetVersionId: clip.assetVersionId, nestedSequenceId: clip.nestedSequenceId, range: sourceRange });
  const candidate = ticksInRange(sequenceRange, timebase);
  if (candidate.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trimmed range exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  const siblings = work.avSiblingsOf(clip);
  work.assertNoTrackOverlap(clip.trackId, timebase, candidate, [clip.id, ...siblings.map((sibling) => sibling.id)]);
  const trimSeconds = rangeDuration(sequenceRange);
  for (const region of work.boundAudioRegions(clip.id)) {
    const binding = region.timeBinding as { basis?: string } | null;
    if (binding?.basis === 'SOURCE' || compareFraction(rangeDuration(mediaRangeSchema.parse(region.localRange)), trimSeconds) > 0) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region is invalidated by this trim', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
    }
  }
  work.updateClip(clip, { ...clip, sourceRange, sequenceRange }, { action: 'TRIM_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
  // AV 同步：关联片段保持同一序列区间，源入点不变、出点按同样时长换算到各自源时基。
  for (const sibling of siblings) {
    const siblingSource = mediaRangeSchema.parse(sibling.sourceRange);
    const siblingTimebase = siblingSource.start.timebase;
    const siblingStartTicks = exactTicks(timeFraction(siblingSource.start), siblingTimebase);
    const trimSourceTicks = exactTicks(trimSeconds, siblingTimebase);
    const next: KernelClip = {
      ...sibling,
      sequenceRange,
      sourceRange: mediaRangeSchema.parse({ start: siblingSource.start, end: mediaTimeOf(siblingStartTicks + trimSourceTicks, siblingTimebase) }),
    };
    work.updateClip(sibling, next, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id } });
  }
}

export function moveClip(work: WorkingTimeline, operation: Op<'move_clip'>): void {
  const { clip, track: currentTrack } = work.editableClip(operation.clipId);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  const targetTrackId = operation.trackId ?? clip.trackId;
  const targetTrack = work.editableTrack(targetTrackId);
  work.assertObjectLockAllows('TRACK', targetTrackId, ['POSITION', 'DURATION']);
  work.assertObjectLockAllows('CLIP', clip.id, ['POSITION', 'TRACK']);
  if (currentTrack.kind !== targetTrack.kind) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'move_clip requires a track of the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
  }
  const sequenceRange = mediaRangeSchema.parse(operation.sequenceRange ?? clip.sequenceRange);
  const currentSpan = ticksInRange(clip.sequenceRange, timebase);
  const candidate = ticksInRange(sequenceRange, timebase);
  if (candidate.end - candidate.start !== currentSpan.end - currentSpan.start) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'move_clip keeps duration; use trim_clip to change it', 422, { reason: 'MOVE_REQUIRES_EQUAL_DURATION' });
  }
  if (candidate.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'moved range exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  const siblings = work.avSiblingsOf(clip);
  work.assertNoTrackOverlap(targetTrackId, timebase, candidate, [clip.id, ...siblings.map((sibling) => sibling.id)]);
  const deltaTicks = candidate.start - currentSpan.start;
  work.updateClip(clip, { ...clip, trackId: targetTrackId, sequenceRange }, { action: 'MOVE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
  // 绑定到该片段的音频区域：CLIP_LOCAL 基随片段平移（局部时钟不变）；其它基需要重算时钟（N03-06）→ fail-closed。
  for (const region of work.boundAudioRegions(clip.id)) {
    const binding = region.timeBinding as { basis?: string } | null;
    if (binding?.basis !== 'CLIP_LOCAL') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region has a non-local clock', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
    }
    const span = ticksInRange(region.sequenceRange, timebase);
    work.updateAudioRegion(region, { ...region, sequenceRange: rangeOf(span.start + deltaTicks, span.end + deltaTicks, timebase) }, {
      action: 'UPDATE_AUDIO_REGION', objectKind: 'AUDIO_REGION', objectId: region.id, patch: { op: 'update_audio_region', audioRegionId: region.id },
    });
  }
  // AV 同步：关联片段按同一 delta 平移（跨轨移动时留在各自轨道上保持声画对齐）。
  for (const sibling of siblings) {
    const span = ticksInRange(sibling.sequenceRange, timebase);
    work.updateClip(sibling, { ...sibling, sequenceRange: rangeOf(span.start + deltaTicks, span.end + deltaTicks, timebase) }, {
      action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id },
    });
  }
}

export function duplicateClip(work: WorkingTimeline, operation: Op<'duplicate_clip'>, ctx: KernelContext): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT', 'POSITION']);
  const { durationTicks, timebase } = sequenceTimebase(work.state);
  const anchor = operation.afterClipId === null ? clip : work.clips.get(operation.afterClipId);
  if (anchor === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'anchor clip not found', 404);
  const anchorSpan = ticksInRange(anchor.sequenceRange, timebase);
  const siblings = work.avSiblingsOf(clip);
  const anchorTrack = work.editableTrack(anchor.trackId);
  const ownTrack = work.editableTrack(clip.trackId);
  if (anchorTrack.kind !== ownTrack.kind) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate_clip requires an anchor on a track of the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
  }
  const own = ticksInRange(clip.sequenceRange, timebase);
  const candidate = { start: anchorSpan.end, end: anchorSpan.end + (own.end - own.start) };
  if (candidate.end > durationTicks) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate exceeds sequence duration（扩展序列属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  work.assertNoTrackOverlap(anchor.trackId, timebase, candidate, [clip.id, ...siblings.map((sibling) => sibling.id)]);
  // 复制只新增时间线引用：源版本/二进制原件保持不变。
  const newGroupId = clip.avGroupId === null ? null : ctx.newId('avgp');
  const copy: KernelClip = {
    ...clip,
    id: operation.createdClipId ?? ctx.newId('clp'),
    trackId: anchor.trackId,
    sequenceRange: rangeOf(candidate.start, candidate.end, timebase),
    avGroupId: newGroupId,
    parentClipId: clip.id,
  };
  work.insertClip(copy, { action: 'DUPLICATE_CLIP', objectKind: 'CLIP', objectId: copy.id, patch: { ...operation } });
  // AV 同步：关联的音频片段在同一位置复制一份，并组成新的关联对。
  if (newGroupId !== null) {
    for (const sibling of siblings) {
      const siblingTrack = work.editableTrack(sibling.trackId);
      const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
      const siblingCandidate = { start: anchorSpan.end, end: anchorSpan.end + (siblingSpan.end - siblingSpan.start) };
      if (siblingCandidate.end > durationTicks) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate exceeds sequence duration（扩展序列属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
      }
      work.assertNoTrackOverlap(siblingTrack.id, timebase, siblingCandidate, [sibling.id]);
      const siblingCopy: KernelClip = {
        ...copy,
        id: operation.createdAudioClipId ?? ctx.newId('clp'),
        trackId: siblingTrack.id,
        sourceRange: mediaRangeSchema.parse(sibling.sourceRange),
        sequenceRange: rangeOf(siblingCandidate.start, siblingCandidate.end, timebase),
      };
      work.insertClip(siblingCopy, { action: 'INSERT_CLIP', objectKind: 'CLIP', objectId: siblingCopy.id, patch: { op: 'insert_clip', clipId: siblingCopy.id } });
    }
  }
}

export function replaceClipSource(work: WorkingTimeline, operation: Op<'replace_clip_source'>): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['CONTENT', 'DURATION']);
  const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
  // 替换源不得隐式改变片段在序列上的长度（改长度要用 trim_clip）。
  if (compareFraction(rangeDuration(sourceRange), rangeDuration(mediaRangeSchema.parse(clip.sequenceRange))) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'replacement source duration must match the clip duration', 422, { reason: 'SOURCE_DURATION_MISMATCH' });
  }
  work.assertSourceRangeUsable({ assetVersionId: operation.assetVersionId, nestedSequenceId: operation.nestedSequenceId, range: sourceRange });
  // 源基音频区域：源时钟已变，需重算（N03-06）→ fail-closed。
  for (const region of work.boundAudioRegions(clip.id)) {
    if ((region.timeBinding as { basis?: string } | null)?.basis === 'SOURCE') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region follows the replaced source clock', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
    }
  }
  const replace = (target: KernelClip): KernelClip => ({
    ...target,
    assetVersionId: operation.assetVersionId,
    nestedSequenceId: operation.nestedSequenceId,
    sourceStreamId: operation.sourceStreamId,
    sourceRange,
  });
  const siblings = work.avSiblingsOf(clip);
  work.updateClip(clip, replace(clip), { action: 'REPLACE_CLIP_SOURCE', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
  // AV 同步：关联片段换用同一新源，保持声画一致。
  for (const sibling of siblings) {
    work.updateClip(sibling, replace(sibling), { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id } });
  }
}

/** 按序列起点排序（同起点按 id），保证内核输出顺序确定。 */
function sortBySequenceStart(clips: readonly KernelClip[], timebase: { num: number; den: number }): KernelClip[] {
  return [...clips].sort((left, right) => {
    const a = ticksInRange(left.sequenceRange, timebase).start;
    const b = ticksInRange(right.sequenceRange, timebase).start;
    return a < b ? -1 : a > b ? 1 : left.id.localeCompare(right.id);
  });
}
