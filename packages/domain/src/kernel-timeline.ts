import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  OBJECT_LOCK_DIMENSIONS,
  mediaRangeSchema,
  mediaTimeSchema,
  sourceMediaProbeResultSchema,
  type ObjectLockDimension,
} from '@ancs/contracts';
import {
  applyKernelResult,
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
  compositionVisualObjects,
  projectObjectLocks,
  projectSequences,
  projects,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import type { CompositionProjector } from './composition-projector.js';
import { jsonbNormalize } from './jsonb.js';
import { audioRegionSnapshot, captionSnapshot, clipSnapshot, trackSnapshot } from './composition-snapshots.js';

/**
 * 编辑内核适配器（V5 §6，M1；M2 起写入经组合投影器进入操作日志）：**加载 → 内核 → 持久化**。
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

async function loadTimeline(tx: NodePgDatabase, scope: Scope, operations: readonly KernelTimelineOperation[]): Promise<{ state: TimelineState; known: KnownRows }> {
  // 同一事务连接上顺序查询（pg 客户端不支持在同一连接上并发查询）
  const sequenceRows = await tx.select().from(projectSequences).where(and(eq(projectSequences.workspaceId, scope.workspaceId), eq(projectSequences.projectId, scope.projectId)));
  const trackRows = await tx.select().from(sequenceTracks).where(and(eq(sequenceTracks.workspaceId, scope.workspaceId), eq(sequenceTracks.projectId, scope.projectId)));
  const clipRows = await tx.select().from(sequenceClips).where(and(eq(sequenceClips.workspaceId, scope.workspaceId), eq(sequenceClips.projectId, scope.projectId)));
  const regionRows = await tx.select().from(compositionAudioRegions).where(and(eq(compositionAudioRegions.workspaceId, scope.workspaceId), eq(compositionAudioRegions.projectId, scope.projectId)));
  const captionRows = await tx.select().from(compositionCaptionSpans).where(and(eq(compositionCaptionSpans.workspaceId, scope.workspaceId), eq(compositionCaptionSpans.projectId, scope.projectId)));
  const lockRows = await tx.select().from(projectObjectLocks).where(and(eq(projectObjectLocks.workspaceId, scope.workspaceId), eq(projectObjectLocks.projectId, scope.projectId)));
  const visualObjectRows = await tx.select({ trackId: compositionVisualObjects.trackId }).from(compositionVisualObjects)
    .where(and(eq(compositionVisualObjects.workspaceId, scope.workspaceId), eq(compositionVisualObjects.projectId, scope.projectId)));
  const unmanagedTrackObjects = new Map<string, number>();
  for (const row of visualObjectRows) unmanagedTrackObjects.set(row.trackId, (unmanagedTrackObjects.get(row.trackId) ?? 0) + 1);
  const projectRows = await tx.select({ productionPolicy: projects.productionPolicy }).from(projects)
    .where(and(eq(projects.id, scope.projectId), eq(projects.workspaceId, scope.workspaceId))).limit(1);

  const assetVersionIds = new Set<string>(operations.flatMap(referencedAssetVersionIds));
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
      unmanagedTrackObjects,
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

async function applyWrite(projector: CompositionProjector, write: KernelResult['writes'][number], row: AnyRow, now: Date): Promise<AnyRow> {
  const target = write.type === 'delete' ? write.before : write.after;
  const id = target.value.id;
  if (write.type === 'insert') {
    switch (target.entity) {
      case 'clip': return projector.insert('clip', row as ClipRow);
      case 'track': return projector.insert('track', row as TrackRow);
      case 'audioRegion': return projector.insert('audioRegion', row as AudioRegionRow);
      case 'caption': return projector.insert('caption', row as CaptionRow);
    }
  }
  if (write.type === 'update') {
    const updated = await (() => {
      switch (target.entity) {
        case 'clip': return projector.update('clip', id, { ...clipColumns(target.value), updatedAt: now });
        case 'track': return projector.update('track', id, { ...trackColumns(target.value), updatedAt: now });
        case 'audioRegion': return projector.update('audioRegion', id, { ...audioRegionColumns(target.value), updatedAt: now });
        case 'caption': return projector.update('caption', id, { ...captionColumns(target.value), updatedAt: now });
      }
    })();
    if (updated === null) throw new ApiFailure(ERROR_CODES.INTERNAL, `kernel update target ${target.entity}:${id} disappeared`, 500);
    return updated;
  }
  await projector.delete(target.entity, id);
  return row;
}

async function persist(projector: CompositionProjector, known: KnownRows, result: KernelResult, eventDrafts: KernelEventDraft[]): Promise<void> {
  const scope = projector.scope;
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
    await projector.update('track', trackId, { position: (originalPositions.get(trackId) ?? 0) + 10_000, updatedAt: now });
  }

  for (const write of result.writes) {
    const target = write.type === 'delete' ? write.before : write.after;
    const row = rowOf(known, target, scope, now);
    const written = await applyWrite(projector, write, row, now);
    if (write.type !== 'delete') (known[target.entity] as Map<string, AnyRow>).set(target.value.id, written);
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

/** 在事务内执行一条内核化的时间线操作（写入经投影器，随批次进入操作日志）。 */
export async function runKernelTimelineOperation(
  projector: CompositionProjector,
  operation: KernelTimelineOperation,
  eventDrafts: KernelEventDraft[],
  options: { compensation?: boolean } = {},
): Promise<void> {
  const loaded = await loadTimeline(projector.tx, projector.scope, [operation]);
  const result = applyTimelineOperation(loaded.state, operation, {
    newId: (prefix) => `${prefix}_${randomUUID()}`,
    ...(options.compensation === true ? { compensation: true } : {}),
  });
  await persist(projector, loaded.known, result, eventDrafts);
}

export interface KernelTrialEvent {
  action: string;
  objectKind: string;
  objectId: string;
  patch: Record<string, unknown>;
}

/**
 * 内存试改（V5 §9，M2）：一次加载项目状态，按序在内核中执行整批操作，不写库、不加锁。
 * 返回与持久化路径同序的事件，以及"若落库再读回"的片段行（未改动的行原样保留，
 * 改动的行按持久化同一列映射合成并做 jsonb 归一），供试改结果、内容保护指纹与 A/B 对照使用。
 */
export async function simulateKernelBatch(
  tx: NodePgDatabase,
  scope: Scope,
  operations: readonly KernelTimelineOperation[],
): Promise<{ events: KernelTrialEvent[]; clips: ClipRow[] }> {
  const loaded = await loadTimeline(tx, scope, operations);
  let state = loaded.state;
  const clips = new Map(loaded.known.clip);
  const events: KernelTrialEvent[] = [];
  const now = new Date();
  const context = { newId: (prefix: 'clp' | 'avgp' | 'trk' | 'cap') => `${prefix}_${randomUUID()}` };
  for (const operation of operations) {
    const result = applyTimelineOperation(state, operation, context);
    state = applyKernelResult(state, result);
    for (const write of result.writes) {
      if (write.type === 'delete') {
        if (write.before.entity === 'clip') clips.delete(write.before.value.id);
        continue;
      }
      if (write.after.entity !== 'clip') continue;
      const columns = clipColumns(write.after.value);
      const base = clips.get(write.after.value.id);
      clips.set(write.after.value.id, {
        id: write.after.value.id,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        sequenceId: write.after.value.sequenceId,
        createdAt: base?.createdAt ?? now,
        ...base,
        ...columns,
        sourceRange: jsonbNormalize(columns.sourceRange),
        sequenceRange: jsonbNormalize(columns.sequenceRange),
        timeMapping: jsonbNormalize(columns.timeMapping),
        parameters: columns.parameters === null ? null : jsonbNormalize(columns.parameters),
        updatedAt: now,
      });
    }
    for (const event of result.events) {
      events.push({ action: event.action, objectKind: event.objectKind, objectId: event.objectId, patch: event.patch });
    }
  }
  return { events, clips: [...clips.values()] };
}

