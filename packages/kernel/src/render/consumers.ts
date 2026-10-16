import {
  PLAYBACK_SNAPSHOT_VERSION,
  compareMediaTime,
  playbackFrameAt,
  playbackSnapshotSchema,
  type MediaRange,
  type MediaTime,
  type PlaybackCapabilities,
  type PlaybackSnapshot,
  type RenderPlan,
} from '@ancs/contracts';
import { assertRenderPlanSupported } from './compile.js';

/**
 * V5-M4（§13）：RenderPlan 的消费者投影（纯函数）。
 *
 * 浏览器播放快照与服务端合成计划都只从 RenderPlan 派生，并回带 `planHash`，
 * 因此预览、服务端合成与终渲染可以按同一个哈希逐项对照。
 */

/** 浏览器播放快照：先按后端能力裁决（不支持即 501），再投影为 PlaybackEngine 契约。 */
export function playbackSnapshotFromRenderPlan(plan: RenderPlan, capabilities: PlaybackCapabilities): PlaybackSnapshot {
  assertRenderPlanSupported(plan, capabilities);
  const sourceOf = new Map(plan.sources.map((source) => [source.assetVersionId, source]));
  const assetIdOf = (versionId: string): string => sourceOf.get(versionId)?.assetId ?? '';
  return playbackSnapshotSchema.parse({
    schemaVersion: PLAYBACK_SNAPSHOT_VERSION,
    projectId: plan.projectId,
    sequenceId: plan.sequenceId,
    documentRevision: plan.documentRevision,
    planHash: plan.planHash,
    frameRate: plan.frameRate,
    duration: plan.duration,
    capabilities,
    videoSegments: plan.videoLayers.flatMap((layer) => layer.segments.map((segment) => ({
      clipId: segment.clipId,
      trackId: layer.trackId,
      assetId: assetIdOf(segment.sourceVersionId),
      sourceVersionId: segment.sourceVersionId,
      sourceStreamId: segment.sourceStreamId,
      sequenceRange: segment.sequenceRange,
      sourceRange: segment.sourceRange,
      timeMapping: segment.timeMapping,
      transform: segment.transform,
      crop: segment.crop,
      opacity: segment.opacity,
      sourceHasAudio: sourceOf.get(segment.sourceVersionId)?.hasAudio ?? false,
    }))),
    audioSegments: plan.audio.map((entry) => ({
      kind: entry.kind,
      id: entry.id,
      trackId: entry.trackId,
      assetId: assetIdOf(entry.sourceVersionId),
      sourceVersionId: entry.sourceVersionId,
      sequenceRange: entry.sequenceRange,
      sourceRange: entry.sourceRange,
      gainDb: entry.gainDb,
      pan: entry.pan,
      fadeIn: entry.fadeIn,
      fadeOut: entry.fadeOut,
      audible: entry.audible,
    })),
    captions: plan.captions,
    excludedTrackIds: plan.excludedTrackIds,
    warnings: plan.warnings,
  });
}

export interface ServerSynthesisPlan {
  schemaVersion: 'server-synthesis-plan/1.0';
  backend: 'SERVER_PRECOMPOSED';
  documentRevision: number;
  /** 来源 RenderPlan（快照未携带时为 null） */
  planHash: string | null;
  frameRate: { num: number; den: number };
  duration: MediaTime;
  segments: {
    clipId: string;
    trackId: string;
    startFrame: string;
    endFrameExclusive: string;
    sequenceRange: MediaRange;
    sourceRange: MediaRange;
  }[];
  captions: { captionId: string; startFrame: string; endFrameExclusive: string; text: string }[];
  audio: { id: string; startFrame: string; endFrameExclusive: string; gainDb: number; audible: boolean }[];
}

/** 服务端合成计划：与快照同源、同帧映射（帧边界一律 floor，与预览 seek 同一函数）。 */
export function serverSynthesisPlanFromSnapshot(snapshot: PlaybackSnapshot): ServerSynthesisPlan {
  const frameRate = snapshot.frameRate;
  const frameOf = (time: unknown): string => playbackFrameAt(time, frameRate, 'floor');
  return {
    schemaVersion: 'server-synthesis-plan/1.0',
    backend: 'SERVER_PRECOMPOSED',
    documentRevision: snapshot.documentRevision,
    planHash: snapshot.planHash ?? null,
    frameRate,
    duration: snapshot.duration,
    // 精确比较 BigInt ticks（不得转 Number：长片/细时基下会丢精度）
    segments: [...snapshot.videoSegments]
      .sort((left, right) => compareMediaTime(left.sequenceRange.start, right.sequenceRange.start))
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
