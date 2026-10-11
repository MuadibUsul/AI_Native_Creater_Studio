import {
  ApiFailure,
  ERROR_CODES,
  clipTimeMappingSchema,
  compareMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  visualCropSchema,
  visualParametersSchema,
  visualTransformSchema,
} from '@ancs/contracts';
import { WorkingTimeline, compareFraction, rangeDuration, refs } from './support.js';
import type { KernelClip, KernelContext, KernelEventDraft, KernelTimelineOperation, KernelTrack } from './types.js';

type Op<Name extends KernelTimelineOperation['op']> = Extract<KernelTimelineOperation, { op: Name }>;

/** 把一组轨道按最终顺序落位：只为位置变化的轨道产生写入（持久化层负责两阶段避免唯一索引冲突）。 */
function reorderTracks(
  work: WorkingTimeline,
  finalOrder: readonly KernelTrack[],
  eventFor: (before: KernelTrack, after: KernelTrack) => Omit<KernelEventDraft, 'snapshots'> | null,
): void {
  finalOrder.forEach((track, index) => {
    const current = work.tracks.get(track.id) ?? track;
    if (current.position === index) return;
    const after = { ...current, position: index };
    work.updateTrack(current, after, eventFor(current, after));
  });
}

/** create_track（N03-04）：目标位置被占用时该位置及之后的轨道整体后移一位。 */
export function createTrack(work: WorkingTimeline, operation: Op<'create_track'>, ctx: KernelContext): void {
  work.sequenceTimebase(operation.sequenceId);
  const shifted = work.tracksOfSequence(operation.sequenceId).filter((track) => track.position >= operation.track.position);
  const created: KernelTrack = {
    id: operation.restoreTrackId ?? ctx.newId('trk'),
    sequenceId: operation.sequenceId,
    kind: operation.track.kind,
    position: operation.track.position,
    name: operation.track.name,
    locked: operation.track.locked ?? false,
    muted: operation.track.muted ?? false,
    hidden: operation.track.hidden ?? false,
    solo: operation.track.solo ?? false,
    syncLocked: operation.track.syncLocked ?? false,
  };
  // 写入顺序：先插入新轨（被挤占的轨道由持久化层先移开），再落被后移轨道的最终位置；
  // 事件顺序：先记被后移轨道，最后记 CREATE_TRACK（与撤销语义一致）。
  work.insertTrack(created, null);
  const shiftEvents = shifted.map((existing) => {
    const after = { ...existing, position: existing.position + 1 };
    work.updateTrack(existing, after, null);
    return { existing, after };
  });
  for (const { existing, after } of shiftEvents) {
    work.emit({
      action: 'UPDATE_TRACK', objectKind: 'TRACK', objectId: existing.id,
      patch: { op: 'update_track', trackId: existing.id, changes: { position: after.position } },
      snapshots: { before: refs.track(existing), after: refs.track(after) },
    });
  }
  work.emit({ action: 'CREATE_TRACK', objectKind: 'TRACK', objectId: created.id, patch: { ...operation }, snapshots: { after: refs.track(created) } });
}

export function moveTrack(work: WorkingTimeline, operation: Op<'move_track'>): void {
  const target = work.findTrackOwned(operation.trackId);
  const siblings = work.tracksOfSequence(target.sequenceId).filter((track) => track.id !== target.id);
  const finalOrder = [...siblings];
  finalOrder.splice(Math.min(operation.position, siblings.length), 0, target);
  reorderTracks(work, finalOrder, (before) => ({
    action: before.id === target.id ? 'MOVE_TRACK' : 'UPDATE_TRACK', objectKind: 'TRACK', objectId: before.id,
    patch: { ...operation, trackId: before.id, changes: { position: finalOrder.findIndex((track) => track.id === before.id) } },
  }));
}

export function deleteTrack(work: WorkingTimeline, operation: Op<'delete_track'>): void {
  const target = work.findTrackOwned(operation.trackId);
  work.assertObjectLockAllows('TRACK', target.id, ['POSITION', 'DURATION']);
  const clips = work.clipsOnTrack(target.id);
  // 轨道上的字幕/音频区域/视觉对象不随 MOVE_CLIPS 迁移；必须先显式处理，不能交给外键级联静默删除（V5-M2）。
  const otherObjects = [...work.captions.values()].filter((caption) => caption.trackId === target.id).length
    + [...work.audioRegions.values()].filter((region) => region.trackId === target.id).length
    + (work.state.unmanagedTrackObjects?.get(target.id) ?? 0);
  if (otherObjects > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track still holds captions, audio regions or visual objects; delete or move them first', 409, {
      reason: 'TRACK_NOT_EMPTY', clipCount: clips.length, objectCount: otherObjects,
    });
  }
  if (clips.length > 0) {
    if (operation.nonEmptyPolicy === 'REJECT') {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is not empty; choose MOVE_CLIPS or delete the clips first', 409, { reason: 'TRACK_NOT_EMPTY', clipCount: clips.length });
    }
    const destination = work.findTrackOwned(String(operation.destinationTrackId));
    if (destination.id === target.id || destination.kind !== target.kind) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'destination track must differ and have the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
    }
    for (const clip of clips) {
      work.updateClip(clip, { ...clip, trackId: destination.id }, {
        action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, movedByTrackDelete: true },
      });
    }
  }
  work.deleteTrack(target, { action: 'DELETE_TRACK', objectKind: 'TRACK', objectId: target.id, patch: { ...operation } });
  reorderTracks(work, work.tracksOfSequence(target.sequenceId), (before, after) => ({
    action: 'UPDATE_TRACK', objectKind: 'TRACK', objectId: before.id,
    patch: { op: 'update_track', trackId: before.id, changes: { position: after.position } },
  }));
}

/**
 * update_track：轨道控制只改**这一条**轨道的状态（静音/独奏/隐藏/锁定/同步锁/名称）。
 * 改 position 时按 move_track 语义整体重排（V5-M1 修复：旧实现漏写目标轨位置，导致唯一索引冲突 500）。
 */
export function updateTrack(work: WorkingTimeline, operation: Op<'update_track'>): void {
  const target = work.findTrackOwned(operation.trackId);
  work.assertObjectLockAllows('TRACK', target.id, ['POSITION', 'STYLE']);
  const changes = operation.changes;
  const siblings = work.tracksOfSequence(target.sequenceId).filter((track) => track.id !== target.id);
  const position = changes.position === undefined ? target.position : Math.min(changes.position, siblings.length);
  const next: KernelTrack = {
    ...target,
    name: changes.name ?? target.name,
    locked: changes.locked ?? target.locked,
    muted: changes.muted ?? target.muted,
    hidden: changes.hidden ?? target.hidden,
    solo: changes.solo ?? target.solo,
    syncLocked: changes.syncLocked ?? target.syncLocked,
    position,
  };
  work.updateTrack(target, next, { action: 'UPDATE_TRACK', objectKind: 'TRACK', objectId: target.id, patch: { ...operation } });
  if (changes.position !== undefined && position !== target.position) {
    const finalOrder = [...siblings];
    finalOrder.splice(position, 0, next);
    reorderTracks(work, finalOrder, (before, after) => ({
      action: 'UPDATE_TRACK', objectKind: 'TRACK', objectId: before.id,
      patch: { op: 'update_track', trackId: before.id, changes: { position: after.position } },
    }));
  }
}

/** N03-05：把局部变更合并进片段参数命名空间（保持其余参数与组件自定义 values 不变）。 */
function nextVisualParameters(current: unknown, change: Partial<{ transform: unknown; crop: unknown; opacity: number }>): unknown {
  const base = visualParametersSchema.parse(current ?? {});
  return visualParametersSchema.parse({
    ...base,
    ...(change.transform === undefined ? {} : { transform: change.transform }),
    ...(change.crop === undefined ? {} : { crop: change.crop }),
    ...(change.opacity === undefined ? {} : { opacity: change.opacity }),
  });
}

/** 变换/裁切/透明度都是**参数化修改**——只改片段参数，不触发镜头重生成、不新增 Scene/Provider 任务。 */
export function setClipParameters(
  work: WorkingTimeline,
  operation: Op<'set_clip_transform'> | Op<'set_clip_crop'> | Op<'set_clip_opacity'>,
): void {
  const { clip } = work.editableClip(operation.clipId);
  work.assertObjectLockAllows('CLIP', clip.id, ['STYLE']);
  let parameters: unknown;
  let action: string;
  if (operation.op === 'set_clip_transform') {
    parameters = nextVisualParameters(clip.parameters, { transform: visualTransformSchema.parse(operation.transform) });
    action = 'SET_CLIP_TRANSFORM';
  } else if (operation.op === 'set_clip_crop') {
    const crop = visualCropSchema.parse(operation.crop);
    if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crop must leave a non-empty visible area', 422, { reason: 'CROP_AREA_EMPTY' });
    }
    parameters = nextVisualParameters(clip.parameters, { crop });
    action = 'SET_CLIP_CROP';
  } else {
    parameters = nextVisualParameters(clip.parameters, { opacity: operation.opacity });
    action = 'SET_CLIP_OPACITY';
  }
  work.updateClip(clip, { ...clip, parameters }, { action, objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
}

/** set_av_link（N03-04）：linked=true 把一视频一音频绑成新 avGroupId；false 解链。 */
export function setAvLink(work: WorkingTimeline, operation: Op<'set_av_link'>, ctx: KernelContext): void {
  const clips = operation.clipIds.map((clipId) => work.editableClip(clipId).clip);
  if (!operation.linked) {
    // 解链：清空 avGroupId —— 其后视频的 trim/move/split 不再联动音轨。
    for (const clip of clips) {
      if (clip.avGroupId === null) continue;
      work.updateClip(clip, { ...clip, avGroupId: null }, { action: 'SET_AV_LINK', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation, clipId: clip.id } });
    }
    return;
  }
  if (clips.length !== 2) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linking requires exactly two clips', 422, { reason: 'AV_LINK_INVALID' });
  const [left, right] = clips as [KernelClip, KernelClip];
  if (left.sequenceId !== right.sequenceId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linked clips must belong to the same sequence', 422, { reason: 'AV_LINK_INVALID' });
  }
  if (work.findTrackOwned(left.trackId).kind === work.findTrackOwned(right.trackId).kind) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AV link requires one video clip and one audio clip', 422, { reason: 'AV_LINK_INVALID' });
  }
  if (compareFraction(rangeDuration(mediaRangeSchema.parse(left.sequenceRange)), rangeDuration(mediaRangeSchema.parse(right.sequenceRange))) !== 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linked clips must have equal durations', 422, { reason: 'AV_LINK_DURATION_MISMATCH' });
  }
  const groupId = ctx.newId('avgp');
  for (const clip of clips) {
    work.updateClip(clip, { ...clip, avGroupId: groupId }, { action: 'SET_AV_LINK', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation, clipId: clip.id } });
  }
}

/** update_clip（底层字段修改；撤销/迁移等内部路径使用）：边界、源、父片段与线性映射全部校验。 */
export function updateClip(work: WorkingTimeline, operation: Op<'update_clip'>): void {
  const clip = work.findClip(operation.clipId);
  const changes = operation.changes;
  const candidate: KernelClip = {
    ...clip,
    ...(changes.trackId === undefined ? {} : { trackId: changes.trackId }),
    ...(changes.sourceStreamId === undefined ? {} : { sourceStreamId: changes.sourceStreamId }),
    ...(changes.sourceRange === undefined ? {} : { sourceRange: mediaRangeSchema.parse(changes.sourceRange) }),
    ...(changes.sequenceRange === undefined ? {} : { sequenceRange: mediaRangeSchema.parse(changes.sequenceRange) }),
    ...(changes.timeMapping === undefined ? {} : { timeMapping: clipTimeMappingSchema.parse(changes.timeMapping) }),
    ...(changes.avGroupId === undefined ? {} : { avGroupId: changes.avGroupId }),
    ...(changes.parentClipId === undefined ? {} : { parentClipId: changes.parentClipId }),
  };
  const track = work.tracks.get(candidate.trackId);
  if (!track || track.sequenceId !== clip.sequenceId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip track not found', 404);
  if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
  const sequence = work.state.sequences.get(clip.sequenceId);
  if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip sequence not found', 404);
  const sequenceRange = mediaRangeSchema.parse(candidate.sequenceRange);
  const sourceRange = mediaRangeSchema.parse(candidate.sourceRange);
  if (compareMediaTime(sequenceRange.start, { ticks: '0', timebase: sequenceRange.start.timebase }) < 0
    || compareMediaTime(sequenceRange.end, mediaTimeSchema.parse(sequence.duration)) > 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip sequence range exceeds sequence bounds', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
  }
  if (candidate.assetVersionId !== null) {
    work.assertAssetRangeUsable(candidate.assetVersionId, sourceRange);
  } else if (candidate.nestedSequenceId !== null) {
    const nested = work.state.sequences.get(candidate.nestedSequenceId);
    if (!nested || compareMediaTime(sourceRange.end, nested.duration) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
  }
  if (candidate.parentClipId !== null) {
    const parent = work.clips.get(candidate.parentClipId);
    if (!parent || parent.sequenceId !== clip.sequenceId) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'parent clip not found', 404);
  }
  const rate = clipTimeMappingSchema.parse(candidate.timeMapping).rate;
  const source = rangeDuration(sourceRange);
  const sequenceSpan = rangeDuration(sequenceRange);
  if (source.num * sequenceSpan.den * BigInt(rate.den) !== BigInt(rate.num) * source.den * sequenceSpan.num) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'timeMapping rate does not match source and sequence ranges', 422, { reason: 'TIME_MAPPING_MISMATCH' });
  }
  work.updateClip(clip, candidate, { action: 'UPDATE_CLIP', objectKind: 'CLIP', objectId: clip.id, patch: { ...operation } });
}
