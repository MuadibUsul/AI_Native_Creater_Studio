import {
  ApiFailure,
  ERROR_CODES,
  compareMediaTime,
  legacyMillisecondsToMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  type MediaRange,
  type MediaTime,
  type ObjectLockDimension,
  type ObjectLockKind,
} from '@ancs/contracts';
import {
  TimeNotRepresentableError,
  compareFractions,
  exactTicks as exactTicksStrict,
  mediaTimeFromTicks,
  rangeDurationFraction,
  timeToFraction,
  type Fraction,
} from '@ancs/time';
import { lockKey, type KernelAudioRegion, type KernelChange, type KernelClip, type KernelEventDraft, type KernelTrack, type TimelineState } from './types.js';

/** 有理秒 → 序列/源时基的精确 ticks；不能整除 → 422 TIME_NOT_REPRESENTABLE（与旧实现同一错误）。 */
export function exactTicks(value: Fraction, timebase: { num: number; den: number }): bigint {
  try {
    return exactTicksStrict(value, timebase);
  } catch (error) {
    if (error instanceof TimeNotRepresentableError) {
      if (error.message === 'invalid timebase') {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'invalid timebase', 422, { reason: 'TIME_BASE_INVALID' });
      }
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'time cannot be represented exactly in the sequence timebase', 422, { reason: 'TIME_NOT_REPRESENTABLE' });
    }
    throw error;
  }
}

export const timeFraction = (time: MediaTime): Fraction => timeToFraction(time);
export const rangeDuration = (range: MediaRange): Fraction => rangeDurationFraction(range);
export const compareFraction = (left: Fraction, right: Fraction): number => compareFractions(left, right);
export const mediaTimeOf = (ticks: bigint, timebase: { num: number; den: number }): MediaTime => mediaTimeFromTicks(ticks, timebase);
export const rangeOf = (start: bigint, end: bigint, timebase: { num: number; den: number }): MediaRange =>
  mediaRangeSchema.parse({ start: mediaTimeOf(start, timebase), end: mediaTimeOf(end, timebase) });

export function ticksInRange(range: MediaRange, timebase: { num: number; den: number }): { start: bigint; end: bigint } {
  const parsed = mediaRangeSchema.parse(range);
  return {
    start: exactTicks(timeFraction(parsed.start), timebase),
    end: exactTicks(timeFraction(parsed.end), timebase),
  };
}

export const CLIP_IDENTITY_MAPPING = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

export function identityForwardMapping(clip: KernelClip): boolean {
  const mapping = clip.timeMapping as { rate?: { num?: number; den?: number }; direction?: string } | null;
  return mapping?.direction === 'FORWARD' && (mapping?.rate?.num ?? 1) === 1 && (mapping?.rate?.den ?? 1) === 1;
}

/** 序列编辑时基与时长（ticks）。 */
export function sequenceTimebase(state: TimelineState): { durationTicks: bigint; timebase: { num: number; den: number } } {
  const duration = mediaTimeSchema.parse(state.sequence.duration);
  return { durationTicks: exactTicks(timeFraction(duration), duration.timebase), timebase: duration.timebase };
}

/**
 * 可变工作集：内核在一个操作内按顺序修改片段/音频区域/轨道，
 * 后续检查（如重叠）看到的是**已应用前序写入**的状态（与旧实现"同事务读到自己的写入"一致）。
 */
export class WorkingTimeline {
  readonly clips: Map<string, KernelClip>;
  readonly tracks: Map<string, KernelTrack>;
  readonly audioRegions: Map<string, KernelAudioRegion>;

  constructor(readonly state: TimelineState) {
    this.clips = new Map(state.clips.map((clip) => [clip.id, clip]));
    this.tracks = new Map(state.tracks.map((track) => [track.id, track]));
    this.audioRegions = new Map(state.audioRegions.map((region) => [region.id, region]));
  }

  findClip(clipId: string): KernelClip {
    const clip = this.clips.get(clipId);
    if (!clip) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip not found', 404);
    return clip;
  }

  /** 同序列轨道（不检查锁：轨道控制需要能解锁）。 */
  findTrackOwned(trackId: string): KernelTrack {
    const track = this.tracks.get(trackId);
    if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'track not found', 404);
    return track;
  }

  /** 可编辑轨道：存在且未锁。 */
  editableTrack(trackId: string): KernelTrack {
    const track = this.findTrackOwned(trackId);
    if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
    return track;
  }

  /** 片段及其所在轨道（轨道被锁 → 409）。 */
  editableClip(clipId: string): { clip: KernelClip; track: KernelTrack } {
    const clip = this.findClip(clipId);
    return { clip, track: this.editableTrack(clip.trackId) };
  }

  clipsOnTrack(trackId: string): KernelClip[] {
    return [...this.clips.values()].filter((clip) => clip.trackId === trackId);
  }

  /** 同 avGroupId 的关联片段（视频/音频对；不含自身）。 */
  avSiblingsOf(clip: KernelClip): KernelClip[] {
    if (clip.avGroupId === null) return [];
    return [...this.clips.values()].filter((candidate) => candidate.avGroupId === clip.avGroupId && candidate.id !== clip.id);
  }

  /** 绑定到该片段的音频区域（局部时钟同步的前置面）。 */
  boundAudioRegions(clipId: string): KernelAudioRegion[] {
    return [...this.audioRegions.values()].filter((region) => (region.timeBinding as { clipId?: string | null } | null)?.clipId === clipId);
  }

  lockDimensions(objectKind: ObjectLockKind, objectId: string): readonly ObjectLockDimension[] | null {
    return this.state.locks.get(lockKey(objectKind, objectId)) ?? null;
  }

  /** 显式对象锁：被锁维度命中即拒绝（对象锁语义）。 */
  assertObjectLockAllows(objectKind: ObjectLockKind, objectId: string, dimensions: readonly ObjectLockDimension[]): void {
    const locked = this.lockDimensions(objectKind, objectId) ?? [];
    if (locked.some((dimension) => dimensions.includes(dimension))) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target object is locked for this change', 409, {
        reason: 'EDIT_IMPACT_LOCKED',
        objectKind,
        objectId,
      });
    }
  }

  /** 目标轨重叠检查（半开区间；排除给定片段）。 */
  assertNoTrackOverlap(trackId: string, timebase: { num: number; den: number }, candidate: { start: bigint; end: bigint }, excludeClipIds: readonly string[]): void {
    for (const clip of this.clipsOnTrack(trackId)) {
      if (excludeClipIds.includes(clip.id)) continue;
      const span = ticksInRange(clip.sequenceRange, timebase);
      if (span.start >= candidate.end || span.end <= candidate.start) continue;
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target range overlaps an existing clip', 409, { reason: 'CLIP_OVERLAP', clipId: clip.id });
    }
  }

  /** 源侧边界（素材时长 / 嵌套序列时长）+ READY/校验和检查。 */
  assertSourceRangeUsable(input: { assetVersionId: string | null; nestedSequenceId: string | null; range: MediaRange }): void {
    const zero = (time: MediaTime): MediaTime => mediaTimeOf(0n, time.timebase);
    if (input.assetVersionId !== null) {
      const source = this.state.sources.assetVersions.get(input.assetVersionId);
      if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
      if (source.status !== 'READY' || source.durationMs === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version is not ready with known duration', 409);
      if (source.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version has no immutable checksum', 409, { reason: 'SOURCE_CHECKSUM_MISSING' });
      if (compareMediaTime(input.range.start, zero(input.range.start)) < 0
        || compareMediaTime(input.range.end, legacyMillisecondsToMediaTime(source.durationMs)) > 0) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds asset duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
      }
      return;
    }
    if (input.nestedSequenceId !== null) {
      const nested = this.state.sources.sequenceDurations.get(input.nestedSequenceId);
      if (!nested) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'nested sequence not found', 404);
      if (compareMediaTime(input.range.start, zero(input.range.start)) < 0 || compareMediaTime(input.range.end, nested) > 0) {
        throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
      }
      return;
    }
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source is missing', 422, { reason: 'SOURCE_MISSING' });
  }

  /** 记录写入并同步工作集。 */
  readonly changes: KernelChange[] = [];

  insertClip(clip: KernelClip, event: KernelEventDraft | null): void {
    this.clips.set(clip.id, clip);
    this.changes.push({ write: { entity: 'clip', type: 'insert', after: clip }, event });
  }

  updateClip(before: KernelClip, after: KernelClip, event: KernelEventDraft | null): void {
    this.clips.set(after.id, after);
    this.changes.push({ write: { entity: 'clip', type: 'update', before, after }, event });
  }

  deleteClip(before: KernelClip, event: KernelEventDraft | null): void {
    this.clips.delete(before.id);
    this.changes.push({ write: { entity: 'clip', type: 'delete', before }, event });
  }

  insertTrack(track: KernelTrack): void {
    this.tracks.set(track.id, track);
    this.changes.push({ write: { entity: 'track', type: 'insert', after: track }, event: null });
  }

  updateAudioRegion(before: KernelAudioRegion, after: KernelAudioRegion, event: KernelEventDraft | null): void {
    this.audioRegions.set(after.id, after);
    this.changes.push({ write: { entity: 'audioRegion', type: 'update', before, after }, event });
  }
}

export const sequenceSeconds = (ticks: bigint, timebase: { num: number; den: number }): Fraction => ({
  num: ticks * BigInt(timebase.num),
  den: BigInt(timebase.den),
});
