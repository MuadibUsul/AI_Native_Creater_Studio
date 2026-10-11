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
  type MediaTime,
  type ObjectLockDimension,
} from '@ancs/contracts';
import {
  applyTimelineOperation,
  lockKey,
  primaryClipIdOf,
  type KernelAssetVersionFacts,
  type KernelAudioRegion,
  type KernelClip,
  type KernelResult,
  type KernelTimelineOperation,
  type KernelTrack,
  type TimelineState,
} from '@ancs/kernel';
import { assetVersions, compositionAudioRegions, projectObjectLocks, projectSequences, sequenceClips, sequenceTracks } from '@ancs/db';
import { audioRegionSnapshot, clipSnapshot } from './composition-snapshots.js';

/**
 * 编辑内核适配器（V5 §6，M1）：**加载 → 内核 → 持久化**。
 *
 * - 加载：把一个序列的轨道/片段/音频区域、对象锁与源事实读成内核状态（同一事务内，读到本批前序写入）；
 * - 内核：`applyTimelineOperation` 纯函数决定全部规则（锁、边界、AV 同步、源范围、时间精度）；
 * - 持久化：按内核给出的顺序写行，并以与旧实现**完全相同**的形状记录 edit_events（undo/redo 依赖）。
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

interface LoadedTimeline {
  state: TimelineState;
  clipRows: Map<string, ClipRow>;
  audioRegionRows: Map<string, AudioRegionRow>;
}

const parseLockDimensions = (value: unknown): ObjectLockDimension[] =>
  Array.isArray(value) ? OBJECT_LOCK_DIMENSIONS.filter((dimension) => value.includes(dimension)) : [];

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
  id: row.id,
  sequenceId: row.sequenceId,
  kind: row.kind,
  position: row.position,
  name: row.name,
  locked: row.locked,
  muted: row.muted,
  hidden: row.hidden,
  solo: row.solo,
  syncLocked: row.syncLocked,
});

const toKernelAudioRegion = (row: AudioRegionRow): KernelAudioRegion => ({
  id: row.id,
  sequenceId: row.sequenceId,
  timeBinding: row.timeBinding,
  localRange: mediaRangeSchema.parse(row.localRange),
  sequenceRange: mediaRangeSchema.parse(row.sequenceRange),
});

/** 操作所在序列：insert_clip 直接给出；其它片段操作由片段反查（不存在 → 404，与旧实现一致）。 */
async function resolveSequenceId(tx: NodePgDatabase, scope: Scope, operation: KernelTimelineOperation): Promise<string> {
  if (operation.op === 'insert_clip') {
    const rows = await tx.select({ id: projectSequences.id }).from(projectSequences).where(and(
      eq(projectSequences.id, operation.sequenceId), eq(projectSequences.workspaceId, scope.workspaceId), eq(projectSequences.projectId, scope.projectId),
    )).limit(1);
    if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
    return rows[0].id;
  }
  const clipId = primaryClipIdOf(operation) ?? '';
  const rows = await tx.select({ sequenceId: sequenceClips.sequenceId }).from(sequenceClips).where(and(
    eq(sequenceClips.id, clipId), eq(sequenceClips.workspaceId, scope.workspaceId), eq(sequenceClips.projectId, scope.projectId),
  )).limit(1);
  if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip not found', 404);
  return rows[0].sequenceId;
}

async function loadTimeline(tx: NodePgDatabase, scope: Scope, sequenceId: string, operation: KernelTimelineOperation): Promise<LoadedTimeline> {
  const sequenceRows = await tx.select().from(projectSequences).where(and(
    eq(projectSequences.workspaceId, scope.workspaceId), eq(projectSequences.projectId, scope.projectId),
  ));
  const sequence = sequenceRows.find((row) => row.id === sequenceId);
  if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  // 同一事务连接上顺序查询（pg 客户端不支持在同一连接上并发查询）
  const trackRows = await tx.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.sequenceId, sequenceId), eq(sequenceTracks.workspaceId, scope.workspaceId), eq(sequenceTracks.projectId, scope.projectId),
  ));
  const clipRows = await tx.select().from(sequenceClips).where(and(
    eq(sequenceClips.sequenceId, sequenceId), eq(sequenceClips.workspaceId, scope.workspaceId), eq(sequenceClips.projectId, scope.projectId),
  ));
  const audioRegionRows = await tx.select().from(compositionAudioRegions).where(and(
    eq(compositionAudioRegions.sequenceId, sequenceId), eq(compositionAudioRegions.workspaceId, scope.workspaceId), eq(compositionAudioRegions.projectId, scope.projectId),
  ));
  const lockRows = await tx.select().from(projectObjectLocks).where(and(
    eq(projectObjectLocks.workspaceId, scope.workspaceId), eq(projectObjectLocks.projectId, scope.projectId),
  ));

  const assetVersionIds = new Set<string>();
  for (const row of clipRows) if (row.assetVersionId !== null) assetVersionIds.add(row.assetVersionId);
  if ((operation.op === 'insert_clip' || operation.op === 'replace_clip_source') && operation.assetVersionId !== null) {
    assetVersionIds.add(operation.assetVersionId);
  }
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

  const state: TimelineState = {
    sequence: { id: sequence.id, duration: mediaTimeSchema.parse(sequence.duration) },
    tracks: trackRows.map(toKernelTrack),
    clips: clipRows.map(toKernelClip),
    audioRegions: audioRegionRows.map(toKernelAudioRegion),
    locks: new Map(lockRows.map((row) => [lockKey(row.objectKind as never, row.objectId), parseLockDimensions(row.dimensions)])),
    sources: {
      assetVersions: facts,
      sequenceDurations: new Map<string, MediaTime>(sequenceRows.map((row) => [row.id, mediaTimeSchema.parse(row.duration)])),
    },
  };
  return {
    state,
    clipRows: new Map(clipRows.map((row) => [row.id, row])),
    audioRegionRows: new Map(audioRegionRows.map((row) => [row.id, row])),
  };
}

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

/** 按内核顺序落库并记录事件（事件 patch 与旧实现同形：内核 patch + before/after 快照）。 */
async function persist(tx: NodePgDatabase, scope: Scope, loaded: LoadedTimeline, result: KernelResult, eventDrafts: KernelEventDraft[]): Promise<void> {
  const clipRows = new Map(loaded.clipRows);
  const regionRows = new Map(loaded.audioRegionRows);
  for (const { write, event } of result.changes) {
    const now = new Date();
    let before: unknown;
    let after: unknown;
    if (write.entity === 'clip') {
      if (write.type === 'insert') {
        const row = { id: write.after.id, workspaceId: scope.workspaceId, projectId: scope.projectId, sequenceId: write.after.sequenceId, ...clipColumns(write.after), createdAt: now, updatedAt: now } as ClipRow;
        await tx.insert(sequenceClips).values(row);
        clipRows.set(row.id, row);
        after = clipSnapshot(row);
      } else if (write.type === 'update') {
        const current = clipRows.get(write.before.id);
        if (!current) throw new ApiFailure(ERROR_CODES.INTERNAL, 'kernel updated an unknown clip', 500);
        const row = { ...current, ...clipColumns(write.after), updatedAt: now } as ClipRow;
        await tx.update(sequenceClips).set({ ...clipColumns(write.after), updatedAt: now }).where(eq(sequenceClips.id, row.id));
        clipRows.set(row.id, row);
        before = clipSnapshot(current);
        after = clipSnapshot(row);
      } else {
        const current = clipRows.get(write.before.id);
        if (!current) throw new ApiFailure(ERROR_CODES.INTERNAL, 'kernel deleted an unknown clip', 500);
        await tx.delete(sequenceClips).where(eq(sequenceClips.id, current.id));
        clipRows.delete(current.id);
        before = clipSnapshot(current);
      }
    } else if (write.entity === 'track') {
      await tx.insert(sequenceTracks).values({ ...write.after, workspaceId: scope.workspaceId, projectId: scope.projectId, createdAt: now, updatedAt: now });
    } else {
      const current = regionRows.get(write.before.id);
      if (!current) throw new ApiFailure(ERROR_CODES.INTERNAL, 'kernel updated an unknown audio region', 500);
      const changes = { timeBinding: write.after.timeBinding, localRange: write.after.localRange, sequenceRange: write.after.sequenceRange, updatedAt: now };
      const row = { ...current, ...changes } as AudioRegionRow;
      await tx.update(compositionAudioRegions).set(changes).where(eq(compositionAudioRegions.id, current.id));
      regionRows.set(row.id, row);
      before = audioRegionSnapshot(current);
      after = audioRegionSnapshot(row);
    }
    if (event !== null) {
      eventDrafts.push({
        action: event.action,
        sceneId: null,
        objectKind: event.objectKind,
        objectId: event.objectId,
        patch: { ...event.patch, ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) },
      });
    }
  }
}

/** 在事务内执行一条内核化的时间线操作。 */
export async function runKernelTimelineOperation(
  tx: NodePgDatabase,
  scope: Scope,
  operation: KernelTimelineOperation,
  eventDrafts: KernelEventDraft[],
): Promise<void> {
  const sequenceId = await resolveSequenceId(tx, scope, operation);
  const loaded = await loadTimeline(tx, scope, sequenceId, operation);
  const result = applyTimelineOperation(loaded.state, operation, { newId: (prefix) => `${prefix}_${randomUUID()}` });
  await persist(tx, scope, loaded, result, eventDrafts);
}
