import { and, eq, inArray } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import {
  ApiFailure,
  ERROR_CODES,
  PLAYBACK_ERROR_REASONS,
  frameIndexToMediaTime,
  mediaTimeSchema,
  sourceMediaProbeResultSchema,
  type PlaybackBackendKind,
  type PlaybackCapabilities,
  type PlaybackCapabilityFlag,
  type PlaybackSnapshot,
  type RenderPlan,
} from '@ancs/contracts';
import {
  assetVersions,
  compositionAnimationBindings,
  compositionAudioRegions,
  compositionCaptionSpans,
  compositionVisualObjects,
  projectSequences,
  projects,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import {
  compileRenderPlan,
  playbackSnapshotFromRenderPlan,
  serverSynthesisPlanFromSnapshot,
  type RenderPlanInput,
  type RenderSourceFacts,
  type ServerSynthesisPlan,
} from '@ancs/kernel';
import type { DomainDeps } from './deps.js';
import { toKernelAudioRegion, toKernelCaption, toKernelClip, toKernelTrack } from './kernel-timeline.js';

/**
 * N03-08 多轨媒体预览与真实合成：**播放快照**投影。
 *
 * V5-M4：渲染规则全部在内核 `compileRenderPlan`（纯函数）里；本模块只负责**加载**序列状态，
 * 再把同一份 RenderPlan 投影给预览（HTML_MEDIA_BASELINE）、服务端合成（SERVER_PRECOMPOSED）与终渲染，
 * 因此"窗口预览与服务端合成关键帧对照"可逐帧核对（同一 planHash），且不存在浏览器 props 之外的隐藏工程。
 */

export const PLAYBACK_BACKEND_CAPABILITIES: Record<PlaybackBackendKind, PlaybackCapabilities> = {
  // 浏览器 baseline：逐段媒体 + CSS 变换/裁切/透明度 + WebAudio 混音；不做逐帧组件渲染（v0.4 增量要求）
  HTML_MEDIA_BASELINE: {
    backend: 'HTML_MEDIA_BASELINE',
    videoPrecision: 'KEYFRAME_APPROXIMATE',
    audioPrecision: 'FRAME_ACCURATE',
    supported: ['PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE', 'CAPTIONS_BURNED_IN', 'MULTI_TRACK_COMPOSITE'],
    unsupported: ['GRAPHICS_COMPONENT_RENDER', 'KEYFRAME_ANIMATION', 'TIME_REMAP', 'NESTED_SEQUENCE'],
  },
  // 服务端预合成（G0 baseline / 受控预渲染）：逐帧准确，可渲染组件图形
  SERVER_PRECOMPOSED: {
    backend: 'SERVER_PRECOMPOSED',
    videoPrecision: 'FRAME_ACCURATE',
    audioPrecision: 'FRAME_ACCURATE',
    supported: ['PER_SEGMENT_TRANSFORM', 'PER_SEGMENT_CROP', 'PER_SEGMENT_OPACITY', 'AUDIO_GAIN_FADE_PAN', 'AUDIO_CROSSFADE', 'CAPTIONS_BURNED_IN', 'GRAPHICS_COMPONENT_RENDER', 'MULTI_TRACK_COMPOSITE'],
    // 关键帧/变速倒放/嵌套序列尚无任何后端实现：显式声明不支持（RenderPlan 会列出需求并被拒绝）
    unsupported: ['KEYFRAME_ANIMATION', 'TIME_REMAP', 'NESTED_SEQUENCE'],
  },
};

/** 能力查询：未显式列出的能力一律视为**不支持**（不得把未知能力展示为支持）。 */
export const playbackSupports = (capabilities: PlaybackCapabilities, flag: PlaybackCapabilityFlag): boolean =>
  capabilities.supported.includes(flag) && !capabilities.unsupported.includes(flag);

export type { ServerSynthesisPlan };

/** 读一条序列的完整状态（只读、一致性由单条查询序列保证），交给内核编译。 */
export async function loadRenderPlanInput(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string },
): Promise<RenderPlanInput> {
  const inScope = <T extends { workspaceId: PgColumn; projectId: PgColumn; sequenceId: PgColumn }>(table: T) => and(
    eq(table.sequenceId, input.sequenceId),
    eq(table.workspaceId, input.workspaceId),
    eq(table.projectId, input.projectId),
  );
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
  const tracks = await deps.db.select().from(sequenceTracks).where(inScope(sequenceTracks));
  const clips = await deps.db.select().from(sequenceClips).where(inScope(sequenceClips));
  const regions = await deps.db.select().from(compositionAudioRegions).where(inScope(compositionAudioRegions));
  const captions = await deps.db.select().from(compositionCaptionSpans).where(inScope(compositionCaptionSpans));
  const visualObjects = await deps.db.select({ id: compositionVisualObjects.id, sequenceId: compositionVisualObjects.sequenceId, trackId: compositionVisualObjects.trackId })
    .from(compositionVisualObjects).where(inScope(compositionVisualObjects));
  const animationBindings = await deps.db.select({
    id: compositionAnimationBindings.id,
    sequenceId: compositionAnimationBindings.sequenceId,
    targetKind: compositionAnimationBindings.targetKind,
    targetId: compositionAnimationBindings.targetId,
    propertyPath: compositionAnimationBindings.propertyPath,
  }).from(compositionAnimationBindings).where(inScope(compositionAnimationBindings));

  const versionIds = [...new Set(clips.map((clip) => clip.assetVersionId).filter((id): id is string => id !== null))];
  const versionRows = versionIds.length === 0 ? [] : await deps.db.select({
    id: assetVersions.id,
    assetId: assetVersions.assetId,
    status: assetVersions.status,
    checksumSha256: assetVersions.checksumSha256,
    storageKey: assetVersions.storageKey,
    durationMs: assetVersions.durationMs,
    mediaProbe: assetVersions.mediaProbe,
  }).from(assetVersions).where(and(inArray(assetVersions.id, versionIds), eq(assetVersions.workspaceId, input.workspaceId)));
  const sources = new Map<string, RenderSourceFacts>(versionRows.map((row) => {
    // 源是否含音频流按规范探测结果判定（不得猜测字段形状）
    const probe = sourceMediaProbeResultSchema.safeParse(row.mediaProbe);
    return [row.id, {
      assetId: row.assetId,
      status: row.status,
      checksumSha256: row.checksumSha256,
      stored: row.storageKey !== null,
      durationKnown: row.durationMs !== null,
      hasAudio: probe.success && probe.data.status === 'READY' && probe.data.streams.some((stream) => stream.type === 'AUDIO'),
    }];
  }));

  return {
    projectId: input.projectId,
    documentRevision: projectRows[0]?.revision ?? 0,
    sequence: { id: sequence.id, duration: mediaTimeSchema.parse(sequence.duration), frameRate: sequence.frameRate as { num: number; den: number } },
    tracks: tracks.map(toKernelTrack),
    clips: clips.map(toKernelClip),
    audioRegions: regions.map(toKernelAudioRegion),
    captions: captions.map(toKernelCaption),
    visualObjects,
    animationBindings,
    sources,
  };
}

/** 加载 + 内核编译：本序列当前 revision 的唯一 RenderPlan。 */
export async function compileSequenceRenderPlan(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string },
): Promise<RenderPlan> {
  return compileRenderPlan(await loadRenderPlanInput(deps, input));
}

/** 播放快照 = RenderPlan 按后端能力裁决后的投影（不支持的需求 501，不静默省略）。 */
export async function buildPlaybackSnapshot(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; sequenceId: string; backend?: PlaybackBackendKind },
): Promise<PlaybackSnapshot> {
  const backend: PlaybackBackendKind = input.backend ?? 'HTML_MEDIA_BASELINE';
  const plan = await compileSequenceRenderPlan(deps, input);
  return playbackSnapshotFromRenderPlan(plan, PLAYBACK_BACKEND_CAPABILITIES[backend]);
}

/** 服务端合成计划：与快照同源、同帧映射（供 render-worker 消费；不引入第二套工程状态）。 */
export function buildServerSynthesisPlan(snapshot: PlaybackSnapshot): ServerSynthesisPlan {
  return serverSynthesisPlanFromSnapshot(snapshot);
}

/** 帧 → 时间（与 playbackFrameAt 互逆；供预览 seek 与合成计划核对）。 */
export const playbackTimeOfFrame = (frameIndex: string, frameRate: { num: number; den: number }) =>
  frameIndexToMediaTime(frameIndex, frameRate);
