import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import {
  OBJECT_LOCK_DIMENSIONS,
  mediaRangeSchema,
  mediaTimeSchema,
  sourceMediaProbeResultSchema,
  type ObjectLockDimension,
} from '@ancs/contracts';
import {
  applyTimelineOperation,
  lockKey,
  referencedAssetVersionIds,
  type KernelAssetVersionFacts,
  type KernelAudioRegion,
  type KernelCaption,
  type KernelClip,
  type KernelEntity,
  type KernelResult,
  type KernelTimelineOperation,
  type KernelTrack,
  type TimelineState,
} from '@ancs/kernel';
import {
  assetVersions,
  compositionAudioRegions,
  compositionCaptionSpans,
  projectObjectLocks,
  projectSequences,
  projects,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import { audioRegionSnapshot, captionSnapshot, clipSnapshot, trackSnapshot } from './composition-snapshots.js';

/**
 * 编辑内核适配器（V5 §6，M1）：**加载 → 内核 → 持久化**。
 *
 * - 加载：把**整个项目**的序列/轨道/片段/音频区域/字幕、对象锁、源事实与策略读成内核状态
 *   （同一事务内，读到本批前序写入；查找语义与旧实现的查询条件一致，保证错误码不变）；
 * - 内核：`applyTimelineOperation` 纯函数决定全部规则；
 * - 持久化：按内核顺序写行（轨道位置两阶段落位，避免 (sequence_id, position) 唯一索引瞬时冲突），
 *   再按内核事件顺序记录 edit_events（patch 与旧实现同形：内核 patch + 实体快照；undo/redo 依赖）。
 * 领域层在这里不再包含任何编辑规则。
 */

export interface KernelEventDraft {
  action: string;
  sceneId: string | null;
  objectKind?: 'PROJECT' | 'SCENE' | 'SEQUENCE' | 'TRACK' | 'CLIP' | 'VISUAL_OBJECT' | 'EFFECT' | 'ANIMATION' | 'CAPTION' | 'AUDIO_REGION' | 'OBJECT_LOCK';
  objectId?: string;
  patch: Record<string, unknown>;
}

interface Scope {
  workspaceId: string;
  projectId: string;
}

type ClipRow = typeof sequenceClips.$inferSelect;
type TrackRow = typeof sequenceTracks.$inferSelect;
type AudioRegionRow = typeof compositionAudioRegions.$inferSelect;
type CaptionRow = typeof compositionCaptionSpans.$inferSelect;
type AnyRow = ClipRow | TrackRow | AudioRegionRow | CaptionRow;

/** 已知行（加载 + 本操作写入后的最新值；删除的行保留，供 before 快照补全时间戳）。 */
interface KnownRows {
  clip: Map<string, ClipRow>;
  track: Map<string, TrackRow>;
  audioRegion: Map<string, AudioRegionRow>;
  caption: Map<string, CaptionRow>;
}

const parseLockDimensions = (value: unknown): ObjectLockDimension[] =>
  Array.isArray(value) ? OBJECT_LOCK_DIMENSIONS.filter((dimension) => value.includes(dimension)) : [];

// ── 行 ↔ 内核核心字段 ─────────────────────────────────────

const toKernelClip = (row: ClipRow): KernelClip => ({
  id: row.id,
  sequenceId: row.sequenceId,
  trackId: row.trackId,
  assetVersionId: row.assetVersionId,
  nestedSequenceId: row.nestedSequenceId,
  sourceStreamId: row.sourceStreamId,
  sourceRange: mediaRangeSchema.parse(row.sourceRange),
  sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
  timeMapping: row.timeMapping,
  avGroupId: row.avGroupId,
  parentClipId: row.parentClipId,
  parameters: row.parameters ?? null,
});

const toKernelTrack = (row: TrackRow): KernelTrack => ({
  id: row.id, sequenceId: row.sequenceId, kind: row.kind, position: row.position, name: row.name,
  locked: row.locked, muted: row.muted, hidden: row.hidden, solo: row.solo, syncLocked: row.syncLocked,
});

const toKernelAudioRegion = (row: AudioRegionRow): KernelAudioRegion => ({
  id: row.id,
  sequenceId: row.sequenceId,
  trackId: row.trackId,
  timeBinding: row.timeBinding,
  localRange: mediaRangeSchema.parse(row.localRange),
  sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
  sourceStreamId: row.sourceStreamId,
  channelMapping: row.channelMapping,
  gainDb: Number(row.gainDb),
  pan: Number(row.pan),
  fadeIn: mediaTimeSchema.parse(row.fadeIn),
  fadeOut: mediaTimeSchema.parse(row.fadeOut),
  parameters: row.parameters,
});

const toKernelCaption = (row: CaptionRow): KernelCaption => ({
  id: row.id,
  sequenceId: row.sequenceId,
  trackId: row.trackId,
  timeBinding: row.timeBinding,
  localRange: row.localRange as KernelCaption['localRange'],
  sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
  text: row.text,
  languageTag: row.languageTag,
  style: row.style,
  words: row.words,
  speechAnchorId: row.speechAnchorId,
});

const clipColumns = (clip: KernelClip) => ({
  trackId: clip.trackId,
  assetVersionId: clip.assetVersionId,
  nestedSequenceId: clip.nestedSequenceId,
  sourceStreamId: clip.sourceStreamId,
  sourceRange: clip.sourceRange,
  sequenceRange: clip.sequenceRange,
  timeMapping: clip.timeMapping,
  avGroupId: clip.avGroupId,
  parentClipId: clip.parentClipId,
  parameters: clip.parameters,
});

const trackColumns = (track: KernelTrack) => ({
  kind: track.kind, position: track.position, name: track.name, locked: track.locked, muted: track.muted,
  hidden: track.hidden, solo: track.solo, syncLocked: track.syncLocked,
});

const audioRegionColumns = (region: KernelAudioRegion) => ({
  trackId: region.trackId,
  timeBinding: region.timeBinding,
  localRange: region.localRange,
  sequenceRange: region.sequenceRange,
  sourceStreamId: region.sourceStreamId,
  channelMapping: region.channelMapping,
  gainDb: String(region.gainDb),
  pan: String(region.pan),
  fadeIn: region.fadeIn,
  fadeOut: region.fadeOut,
  parameters: region.parameters,
});

const captionColumns = (caption: KernelCaption) => ({
  trackId: caption.trackId,
  timeBinding: caption.timeBinding,
  localRange: caption.localRange,
  sequenceRange: caption.sequenceRange,
  text: caption.text,
  languageTag: caption.languageTag,
  style: caption.style,
  words: caption.words,
  speechAnchorId: caption.speechAnchorId,
});

// ── 加载 ─────────────────────────────────────────────────

async function loadTimeline(tx: NodePgDatabase, scope: Scope, operation: KernelTimelineOperation): Promise<{ state: TimelineState; known: KnownRows }> {
  // 同一事务连接上顺序查询（pg 客户端不支持在同一连接上并发查询）
  const sequenceRows = await tx.select().from(projectSequences).where(and(eq(projectSequences.workspaceId, scope.workspaceId), eq(projectSequences.projectId, scope.projectId)));
  const trackRows = await tx.select().from(sequenceTracks).where(and(eq(sequenceTracks.workspaceId, scope.workspaceId), eq(sequenceTracks.projectId, scope.projectId)));
  const clipRows = await tx.select().from(sequenceClips).where(and(eq(sequenceClips.workspaceId, scope.workspaceId), eq(sequenceClips.projectId, scope.projectId)));
  const regionRows = await tx.select().from(compositionAudioRegions).where(and(eq(compositionAudioRegions.workspaceId, scope.workspaceId), eq(compositionAudioRegions.projectId, scope.projectId)));
  const captionRows = await tx.select().from(compositionCaptionSpans).where(and(eq(compositionCaptionSpans.workspaceId, scope.workspaceId), eq(compositionCaptionSpans.projectId, scope.projectId)));
  const lockRows = await tx.select().from(projectObjectLocks).where(and(eq(projectObjectLocks.workspaceId, scope.workspaceId), eq(projectObjectLocks.projectId, scope.projectId)));
  const projectRows = await tx.select({ productionPolicy: projects.productionPolicy }).from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId))).limit(1);

  const assetVersionIds = new Set<string>(referencedAssetVersionIds(operation));
  for (const row of clipRows) if (row.assetVersionId !== null) assetVersionIds.add(row.assetVersionId);
  const assetRows = assetVersionIds.size === 0 ? [] : await tx.select({
    id: assetVersions.id,
    status: assetVersions.status,
    durationMs: assetVersions.durationMs,
    checksumSha256: assetVersions.checksumSha256,
    mediaProbe: assetVersions.mediaProbe,
  }).from(assetVersions).where(and(inArray(assetVersions.id, [...assetVersionIds]), eq(assetVersions.workspaceId, scope.workspaceId)));
  const facts = new Map<string, KernelAssetVersionFacts>(assetRows.map((row) => {
    // 源是否含音频流按规范探测结果判定（不得猜测字段形状）。
    const probe = sourceMediaProbeResultSchema.safeParse(row.mediaProbe);
    return [row.id, {
      status: row.status,
      durationMs: row.durationMs,
      checksumSha256: row.checksumSha256,
      hasAudio: probe.success && probe.data.status === 'READY' && probe.data.streams.some((stream) => stream.type === 'AUDIO'),
    }];
  }));
  const policy = projectRows[0]?.productionPolicy as { preserveOriginalSpeech?: boolean } | null | undefined;

  return {
    state: {
      sequences: new Map(sequenceRows.map((row) => [row.id, { id: row.id, duration: mediaTimeSchema.parse(row.duration) }])),
      tracks: trackRows.map(toKernelTrack),
      clips: clipRows.map(toKernelClip),
      audioRegions: regionRows.map(toKernelAudioRegion),
      captions: captionRows.map(toKernelCaption),
      locks: new Map(lockRows.map((row) => [lockKey(row.objectKind as never, row.objectId), parseLockDimensions(row.dimensions)])),
      sources: { assetVersions: facts },
      policy: { preserveOriginalSpeech: policy?.preserveOriginalSpeech === true },
    },
    known: {
      clip: new Map(clipRows.map((row) => [row.id, row])),
      track: new Map(trackRows.map((row) => [row.id, row])),
      audioRegion: new Map(regionRows.map((row) => [row.id, row])),
      caption: new Map(captionRows.map((row) => [row.id, row])),
    },
  };
}

// ── 持久化 ───────────────────────────────────────────────

/** 内核实体 → 完整行（以已知行补全租户与时间戳字段；新对象用当前时刻）。 */
function rowOf(known: KnownRows, entity: KernelEntity, scope: Scope, now: Date): AnyRow {
  const base = { id: entity.value.id, workspaceId: scope.workspaceId, projectId: scope.projectId, sequenceId: entity.value.sequenceId, createdAt: now, updatedAt: now };
  switch (entity.entity) {
    case 'clip': return { ...base, ...known.clip.get(entity.value.id), ...clipColumns(entity.value) } as ClipRow;
    case 'track': return { ...base, ...known.track.get(entity.value.id), ...trackColumns(entity.value) } as TrackRow;
    case 'audioRegion': return { ...base, ...known.audioRegion.get(entity.value.id), ...audioRegionColumns(entity.value) } as AudioRegionRow;
    case 'caption': return { ...base, ...known.caption.get(entity.value.id), ...captionColumns(entity.value) } as CaptionRow;
  }
}

function snapshotOf(known: KnownRows, entity: KernelEntity, scope: Scope, now: Date): unknown {
  const row = rowOf(known, entity, scope, now);
  switch (entity.entity) {
    case 'clip': return clipSnapshot(row as ClipRow);
    case 'track': return trackSnapshot(row as TrackRow);
    case 'audioRegion': return audioRegionSnapshot(row as AudioRegionRow);
    case 'caption': return captionSnapshot(row as CaptionRow);
  }
}

async function applyWrite(tx: NodePgDatabase, write: KernelResult['writes'][number], row: AnyRow, now: Date): Promise<void> {
  const target = write.type === 'delete' ? write.before : write.after;
  const id = target.value.id;
  if (write.type === 'insert') {
    switch (target.entity) {
      case 'clip': await tx.insert(sequenceClips).values(row as ClipRow); return;
      case 'track': await tx.insert(sequenceTracks).values(row as TrackRow); return;
      case 'audioRegion': await tx.insert(compositionAudioRegions).values(row as AudioRegionRow); return;
      case 'caption': await tx.insert(compositionCaptionSpans).values(row as CaptionRow); return;
    }
  }
  if (write.type === 'update') {
    switch (target.entity) {
      case 'clip': await tx.update(sequenceClips).set({ ...clipColumns(target.value), updatedAt: now }).where(eq(sequenceClips.id, id)); return;
      case 'track': await tx.update(sequenceTracks).set({ ...trackColumns(target.value), updatedAt: now }).where(eq(sequenceTracks.id, id)); return;
      case 'audioRegion': await tx.update(compositionAudioRegions).set({ ...audioRegionColumns(target.value), updatedAt: now }).where(eq(compositionAudioRegions.id, id)); return;
      case 'caption': await tx.update(compositionCaptionSpans).set({ ...captionColumns(target.value), updatedAt: now }).where(eq(compositionCaptionSpans.id, id)); return;
    }
  }
  switch (target.entity) {
    case 'clip': await tx.delete(sequenceClips).where(eq(sequenceClips.id, id)); return;
    case 'track': await tx.delete(sequenceTracks).where(eq(sequenceTracks.id, id)); return;
    case 'audioRegion': await tx.delete(compositionAudioRegions).where(eq(compositionAudioRegions.id, id)); return;
    case 'caption': await tx.delete(compositionCaptionSpans).where(eq(compositionCaptionSpans.id, id)); return;
  }
}

async function persist(tx: NodePgDatabase, scope: Scope, known: KnownRows, result: KernelResult, eventDrafts: KernelEventDraft[]): Promise<void> {
  const now = new Date();
  // 轨道两阶段落位：先把位置会变化的既有轨道整体移出（+10000），再按内核顺序写最终位置。
  const originalPositions = new Map([...known.track.values()].map((row) => [row.id, row.position]));
  const movingTracks = new Set<string>();
  for (const write of result.writes) {
    if (write.type === 'update' && write.after.entity === 'track') {
      const original = originalPositions.get(write.after.value.id);
      if (original !== undefined && original !== write.after.value.position) movingTracks.add(write.after.value.id);
    }
  }
  for (const trackId of movingTracks) {
    await tx.update(sequenceTracks).set({ position: (originalPositions.get(trackId) ?? 0) + 10_000, updatedAt: now }).where(eq(sequenceTracks.id, trackId));
  }

  for (const write of result.writes) {
    const target = write.type === 'delete' ? write.before : write.after;
    const row = rowOf(known, target, scope, now);
    await applyWrite(tx, write, row, now);
    if (write.type !== 'delete') (known[target.entity] as Map<string, AnyRow>).set(target.value.id, row);
  }

  for (const event of result.events) {
    const snapshots = Object.fromEntries(Object.entries(event.snapshots).map(([key, entity]) => [key, snapshotOf(known, entity, scope, now)]));
    eventDrafts.push({
      action: event.action,
      sceneId: null,
      objectKind: event.objectKind,
      objectId: event.objectId,
      patch: { ...event.patch, ...snapshots },
    });
  }
}

/** 在事务内执行一条内核化的时间线操作。 */
export async function runKernelTimelineOperation(
  tx: NodePgDatabase,
  scope: Scope,
  operation: KernelTimelineOperation,
  eventDrafts: KernelEventDraft[],
  options: { compensation?: boolean } = {},
): Promise<void> {
  const loaded = await loadTimeline(tx, scope, operation);
  const result = applyTimelineOperation(loaded.state, operation, {
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    ...(options.compensation === true ? { compensation: true } : {}),
  });
  await persist(tx, scope, loaded.known, result, eventDrafts);
}
