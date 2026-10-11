import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PLAYBACK_ERROR_REASONS,
  PLAYBACK_SNAPSHOT_VERSION,
  frameIndexToMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  playbackFrameAt,
  playbackSnapshotSchema,
  sourceMediaProbeResultSchema,
  visualCropSchema,
  visualParametersSchema,
  visualTransformSchema,
  type PlaybackBackendKind,
  type PlaybackCapabilities,
  type PlaybackCapabilityFlag,
  type PlaybackSnapshot,
} from '@ancs/contracts';
import {
  assetVersions,
  assets,
  compositionAudioRegions,
  compositionCaptionSpans,
  compositionVisualObjects,
  projectSequences,
  projects,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * N03-08 多轨媒体预览与真实合成：**播放快照**投影。
 *
 * 一份工程文档 → 一份快照：视频段、音频段、字幕、能力与排除项全部由同一投影产出，
 * 预览（HTML_MEDIA_BASELINE）与服务端合成（SERVER_PRECOMPOSED）都消费它，
 * 因此"窗口预览与服务端合成关键帧对照"可逐帧核对，且不存在浏览器 props 之外的隐藏工程。
 */

export const PLAYBACK_BACKEND_CAPABILITIES: Record<PlaybackBackendKind, PlaybackCapabilities> = {
  // 浏览器 baseline：逐段媒体 + CSS 变换/裁切/透明度 + WebAudio 混音；不做逐帧组件渲染（v0.4 增量要求）
  HTML_MEDIA_BASELINE: {
    backend: 'HTML_MEDIA_BASELINE',
    videoPrecision: 'KEYFRAME_APPROXIMATE',
    audioPrecision: 'FRAME_ACCURATE',
    supported: ['PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE', 'CAPTIONS_BURNED_IN', 'MULTI_TRACK_COMPOSITE'],
    unsupported: ['GRAPHICS_COMPONENT_RENDER'],
  },
  // 服务端预合成（G0 baseline / 受控预渲染）：逐帧准确，可渲染组件图形
  SERVER_PRECOMPOSED: {
    backend: 'SERVER_PRECOMPOSED',
    videoPrecision: 'FRAME_ACCURATE',
    audioPrecision: 'FRAME_ACCURATE',
    supported: ['PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE', 'CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER', 'MULTI_TRACK_COMPOSITE'],
    unsupported: [],
  },
};

/** 能力查询：未显式列出的能力一律视为**不支持**（不得把未知能力展示为支持）。 */
export const playbackSupports = (capabilities: PlaybackCapabilities, flag: PlaybackCapabilityFlag): boolean =>
  capabilities.supported.includes(flag) && !capabilities.unsupported.includes(flag);

export interface ServerSynthesisPlan {
  schemaVersion: 'server-synthesis-plan/1.0';
  backend: 'SERVER_PRECOMPOSED';
  documentRevision: number;
  frameRate: { num: number; den: number };
  duration: ReturnType<typeof mediaTimeSchema.parse>;
  segments: {
    clipId: string;
    trackId: string;
    startFrame: string;
    endFrameExclusive: string;
    sequenceRange: ReturnType<typeof mediaRangeSchema.parse>;
    sourceRange: ReturnType<typeof mediaRangeSchema.parse>;
  }[];
  captions: { captionId: string; startFrame: string; endFrameExclusive: string; text: string }[];
  audio: { id: string; startFrame: string; endFrameExclusive: string; gainDb: number; audible: boolean }[];
}

export async function buildPlaybackSnapshot(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; backend?: PlaybackBackendKind },
): Promise<PlaybackSnapshot> {
  const backend: PlaybackBackendKind = input.backend ?? 'HTML_MEDIA_BASELINE';
  const capabilities = PLAYBACK_BACKEND_CAPABILITIES[backend];
  const sequenceRows = await deps.db.select().from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  const sequence = sequenceRows[0];
  if (!sequence) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404, { reason: PLAYBACK_ERROR_REASONS.SEQUENCE_NOT_FOUND });
  }
  const projectRows = await deps.db.select({ revision: projects.revision }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  const documentRevision = projectRows[0]?.revision ?? 0;
  const duration = mediaTimeSchema.parse(sequence.duration);

  const tracks = await deps.db.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.sequenceId, input.sequenceId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
  ));
  const audioTracks = tracks.filter((track) => track.kind === 'AUDIO');
  const soloActive = audioTracks.some((track) => track.solo);
  const excludedTrackIds = tracks.filter((track) => track.hidden && track.kind === 'VIDEO').map((track) => track.id);

  const clips = await deps.db.select({
    clip: sequenceClips,
    assetId: assets.id,
    versionStatus: assetVersions.status,
    versionChecksum: assetVersions.checksumSha256,
    versionDurationMs: assetVersions.durationMs,
    mediaProbe: assetVersions.mediaProbe,
    versionStorageKey: assetVersions.storageKey,
  }).from(sequenceClips)
    .innerJoin(assetVersions, eq(assetVersions.id, sequenceClips.assetVersionId))
    .innerJoin(assets, eq(assets.id, assetVersions.assetId))
    .where(and(
      eq(sequenceClips.sequenceId, input.sequenceId),
      eq(sequenceClips.workspaceId, input.workspaceId),
      eq(sequenceClips.projectId, input.projectId),
    ));

  const videoSegments = [] as PlaybackSnapshot['videoSegments'];
  const warnings: string[] = [];
  for (const row of clips) {
    const track = tracks.find((candidate) => candidate.id === row.clip.trackId);
    if (track === undefined) continue;
    if (track.kind !== 'VIDEO') continue;
    // 隐藏的视频轨不进入播放段（在 excludedTrackIds/warnings 中显式列出，不静默丢弃）
    if (track.hidden) continue;
    if (row.versionStatus !== 'READY' || row.versionChecksum === null || row.versionStorageKey === null || row.versionDurationMs === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip source is not playable', 409, {
        reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE,
        clipId: row.clip.id,
      });
    }
    const parameters = row.clip.parameters === null || row.clip.parameters === undefined
      ? visualParametersSchema.parse({})
      : visualParametersSchema.parse(row.clip.parameters);
    const probe = sourceMediaProbeResultSchema.safeParse(row.mediaProbe);
    const sourceHasAudio = probe.success && probe.data.status === 'READY' && probe.data.streams.some((stream) => stream.type === 'AUDIO');
    videoSegments.push({
      clipId: row.clip.id,
      trackId: track.id,
      assetId: row.assetId,
      sourceVersionId: row.clip.assetVersionId ?? '',
      sourceStreamId: row.clip.sourceStreamId,
      sequenceRange: mediaRangeSchema.parse(row.clip.sequenceRange),
      sourceRange: mediaRangeSchema.parse(row.clip.sourceRange),
      timeMapping: row.clip.timeMapping as PlaybackSnapshot['videoSegments'][number]['timeMapping'],
      transform: visualTransformSchema.parse(parameters.transform),
      crop: visualCropSchema.parse(parameters.crop),
      opacity: parameters.opacity,
      sourceHasAudio,
    });
  }
  if (excludedTrackIds.length > 0) {
    warnings.push(`hidden video tracks excluded: ${excludedTrackIds.join(',')}`);
  }

  const regions = await deps.db.select().from(compositionAudioRegions).where(and(
    eq(compositionAudioRegions.sequenceId, input.sequenceId),
    eq(compositionAudioRegions.workspaceId, input.workspaceId),
    eq(compositionAudioRegions.projectId, input.projectId),
  ));
  const audioSegments = [] as PlaybackSnapshot['audioSegments'];
  for (const row of regions) {
    const track = audioTracks.find((candidate) => candidate.id === row.trackId);
    if (track === undefined) continue;
    const audible = !track.muted && (soloActive ? track.solo : true);
    // 引用片段派生的音频（未建立独立区域时）与显式区域都进入同一列表，便于对照
    const linkedClip = clips.find((candidate) => candidate.clip.id === (row.timeBinding as { clipId?: string | null }).clipId);
    audioSegments.push({
      kind: 'REGION',
      id: row.id,
      trackId: track.id,
      assetId: linkedClip?.assetId ?? '',
      sourceVersionId: linkedClip?.clip.assetVersionId ?? '',
      sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
      sourceRange: mediaRangeSchema.parse(row.localRange),
      gainDb: Number(row.gainDb),
      pan: Number(row.pan),
      fadeIn: mediaTimeSchema.parse(row.fadeIn),
      fadeOut: mediaTimeSchema.parse(row.fadeOut),
      audible,
    });
  }

  const captionRows = await deps.db.select().from(compositionCaptionSpans).where(and(
    eq(compositionCaptionSpans.sequenceId, input.sequenceId),
    eq(compositionCaptionSpans.workspaceId, input.workspaceId),
    eq(compositionCaptionSpans.projectId, input.projectId),
  ));
  const captionTracks = tracks.filter((track) => track.kind === 'CAPTION');
  const captions = captionRows
    .filter((row) => captionTracks.some((track) => track.id === row.trackId && !track.hidden))
    .map((row) => ({
      captionId: row.id,
      trackId: row.trackId,
      sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
      text: row.text,
      languageTag: row.languageTag,
      style: row.style as PlaybackSnapshot['captions'][number]['style'],
    }));

  const graphics = await deps.db.select({ id: compositionVisualObjects.id }).from(compositionVisualObjects).where(and(
    eq(compositionVisualObjects.sequenceId, input.sequenceId),
    eq(compositionVisualObjects.workspaceId, input.workspaceId),
    eq(compositionVisualObjects.projectId, input.projectId),
  ));
  if (graphics.length > 0 && !playbackSupports(capabilities, 'GRAPHICS_COMPONENT_RENDER')) {
    // 图形对象需要逐帧渲染：baseline 后端**明确不支持**，不得用静态截图冒充连续播放
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'graphics objects require per-frame rendering; use the server-synthesized backend', 501, {
      reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY,
      capability: 'GRAPHICS_COMPONENT_RENDER',
      backend,
      objectCount: graphics.length,
    });
  }

  if (videoSegments.length === 0 && audioSegments.length === 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'sequence has no playable content', 409, { reason: PLAYBACK_ERROR_REASONS.EMPTY_TIMELINE });
  }

  return playbackSnapshotSchema.parse({
    schemaVersion: PLAYBACK_SNAPSHOT_VERSION,
    projectId: input.projectId,
    sequenceId: input.sequenceId,
    documentRevision,
    frameRate: sequence.frameRate as { num: number; den: number },
    duration,
    capabilities,
    videoSegments,
    audioSegments,
    captions,
    excludedTrackIds,
    warnings,
  });
}

/** 服务端合成计划：与快照同源、同帧映射（供 render-worker 消费；不引入第二套工程状态）。 */
export function buildServerSynthesisPlan(snapshot: PlaybackSnapshot): ServerSynthesisPlan {
  const frameRate = snapshot.frameRate;
  const frameOf = (time: unknown): string => playbackFrameAt(time, frameRate, 'floor');
  return {
    schemaVersion: 'server-synthesis-plan/1.0',
    backend: 'SERVER_PRECOMPOSED',
    documentRevision: snapshot.documentRevision,
    frameRate,
    duration: snapshot.duration,
    segments: [...snapshot.videoSegments]
      .sort((left, right) => Number(left.sequenceRange.start.ticks) - Number(right.sequenceRange.start.ticks))
      .map((segment) => ({
        clipId: segment.clipId,
        trackId: segment.trackId,
        startFrame: frameOf(segment.sequenceRange.start),
        endFrameExclusive: frameOf(segment.sequenceRange.end),
        sequenceRange: segment.sequenceRange,
        sourceRange: segment.sourceRange,
      })),
    captions: snapshot.captions.map((caption) => ({
      captionId: caption.captionId,
      startFrame: frameOf(caption.sequenceRange.start),
      endFrameExclusive: frameOf(caption.sequenceRange.end),
      text: caption.text,
    })),
    audio: snapshot.audioSegments.map((segment) => ({
      id: segment.id,
      startFrame: frameOf(segment.sequenceRange.start),
      endFrameExclusive: frameOf(segment.sequenceRange.end),
      gainDb: segment.gainDb,
      audible: segment.audible,
    })),
  };
}

/** 帧 → 时间（与 playbackFrameAt 互逆；供预览 seek 与合成计划核对）。 */
export const playbackTimeOfFrame = (frameIndex: string, frameRate: { num: number; den: number }) =>
  frameIndexToMediaTime(frameIndex, frameRate);
