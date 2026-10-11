import {
  ApiFailure,
  ERROR_CODES,
  PLAYBACK_ERROR_REASONS,
  RENDER_PLAN_HASHED_FIELDS,
  RENDER_PLAN_IR_VERSION,
  clipTimeMappingSchema,
  mediaRangeSchema,
  mediaTimeSchema,
  renderPlanSchema,
  versionedParametersSchema,
  visualParametersSchema,
  type FrameRate,
  type MediaRange,
  type MediaTime,
  type PlaybackCapabilities,
  type RenderPlan,
  type RenderPlanAudioEntry,
  type RenderPlanCaption,
  type RenderPlanSource,
  type RenderPlanVideoLayer,
  type RenderPlanVideoSegment,
  type RenderRequirement,
} from '@ancs/contracts';
import { compareFractions, compareMediaTime, mediaTimeFromTicks, rangeDurationFraction, sequenceTimeToSourcePts } from '@ancs/time';
import type { KernelAudioRegion, KernelCaption, KernelClip, KernelTrack } from '../timeline/types.js';
import { canonicalJson, sha256Hex } from './hash.js';

/**
 * V5-M4（§13）：`compileRenderPlan` —— 序列状态 → RenderPlan IR 的**纯编译器**。
 *
 * 输入是内存中的序列状态（与编辑内核同一组实体类型）加上源素材的不可变事实；
 * 不读数据库、不取墙钟。浏览器播放快照、服务端合成计划与终渲染后端都从同一个输出派生。
 *
 * fail-closed：
 * - 输出将要发声/出画的条目，其源必须可播放（READY + 校验和 + 存储对象 + 时长）→ 否则 409 `SOURCE_NOT_PLAYABLE`；
 * - 音频区域绑定的片段不存在或没有源 → 同上（不输出空源 ID）；
 * - 没有任何视频段与音频条目 → 409 `EMPTY_TIMELINE`。
 * 能力取舍不在编译器里做：编译器只如实列出 `requirements`，由 `assertRenderPlanSupported` 按后端裁决。
 */

/** 源素材版本的不可变事实（入库与探测产生，编辑不改变）。 */
export interface RenderSourceFacts {
  assetId: string;
  status: string;
  checksumSha256: string | null;
  /** 对象存储中已有字节（storageKey 非空） */
  stored: boolean;
  durationKnown: boolean;
  hasAudio: boolean;
}

export interface RenderPlanInput {
  projectId: string;
  documentRevision: number;
  sequence: { id: string; duration: MediaTime; frameRate: FrameRate };
  /** 可传入整个项目的实体；编译器只取本序列 */
  tracks: readonly KernelTrack[];
  clips: readonly KernelClip[];
  audioRegions: readonly KernelAudioRegion[];
  captions: readonly KernelCaption[];
  /** 视觉对象（需要逐帧组件渲染） */
  visualObjects: readonly { id: string; sequenceId: string; trackId: string }[];
  animationBindings: readonly { id: string; sequenceId: string; targetKind: string; targetId: string; propertyPath: string }[];
  /** 按 assetVersionId；缺失 = 不存在或不属于本工作区 */
  sources: ReadonlyMap<string, RenderSourceFacts>;
}

const byStartThenId = <T extends { sequenceRange: MediaRange }>(idOf: (value: T) => string) => (left: T, right: T): number =>
  compareMediaTime(left.sequenceRange.start, right.sequenceRange.start) || (idOf(left) < idOf(right) ? -1 : idOf(left) > idOf(right) ? 1 : 0);

const byPositionThenId = (left: KernelTrack, right: KernelTrack): number =>
  left.position - right.position || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const zeroLike = (time: MediaTime): MediaTime => mediaTimeFromTicks(0n, time.timebase);

const sourceNotPlayable = (details: Record<string, unknown>): ApiFailure =>
  new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip source is not playable', 409, { reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE, ...details });

/** 序列区间与源区间是否 1:1 正向（否则需要变速/倒放能力）。 */
function isIdentityTiming(mapping: { rate: { num: number; den: number }; direction: string }, sequenceRange: MediaRange, sourceRange: MediaRange): boolean {
  return mapping.direction === 'FORWARD'
    && mapping.rate.num === mapping.rate.den
    && compareFractions(rangeDurationFraction(sequenceRange), rangeDurationFraction(sourceRange)) === 0;
}

const isIdentityTransform = (segment: RenderPlanVideoSegment): boolean =>
  segment.transform.position.x === 0 && segment.transform.position.y === 0
  && segment.transform.scale.x === 1 && segment.transform.scale.y === 1
  && segment.transform.rotationDeg === 0;

const hasCrop = (segment: RenderPlanVideoSegment): boolean =>
  segment.crop.left !== 0 || segment.crop.top !== 0 || segment.crop.right !== 0 || segment.crop.bottom !== 0;

const rangesOverlap = (left: MediaRange, right: MediaRange): boolean =>
  compareMediaTime(left.start, right.end) < 0 && compareMediaTime(right.start, left.end) < 0;

/** 文案受契约 200 字符上限约束：ID 过多时改为计数。 */
const listWarning = (label: string, ids: readonly string[]): string => {
  const full = `${label}: ${ids.join(',')}`;
  return full.length <= 200 ? full : `${label}: ${String(ids.length)} (see excludedTrackIds)`;
};

export function compileRenderPlan(input: RenderPlanInput): RenderPlan {
  const sequenceId = input.sequence.id;
  const tracks = input.tracks.filter((track) => track.sequenceId === sequenceId).sort(byPositionThenId);
  const trackById = new Map(tracks.map((track) => [track.id, track]));
  const clips = input.clips.filter((clip) => clip.sequenceId === sequenceId && trackById.has(clip.trackId));
  const clipById = new Map(clips.map((clip) => [clip.id, clip]));
  const warnings: string[] = [];
  const requirements = new Set<RenderRequirement>();
  const usedSources = new Map<string, RenderPlanSource>();

  const useSource = (assetVersionId: string, details: Record<string, unknown>): void => {
    const facts = input.sources.get(assetVersionId);
    if (facts === undefined || facts.status !== 'READY' || facts.checksumSha256 === null || !facts.stored || !facts.durationKnown) {
      throw sourceNotPlayable({ ...details, assetVersionId });
    }
    usedSources.set(assetVersionId, { assetVersionId, assetId: facts.assetId, checksumSha256: facts.checksumSha256, hasAudio: facts.hasAudio });
  };

  // ── 排除项：隐藏的视频/图形/字幕轨（音频轨用静音/独奏表达可听性，不按 hidden 排除）
  const hiddenOf = (kind: string): string[] => tracks.filter((track) => track.kind === kind && track.hidden).map((track) => track.id);
  const hiddenVideo = hiddenOf('VIDEO');
  const hiddenGraphic = hiddenOf('GRAPHIC');
  const hiddenCaption = hiddenOf('CAPTION');
  if (hiddenVideo.length > 0) warnings.push(listWarning('hidden video tracks excluded', hiddenVideo));
  if (hiddenGraphic.length > 0) warnings.push(listWarning('hidden graphic tracks excluded', hiddenGraphic));
  if (hiddenCaption.length > 0) warnings.push(listWarning('hidden caption tracks excluded', hiddenCaption));
  const excludedTrackIds = [...hiddenVideo, ...hiddenGraphic, ...hiddenCaption];
  const excluded = new Set(excludedTrackIds);

  // ── 视频层（自下而上 = position 升序）
  const videoLayers: RenderPlanVideoLayer[] = [];
  for (const track of tracks) {
    if (track.kind !== 'VIDEO' || excluded.has(track.id)) continue;
    const segments: RenderPlanVideoSegment[] = [];
    for (const clip of clips.filter((candidate) => candidate.trackId === track.id)) {
      if (clip.nestedSequenceId !== null || clip.assetVersionId === null) {
        requirements.add('NESTED_SEQUENCE');
        warnings.push(listWarning('nested sequence clip not compiled', [clip.id]));
        continue;
      }
      useSource(clip.assetVersionId, { clipId: clip.id });
      const parameters = visualParametersSchema.parse(clip.parameters ?? {});
      const sequenceRange = mediaRangeSchema.parse(clip.sequenceRange);
      const sourceRange = mediaRangeSchema.parse(clip.sourceRange);
      const timeMapping = clipTimeMappingSchema.parse(clip.timeMapping ?? {});
      segments.push({
        clipId: clip.id,
        sourceVersionId: clip.assetVersionId,
        sourceStreamId: clip.sourceStreamId,
        sequenceRange,
        sourceRange,
        timeMapping,
        transform: parameters.transform,
        crop: parameters.crop,
        opacity: parameters.opacity,
      });
      if (!isIdentityTiming(timeMapping, sequenceRange, sourceRange)) requirements.add('TIME_REMAP');
    }
    segments.sort(byStartThenId((segment) => segment.clipId));
    for (const segment of segments) {
      if (!isIdentityTransform(segment)) requirements.add('PER_SEGMENT_TRANSFORM');
      if (hasCrop(segment)) requirements.add('PER_SEGMENT_CROP');
      if (segment.opacity < 1) requirements.add('PER_SEGMENT_OPACITY');
    }
    if (segments.length > 0) videoLayers.push({ trackId: track.id, trackPosition: track.position, segments });
  }
  if (videoLayers.length > 1) requirements.add('MULTI_TRACK_COMPOSITE');

  // ── 音频：区域 + 音频轨片段原声（区域接管其所绑 AV 组的音频）
  const audioTracks = tracks.filter((track) => track.kind === 'AUDIO');
  const soloActive = audioTracks.some((track) => track.solo);
  const audibleOf = (track: KernelTrack): boolean => !track.muted && (soloActive ? track.solo : true);
  const regions = input.audioRegions.filter((region) => region.sequenceId === sequenceId && trackById.get(region.trackId)?.kind === 'AUDIO');
  const takenOverClips = new Set<string>();
  const takenOverGroups = new Set<string>();
  const audio: RenderPlanAudioEntry[] = [];
  for (const region of regions) {
    const track = trackById.get(region.trackId) as KernelTrack;
    const binding = region.timeBinding as { basis?: string; clipId?: string | null } | null;
    const clip = binding?.clipId == null ? undefined : clipById.get(binding.clipId);
    if (clip === undefined || clip.assetVersionId === null || (binding?.basis !== 'CLIP_LOCAL' && binding?.basis !== 'SOURCE')) {
      throw sourceNotPlayable({ audioRegionId: region.id, cause: 'AUDIO_SOURCE_UNRESOLVED' });
    }
    takenOverClips.add(clip.id);
    if (clip.avGroupId !== null) takenOverGroups.add(clip.avGroupId);
    const sequenceRange = mediaRangeSchema.parse(region.sequenceRange);
    const clipSequence = mediaRangeSchema.parse(clip.sequenceRange);
    const clipSource = mediaRangeSchema.parse(clip.sourceRange);
    const mapping = clipTimeMappingSchema.parse(clip.timeMapping ?? {});
    if (!isIdentityTiming(mapping, clipSequence, clipSource)) requirements.add('TIME_REMAP');
    // CLIP_LOCAL：区域的序列区间落在所绑片段内 → 按片段映射到源时钟；SOURCE：局部区间即源区间
    const sourceRange = binding.basis === 'SOURCE'
      ? mediaRangeSchema.parse(region.localRange)
      : mediaRangeSchema.parse({
        start: sequenceTimeToSourcePts(sequenceRange.start, clipSequence, clipSource, 'nearest'),
        end: sequenceTimeToSourcePts(sequenceRange.end, clipSequence, clipSource, 'nearest'),
      });
    const entry: RenderPlanAudioEntry = {
      kind: 'REGION',
      id: region.id,
      trackId: track.id,
      sourceVersionId: clip.assetVersionId,
      sourceStreamId: region.sourceStreamId,
      sequenceRange,
      sourceRange,
      channelMapping: Array.isArray(region.channelMapping) ? (region.channelMapping as RenderPlanAudioEntry['channelMapping']) : null,
      gainDb: region.gainDb,
      pan: region.pan,
      fadeIn: mediaTimeSchema.parse(region.fadeIn),
      fadeOut: mediaTimeSchema.parse(region.fadeOut),
      audible: audibleOf(track),
    };
    if (entry.audible) useSource(clip.assetVersionId, { audioRegionId: region.id });
    audio.push(entry);
  }
  for (const clip of clips) {
    const track = trackById.get(clip.trackId) as KernelTrack;
    if (track.kind !== 'AUDIO') continue;
    if (takenOverClips.has(clip.id) || (clip.avGroupId !== null && takenOverGroups.has(clip.avGroupId))) continue;
    if (clip.nestedSequenceId !== null || clip.assetVersionId === null) {
      requirements.add('NESTED_SEQUENCE');
      warnings.push(listWarning('nested sequence clip not compiled', [clip.id]));
      continue;
    }
    const sequenceRange = mediaRangeSchema.parse(clip.sequenceRange);
    const sourceRange = mediaRangeSchema.parse(clip.sourceRange);
    if (!isIdentityTiming(clipTimeMappingSchema.parse(clip.timeMapping ?? {}), sequenceRange, sourceRange)) requirements.add('TIME_REMAP');
    const entry: RenderPlanAudioEntry = {
      kind: 'CLIP_AUDIO',
      id: clip.id,
      trackId: track.id,
      sourceVersionId: clip.assetVersionId,
      sourceStreamId: clip.sourceStreamId,
      sequenceRange,
      sourceRange,
      channelMapping: null,
      gainDb: 0,
      pan: 0,
      fadeIn: zeroLike(sequenceRange.start),
      fadeOut: zeroLike(sequenceRange.start),
      audible: audibleOf(track),
    };
    if (entry.audible) useSource(clip.assetVersionId, { clipId: clip.id });
    audio.push(entry);
  }
  const trackOrder = new Map(tracks.map((track, index) => [track.id, index]));
  audio.sort((left, right) => (trackOrder.get(left.trackId) ?? 0) - (trackOrder.get(right.trackId) ?? 0) || byStartThenId<RenderPlanAudioEntry>((entry) => entry.id)(left, right));
  const audible = audio.filter((entry) => entry.audible);
  if (audible.some((entry) => entry.gainDb !== 0 || entry.pan !== 0 || entry.fadeIn.ticks !== '0' || entry.fadeOut.ticks !== '0')) {
    requirements.add('AUDIO_GAIN_FADE_PAN');
  }
  if (audible.some((left, index) => audible.some((right, other) => other > index && right.trackId === left.trackId && rangesOverlap(left.sequenceRange, right.sequenceRange)))) {
    requirements.add('AUDIO_CROSSFADE');
  }

  // ── 字幕（不可见字幕轨已排除）
  const captions: RenderPlanCaption[] = input.captions
    .filter((caption) => caption.sequenceId === sequenceId && trackById.get(caption.trackId)?.kind === 'CAPTION' && !excluded.has(caption.trackId))
    .map((caption) => ({
      captionId: caption.id,
      trackId: caption.trackId,
      sequenceRange: mediaRangeSchema.parse(caption.sequenceRange),
      text: caption.text,
      languageTag: caption.languageTag,
      style: versionedParametersSchema.parse(caption.style),
    }))
    .sort(byStartThenId((caption) => caption.captionId));
  if (captions.length > 0) requirements.add('CAPTIONS_BURNED_IN');

  // ── 需要逐帧组件渲染的元素：可见轨上的视觉对象 + 图形轨片段
  const graphicsElementIds = [
    ...input.visualObjects.filter((object) => object.sequenceId === sequenceId && trackById.has(object.trackId) && !excluded.has(object.trackId)).map((object) => object.id),
    ...clips.filter((clip) => trackById.get(clip.trackId)?.kind === 'GRAPHIC' && !excluded.has(clip.trackId)).map((clip) => clip.id),
  ].sort();
  if (graphicsElementIds.length > 0) requirements.add('GRAPHICS_COMPONENT_RENDER');

  // ── 关键帧：只计入作用于本计划内元素的绑定
  const planElementIds = new Set<string>([
    ...videoLayers.flatMap((layer) => layer.segments.map((segment) => segment.clipId)),
    ...audio.map((entry) => entry.id),
    ...captions.map((caption) => caption.captionId),
    ...graphicsElementIds,
  ]);
  const animatedTargets = input.animationBindings
    .filter((binding) => binding.sequenceId === sequenceId && planElementIds.has(binding.targetId))
    .map((binding) => ({ bindingId: binding.id, targetKind: binding.targetKind, targetId: binding.targetId, propertyPath: binding.propertyPath }))
    .sort((left, right) => (left.bindingId < right.bindingId ? -1 : left.bindingId > right.bindingId ? 1 : 0));
  if (animatedTargets.length > 0) requirements.add('KEYFRAME_ANIMATION');

  if (videoLayers.length === 0 && audio.length === 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'sequence has no playable content', 409, { reason: PLAYBACK_ERROR_REASONS.EMPTY_TIMELINE });
  }

  const body: Pick<RenderPlan, (typeof RENDER_PLAN_HASHED_FIELDS)[number]> = {
    irVersion: RENDER_PLAN_IR_VERSION,
    frameRate: { num: input.sequence.frameRate.num, den: input.sequence.frameRate.den },
    duration: mediaTimeSchema.parse(input.sequence.duration),
    sources: [...usedSources.values()].sort((left, right) => (left.assetVersionId < right.assetVersionId ? -1 : left.assetVersionId > right.assetVersionId ? 1 : 0)),
    videoLayers,
    audio,
    captions,
    graphicsElementIds,
    animatedTargets,
    requirements: [...requirements].sort(),
    excludedTrackIds,
  };
  return renderPlanSchema.parse({
    ...body,
    planHash: renderPlanHash(body),
    projectId: input.projectId,
    sequenceId,
    documentRevision: input.documentRevision,
    warnings,
  });
}

/** planHash：只覆盖渲染内容字段（`RENDER_PLAN_HASHED_FIELDS`）。 */
export function renderPlanHash(plan: Pick<RenderPlan, (typeof RENDER_PLAN_HASHED_FIELDS)[number]>): string {
  const hashed: Record<string, unknown> = {};
  for (const field of RENDER_PLAN_HASHED_FIELDS) hashed[field] = plan[field];
  return sha256Hex(canonicalJson(hashed));
}

/** 计划的需求中，后端未显式声明支持的部分（未声明 = 不支持）。 */
export function unsupportedRenderRequirements(plan: Pick<RenderPlan, 'requirements'>, capabilities: PlaybackCapabilities): RenderRequirement[] {
  return plan.requirements.filter((requirement) => !capabilities.supported.includes(requirement) || capabilities.unsupported.includes(requirement));
}

/**
 * 后端裁决：任一需求不被支持 → 501 `UNSUPPORTED_CAPABILITY`（显式拒绝，不静默省略效果）。
 * `capability` 为首个缺失能力（兼容既有调用方），`capabilities` 列出全部缺失项。
 */
export function assertRenderPlanSupported(plan: RenderPlan, capabilities: PlaybackCapabilities): void {
  const missing = unsupportedRenderRequirements(plan, capabilities);
  if (missing.length === 0) return;
  const first = missing[0] as RenderRequirement;
  throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `render plan requires ${missing.join(', ')}, which backend ${capabilities.backend} does not support`, 501, {
    reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
    capability: first,
    capabilities: missing,
    backend: capabilities.backend,
    ...(first === 'GRAPHICS_COMPONENT_RENDER' ? { objectCount: plan.graphicsElementIds.length } : {}),
  });
}

/** 段/条目在序列时间上的重叠检查（供后端分区复用）。 */
export const renderRangesOverlap = rangesOverlap;
