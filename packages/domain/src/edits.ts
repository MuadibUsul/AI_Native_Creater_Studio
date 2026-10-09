import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  editRequestSchema,
  editResponseSchema,
  ERROR_CODES,
  OBJECT_LOCK_DIMENSIONS,
  animationBindingSchema,
  audioRegionSchema,
  clipSchema,
  trackSchema,
  AUDIO_MIX_GUARD_REASONS,
  visualCropSchema,
  visualParametersSchema,
  visualTransformSchema,
  compareMediaTime,
  legacyMillisecondsToMediaTime,
  mediaRangeSchema,
  mediaTimeSchema,
  projectVersionSnapshotSchema,
  sourceMediaProbeResultSchema,
  versionConflictDetailsSchema,
  type EditOperation,
  type EditRequest,
  type EditResponse,
  type ObjectLockDimension,
  type ObjectLockKind,
  type Scene,
  type SceneChanges,
} from '@ancs/contracts';
import {
  compositionAudioRegions,
  compositionAnimationBindings,
  compositionCaptionSpans,
  compositionEffectInstances,
  compositionVisualObjects,
  editEvents,
  outboxEvents,
  assetVersions,
  projectObjectLocks,
  projectSequences,
  projectVersions,
  projects,
  scenes,
  sequenceClips,
  sequenceTracks,
} from '@ancs/db';
import { assertAssetBindable } from './assets.js';
import type { DomainDeps } from './channels.js';
import { toProjectDto, toSceneDto, type ProjectRow, type SceneRow } from './mappers.js';
import { AUTO_SNAPSHOT_INTERVAL, buildSnapshotPayload, currentEventSeq } from './versions.js';
import { assertLegacyProjectWriteAllowed } from './composition-migration.js';
import { validateEditOperationCandidate } from './edit-operation-registry.js';
import { assertAnimationKeyframesWithinTarget } from './composition-objects.js';
import { assertProjectApiSchemaVersion } from './project-state.js';

/**
 * 编辑事务处理器（P02-02/P02-03 / 计划 §4.6—§4.8；规范 §23）。
 *
 * 处理顺序（§4.6）：幂等（中间件）→ 加载聚合与预期 revision → Lock/合法性检查 →
 * 事务内条件更新（新状态 + revision + EditEvent + Outbox 同事务）→ 返回权威结果。
 *
 * 并发规则（§4.6）：同 Scene 竞争按 expectedSceneRevisions 条件更新（只允许一个成功）；
 * 同一请求内对同一 Scene 的多个操作按顺序应用（共享一次预期校验——一个 editRequest 是
 * 一个逻辑编辑）；不同 Scene 可合并；结构性操作（含 restore_project_version）要求
 * baseProjectRevision 精确匹配；冲突返回 409 VERSION_CONFLICT + 刷新信息。
 *
 * Undo/Redo（§4.8）：以**补偿事件**实现（action 前缀 UNDO_/REDO_，compensatesEventId 指向被补偿
 * 事件；UNDO 事件额外记录原始操作以便重做）；恢复产生新 revision，历史事件与账本不改写。
 * 每次内容事件在 patch 中记录受影响 Scene 的**前后内容快照**（供补偿与按 revision 恢复重放）。
 */

const STRUCTURAL_OPERATIONS = new Set(
  Object.values(EDIT_OPERATION_REGISTRY).filter((definition) => definition.structural).map((definition) => definition.operation),
);

/** Scene 内容快照（补偿与恢复重放的事实来源；不含 id/revision/position/startMs/时间戳）。 */
export interface SceneContentSnapshot {
  narration: string;
  visualIntent: string;
  sceneType: string;
  semanticType: string;
  durationMs: number;
  componentId: string | null;
  componentVersion: string | null;
  props: Record<string, unknown>;
  providerRequirement: Record<string, unknown> | null;
  transition: Record<string, unknown>;
  sourceBindings: unknown[];
  dataBindings: unknown[];
  /** Scene 资产绑定（P02-04）：replace_asset 变更、restore/undo 一并还原 */
  assetBindings: { assetId: string; role: string }[];
  /** 来源旁白块（P04-05；旧事件可能缺失 → 还原时保留现值） */
  narrationBlockIds?: string[];
  locked: boolean;
  status: string;
}

export const contentOf = (row: SceneRow): SceneContentSnapshot => ({
  narration: row.narration,
  visualIntent: row.visualIntent,
  sceneType: row.sceneType,
  semanticType: row.semanticType,
  durationMs: row.durationMs,
  componentId: row.componentId,
  componentVersion: row.componentVersion,
  props: structuredClone(row.props) as Record<string, unknown>,
  providerRequirement:
    row.providerRequirement === null ? null : (structuredClone(row.providerRequirement) as Record<string, unknown>),
  transition: structuredClone(row.transition) as Record<string, unknown>,
  sourceBindings: structuredClone(row.sourceBindings) as unknown[],
  dataBindings: structuredClone(row.dataBindings) as unknown[],
  assetBindings: structuredClone(row.assetBindings) as { assetId: string; role: string }[],
  narrationBlockIds: structuredClone(row.narrationBlockIds) as string[],
  locked: row.locked,
  status: row.status,
});

const contentOfScene = (scene: Scene): SceneContentSnapshot => ({
  narration: scene.narration,
  visualIntent: scene.visualIntent,
  sceneType: scene.sceneType,
  semanticType: scene.semanticType,
  durationMs: scene.durationMs,
  componentId: scene.componentId,
  componentVersion: scene.componentVersion,
  props: structuredClone(scene.props),
  providerRequirement: scene.providerRequirement === null ? null : structuredClone(scene.providerRequirement),
  transition: structuredClone(scene.transition),
  sourceBindings: structuredClone(scene.sourceBindings),
  dataBindings: structuredClone(scene.dataBindings),
  assetBindings: structuredClone(scene.assetBindings) as { assetId: string; role: string }[],
  narrationBlockIds: [...scene.narrationBlockIds],
  locked: scene.locked,
  status: scene.status,
});

const applyContent = (row: SceneRow, content: SceneContentSnapshot): void => {
  row.narration = content.narration;
  row.visualIntent = content.visualIntent;
  row.sceneType = content.sceneType;
  row.semanticType = content.semanticType;
  row.durationMs = content.durationMs;
  row.componentId = content.componentId;
  row.componentVersion = content.componentVersion;
  row.props = structuredClone(content.props);
  row.providerRequirement = content.providerRequirement === null ? null : structuredClone(content.providerRequirement);
  row.transition = structuredClone(content.transition);
  row.sourceBindings = structuredClone(content.sourceBindings);
  row.dataBindings = structuredClone(content.dataBindings);
  row.assetBindings = structuredClone(content.assetBindings);
  // 旧事件无 narrationBlockIds → 保留当前值（不误清空）
  if (content.narrationBlockIds !== undefined) row.narrationBlockIds = [...content.narrationBlockIds];
  row.locked = content.locked;
  row.status = content.status;
};

/** 内容快照 → sceneChanges（内容字段；locked 经 set_scene_lock 单独处理）。 */
export const contentToChanges = (content: SceneContentSnapshot): SceneChanges => ({
  narration: content.narration,
  visualIntent: content.visualIntent,
  sceneType: content.sceneType,
  semanticType: content.semanticType,
  durationMs: content.durationMs,
  componentId: content.componentId,
  componentVersion: content.componentVersion,
  props: content.props,
  providerRequirement: content.providerRequirement as SceneChanges['providerRequirement'],
  transition: content.transition as SceneChanges['transition'],
  sourceBindings: content.sourceBindings as SceneChanges['sourceBindings'],
  dataBindings: content.dataBindings as SceneChanges['dataBindings'],
});

const versionConflict = (
  message: string,
  currentProjectRevision: number,
  sceneRevisions: Record<string, number> = {},
): ApiFailure =>
  new ApiFailure(
    ERROR_CODES.VERSION_CONFLICT,
    message,
    409,
    versionConflictDetailsSchema.parse({ currentProjectRevision, sceneRevisions }),
  );

export interface ProcessEditsInput {
  workspaceId: string;
  projectId: string;
  actor: { type: 'USER' | 'AI' | 'SYSTEM'; id: string | null };
  request: EditRequest;
  /** 补偿链路（Undo/Redo）：事件以 UNDO_/REDO_ 前缀落库并指向被补偿事件 */
  compensation?: {
    kind: 'UNDO' | 'REDO';
    originalEventId: string;
    originalAction: string;
    /** UNDO 事件记录原始操作，供后续重做 */
    originalOperation?: EditOperation;
    /** 事件意图（覆盖 request.intent） */
    intentText?: string;
  };
}

export interface ProcessEditsResult {
  response: EditResponse;
  createdSceneIds: string[];
}

interface EventPatchLike {
  op?: string;
  sceneId?: string | null;
  tailSceneId?: string;
  after?: SceneContentSnapshot;
  tail?: SceneContentSnapshot;
  /** restore_project_version 重建（删除后重新出现）的场景：作为新的 revision 基线 */
  recreatedScenes?: { sceneId: string; after: SceneContentSnapshot }[];
}

/** 内容类操作（重放只认这些；Lock/删除/项目级事件不改变内容 revision）。 */
const CONTENT_OPERATIONS = new Set(['insert_scene', 'duplicate_scene', 'update_scene', 'split_scene', 'restore_scene', 'replace_asset']);

/** 按 Scene revision 重放内容事件（restore_scene 的事实重建；单遍扫描并在目标处截获）。
 *  事件的 sceneId 列为准（insert 的 patch 不含 sceneId）；split 的尾部经 patch.tailSceneId 关联。 */
export function replaySceneContent(
  events: { action: string; sceneId?: string | null; patch: unknown }[],
  sceneId: string,
  target: number,
): SceneContentSnapshot | null {
  let revision = 0;
  let state: SceneContentSnapshot | null = null;
  let captured: SceneContentSnapshot | null = null;

  for (const event of events) {
    const patch = event.patch as EventPatchLike | null;
    if (patch === null || typeof patch !== 'object') continue;
    if (patch.op === undefined || !CONTENT_OPERATIONS.has(patch.op)) continue;

    const recreated = patch.recreatedScenes?.find((entry) => entry.sceneId === sceneId);
    const sceneRef = event.sceneId ?? patch.sceneId ?? null;
    if (recreated !== undefined) {
      revision = 1;
      state = recreated.after;
    } else if (patch.tailSceneId === sceneId && patch.tail !== undefined) {
      revision = 1;
      state = patch.tail;
    } else if (sceneRef === sceneId && patch.after !== undefined) {
      const isBaseline = patch.op === 'insert_scene' || patch.op === 'duplicate_scene';
      revision = isBaseline ? 1 : revision + 1;
      state = patch.after;
    } else {
      continue;
    }
    if (revision === target && captured === null) captured = state;
  }

  if (state === null || target < 1 || target > revision) return null;
  return captured;
}

interface EventDraft {
  action: string;
  sceneId: string | null;
  objectKind?: 'PROJECT' | 'SCENE' | 'SEQUENCE' | 'TRACK' | 'CLIP' | 'VISUAL_OBJECT' | 'EFFECT' | 'ANIMATION' | 'CAPTION' | 'AUDIO_REGION' | 'OBJECT_LOCK';
  objectId?: string;
  patch: Record<string, unknown>;
}

/** 片段行（或由行派生的候选对象）：parameters 可缺省，快照时按缺省语义补全。 */
type ClipRowLike = Omit<typeof sequenceClips.$inferSelect, 'parameters'> & { parameters?: unknown };

const clipSnapshot = (row: ClipRowLike) => clipSchema.parse({
  ...row,
  parameters: row.parameters === null || row.parameters === undefined ? undefined : visualParametersSchema.parse(row.parameters),
  createdAt: row.createdAt.toISOString(),
});
const trackSnapshot = (row: typeof sequenceTracks.$inferSelect) => trackSchema.parse({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
const animationSnapshot = (row: typeof compositionAnimationBindings.$inferSelect) => animationBindingSchema.parse({
  ...row,
  createdAt: row.createdAt.toISOString(),
});
const audioRegionSnapshot = (row: typeof compositionAudioRegions.$inferSelect) => audioRegionSchema.parse({
  ...row,
  gainDb: Number(row.gainDb),
  pan: Number(row.pan),
  createdAt: row.createdAt.toISOString(),
});

/** N03-02 共享工具：有理时间比较与片段编辑前置检查。 */
const compareFraction = (left: Fraction, right: Fraction): number => {
  const difference = left.num * right.den - right.num * left.den;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
};
const ticksInRange = (range: unknown, timebase: { num: number; den: number }): { start: bigint; end: bigint } => {
  const parsed = mediaRangeSchema.parse(range);
  return {
    start: exactTicks(timeFraction(parsed.start), timebase),
    end: exactTicks(timeFraction(parsed.end), timebase),
  };
};
const identityForwardMapping = (row: typeof sequenceClips.$inferSelect): boolean => {
  const mapping = row.timeMapping as { rate?: { num?: number; den?: number }; direction?: string };
  return mapping?.direction === 'FORWARD' && (mapping?.rate?.num ?? 1) === 1 && (mapping?.rate?.den ?? 1) === 1;
};

async function loadEditableClip(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; clipId: string },
): Promise<{ row: typeof sequenceClips.$inferSelect; track: typeof sequenceTracks.$inferSelect }> {
  const rows = await tx.select().from(sequenceClips).where(and(
    eq(sequenceClips.id, input.clipId),
    eq(sequenceClips.workspaceId, input.workspaceId),
    eq(sequenceClips.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip not found', 404);
  const track = await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: row.trackId });
  return { row, track };
}

/** 按归属加载轨道（不因轨道自身 locked 标志阻断：轨道控制需要能解锁）。 */
async function loadTrackOwned(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; trackId: string },
): Promise<typeof sequenceTracks.$inferSelect> {
  const rows = await tx.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.id, input.trackId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
  )).limit(1);
  const track = rows[0];
  if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'track not found', 404);
  return track;
}

async function loadTrack(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; sequenceId: string; trackId: string },
): Promise<typeof sequenceTracks.$inferSelect> {
  const rows = await tx.select().from(sequenceTracks).where(and(
    eq(sequenceTracks.id, input.trackId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
    eq(sequenceTracks.sequenceId, input.sequenceId),
  )).limit(1);
  const track = rows[0];
  if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'track not found', 404);
  if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
  return track;
}

async function loadSequenceTimebase(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; sequenceId: string },
): Promise<{ durationTicks: bigint; timebase: { num: number; den: number } }> {
  const rows = await tx.select({ duration: projectSequences.duration }).from(projectSequences).where(and(
    eq(projectSequences.id, input.sequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const duration = mediaTimeSchema.parse(row.duration);
  return { durationTicks: exactTicks(timeFraction(duration), duration.timebase), timebase: duration.timebase };
}

/** 同 avGroupId 的关联片段（视频/音频对；不含自身）。 */
async function avSiblingsOf(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; row: typeof sequenceClips.$inferSelect },
): Promise<(typeof sequenceClips.$inferSelect)[]> {
  if (input.row.avGroupId === null) return [];
  const rows = await tx.select().from(sequenceClips).where(and(
    eq(sequenceClips.sequenceId, input.row.sequenceId),
    eq(sequenceClips.workspaceId, input.workspaceId),
    eq(sequenceClips.projectId, input.projectId),
    eq(sequenceClips.avGroupId, input.row.avGroupId),
  ));
  return rows.filter((candidate) => candidate.id !== input.row.id);
}

/** 绑定到该片段的音频区域（局部时钟同步的前置面）。 */
async function clipBoundAudioRegions(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; sequenceId: string; clipId: string },
): Promise<(typeof compositionAudioRegions.$inferSelect)[]> {
  const rows = await tx.select().from(compositionAudioRegions).where(and(
    eq(compositionAudioRegions.sequenceId, input.sequenceId),
    eq(compositionAudioRegions.workspaceId, input.workspaceId),
    eq(compositionAudioRegions.projectId, input.projectId),
  ));
  return rows.filter((row) => (row.timeBinding as { clipId?: string | null }).clipId === input.clipId);
}

/** 源侧边界（素材时长 / 嵌套序列时长）+ READY/校验和检查；N03-01 起共用同一判据。 */
async function assertSourceRangeUsable(
  tx: NodePgDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    assetVersionId: string | null;
    nestedSequenceId: string | null;
    range: ReturnType<typeof mediaRangeSchema.parse>;
  },
): Promise<void> {
  if (input.assetVersionId !== null) {
    const rows = await tx.select({
      durationMs: assetVersions.durationMs, status: assetVersions.status, checksumSha256: assetVersions.checksumSha256,
    }).from(assetVersions).where(and(eq(assetVersions.id, input.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
    const source = rows[0];
    if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
    if (source.status !== 'READY' || source.durationMs === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version is not ready with known duration', 409);
    if (source.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version has no immutable checksum', 409, { reason: 'SOURCE_CHECKSUM_MISSING' });
    if (compareMediaTime(input.range.start, mediaTimeOf(0n, input.range.start.timebase)) < 0
      || compareMediaTime(input.range.end, legacyMillisecondsToMediaTime(source.durationMs)) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds asset duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
    return;
  }
  if (input.nestedSequenceId !== null) {
    const rows = await tx.select({ duration: projectSequences.duration }).from(projectSequences).where(and(
      eq(projectSequences.id, input.nestedSequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
    )).limit(1);
    const nested = rows[0];
    if (!nested) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'nested sequence not found', 404);
    if (compareMediaTime(input.range.start, mediaTimeOf(0n, input.range.start.timebase)) < 0
      || compareMediaTime(input.range.end, mediaTimeSchema.parse(nested.duration)) > 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
    }
    return;
  }
  throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source is missing', 422, { reason: 'SOURCE_MISSING' });
}

/** 目标对象上的显式对象锁（对象锁语义）：被锁维度命中即拒绝；与影响面门互为纵深防御。 */
async function assertObjectLockAllows(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; objectKind: ObjectLockKind; objectId: string; dimensions: ObjectLockDimension[] },
): Promise<void> {
  const rows = await tx.select({ dimensions: projectObjectLocks.dimensions }).from(projectObjectLocks).where(and(
    eq(projectObjectLocks.workspaceId, input.workspaceId),
    eq(projectObjectLocks.projectId, input.projectId),
    eq(projectObjectLocks.objectKind, input.objectKind),
    eq(projectObjectLocks.objectId, input.objectId),
  )).limit(1);
  const locked = (rows[0]?.dimensions ?? []) as string[];
  if (locked.some((dimension) => input.dimensions.includes(dimension as ObjectLockDimension))) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target object is locked for this change', 409, {
      reason: 'EDIT_IMPACT_LOCKED',
      objectKind: input.objectKind,
      objectId: input.objectId,
    });
  }
}

/** 在给定序列时间切开一条片段（左段留原 id、右段新建为子片段）并落事件；N03-02／N03-03 共用。 */
async function splitClipRow(
  tx: NodePgDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    patchBase: Record<string, unknown>;
    row: typeof sequenceClips.$inferSelect;
    leftRange: ReturnType<typeof mediaRangeSchema.parse>;
    rightRange: ReturnType<typeof mediaRangeSchema.parse>;
    leftSeconds: Fraction;
    leftAction: string;
    createdId: string;
  },
  eventDrafts: EventDraft[],
): Promise<void> {
  const before = clipSnapshot(input.row);
  const sourceSpan = mediaRangeSchema.parse(input.row.sourceRange);
  const sourceTimebase = sourceSpan.start.timebase;
  const sourceStartTicks = exactTicks(timeFraction(sourceSpan.start), sourceTimebase);
  const sourceLeftTicks = exactTicks(input.leftSeconds, sourceTimebase);
  const leftSource = mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceLeftTicks, sourceTimebase) });
  const rightSource = mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceLeftTicks, sourceTimebase), end: sourceSpan.end });
  const afterLeft = { ...input.row, sequenceRange: input.leftRange, sourceRange: leftSource, updatedAt: new Date() };
  await tx.update(sequenceClips).set({ sequenceRange: input.leftRange, sourceRange: leftSource, updatedAt: new Date() }).where(eq(sequenceClips.id, input.row.id));
  eventDrafts.push({
    action: input.leftAction, sceneId: null, objectKind: 'CLIP', objectId: input.row.id,
    patch: { ...input.patchBase, clipId: input.row.id, before, after: clipSnapshot(afterLeft) },
  });
  const rightRow = {
    id: input.createdId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: input.row.sequenceId, trackId: input.row.trackId,
    assetVersionId: input.row.assetVersionId, nestedSequenceId: input.row.nestedSequenceId, sourceStreamId: input.row.sourceStreamId,
    sourceRange: rightSource, sequenceRange: input.rightRange, timeMapping: input.row.timeMapping, avGroupId: input.row.avGroupId,
    parameters: input.row.parameters,
    // 右段是原片段的子片段（血缘可追溯）。
    parentClipId: input.row.id, createdAt: new Date(), updatedAt: new Date(),
  };
  await tx.insert(sequenceClips).values(rightRow);
  eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: rightRow.id, patch: { op: 'insert_clip', clipId: rightRow.id, after: clipSnapshot(rightRow) } });
}

/**
 * N03-06 原声保护：项目策略 `preserveOriginalSpeech=true` 时，音频区域只允许**非破坏性混音**改动
 * （增益/淡入淡出/声像/声道映射/参数），任何改动源流或局部时间的编辑都必须拒绝——不得改变语言内容。
 */
async function assertOriginalSpeechPreserved(
  tx: NodePgDatabase,
  input: { workspaceId: string; projectId: string; touchesSourceClock: boolean },
): Promise<void> {
  if (!input.touchesSourceClock) return;
  const rows = await tx.select({ productionPolicy: projects.productionPolicy }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  const policy = rows[0]?.productionPolicy as { preserveOriginalSpeech?: boolean } | null | undefined;
  if (policy?.preserveOriginalSpeech === true) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'original speech protection forbids changing the source clock', 409, {
      reason: AUDIO_MIX_GUARD_REASONS.ORIGINAL_SPEECH_PROTECTED,
    });
  }
}

/** N03-05：把局部变更合并进片段参数命名空间（保持其余参数与组件自定义 values 不变）。 */
function nextVisualParameters(
  current: unknown,
  change: Partial<{ transform: unknown; crop: unknown; opacity: number }>,
): ReturnType<typeof visualParametersSchema.parse> {
  const base = visualParametersSchema.parse(current ?? {});
  return visualParametersSchema.parse({
    ...base,
    ...(change.transform === undefined ? {} : { transform: change.transform }),
    ...(change.crop === undefined ? {} : { crop: change.crop }),
    ...(change.opacity === undefined ? {} : { opacity: change.opacity }),
  });
}

/** 轨道重排的两阶段写入：先整体偏移再落位，避免 (sequence_id, position) 唯一索引的瞬时冲突。 */
async function commitTrackOrder(
  tx: NodePgDatabase,
  finalOrder: (typeof sequenceTracks.$inferSelect)[],
  now: Date,
): Promise<void> {
  const moved = finalOrder.map((row, index) => ({ row, index })).filter(({ row, index }) => row.position !== index);
  if (moved.length === 0) return;
  for (const { row } of moved) {
    await tx.update(sequenceTracks).set({ position: row.position + 10_000, updatedAt: now }).where(eq(sequenceTracks.id, row.id));
  }
  for (const { row, index } of moved) {
    await tx.update(sequenceTracks).set({ position: index, updatedAt: now }).where(eq(sequenceTracks.id, row.id));
  }
}

/** 目标轨上的重叠检查（半开区间；排除给定片段）。 */
async function assertNoTrackOverlap(
  tx: NodePgDatabase,
  input: {
    workspaceId: string;
    projectId: string;
    sequenceId: string;
    trackId: string;
    timebase: { num: number; den: number };
    candidate: { start: bigint; end: bigint };
    excludeClipIds: string[];
  },
): Promise<void> {
  const rows = await tx.select().from(sequenceClips).where(and(
    eq(sequenceClips.sequenceId, input.sequenceId),
    eq(sequenceClips.workspaceId, input.workspaceId),
    eq(sequenceClips.projectId, input.projectId),
    eq(sequenceClips.trackId, input.trackId),
  ));
  for (const row of rows) {
    if (input.excludeClipIds.includes(row.id)) continue;
    const span = ticksInRange(row.sequenceRange, input.timebase);
    if (span.start >= input.candidate.end || span.end <= input.candidate.start) continue;
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target range overlaps an existing clip', 409, { reason: 'CLIP_OVERLAP', clipId: row.id });
  }
}

async function restoreNormalizedSnapshot(
  tx: NodePgDatabase,
  input: Pick<ProcessEditsInput, 'workspaceId' | 'projectId'>,
  snapshot: ReturnType<typeof projectVersionSnapshotSchema.parse>,
): Promise<void> {
  const document = snapshot.document;
  if (document === undefined) return;
  if (document.projectId !== input.projectId) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'project version document belongs to another project', 500);
  }
  const composition = document.composition;
  const scoped = [
    ...composition.sequences,
    ...composition.tracks,
    ...composition.clips,
    ...composition.visualObjects,
    ...composition.effects,
    ...composition.animations,
    ...composition.captions,
    ...composition.audioRegions,
  ];
  if (scoped.some((item) => item.workspaceId !== input.workspaceId || item.projectId !== input.projectId)) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'project version contains cross-scope composition objects', 500);
  }
  if (snapshot.locks.some((lock) => lock.workspaceId !== input.workspaceId || lock.projectId !== input.projectId)) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'project version contains cross-scope object locks', 500);
  }

  await tx.delete(projectObjectLocks).where(and(eq(projectObjectLocks.workspaceId, input.workspaceId), eq(projectObjectLocks.projectId, input.projectId)));
  await tx.delete(compositionAnimationBindings).where(and(eq(compositionAnimationBindings.workspaceId, input.workspaceId), eq(compositionAnimationBindings.projectId, input.projectId)));
  await tx.delete(compositionEffectInstances).where(and(eq(compositionEffectInstances.workspaceId, input.workspaceId), eq(compositionEffectInstances.projectId, input.projectId)));
  await tx.delete(compositionCaptionSpans).where(and(eq(compositionCaptionSpans.workspaceId, input.workspaceId), eq(compositionCaptionSpans.projectId, input.projectId)));
  await tx.delete(compositionAudioRegions).where(and(eq(compositionAudioRegions.workspaceId, input.workspaceId), eq(compositionAudioRegions.projectId, input.projectId)));
  await tx.delete(compositionVisualObjects).where(and(eq(compositionVisualObjects.workspaceId, input.workspaceId), eq(compositionVisualObjects.projectId, input.projectId)));
  await tx.delete(sequenceClips).where(and(eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId)));
  await tx.delete(sequenceTracks).where(and(eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId)));
  await tx.delete(projectSequences).where(and(eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId)));

  if (composition.sequences.length > 0) await tx.insert(projectSequences).values(composition.sequences.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.tracks.length > 0) await tx.insert(sequenceTracks).values(composition.tracks.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.clips.length > 0) await tx.insert(sequenceClips).values(composition.clips.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.visualObjects.length > 0) await tx.insert(compositionVisualObjects).values(composition.visualObjects.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.effects.length > 0) await tx.insert(compositionEffectInstances).values(composition.effects.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.animations.length > 0) await tx.insert(compositionAnimationBindings).values(composition.animations.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.captions.length > 0) await tx.insert(compositionCaptionSpans).values(composition.captions.map((item) => ({ ...item, createdAt: new Date(item.createdAt), updatedAt: new Date(item.createdAt) })));
  if (composition.audioRegions.length > 0) await tx.insert(compositionAudioRegions).values(composition.audioRegions.map((item) => ({
    ...item,
    gainDb: String(item.gainDb),
    pan: String(item.pan),
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.createdAt),
  })));
  if (snapshot.locks.length > 0) await tx.insert(projectObjectLocks).values(snapshot.locks.map((item) => ({
    ...item,
    createdAt: new Date(item.createdAt),
    updatedAt: new Date(item.updatedAt),
  })));
}

type Fraction = { num: bigint; den: bigint };
const rangeDuration = (range: ReturnType<typeof mediaRangeSchema.parse>): Fraction => ({
  num: BigInt(range.end.ticks) * BigInt(range.end.timebase.num) * BigInt(range.start.timebase.den)
    - BigInt(range.start.ticks) * BigInt(range.start.timebase.num) * BigInt(range.end.timebase.den),
  den: BigInt(range.end.timebase.den) * BigInt(range.start.timebase.den),
});
const assertLinearClipMapping = (
  sourceRange: ReturnType<typeof mediaRangeSchema.parse>,
  sequenceRange: ReturnType<typeof mediaRangeSchema.parse>,
  rate: { num: number; den: number },
): void => {
  const source = rangeDuration(sourceRange);
  const sequence = rangeDuration(sequenceRange);
  if (source.num * sequence.den * BigInt(rate.den) !== BigInt(rate.num) * source.den * sequence.num) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'timeMapping rate does not match source and sequence ranges', 422, { reason: 'TIME_MAPPING_MISMATCH' });
  }
};

/** N03-01：有理秒 → 目标时基的精确 ticks；无法整除即明确失败（禁止静默取整）。 */
const exactTicks = (value: Fraction, timebase: { num: number; den: number }): bigint => {
  const numerator = value.num * BigInt(timebase.den);
  const denominator = value.den * BigInt(timebase.num);
  if (denominator === 0n) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'invalid timebase', 422, { reason: 'TIME_BASE_INVALID' });
  if (numerator % denominator !== 0n) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'time cannot be represented exactly in the sequence timebase', 422, { reason: 'TIME_NOT_REPRESENTABLE' });
  }
  return numerator / denominator;
};

const timeFraction = (time: ReturnType<typeof mediaTimeSchema.parse>): Fraction => ({
  num: BigInt(time.ticks) * BigInt(time.timebase.num),
  den: BigInt(time.timebase.den),
});

const mediaTimeOf = (ticks: bigint, timebase: { num: number; den: number }): ReturnType<typeof mediaTimeSchema.parse> =>
  mediaTimeSchema.parse({ ticks: ticks.toString(), timebase });

const CLIP_IDENTITY_MAPPING = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

const parseLockDimensions = (value: unknown): ObjectLockDimension[] =>
  Array.isArray(value)
    ? OBJECT_LOCK_DIMENSIONS.filter((dimension) => value.includes(dimension))
    : [];

async function assertNonSceneLockTargetsExist(
  db: NodePgDatabase,
  input: Pick<ProcessEditsInput, 'workspaceId' | 'projectId'>,
  operations: readonly EditOperation[],
): Promise<void> {
  for (const operation of operations) {
    if (operation.op !== 'set_object_lock' || operation.objectKind === 'PROJECT' || operation.objectKind === 'SCENE') continue;
    let exists = false;
    switch (operation.objectKind) {
      case 'SEQUENCE':
        exists = (await db.select({ id: projectSequences.id }).from(projectSequences).where(and(eq(projectSequences.id, operation.objectId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId))).limit(1)).length > 0;
        break;
      case 'TRACK':
        exists = (await db.select({ id: sequenceTracks.id }).from(sequenceTracks).where(and(eq(sequenceTracks.id, operation.objectId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId))).limit(1)).length > 0;
        break;
      case 'CLIP':
        exists = (await db.select({ id: sequenceClips.id }).from(sequenceClips).where(and(eq(sequenceClips.id, operation.objectId), eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId))).limit(1)).length > 0;
        break;
      case 'VISUAL_OBJECT':
        exists = (await db.select({ id: compositionVisualObjects.id }).from(compositionVisualObjects).where(and(eq(compositionVisualObjects.id, operation.objectId), eq(compositionVisualObjects.workspaceId, input.workspaceId), eq(compositionVisualObjects.projectId, input.projectId))).limit(1)).length > 0;
        break;
      case 'CAPTION':
        exists = (await db.select({ id: compositionCaptionSpans.id }).from(compositionCaptionSpans).where(and(eq(compositionCaptionSpans.id, operation.objectId), eq(compositionCaptionSpans.workspaceId, input.workspaceId), eq(compositionCaptionSpans.projectId, input.projectId))).limit(1)).length > 0;
        break;
      case 'AUDIO_REGION':
        exists = (await db.select({ id: compositionAudioRegions.id }).from(compositionAudioRegions).where(and(eq(compositionAudioRegions.id, operation.objectId), eq(compositionAudioRegions.workspaceId, input.workspaceId), eq(compositionAudioRegions.projectId, input.projectId))).limit(1)).length > 0;
        break;
    }
    if (!exists) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'lock target not found', 404, {
        reason: 'EDIT_LOCK_TARGET_MISSING',
        objectKind: operation.objectKind,
        objectId: operation.objectId,
      });
    }
  }
}

/** 事务内最终校验 + 应用 + 落盘（新状态/revision/EditEvent/Outbox/自动快照同事务）。 */
async function applyEditsInTransaction(
  deps: DomainDeps,
  input: ProcessEditsInput,
  request: EditRequest,
): Promise<{ project: ProjectRow; sceneRows: SceneRow[]; events: (typeof editEvents.$inferSelect)[]; createdSceneIds: string[] }> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);

    const projectRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
      .limit(1);
    const project = projectRows[0];
    if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

    const structural = request.operations.some((op) => STRUCTURAL_OPERATIONS.has(op.op));
    if (structural && project.revision !== request.baseProjectRevision) {
      throw versionConflict('project has changed since baseProjectRevision', project.revision);
    }

    const sceneRows = await tx
      .select()
      .from(scenes)
      .where(and(eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)))
      .orderBy(scenes.position);
    const byId = new Map<string, SceneRow>(sceneRows.map((row) => [row.id, row]));

    const lockRows = await tx
      .select()
      .from(projectObjectLocks)
      .where(and(eq(projectObjectLocks.projectId, input.projectId), eq(projectObjectLocks.workspaceId, input.workspaceId)));
    await assertNonSceneLockTargetsExist(tx as unknown as NodePgDatabase, input, request.operations);
    const candidateResult = validateEditOperationCandidate({
      scenes: sceneRows.map((row) => ({ id: row.id, durationMs: row.durationMs, locked: row.locked })),
      operations: request.operations,
      actorType: input.actor.type,
      projectId: input.projectId,
      locks: lockRows.map((row) => ({
        objectKind: row.objectKind as ObjectLockKind,
        objectId: row.objectId,
        dimensions: parseLockDimensions(row.dimensions),
        reason: row.reason,
      })),
    });

    // 应用前状态（AI 重编导快照用）
    const preApplyProject = structuredClone(project);
    const preApplyRows = sceneRows.map((row) => structuredClone(row));
    // AI 重编导前快照的事件水位线：必须在本批事件插入前捕获
    const txDb = tx as unknown as NodePgDatabase;
    const preApplyEventSeq =
      input.actor.type === 'AI' && input.compensation === undefined
        ? await currentEventSeq(txDb, input.projectId)
        : 0;

    const expectedValidated = new Set<string>();
    const dirtySceneIds = new Set<string>();
    // 读取时的原始 revision：同一请求内同一 Scene 可能被多次操作（revision 多次 +1），
    // 条件更新必须以"本次事务读到的事实"为依据（行锁保证无并发写入，这是最终防线）。
    const initialRevisions = new Map<string, number>(sceneRows.map((row) => [row.id, row.revision]));
    const createdSceneIds: string[] = [];
    const ordered: SceneRow[] = [...sceneRows];
    const eventDrafts: EventDraft[] = [];
    const affectedSceneIds = new Set<string>();
    const touchedObjectLocks = new Map<string, { objectKind: ObjectLockKind; objectId: string }>();
    const runtimeObjectLocks = new Map(lockRows.map((row) => [
      `${row.objectKind}:${row.objectId}`,
      { dimensions: parseLockDimensions(row.dimensions), reason: row.reason },
    ]));
    let restoreSnapshotReason: 'RESTORE' | null = null;

    const requireExpectedOnce = (sceneId: string): void => {
      if (expectedValidated.has(sceneId)) return;
      if (!initialRevisions.has(sceneId)) {
        // The scene was created earlier in this atomic batch and had no concurrent pre-state.
        expectedValidated.add(sceneId);
        return;
      }
      const expected = request.expectedSceneRevisions[sceneId];
      if (expected === undefined) {
        throw new ApiFailure(
          ERROR_CODES.VALIDATION_FAILED,
          `必须提供 expectedSceneRevisions["${sceneId}"]（§4.6 并发协议）`,
          400,
        );
      }
      const row = byId.get(sceneId);
      if (!row || row.revision !== expected) {
        throw versionConflict('scene has changed since expected revision', project.revision, {
          [sceneId]: row?.revision ?? 0,
        });
      }
      expectedValidated.add(sceneId);
    };

    const loadSceneEventsAsc = async (): Promise<{ action: string; sceneId: string | null; patch: unknown }[]> =>
      tx
        .select({ action: editEvents.action, sceneId: editEvents.sceneId, patch: editEvents.patch })
        .from(editEvents)
        .where(and(eq(editEvents.projectId, input.projectId), eq(editEvents.workspaceId, input.workspaceId)))
        .orderBy(editEvents.seq);

    for (const operation of request.operations) {
      switch (operation.op) {
        case 'update_project': {
          const before = { title: project.title, targetDurationMs: project.targetDurationMs };
          if (operation.changes.title !== undefined || operation.changes.targetDurationMs !== undefined) {
            project.title = operation.changes.title ?? project.title;
            project.targetDurationMs =
              operation.changes.targetDurationMs !== undefined ? operation.changes.targetDurationMs : project.targetDurationMs;
          }
          eventDrafts.push({
            action: 'UPDATE_PROJECT',
            sceneId: null,
            patch: { ...operation, before, after: { title: project.title, targetDurationMs: project.targetDurationMs } },
          });
          break;
        }

        case 'update_scene': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          const before = contentOf(row);
          const changes = operation.changes;
          if (changes.narration !== undefined) row.narration = changes.narration;
          if (changes.visualIntent !== undefined) row.visualIntent = changes.visualIntent;
          if (changes.sceneType !== undefined) row.sceneType = changes.sceneType;
          if (changes.semanticType !== undefined) row.semanticType = changes.semanticType;
          if (changes.durationMs !== undefined) row.durationMs = changes.durationMs;
          if (changes.componentId !== undefined) row.componentId = changes.componentId;
          if (changes.componentVersion !== undefined) row.componentVersion = changes.componentVersion;
          if (changes.props !== undefined) row.props = changes.props;
          if (changes.providerRequirement !== undefined) row.providerRequirement = changes.providerRequirement;
          if (changes.transition !== undefined) row.transition = changes.transition;
          if (changes.sourceBindings !== undefined) row.sourceBindings = changes.sourceBindings;
          if (changes.dataBindings !== undefined) row.dataBindings = changes.dataBindings;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'UPDATE_SCENE',
            sceneId: row.id,
            patch: { ...operation, before, after: contentOf(row) },
          });
          break;
        }

        case 'insert_scene': {
          if (operation.afterSceneId !== null && !byId.has(operation.afterSceneId)) {
            throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'afterSceneId 指向的 scene 不存在', 404);
          }
          const newId = operation.createdSceneId ?? operation.restoreSceneId ?? `scn_${randomUUID()}`;
          if (byId.has(newId)) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'restoreSceneId 已被占用（不可覆盖既有 Scene）', 409);
          }
          const now = new Date();
          const draft = operation.sceneDraft;
          const newRow: SceneRow = {
            id: newId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            revision: 1,
            position: 0,
            startMs: 0,
            durationMs: draft.durationMs,
            semanticType: draft.semanticType,
            sceneType: draft.sceneType,
            narrationBlockIds: [...draft.narrationBlockIds],
            narration: draft.narration,
            visualIntent: draft.visualIntent,
            componentId: draft.componentId,
            componentVersion: draft.componentVersion,
            props: draft.props,
            providerRequirement: draft.providerRequirement,
            sourceBindings: draft.sourceBindings,
            dataBindings: draft.dataBindings,
            assetBindings: structuredClone(draft.assetBindings),
            transition: { in: null, out: null },
            /** 草稿可要求锁定（P04-05：锁定旁白 → 锁定场景；作者仍可显式解锁） */
            locked: draft.locked,
            approved: false,
            needsReview: false,
            status: 'EMPTY',
            createdAt: now,
            updatedAt: now,
          };
          const insertIndex =
            operation.afterSceneId === null ? 0 : ordered.findIndex((row) => row.id === operation.afterSceneId) + 1;
          ordered.splice(insertIndex, 0, newRow);
          byId.set(newRow.id, newRow);
          createdSceneIds.push(newRow.id);
          affectedSceneIds.add(newRow.id);
          eventDrafts.push({ action: 'INSERT_SCENE', sceneId: newRow.id, patch: { ...operation, after: contentOf(newRow) } });
          break;
        }

        case 'delete_scene': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          const index = ordered.findIndex((candidate) => candidate.id === row.id);
          const prevSceneId = index > 0 ? (ordered[index - 1]?.id ?? null) : null;
          ordered.splice(index, 1);
          byId.delete(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'DELETE_SCENE',
            sceneId: row.id,
            patch: { ...operation, before: { content: contentOf(row), position: index, prevSceneId } },
          });
          break;
        }

        case 'duplicate_scene': {
          // 复制不修改源 Scene（无需 expected revision）
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          const copyId = operation.createdSceneId ?? operation.restoreSceneId ?? `scn_${randomUUID()}`;
          if (byId.has(copyId)) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'restoreSceneId 已被占用（不可覆盖既有 Scene）', 409);
          }
          const now = new Date();
          const copy: SceneRow = {
            ...structuredClone(row),
            id: copyId,
            revision: 1,
            createdAt: now,
            updatedAt: now,
          };
          const insertIndex =
            operation.afterSceneId === null
              ? ordered.findIndex((candidate) => candidate.id === row.id) + 1
              : ordered.findIndex((candidate) => candidate.id === operation.afterSceneId) + 1;
          ordered.splice(insertIndex, 0, copy);
          byId.set(copy.id, copy);
          createdSceneIds.push(copy.id);
          affectedSceneIds.add(copy.id);
          eventDrafts.push({
            action: 'DUPLICATE_SCENE',
            sceneId: copy.id,
            patch: { ...operation, sourceSceneId: row.id, after: contentOf(copy) },
          });
          break;
        }

        case 'split_scene': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          if (operation.atMs <= 0 || operation.atMs >= row.durationMs) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_scene 的 atMs 必须位于 (0, durationMs) 内', 400);
          }
          const before = contentOf(row);
          const tailDuration = row.durationMs - operation.atMs;
          const now = new Date();
          const tailId = operation.createdTailSceneId ?? operation.restoreTailSceneId ?? `scn_${randomUUID()}`;
          if (byId.has(tailId)) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'restoreTailSceneId 已被占用（不可覆盖既有 Scene）', 409);
          }
          const tail: SceneRow = {
            ...structuredClone(row),
            id: tailId,
            revision: 1,
            // TODO(P06-03)：有 Alignment 后按旁白边界切分并复用音频；当前仅切时长
            narration: '',
            durationMs: tailDuration,
            status: 'EMPTY',
            createdAt: now,
            updatedAt: now,
          };
          row.durationMs = operation.atMs;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          const insertIndex = ordered.findIndex((candidate) => candidate.id === row.id) + 1;
          ordered.splice(insertIndex, 0, tail);
          byId.set(tail.id, tail);
          createdSceneIds.push(tail.id);
          affectedSceneIds.add(row.id);
          affectedSceneIds.add(tail.id);
          eventDrafts.push({
            action: 'SPLIT_SCENE',
            sceneId: row.id,
            patch: { ...operation, tailSceneId: tail.id, before, after: contentOf(row), tail: contentOf(tail) },
          });
          break;
        }

        case 'reorder_scenes': {
          const currentIds = ordered.map((row) => row.id).sort();
          const requestedIds = [...operation.orderedSceneIds].sort();
          if (currentIds.length !== requestedIds.length || currentIds.some((id, index) => id !== requestedIds[index])) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'reorder_scenes 必须包含当前全部 Scene 且不重不漏', 400);
          }
          const beforeOrder = ordered.map((row) => row.id);
          ordered.sort((a, b) => operation.orderedSceneIds.indexOf(a.id) - operation.orderedSceneIds.indexOf(b.id));
          for (const row of ordered) affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'REORDER_SCENES',
            sceneId: null,
            patch: { ...operation, before: { order: beforeOrder }, after: { order: [...operation.orderedSceneIds] } },
          });
          break;
        }

        case 'set_scene_lock': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          const before = { locked: row.locked };
          row.locked = operation.locked;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'SET_SCENE_LOCK',
            sceneId: row.id,
            patch: { ...operation, before, after: { locked: row.locked } },
          });
          break;
        }

        case 'set_object_lock': {
          const key = `${operation.objectKind}:${operation.objectId}`;
          touchedObjectLocks.set(key, { objectKind: operation.objectKind, objectId: operation.objectId });
          if (operation.objectKind === 'SCENE') affectedSceneIds.add(operation.objectId);
          const current = runtimeObjectLocks.get(key);
          const before = current === undefined ? null : { dimensions: [...current.dimensions], reason: current.reason };
          const dimensions = operation.locked
            ? OBJECT_LOCK_DIMENSIONS.filter((dimension) => [...(current?.dimensions ?? []), ...operation.dimensions].includes(dimension))
            : (current?.dimensions ?? []).filter((dimension) => !operation.dimensions.includes(dimension));
          const after = dimensions.length === 0
            ? null
            : { dimensions, reason: operation.reason !== undefined ? operation.reason : (current?.reason ?? null) };
          if (after === null) runtimeObjectLocks.delete(key);
          else runtimeObjectLocks.set(key, after);
          eventDrafts.push({
            action: 'SET_OBJECT_LOCK',
            sceneId: operation.objectKind === 'SCENE' ? operation.objectId : null,
            objectKind: 'OBJECT_LOCK',
            objectId: operation.objectId,
            patch: {
              ...operation,
              before,
              after,
            },
          });
          break;
        }

        case 'insert_clip': {
          const sequenceRows = await tx.select().from(projectSequences).where(and(
            eq(projectSequences.id, operation.sequenceId),
            eq(projectSequences.workspaceId, input.workspaceId),
            eq(projectSequences.projectId, input.projectId),
          )).limit(1);
          const clipSequence = sequenceRows[0];
          if (!clipSequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
          const targetTrackRows = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.id, operation.trackId),
            eq(sequenceTracks.workspaceId, input.workspaceId),
            eq(sequenceTracks.projectId, input.projectId),
            eq(sequenceTracks.sequenceId, operation.sequenceId),
          )).limit(1);
          const targetTrack = targetTrackRows[0];
          if (!targetTrack) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'target track not found', 404);
          if (targetTrack.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'target track is locked', 409, { reason: 'TRACK_LOCKED' });

          const insertSourceRange = mediaRangeSchema.parse(operation.sourceRange);
          const sequenceDuration = mediaTimeSchema.parse(clipSequence.duration);
          const sequenceTimebase = sequenceDuration.timebase;
          const durationTicks = exactTicks(timeFraction(sequenceDuration), sequenceTimebase);
          let sourceHasAudio = false;
          if (operation.assetVersionId !== null) {
            const sourceRows = await tx.select({
              durationMs: assetVersions.durationMs,
              status: assetVersions.status,
              checksumSha256: assetVersions.checksumSha256,
              mediaProbe: assetVersions.mediaProbe,
            }).from(assetVersions).where(and(eq(assetVersions.id, operation.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId))).limit(1);
            const source = sourceRows[0];
            if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
            if (source.status !== 'READY' || source.durationMs === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version is not ready with known duration', 409);
            if (source.checksumSha256 === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version has no immutable checksum', 409, { reason: 'SOURCE_CHECKSUM_MISSING' });
            if (compareMediaTime(insertSourceRange.start, mediaTimeOf(0n, insertSourceRange.start.timebase)) < 0 || compareMediaTime(insertSourceRange.end, legacyMillisecondsToMediaTime(source.durationMs)) > 0) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds asset duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
            }
            // 源是否含音频流按规范探测结果判定（sourceMediaProbeResultSchema；不得猜测字段形状）。
            const probe = sourceMediaProbeResultSchema.safeParse(source.mediaProbe);
            sourceHasAudio = probe.success && probe.data.status === 'READY' && probe.data.streams.some((stream) => stream.type === 'AUDIO');
          } else if (operation.nestedSequenceId !== null) {
            const nestedRows = await tx.select({ duration: projectSequences.duration }).from(projectSequences).where(and(
              eq(projectSequences.id, operation.nestedSequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
            )).limit(1);
            const nested = nestedRows[0];
            if (!nested || compareMediaTime(insertSourceRange.end, mediaTimeSchema.parse(nested.duration)) > 0) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
            }
          }

          const clipTicks = exactTicks(rangeDuration(insertSourceRange), sequenceTimebase);
          const sequenceClipsRows = await tx.select().from(sequenceClips).where(and(
            eq(sequenceClips.sequenceId, operation.sequenceId),
            eq(sequenceClips.workspaceId, input.workspaceId),
            eq(sequenceClips.projectId, input.projectId),
          ));
          const trackClips = sequenceClipsRows.filter((row) => row.trackId === operation.trackId);
          const ticksOf = (range: unknown): { start: bigint; end: bigint } => {
            const parsed = mediaRangeSchema.parse(range);
            return {
              start: exactTicks(timeFraction(parsed.start), sequenceTimebase),
              end: exactTicks(timeFraction(parsed.end), sequenceTimebase),
            };
          };
          const isRestore = operation.restoreClipId !== undefined;
          let startTicks: bigint;
          if (operation.mode === 'APPEND') {
            startTicks = trackClips.reduce((max, row) => {
              const span = ticksOf(row.sequenceRange);
              return span.end > max ? span.end : max;
            }, 0n);
          } else {
            startTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.sequenceStart)), sequenceTimebase);
          }
          const endTicks = startTicks + clipTicks;
          const placement = mediaRangeSchema.parse({ start: mediaTimeOf(startTicks, sequenceTimebase), end: mediaTimeOf(endTicks, sequenceTimebase) });
          if (endTicks > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'insert range exceeds sequence duration（序列长度扩展属 N03-04 轨道/序列控制）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }

          // 触碰既有片段（平移/裁切/切分/删除）前先取对象锁：锁住 POSITION/DURATION/CONTENT
          // 任一维度即拒绝；仅锁无关维度不阻断（与对象锁维度语义一致）。
          const blockingLockDim = (dimensions: readonly string[]): boolean =>
            dimensions.some((dimension) => dimension === 'POSITION' || dimension === 'DURATION' || dimension === 'CONTENT');
          const clipLockDimensions = async (clipId: string): Promise<string[] | null> => {
            const lockRows = await tx.select({ dimensions: projectObjectLocks.dimensions }).from(projectObjectLocks).where(and(
              eq(projectObjectLocks.workspaceId, input.workspaceId),
              eq(projectObjectLocks.projectId, input.projectId),
              eq(projectObjectLocks.objectKind, 'CLIP'),
              eq(projectObjectLocks.objectId, clipId),
            )).limit(1);
            return lockRows[0] ? (lockRows[0].dimensions as string[]) : null;
          };
          const assertShiftFitsSequence = (candidateEndTicks: bigint): void => {
            if (candidateEndTicks > durationTicks) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple exceeds sequence duration（序列长度扩展属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
            }
          };

          if (!isRestore && operation.mode === 'INSERT') {
            for (const row of trackClips) {
              const span = ticksOf(row.sequenceRange);
              if (span.end <= startTicks) continue;
              const lockDimensions = await clipLockDimensions(row.id);
              if (lockDimensions !== null && blockingLockDim(lockDimensions)) {
                throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'insert ripple touches a locked clip', 409, { reason: 'CLIP_LOCKED', clipId: row.id });
              }
              const before = clipSnapshot(row);
              if (span.start >= startTicks) {
                assertShiftFitsSequence(span.end + clipTicks);
                const shifted = mediaRangeSchema.parse({ start: mediaTimeOf(span.start + clipTicks, sequenceTimebase), end: mediaTimeOf(span.end + clipTicks, sequenceTimebase) });
                const afterRow = { ...row, sequenceRange: shifted, updatedAt: new Date() };
                await tx.update(sequenceClips).set({ sequenceRange: shifted, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
                eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'update_clip', before, after: clipSnapshot(afterRow) } });
                continue;
              }
              // 插入点落在片段内部：左段留在原位、右段整体右移 clipTicks（标准插入剪辑语义，避免重叠）。
              assertShiftFitsSequence(span.end + clipTicks);
              const mapping = row.timeMapping as { rate?: { num?: number; den?: number }; direction?: string };
              const identityMapping = mapping?.direction === 'FORWARD' && (mapping?.rate?.num ?? 1) === 1 && (mapping?.rate?.den ?? 1) === 1;
              if (!identityMapping) {
                throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'insert splitting requires a 1:1 forward clip mapping', 422, { reason: 'INSERT_SPLIT_UNSUPPORTED_MAPPING', clipId: row.id });
              }
              const sourceSpan = mediaRangeSchema.parse(row.sourceRange);
              const sourceTimebase = sourceSpan.start.timebase;
              const sourceCutTicks = (sequenceTicks: bigint): bigint =>
                exactTicks({ num: sequenceTicks * BigInt(sequenceTimebase.num), den: BigInt(sequenceTimebase.den) }, sourceTimebase);
              const sourceStartTicks = exactTicks(timeFraction(sourceSpan.start), sourceTimebase);
              const leftRange = mediaRangeSchema.parse({ start: mediaTimeOf(span.start, sequenceTimebase), end: mediaTimeOf(startTicks, sequenceTimebase) });
              const leftSource = mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceCutTicks(startTicks - span.start), sourceTimebase) });
              const leftRow = { ...row, sequenceRange: leftRange, sourceRange: leftSource, updatedAt: new Date() };
              await tx.update(sequenceClips).set({ sequenceRange: leftRange, sourceRange: leftSource, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
              eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'update_clip', before, after: clipSnapshot(leftRow) } });
              const rightId = `clp_${randomUUID()}`;
              const rightRange = mediaRangeSchema.parse({ start: mediaTimeOf(startTicks + clipTicks, sequenceTimebase), end: mediaTimeOf(span.end + clipTicks, sequenceTimebase) });
              const rightSource = mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceCutTicks(startTicks - span.start), sourceTimebase), end: sourceSpan.end });
              const rightRow = {
                id: rightId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: operation.sequenceId, trackId: operation.trackId,
                assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId, sourceStreamId: row.sourceStreamId,
                sourceRange: rightSource, sequenceRange: rightRange, timeMapping: row.timeMapping, avGroupId: row.avGroupId, parentClipId: row.parentClipId,
                createdAt: new Date(), updatedAt: new Date(),
              };
              await tx.insert(sequenceClips).values(rightRow);
              eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: rightId, patch: { op: 'insert_clip', after: clipSnapshot(rightRow) } });
            }
          } else if (!isRestore && operation.mode === 'OVERWRITE') {
            for (const row of trackClips) {
              const span = ticksOf(row.sequenceRange);
              if (span.start >= endTicks || span.end <= startTicks) continue;
              const lockDimensions = await clipLockDimensions(row.id);
              if (lockDimensions !== null && blockingLockDim(lockDimensions)) {
                throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'overwrite range contains a locked clip', 409, { reason: 'CLIP_LOCKED', clipId: row.id });
              }
              const before = clipSnapshot(row);
              if (span.start >= startTicks && span.end <= endTicks) {
                await tx.delete(sequenceClips).where(eq(sequenceClips.id, row.id));
                eventDrafts.push({ action: 'DELETE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'delete_clip', before } });
                continue;
              }
              const mapping = row.timeMapping as { rate?: { num?: number; den?: number }; direction?: string };
              const identityMapping = mapping?.direction === 'FORWARD' && (mapping?.rate?.num ?? 1) === 1 && (mapping?.rate?.den ?? 1) === 1;
              if (!identityMapping) {
                throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'overwrite trimming requires a 1:1 forward clip mapping', 422, { reason: 'OVERWRITE_TRIM_UNSUPPORTED_MAPPING', clipId: row.id });
              }
              const sourceSpan = mediaRangeSchema.parse(row.sourceRange);
              const sourceTimebase = sourceSpan.start.timebase;
              const sourceCutTicks = (sequenceTicks: bigint): bigint =>
                exactTicks({ num: sequenceTicks * BigInt(sequenceTimebase.num), den: BigInt(sequenceTimebase.den) }, sourceTimebase);
              const sourceStartTicks = exactTicks(timeFraction(sourceSpan.start), sourceTimebase);
              if (span.start < startTicks && span.end <= endTicks) {
                const nextRange = mediaRangeSchema.parse({ start: mediaTimeOf(span.start, sequenceTimebase), end: mediaTimeOf(startTicks, sequenceTimebase) });
                const nextSource = mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceCutTicks(startTicks - span.start), sourceTimebase) });
                const afterRow = { ...row, sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() };
                await tx.update(sequenceClips).set({ sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
                eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'update_clip', before, after: clipSnapshot(afterRow) } });
              } else if (span.start >= startTicks && span.end > endTicks) {
                const nextRange = mediaRangeSchema.parse({ start: mediaTimeOf(endTicks, sequenceTimebase), end: mediaTimeOf(span.end, sequenceTimebase) });
                const nextSource = mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceCutTicks(endTicks - span.start), sourceTimebase), end: sourceSpan.end });
                const afterRow = { ...row, sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() };
                await tx.update(sequenceClips).set({ sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
                eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'update_clip', before, after: clipSnapshot(afterRow) } });
              } else {
                // 覆盖区间落在片段内部 → 左段保留、右段重建（源范围同步切分，保持源对齐）
                const leftRange = mediaRangeSchema.parse({ start: mediaTimeOf(span.start, sequenceTimebase), end: mediaTimeOf(startTicks, sequenceTimebase) });
                const leftSource = mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceStartTicks + sourceCutTicks(startTicks - span.start), sourceTimebase) });
                const leftRow = { ...row, sequenceRange: leftRange, sourceRange: leftSource, updatedAt: new Date() };
                await tx.update(sequenceClips).set({ sequenceRange: leftRange, sourceRange: leftSource, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
                eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { op: 'update_clip', before, after: clipSnapshot(leftRow) } });
                const rightId = `clp_${randomUUID()}`;
                const rightRange = mediaRangeSchema.parse({ start: mediaTimeOf(endTicks, sequenceTimebase), end: mediaTimeOf(span.end, sequenceTimebase) });
                const rightSource = mediaRangeSchema.parse({ start: mediaTimeOf(sourceStartTicks + sourceCutTicks(endTicks - span.start), sourceTimebase), end: sourceSpan.end });
                const rightRow = {
                  id: rightId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: operation.sequenceId, trackId: operation.trackId,
                  assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId, sourceStreamId: row.sourceStreamId,
                  sourceRange: rightSource, sequenceRange: rightRange, timeMapping: row.timeMapping, avGroupId: row.avGroupId, parentClipId: row.parentClipId,
                  createdAt: new Date(), updatedAt: new Date(),
                };
                await tx.insert(sequenceClips).values(rightRow);
                eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: rightId, patch: { op: 'insert_clip', after: clipSnapshot(rightRow) } });
              }
            }
          }

          const insertedAt = new Date();
          const clipId = operation.restoreClipId ?? operation.createdClipId ?? `clp_${randomUUID()}`;
          const audioGroupId = operation.linkAudio && sourceHasAudio ? `avgp_${randomUUID()}` : null;
          const insertedRow = {
            id: clipId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: operation.sequenceId, trackId: operation.trackId,
            assetVersionId: operation.assetVersionId ?? null, nestedSequenceId: operation.nestedSequenceId ?? null, sourceStreamId: operation.sourceStreamId ?? null,
            sourceRange: insertSourceRange, sequenceRange: placement, timeMapping: CLIP_IDENTITY_MAPPING, avGroupId: audioGroupId, parentClipId: null,
            createdAt: insertedAt, updatedAt: insertedAt,
          };
          await tx.insert(sequenceClips).values(insertedRow);
          eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: clipId, patch: { ...operation, after: clipSnapshot(insertedRow) } });

          if (audioGroupId !== null) {
            let audioTrackId = operation.audioTrackId;
            if (audioTrackId === null) {
              const sequenceTracksRows = await tx.select().from(sequenceTracks).where(and(
                eq(sequenceTracks.sequenceId, operation.sequenceId),
                eq(sequenceTracks.workspaceId, input.workspaceId),
                eq(sequenceTracks.projectId, input.projectId),
              ));
              const audioTracks = sequenceTracksRows.filter((row) => row.kind === 'AUDIO').sort((left, right) => left.position - right.position);
              const firstAudio = audioTracks[0];
              if (firstAudio) {
                audioTrackId = firstAudio.id;
              } else {
                // TODO(N03-04)：轨道生命周期（新建/复用/删除/轨道控制）属 N03-04；原语落地前，
                //   此处自动创建的音频轨在 undo 后只会删除片段、保留空轨，需按同一 avGroupId 回收。
                const position = sequenceTracksRows.reduce((max, row) => Math.max(max, row.position), -1) + 1;
                const createdAudioTrackId = `trk_${randomUUID()}`;
                await tx.insert(sequenceTracks).values({
                  id: createdAudioTrackId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: operation.sequenceId,
                  kind: 'AUDIO', position, name: '音频', locked: false, muted: false, hidden: false, createdAt: insertedAt, updatedAt: insertedAt,
                });
                audioTrackId = createdAudioTrackId;
              }
            } else {
              const audioTrackRows = await tx.select().from(sequenceTracks).where(and(
                eq(sequenceTracks.id, audioTrackId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId), eq(sequenceTracks.sequenceId, operation.sequenceId),
              )).limit(1);
              const audioTrack = audioTrackRows[0];
              if (!audioTrack) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio track not found', 404);
              if (audioTrack.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'audio track is locked', 409, { reason: 'TRACK_LOCKED' });
            }
            const audioClipId = operation.createdAudioClipId ?? `clp_${randomUUID()}`;
            const audioRow = { ...insertedRow, id: audioClipId, trackId: audioTrackId };
            await tx.insert(sequenceClips).values(audioRow);
            eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: audioClipId, patch: { op: 'insert_clip', after: clipSnapshot(audioRow) } });
          }
          break;
        }

        case 'delete_clip': {
          const rows = await tx.select().from(sequenceClips).where(and(
            eq(sequenceClips.id, operation.clipId),
            eq(sequenceClips.workspaceId, input.workspaceId),
            eq(sequenceClips.projectId, input.projectId),
          )).limit(1);
          const row = rows[0];
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip not found', 404);
          const trackRows = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.id, row.trackId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId),
          )).limit(1);
          if (trackRows[0]?.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
          const deletedBefore = clipSnapshot(row);
          await tx.delete(sequenceClips).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'DELETE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before: deletedBefore } });
          break;
        }

        case 'split_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          const span = ticksInRange(row.sequenceRange, timebase);
          const atTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
          if (atTicks <= span.start || atTicks >= span.end) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split point must fall inside the clip', 422, { reason: 'SPLIT_POINT_OUTSIDE_CLIP' });
          }
          if (!identityForwardMapping(row)) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split requires a 1:1 forward clip mapping', 422, { reason: 'SPLIT_UNSUPPORTED_MAPPING' });
          }
          const leftDuration = atTicks - span.start;
          const leftRange = mediaRangeSchema.parse({ start: mediaTimeOf(span.start, timebase), end: mediaTimeOf(atTicks, timebase) });
          const rightRange = mediaRangeSchema.parse({ start: mediaTimeOf(atTicks, timebase), end: mediaTimeOf(span.end, timebase) });
          if (rightRange.end !== undefined && span.end > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          // 绑定到该片段的音频区域：局部时钟落在右段或跨越切点 → 需要区域级切分（N03-06），fail-closed 不静默改时钟。
          for (const region of await clipBoundAudioRegions(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, clipId: row.id })) {
            const localRange = mediaRangeSchema.parse(region.localRange);
            const localSeconds = rangeDuration(localRange);
            if (compareFraction(localSeconds, { num: leftDuration * BigInt(timebase.num), den: BigInt(timebase.den) }) > 0) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region spans the split point', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
            }
          }
          // 视频/音频对：同一 avGroupId 的关联片段按同一方式切分（保持声画同步）。
          const splitTargets = [
            { row, leftRange, rightRange, createdId: operation.createdClipId ?? `clp_${randomUUID()}` },
            ...(await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row })).map((sibling) => {
              if (!identityForwardMapping(sibling)) {
                throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split requires a 1:1 forward clip mapping', 422, { reason: 'SPLIT_UNSUPPORTED_MAPPING', clipId: sibling.id });
              }
              const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
              return {
                row: sibling,
                leftRange: mediaRangeSchema.parse({ start: mediaTimeOf(siblingSpan.start, timebase), end: mediaTimeOf(siblingSpan.start + leftDuration, timebase) }),
                rightRange: mediaRangeSchema.parse({ start: mediaTimeOf(siblingSpan.start + leftDuration, timebase), end: mediaTimeOf(siblingSpan.end, timebase) }),
                createdId: operation.createdAudioClipId ?? `clp_${randomUUID()}`,
              };
            }),
          ];
          for (const target of splitTargets) {
            await splitClipRow(tx, {
              workspaceId: input.workspaceId, projectId: input.projectId, patchBase: operation,
              row: target.row, leftRange: target.leftRange, rightRange: target.rightRange,
              leftSeconds: { num: leftDuration * BigInt(timebase.num), den: BigInt(timebase.den) },
              leftAction: target.row.id === row.id ? 'SPLIT_CLIP' : 'UPDATE_CLIP',
              createdId: target.createdId,
            }, eventDrafts);
          }
          break;
        }

        case 'slip_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT'] });
          const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
          const sequenceSeconds = rangeDuration(mediaRangeSchema.parse(row.sequenceRange));
          const sourceSeconds = rangeDuration(sourceRange);
          if (compareFraction(sourceSeconds, sequenceSeconds) !== 0) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slip keeps the clip position and duration', 422, { reason: 'SLIP_DURATION_MISMATCH' });
          }
          await assertSourceRangeUsable(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId, range: sourceRange,
          });
          // 本地滑移量（源）用于把 AV 关联片段同步滑移，保持声画一致。
          const previousStartSeconds = timeFraction(mediaRangeSchema.parse(row.sourceRange).start);
          const nextStartSeconds = timeFraction(sourceRange.start);
          const slipSeconds: Fraction = {
            num: nextStartSeconds.num * previousStartSeconds.den - previousStartSeconds.num * nextStartSeconds.den,
            den: nextStartSeconds.den * previousStartSeconds.den,
          };
          const slipTargets = [{ row, range: sourceRange }];
          for (const sibling of await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row })) {
            const siblingSource = mediaRangeSchema.parse(sibling.sourceRange);
            if (compareFraction(rangeDuration(siblingSource), sequenceSeconds) !== 0) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'linked clip duration mismatch prevents slip sync', 409, { reason: 'AV_LINK_DURATION_MISMATCH', clipId: sibling.id });
            }
            const siblingTimebase = siblingSource.start.timebase;
            const siblingStartTicks = exactTicks(timeFraction(siblingSource.start), siblingTimebase);
            const slipTicks = exactTicks(slipSeconds, siblingTimebase);
            const nextStart = siblingStartTicks + slipTicks;
            if (nextStart < 0n) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slip exceeds available source handles', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: sibling.id });
            slipTargets.push({ row: sibling, range: mediaRangeSchema.parse({
              start: mediaTimeOf(nextStart, siblingTimebase),
              end: mediaTimeOf(exactTicks(rangeDuration(siblingSource), siblingTimebase) + nextStart, siblingTimebase),
            }) });
          }
          for (const target of slipTargets) {
            const before = clipSnapshot(target.row);
            const after = clipSnapshot({ ...target.row, sourceRange: target.range, updatedAt: new Date() });
            await tx.update(sequenceClips).set({ sourceRange: target.range, updatedAt: new Date() }).where(eq(sequenceClips.id, target.row.id));
            eventDrafts.push({
              action: target.row.id === row.id ? 'SLIP_CLIP' : 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: target.row.id,
              patch: { ...operation, clipId: target.row.id, before, after },
            });
          }
          break;
        }

        case 'slide_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['POSITION'] });
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          const offsetTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.offset)), timebase);
          const span = ticksInRange(row.sequenceRange, timebase);
          const trackClips = (await tx.select().from(sequenceClips).where(and(
            eq(sequenceClips.sequenceId, row.sequenceId), eq(sequenceClips.workspaceId, input.workspaceId),
            eq(sequenceClips.projectId, input.projectId), eq(sequenceClips.trackId, row.trackId),
          ))).filter((candidate) => candidate.id !== row.id);
          // slide 需要左右都有相邻片段来吸收位移（否则总时长会变，那属于 trim/move）。
          const prev = trackClips.find((candidate) => ticksInRange(candidate.sequenceRange, timebase).end === span.start);
          const next = trackClips.find((candidate) => ticksInRange(candidate.sequenceRange, timebase).start === span.end);
          if (prev === undefined || next === undefined) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide requires adjacent neighbors on both sides', 422, { reason: 'SLIDE_REQUIRES_ADJACENT_NEIGHBORS' });
          }
          for (const neighbor of [prev, next]) {
            await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: neighbor.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
            if (!identityForwardMapping(neighbor)) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide requires 1:1 forward mapping on neighbors', 422, { reason: 'SLIDE_UNSUPPORTED_MAPPING', clipId: neighbor.id });
            }
          }
          const shiftedClip = mediaRangeSchema.parse({ start: mediaTimeOf(span.start + offsetTicks, timebase), end: mediaTimeOf(span.end + offsetTicks, timebase) });
          if (span.start + offsetTicks < 0n || span.end + offsetTicks > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide exceeds sequence bounds', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          // 邻居按相反方向伸缩；伸缩量必须落在可用源 handle 内。
          const prevSpan = ticksInRange(prev.sequenceRange, timebase);
          const prevSource = mediaRangeSchema.parse(prev.sourceRange);
          const prevDurationSeconds: Fraction = { num: offsetTicks * BigInt(timebase.num), den: BigInt(timebase.den) };
          const prevTargetSeconds: Fraction = {
            num: rangeDuration(prevSource).num * prevDurationSeconds.den + prevDurationSeconds.num * rangeDuration(prevSource).den,
            den: rangeDuration(prevSource).den * prevDurationSeconds.den,
          };
          if (prevTargetSeconds.num <= 0n) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide would collapse the previous clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: prev.id });
          }
          const prevSourceEndTicks = exactTicks(timeFraction(prevSource.start), prevSource.start.timebase) + exactTicks(prevTargetSeconds, prevSource.start.timebase);
          const nextSpan = ticksInRange(next.sequenceRange, timebase);
          const nextSource = mediaRangeSchema.parse(next.sourceRange);
          const nextDurationSeconds: Fraction = { num: -offsetTicks * BigInt(timebase.num), den: BigInt(timebase.den) };
          const nextTargetSeconds: Fraction = {
            num: rangeDuration(nextSource).num * nextDurationSeconds.den + nextDurationSeconds.num * rangeDuration(nextSource).den,
            den: rangeDuration(nextSource).den * nextDurationSeconds.den,
          };
          if (nextTargetSeconds.num <= 0n) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide would collapse the next clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: next.id });
          }
          const nextSourceStartShift = exactTicks({ num: offsetTicks * BigInt(timebase.num), den: BigInt(timebase.den) }, nextSource.start.timebase);
          const nextSourceStartTicks = exactTicks(timeFraction(nextSource.start), nextSource.start.timebase) + nextSourceStartShift;
          if (nextSourceStartTicks < 0n) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'slide needs source handles before the next clip in-point', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: next.id });
          }
          // 邻居的新范围（同轨；由位移吸收，合成时长不变）。
          const prevRange = mediaRangeSchema.parse({ start: mediaTimeOf(prevSpan.start, timebase), end: mediaTimeOf(prevSpan.end + offsetTicks, timebase) });
          const nextRange = mediaRangeSchema.parse({ start: mediaTimeOf(nextSpan.start + offsetTicks, timebase), end: mediaTimeOf(nextSpan.end, timebase) });
          const prevSourceRange = mediaRangeSchema.parse({ start: prevSource.start, end: mediaTimeOf(prevSourceEndTicks, prevSource.start.timebase) });
          // 邻居内容在时间线上保持不动：next 只推进源入点（出点不变，时长自然缩短）。
          const nextSourceRange = mediaRangeSchema.parse({
            start: mediaTimeOf(nextSourceStartTicks, nextSource.start.timebase),
            end: nextSource.end,
          });
          const edits: { row: typeof sequenceClips.$inferSelect; sequenceRange: ReturnType<typeof mediaRangeSchema.parse>; sourceRange: ReturnType<typeof mediaRangeSchema.parse>; action: string }[] = [
            { row: prev, sequenceRange: prevRange, sourceRange: prevSourceRange, action: 'UPDATE_CLIP' },
            { row: next, sequenceRange: nextRange, sourceRange: nextSourceRange, action: 'UPDATE_CLIP' },
            { row, sequenceRange: shiftedClip, sourceRange: mediaRangeSchema.parse(row.sourceRange), action: 'SLIDE_CLIP' },
          ];
          // AV 关联片段按同一位移移动（留在各自轨道；若因此重叠则由重叠检查拒绝）。
          for (const sibling of await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row })) {
            const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
            const siblingRange = mediaRangeSchema.parse({ start: mediaTimeOf(siblingSpan.start + offsetTicks, timebase), end: mediaTimeOf(siblingSpan.end + offsetTicks, timebase) });
            await assertNoTrackOverlap(tx, {
              workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: sibling.trackId, timebase,
              candidate: { start: siblingSpan.start + offsetTicks, end: siblingSpan.end + offsetTicks }, excludeClipIds: [sibling.id],
            });
            edits.push({ row: sibling, sequenceRange: siblingRange, sourceRange: mediaRangeSchema.parse(sibling.sourceRange), action: 'UPDATE_CLIP' });
          }
          for (const edit of edits) {
            const before = clipSnapshot(edit.row);
            const after = clipSnapshot({ ...edit.row, sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange, updatedAt: new Date() });
            await tx.update(sequenceClips).set({ sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange, updatedAt: new Date() }).where(eq(sequenceClips.id, edit.row.id));
            eventDrafts.push({ action: edit.action, sceneId: null, objectKind: 'CLIP', objectId: edit.row.id, patch: { ...operation, clipId: edit.row.id, before, after } });
          }
          break;
        }

        case 'roll_clip': {
          const left = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.leftClipId });
          const right = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.rightClipId });
          for (const target of [left, right]) {
            await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: target.row.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
            if (!identityForwardMapping(target.row)) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires 1:1 forward mapping', 422, { reason: 'ROLL_UNSUPPORTED_MAPPING', clipId: target.row.id });
            }
          }
          if (left.row.trackId !== right.row.trackId) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires both clips on the same track', 422, { reason: 'ROLL_REQUIRES_SAME_TRACK' });
          }
          const { timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: left.row.sequenceId });
          const leftSpan = ticksInRange(left.row.sequenceRange, timebase);
          const rightSpan = ticksInRange(right.row.sequenceRange, timebase);
          if (leftSpan.end !== rightSpan.start) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll requires adjacent clips', 422, { reason: 'ROLL_REQUIRES_ADJACENT_CLIPS' });
          }
          const atTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
          if (atTicks <= leftSpan.start || atTicks >= rightSpan.end) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll point must fall inside the combined span', 422, { reason: 'ROLL_POINT_OUTSIDE_SPAN' });
          }
          const deltaLeft = atTicks - leftSpan.end;
          const deltaRight = atTicks - rightSpan.start;
          const leftSource = mediaRangeSchema.parse(left.row.sourceRange);
          const rightSource = mediaRangeSchema.parse(right.row.sourceRange);
          const leftSourceTicks = exactTicks(timeFraction(leftSource.start), leftSource.start.timebase);
          const leftSourceEndTicks = leftSourceTicks + exactTicks(rangeDuration(leftSource), leftSource.start.timebase) + exactTicks({ num: deltaLeft * BigInt(timebase.num), den: BigInt(timebase.den) }, leftSource.start.timebase);
          const rightSourceTicks = exactTicks(timeFraction(rightSource.start), rightSource.start.timebase) + exactTicks({ num: deltaRight * BigInt(timebase.num), den: BigInt(timebase.den) }, rightSource.start.timebase);
          const rightSourceEndTicks = exactTicks(timeFraction(rightSource.end), rightSource.end.timebase);
          if (leftSourceEndTicks <= leftSourceTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll would collapse the left clip', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: left.row.id });
          }
          if (rightSourceTicks < 0n || rightSourceTicks >= rightSourceEndTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'roll needs source handles before the right clip in-point', 422, { reason: 'HANDLE_UNAVAILABLE', clipId: right.row.id });
          }
          const leftRange = mediaRangeSchema.parse({ start: mediaTimeOf(leftSpan.start, timebase), end: mediaTimeOf(atTicks, timebase) });
          const rightRange = mediaRangeSchema.parse({ start: mediaTimeOf(atTicks, timebase), end: mediaTimeOf(rightSpan.end, timebase) });
          const leftSourceNext = mediaRangeSchema.parse({ start: leftSource.start, end: mediaTimeOf(leftSourceEndTicks, leftSource.start.timebase) });
          const rightSourceNext = mediaRangeSchema.parse({ start: mediaTimeOf(rightSourceTicks, rightSource.start.timebase), end: rightSource.end });
          for (const edit of [
            { row: left.row, sequenceRange: leftRange, sourceRange: leftSourceNext },
            { row: right.row, sequenceRange: rightRange, sourceRange: rightSourceNext },
          ]) {
            const before = clipSnapshot(edit.row);
            const after = clipSnapshot({ ...edit.row, sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange, updatedAt: new Date() });
            await tx.update(sequenceClips).set({ sequenceRange: edit.sequenceRange, sourceRange: edit.sourceRange, updatedAt: new Date() }).where(eq(sequenceClips.id, edit.row.id));
            eventDrafts.push({ action: 'ROLL_CLIP', sceneId: null, objectKind: 'CLIP', objectId: edit.row.id, patch: { ...operation, clipId: edit.row.id, before, after } });
          }
          break;
        }

        case 'ripple_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          const span = ticksInRange(row.sequenceRange, timebase);
          const siblings = await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row });
          // 收缝量：DELETE 用片段自身时长；TRIM_* 用显式 amount。
          let gapTicks: bigint;
          if (operation.action === 'DELETE') {
            if (!identityForwardMapping(row)) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple delete requires 1:1 forward mapping', 422, { reason: 'RIPPLE_UNSUPPORTED_MAPPING' });
            }
            gapTicks = span.end - span.start;
          } else {
            const amountTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.amount)), timebase);
            if (amountTicks <= 0n || amountTicks >= span.end - span.start) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple amount must be smaller than the clip duration', 422, { reason: 'RIPPLE_AMOUNT_OUT_OF_RANGE' });
            }
            if (amountTicks > durationTicks) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple amount exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
            }
            gapTicks = amountTicks;
          }
          // 掐头/去尾收缝后，片段自身都停在原位、时长缩短 gap；差别在源侧：掐头推进源入点、去尾回收源出点。
          const shiftFrom = span.end;
          // 受影响轨道：DELETE 默认跨全序列全部轨道；TRIM_* 与 closeAcrossTracks=false 只在同轨收缝。
          const scopeAcrossTracks = operation.closeAcrossTracks;
          const allTracks = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.sequenceId, row.sequenceId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId),
          ));
          // 收缝范围：显式跨轨 = 全部轨道；否则 = 本轨 + 同步锁打开的轨道（N03-04 同步锁语义）。
          const trackRows = scopeAcrossTracks ? allTracks : allTracks.filter((track) => track.id === row.trackId || track.syncLocked);
          const scopedTrackIds = new Set(trackRows.map((track) => track.id));
          for (const sibling of siblings) {
            if (!scopedTrackIds.has(sibling.trackId)) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'ripple scope would desync linked audio; enable sync lock or closeAcrossTracks', 409, { reason: 'AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE' });
            }
          }
          const removedIds = new Set<string>([row.id, ...siblings.map((sibling) => sibling.id)]);
          // 主片段（及 AV 关联片段）先落删除/裁剪事件。
          const primaryBefore = clipSnapshot(row);
          if (operation.action === 'DELETE') {
            for (const target of [row, ...siblings]) {
              const targetSpan = ticksInRange(target.sequenceRange, timebase);
              const targetBefore = clipSnapshot(target);
              await tx.delete(sequenceClips).where(eq(sequenceClips.id, target.id));
              eventDrafts.push({
                action: target.id === row.id ? 'RIPPLE_CLIP' : 'DELETE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: target.id,
                patch: { ...operation, clipId: target.id, deletedRange: { start: mediaTimeOf(targetSpan.start, timebase), end: mediaTimeOf(targetSpan.end, timebase) }, before: targetBefore },
              });
            }
          } else {
            const sourceSpan = mediaRangeSchema.parse(row.sourceRange);
            const sourceTimebase = sourceSpan.start.timebase;
            const sourceTicks = exactTicks(timeFraction(sourceSpan.start), sourceTimebase);
            const amountSourceTicks = exactTicks({ num: gapTicks * BigInt(timebase.num), den: BigInt(timebase.den) }, sourceTimebase);
            const nextRange = mediaRangeSchema.parse({ start: mediaTimeOf(span.start, timebase), end: mediaTimeOf(span.end - gapTicks, timebase) });
            const sourceDurationTicks = exactTicks(rangeDuration(sourceSpan), sourceTimebase);
            const nextSource = operation.action === 'TRIM_HEAD'
              ? mediaRangeSchema.parse({ start: mediaTimeOf(sourceTicks + amountSourceTicks, sourceTimebase), end: sourceSpan.end })
              : mediaRangeSchema.parse({ start: sourceSpan.start, end: mediaTimeOf(sourceTicks + sourceDurationTicks - amountSourceTicks, sourceTimebase) });
            const after = clipSnapshot({ ...row, sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() });
            await tx.update(sequenceClips).set({ sequenceRange: nextRange, sourceRange: nextSource, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
            eventDrafts.push({ action: 'RIPPLE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, clipId: row.id, before: primaryBefore, after } });
            // AV 关联片段按同一序列区间收缝（保持同步）。
            for (const sibling of siblings) {
              const siblingBefore = clipSnapshot(sibling);
              const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
              const siblingSource = mediaRangeSchema.parse(sibling.sourceRange);
              const siblingTimebase = siblingSource.start.timebase;
              const siblingSourceTicks = exactTicks(timeFraction(siblingSource.start), siblingTimebase);
              const amountSiblingTicks = exactTicks({ num: gapTicks * BigInt(timebase.num), den: BigInt(timebase.den) }, siblingTimebase);
              const siblingNextRange = mediaRangeSchema.parse({ start: mediaTimeOf(siblingSpan.start, timebase), end: mediaTimeOf(siblingSpan.end - gapTicks, timebase) });
              const siblingNextSource = operation.action === 'TRIM_HEAD'
                ? mediaRangeSchema.parse({
                  start: mediaTimeOf(siblingSourceTicks + amountSiblingTicks, siblingTimebase),
                  end: siblingSource.end,
                })
                : mediaRangeSchema.parse({
                  start: siblingSource.start,
                  end: mediaTimeOf(siblingSourceTicks + exactTicks(rangeDuration(siblingSource), siblingTimebase) - amountSiblingTicks, siblingTimebase),
                });
              const siblingAfter = clipSnapshot({ ...sibling, sequenceRange: siblingNextRange, sourceRange: siblingNextSource, updatedAt: new Date() });
              await tx.update(sequenceClips).set({ sequenceRange: siblingNextRange, sourceRange: siblingNextSource, updatedAt: new Date() }).where(eq(sequenceClips.id, sibling.id));
              eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id, before: siblingBefore, after: siblingAfter } });
            }
          }
          // 收缝：受影响轨道上起点晚于缝隙的片段整体左移 gapTicks（每段都落 UPDATE_CLIP，位置变化对用户可见/可撤销）。
          for (const track of trackRows) {
            const rows = await tx.select().from(sequenceClips).where(and(
              eq(sequenceClips.sequenceId, row.sequenceId), eq(sequenceClips.workspaceId, input.workspaceId),
              eq(sequenceClips.projectId, input.projectId), eq(sequenceClips.trackId, track.id),
            ));
            for (const candidate of rows) {
              if (removedIds.has(candidate.id)) continue;
              const candidateSpan = ticksInRange(candidate.sequenceRange, timebase);
              if (candidateSpan.start < shiftFrom) continue;
              const shifted = mediaRangeSchema.parse({
                start: mediaTimeOf(candidateSpan.start - gapTicks, timebase), end: mediaTimeOf(candidateSpan.end - gapTicks, timebase),
              });
              if (candidateSpan.start - gapTicks < 0n) {
                throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'ripple would move a clip before sequence start', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS', clipId: candidate.id });
              }
              const candidateBefore = clipSnapshot(candidate);
              const candidateAfter = clipSnapshot({ ...candidate, sequenceRange: shifted, updatedAt: new Date() });
              await tx.update(sequenceClips).set({ sequenceRange: shifted, updatedAt: new Date() }).where(eq(sequenceClips.id, candidate.id));
              eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: candidate.id, patch: { op: 'update_clip', clipId: candidate.id, ripple: true, before: candidateBefore, after: candidateAfter } });
            }
          }
          break;
        }

        case 'split_av_cut': {
          const video = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.videoClipId });
          const audio = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.audioClipId });
          if (video.row.avGroupId === null || video.row.avGroupId !== audio.row.avGroupId) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_av_cut requires an AV-linked clip pair', 422, { reason: 'CLIPS_NOT_AV_LINKED' });
          }
          const { timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: video.row.sequenceId });
          const offsetTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.offset)), timebase);
          const videoAt = exactTicks(timeFraction(mediaTimeSchema.parse(operation.at)), timebase);
          // J：音频切点早于视频（音频先入）；L：音频切点晚于视频（音频后出）。
          const audioAt = operation.kind === 'J' ? videoAt - offsetTicks : videoAt + offsetTicks;
          const videoSpan = ticksInRange(video.row.sequenceRange, timebase);
          const audioSpan = ticksInRange(audio.row.sequenceRange, timebase);
          for (const target of [
            { row: video.row, at: videoAt, span: videoSpan, kind: 'video' },
            { row: audio.row, at: audioAt, span: audioSpan, kind: 'audio' },
          ]) {
            await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: target.row.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
            if (!identityForwardMapping(target.row)) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_av_cut requires 1:1 forward mapping', 422, { reason: 'AV_CUT_UNSUPPORTED_MAPPING', clipId: target.row.id });
            }
            if (target.at <= target.span.start || target.at >= target.span.end) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'cut point must fall inside the clip', 422, {
                reason: 'CUT_POINT_OUTSIDE_CLIP', clipId: target.row.id, role: target.kind,
              });
            }
          }
          // 视频按 at 切分；音频按错开后的切点切分（源范围连续，切换处原音不跳）。
          await splitClipRow(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, patchBase: operation,
            row: video.row,
            leftRange: mediaRangeSchema.parse({ start: mediaTimeOf(videoSpan.start, timebase), end: mediaTimeOf(videoAt, timebase) }),
            rightRange: mediaRangeSchema.parse({ start: mediaTimeOf(videoAt, timebase), end: mediaTimeOf(videoSpan.end, timebase) }),
            leftSeconds: { num: (videoAt - videoSpan.start) * BigInt(timebase.num), den: BigInt(timebase.den) },
            leftAction: 'SPLIT_AV_CUT',
            createdId: operation.createdVideoClipId ?? `clp_${randomUUID()}`,
          }, eventDrafts);
          await splitClipRow(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, patchBase: operation,
            row: audio.row,
            leftRange: mediaRangeSchema.parse({ start: mediaTimeOf(audioSpan.start, timebase), end: mediaTimeOf(audioAt, timebase) }),
            rightRange: mediaRangeSchema.parse({ start: mediaTimeOf(audioAt, timebase), end: mediaTimeOf(audioSpan.end, timebase) }),
            leftSeconds: { num: (audioAt - audioSpan.start) * BigInt(timebase.num), den: BigInt(timebase.den) },
            leftAction: 'UPDATE_CLIP',
            createdId: operation.createdAudioClipId ?? `clp_${randomUUID()}`,
          }, eventDrafts);
          break;
        }

        case 'create_track': {
          const sequenceRows = await tx.select().from(projectSequences).where(and(
            eq(projectSequences.id, operation.sequenceId),
            eq(projectSequences.workspaceId, input.workspaceId),
            eq(projectSequences.projectId, input.projectId),
          )).limit(1);
          if (!sequenceRows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
          const now = new Date();
          const existingTracks = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.sequenceId, operation.sequenceId),
            eq(sequenceTracks.workspaceId, input.workspaceId),
            eq(sequenceTracks.projectId, input.projectId),
          ));
          // 目标位置被占用时把该位置及之后的轨道整体后移（两阶段写入避免唯一索引瞬时冲突）。
          const shifted = existingTracks.filter((row) => row.position >= operation.track.position).sort((left, right) => left.position - right.position);
          for (const existing of shifted) {
            await tx.update(sequenceTracks).set({ position: existing.position + 10_000, updatedAt: now }).where(eq(sequenceTracks.id, existing.id));
          }
          const createdTrackId = operation.restoreTrackId ?? `trk_${randomUUID()}`;
          const createdTrack = {
            id: createdTrackId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: operation.sequenceId,
            kind: operation.track.kind, position: operation.track.position, name: operation.track.name,
            locked: operation.track.locked ?? false, muted: operation.track.muted ?? false, hidden: operation.track.hidden ?? false,
            solo: operation.track.solo ?? false, syncLocked: operation.track.syncLocked ?? false,
            createdAt: now, updatedAt: now,
          };
          await tx.insert(sequenceTracks).values(createdTrack);
          for (const existing of shifted) {
            const shiftedPosition = existing.position + 1;
            await tx.update(sequenceTracks).set({ position: shiftedPosition, updatedAt: now }).where(eq(sequenceTracks.id, existing.id));
            eventDrafts.push({ action: 'UPDATE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: existing.id, patch: { op: 'update_track', trackId: existing.id, changes: { position: shiftedPosition }, before: trackSnapshot(existing), after: trackSnapshot({ ...existing, position: shiftedPosition, updatedAt: now }) } });
          }
          eventDrafts.push({ action: 'CREATE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: createdTrackId, patch: { ...operation, after: trackSnapshot(createdTrack) } });
          break;
        }

        case 'move_track': {
          const target = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: operation.trackId });
          const siblings = (await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.sequenceId, target.sequenceId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId),
          ))).filter((row) => row.id !== target.id).sort((left, right) => left.position - right.position);
          const now = new Date();
          const clamped = Math.min(operation.position, siblings.length);
          const finalOrder = [...siblings];
          finalOrder.splice(clamped, 0, target);
          await commitTrackOrder(tx, finalOrder, now);
          for (const [index, row] of finalOrder.entries()) {
            if (row.position === index) continue;
            eventDrafts.push({
              action: row.id === target.id ? 'MOVE_TRACK' : 'UPDATE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: row.id,
              patch: { ...operation, trackId: row.id, changes: { position: index }, before: trackSnapshot(row), after: trackSnapshot({ ...row, position: index, updatedAt: now }) },
            });
          }
          break;
        }

        case 'delete_track': {
          const target = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: operation.trackId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'TRACK', objectId: target.id, dimensions: ['POSITION', 'DURATION'] });
          const now = new Date();
          const clips = await tx.select().from(sequenceClips).where(and(
            eq(sequenceClips.trackId, target.id), eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId),
          ));
          if (clips.length > 0) {
            if (operation.nonEmptyPolicy === 'REJECT') {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is not empty; choose MOVE_CLIPS or delete the clips first', 409, { reason: 'TRACK_NOT_EMPTY', clipCount: clips.length });
            }
            const destination = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: String(operation.destinationTrackId) });
            if (destination.id === target.id || destination.kind !== target.kind) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'destination track must differ and have the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
            }
            for (const clip of clips) {
              const beforeClip = clipSnapshot(clip);
              await tx.update(sequenceClips).set({ trackId: destination.id, updatedAt: now }).where(eq(sequenceClips.id, clip.id));
              eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: clip.id, patch: { op: 'update_clip', clipId: clip.id, movedByTrackDelete: true, before: beforeClip, after: clipSnapshot({ ...clip, trackId: destination.id, updatedAt: now }) } });
            }
          }
          const beforeTrackDelete = trackSnapshot(target);
          await tx.delete(sequenceTracks).where(eq(sequenceTracks.id, target.id));
          eventDrafts.push({ action: 'DELETE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: target.id, patch: { ...operation, before: beforeTrackDelete } });
          const remaining = (await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.sequenceId, target.sequenceId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId),
          ))).sort((left, right) => left.position - right.position);
          await commitTrackOrder(tx, remaining, now);
          for (const [index, row] of remaining.entries()) {
            if (row.position === index) continue;
            eventDrafts.push({ action: 'UPDATE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: row.id, patch: { op: 'update_track', trackId: row.id, changes: { position: index }, before: trackSnapshot(row), after: trackSnapshot({ ...row, position: index, updatedAt: now }) } });
          }
          break;
        }

        case 'update_track': {
          const target = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: operation.trackId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'TRACK', objectId: target.id, dimensions: ['POSITION', 'STYLE'] });
          const changes = operation.changes;
          const now = new Date();
          const beforeTrack = trackSnapshot(target);
          // 轨道控制只改**这一条**轨道的状态：静音/独奏/隐藏/锁定/同步锁与该轨片段无关的其他轨道一律不动。
          const next = {
            ...target,
            name: changes.name ?? target.name,
            locked: changes.locked ?? target.locked,
            muted: changes.muted ?? target.muted,
            hidden: changes.hidden ?? target.hidden,
            solo: changes.solo ?? target.solo,
            syncLocked: changes.syncLocked ?? target.syncLocked,
            updatedAt: now,
          };
          await tx.update(sequenceTracks).set({
            name: next.name, locked: next.locked, muted: next.muted, hidden: next.hidden, solo: next.solo, syncLocked: next.syncLocked, updatedAt: now,
          }).where(eq(sequenceTracks.id, target.id));
          eventDrafts.push({ action: 'UPDATE_TRACK', sceneId: null, objectKind: 'TRACK', objectId: target.id, patch: { ...operation, before: beforeTrack, after: trackSnapshot(next) } });
          if (changes.position !== undefined) {
            const siblings = (await tx.select().from(sequenceTracks).where(and(
              eq(sequenceTracks.sequenceId, target.sequenceId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId),
            ))).filter((row) => row.id !== target.id).sort((left, right) => left.position - right.position);
            const clamped = Math.min(changes.position, siblings.length);
            const finalOrder = [...siblings];
            finalOrder.splice(clamped, 0, { ...next, position: clamped });
            await commitTrackOrder(tx, finalOrder, now);
          }
          break;
        }

        // N03-05：变换/裁切/透明度都是**参数化修改**——只改片段参数，不触发镜头重生成、不新增 Scene/Provider 任务。
        case 'set_clip_transform': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['STYLE'] });
          const before = clipSnapshot(row);
          const parameters = nextVisualParameters(row.parameters, { transform: visualTransformSchema.parse(operation.transform) });
          await tx.update(sequenceClips).set({ parameters, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'SET_CLIP_TRANSFORM', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after: clipSnapshot({ ...row, parameters, updatedAt: new Date() }) } });
          break;
        }

        case 'set_clip_crop': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['STYLE'] });
          const before = clipSnapshot(row);
          const crop = visualCropSchema.parse(operation.crop);
          if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crop must leave a non-empty visible area', 422, { reason: 'CROP_AREA_EMPTY' });
          }
          const parameters = nextVisualParameters(row.parameters, { crop });
          await tx.update(sequenceClips).set({ parameters, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'SET_CLIP_CROP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after: clipSnapshot({ ...row, parameters, updatedAt: new Date() }) } });
          break;
        }

        case 'set_clip_opacity': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['STYLE'] });
          const before = clipSnapshot(row);
          const parameters = nextVisualParameters(row.parameters, { opacity: operation.opacity });
          await tx.update(sequenceClips).set({ parameters, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'SET_CLIP_OPACITY', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after: clipSnapshot({ ...row, parameters, updatedAt: new Date() }) } });
          break;
        }

        case 'set_av_link': {
          const rows: (typeof sequenceClips.$inferSelect)[] = [];
          for (const clipId of operation.clipIds) {
            const loaded = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId });
            rows.push(loaded.row);
          }
          const now = new Date();
          if (!operation.linked) {
            // 解链：清空 avGroupId —— 其后视频的 trim/move/split 不再联动音轨。
            for (const row of rows) {
              if (row.avGroupId === null) continue;
              const beforeClip = clipSnapshot(row);
              await tx.update(sequenceClips).set({ avGroupId: null, updatedAt: now }).where(eq(sequenceClips.id, row.id));
              eventDrafts.push({ action: 'SET_AV_LINK', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, clipId: row.id, before: beforeClip, after: clipSnapshot({ ...row, avGroupId: null, updatedAt: now }) } });
            }
            break;
          }
          if (rows.length !== 2) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linking requires exactly two clips', 422, { reason: 'AV_LINK_INVALID' });
          const [left, right] = rows as [(typeof sequenceClips.$inferSelect), (typeof sequenceClips.$inferSelect)];
          if (left.sequenceId !== right.sequenceId) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linked clips must belong to the same sequence', 422, { reason: 'AV_LINK_INVALID' });
          }
          const leftTrack = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: left.trackId });
          const rightTrack = await loadTrackOwned(tx, { workspaceId: input.workspaceId, projectId: input.projectId, trackId: right.trackId });
          if (leftTrack.kind === rightTrack.kind) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'AV link requires one video clip and one audio clip', 422, { reason: 'AV_LINK_INVALID' });
          }
          if (compareFraction(rangeDuration(mediaRangeSchema.parse(left.sequenceRange)), rangeDuration(mediaRangeSchema.parse(right.sequenceRange))) !== 0) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'linked clips must have equal durations', 422, { reason: 'AV_LINK_DURATION_MISMATCH' });
          }
          const linkedGroupId = `avgp_${randomUUID()}`;
          for (const row of rows) {
            const beforeClip = clipSnapshot(row);
            await tx.update(sequenceClips).set({ avGroupId: linkedGroupId, updatedAt: now }).where(eq(sequenceClips.id, row.id));
            eventDrafts.push({ action: 'SET_AV_LINK', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, clipId: row.id, after: clipSnapshot({ ...row, avGroupId: linkedGroupId, updatedAt: now }), before: beforeClip } });
          }
          break;
        }

        case 'trim_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT', 'DURATION', 'POSITION'] });
          const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
          const sequenceRange = mediaRangeSchema.parse(operation.sequenceRange);
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          if (!identityForwardMapping(row)) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trim requires a 1:1 forward clip mapping', 422, { reason: 'TRIM_UNSUPPORTED_MAPPING' });
          }
          if (compareFraction(rangeDuration(sourceRange), rangeDuration(sequenceRange)) !== 0) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trim must keep source and sequence durations equal', 422, { reason: 'TRIM_RANGE_DURATION_MISMATCH' });
          }
          await assertSourceRangeUsable(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId, range: sourceRange,
          });
          const candidate = ticksInRange(sequenceRange, timebase);
          if (candidate.end > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'trimmed range exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          const siblings = await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row });
          await assertNoTrackOverlap(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: row.trackId, timebase,
            candidate, excludeClipIds: [row.id, ...siblings.map((sibling) => sibling.id)],
          });
          const trimSeconds = rangeDuration(sequenceRange);
          for (const region of await clipBoundAudioRegions(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, clipId: row.id })) {
            const binding = region.timeBinding as { basis?: string };
            const localRange = mediaRangeSchema.parse(region.localRange);
            if (binding.basis === 'SOURCE' || compareFraction(rangeDuration(localRange), trimSeconds) > 0) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region is invalidated by this trim', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
            }
          }
          const before = clipSnapshot(row);
          const after = clipSnapshot({ ...row, sourceRange, sequenceRange, updatedAt: new Date() });
          await tx.update(sequenceClips).set({ sourceRange, sequenceRange, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'TRIM_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after } });
          // AV 同步：关联片段保持同一序列区间，源入点按同样时长前移。
          for (const sibling of siblings) {
            const siblingBefore = clipSnapshot(sibling);
            const siblingSource = mediaRangeSchema.parse(sibling.sourceRange);
            const siblingTimebase = siblingSource.start.timebase;
            const siblingStartTicks = exactTicks(timeFraction(siblingSource.start), siblingTimebase);
            // 裁剪时长以秒分数表示，交 exactTicks 换算到关联片段的源时基（不要再乘一遍时基）。
            const trimSourceTicks = exactTicks(trimSeconds, siblingTimebase);
            const nextSibling = { ...sibling, sequenceRange, sourceRange: mediaRangeSchema.parse({
              start: siblingSource.start, end: mediaTimeOf(siblingStartTicks + trimSourceTicks, siblingTimebase),
            }), updatedAt: new Date() };
            await tx.update(sequenceClips).set({ sequenceRange: nextSibling.sequenceRange, sourceRange: nextSibling.sourceRange, updatedAt: new Date() }).where(eq(sequenceClips.id, sibling.id));
            eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id, before: siblingBefore, after: clipSnapshot(nextSibling) } });
          }
          break;
        }

        case 'move_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          const targetTrackId = operation.trackId ?? row.trackId;
          const targetTrack = await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: targetTrackId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'TRACK', objectId: targetTrackId, dimensions: ['POSITION', 'DURATION'] });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['POSITION', 'TRACK'] });
          const { track: currentTrack } = { track: await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: row.trackId }) };
          if (currentTrack.kind !== targetTrack.kind) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'move_clip requires a track of the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
          }
          const sequenceRange = operation.sequenceRange === undefined ? mediaRangeSchema.parse(row.sequenceRange) : mediaRangeSchema.parse(operation.sequenceRange);
          const currentSpan = ticksInRange(row.sequenceRange, timebase);
          const candidate = ticksInRange(sequenceRange, timebase);
          if (candidate.end - candidate.start !== currentSpan.end - currentSpan.start) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'move_clip keeps duration; use trim_clip to change it', 422, { reason: 'MOVE_REQUIRES_EQUAL_DURATION' });
          }
          if (candidate.end > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'moved range exceeds sequence duration', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          const siblings = await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row });
          await assertNoTrackOverlap(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: targetTrackId, timebase,
            candidate, excludeClipIds: [row.id, ...siblings.map((sibling) => sibling.id)],
          });
          const deltaTicks = candidate.start - currentSpan.start;
          const before = clipSnapshot(row);
          const after = clipSnapshot({ ...row, trackId: targetTrackId, sequenceRange, updatedAt: new Date() });
          await tx.update(sequenceClips).set({ trackId: targetTrackId, sequenceRange, updatedAt: new Date() }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'MOVE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after } });
          // 绑定到该片段的音频区域：CLIP_LOCAL 基随片段平移（局部时钟不变）；其它基需要重算时钟（N03-06）→ fail-closed。
          for (const region of await clipBoundAudioRegions(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, clipId: row.id })) {
            const binding = region.timeBinding as { basis?: string };
            if (binding.basis !== 'CLIP_LOCAL') {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region has a non-local clock', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
            }
            const regionBefore = audioRegionSnapshot(region);
            const regionRange = mediaRangeSchema.parse(region.sequenceRange);
            const shifted = mediaRangeSchema.parse({
              start: mediaTimeOf(exactTicks(timeFraction(regionRange.start), timebase) + deltaTicks, timebase),
              end: mediaTimeOf(exactTicks(timeFraction(regionRange.end), timebase) + deltaTicks, timebase),
            });
            const regionAfter = audioRegionSnapshot({ ...region, sequenceRange: shifted, updatedAt: new Date() });
            await tx.update(compositionAudioRegions).set({ sequenceRange: shifted, updatedAt: new Date() }).where(eq(compositionAudioRegions.id, region.id));
            eventDrafts.push({ action: 'UPDATE_AUDIO_REGION', sceneId: null, objectKind: 'AUDIO_REGION', objectId: region.id, patch: { op: 'update_audio_region', audioRegionId: region.id, before: regionBefore, after: regionAfter } });
          }
          // AV 同步：关联片段按同一 delta 平移（跨轨移动时留在各自轨道上保持声画对齐）。
          for (const sibling of siblings) {
            const siblingBefore = clipSnapshot(sibling);
            const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
            const shifted = mediaRangeSchema.parse({
              start: mediaTimeOf(siblingSpan.start + deltaTicks, timebase), end: mediaTimeOf(siblingSpan.end + deltaTicks, timebase),
            });
            const nextSibling = { ...sibling, sequenceRange: shifted, updatedAt: new Date() };
            await tx.update(sequenceClips).set({ sequenceRange: shifted, updatedAt: new Date() }).where(eq(sequenceClips.id, sibling.id));
            eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id, before: siblingBefore, after: clipSnapshot(nextSibling) } });
          }
          break;
        }

        case 'duplicate_clip': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT', 'POSITION'] });
          const { durationTicks, timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId });
          const anchor = operation.afterClipId === null
            ? row
            : (await tx.select().from(sequenceClips).where(and(
              eq(sequenceClips.id, operation.afterClipId), eq(sequenceClips.workspaceId, input.workspaceId),
              eq(sequenceClips.projectId, input.projectId), eq(sequenceClips.sequenceId, row.sequenceId),
            )).limit(1))[0];
          if (anchor === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'anchor clip not found', 404);
          const anchorSpan = ticksInRange(anchor.sequenceRange, timebase);
          const siblingRows = await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row });
          const trackId = anchor.trackId;
          const anchorTrack = await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId });
          const ownTrack = await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: row.trackId });
          if (anchorTrack.kind !== ownTrack.kind) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate_clip requires an anchor on a track of the same kind', 422, { reason: 'TRACK_KIND_MISMATCH' });
          }
          const duration = ticksInRange(row.sequenceRange, timebase);
          const length = duration.end - duration.start;
          const candidate = { start: anchorSpan.end, end: anchorSpan.end + length };
          if (candidate.end > durationTicks) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate exceeds sequence duration（扩展序列属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          await assertNoTrackOverlap(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId, timebase,
            candidate, excludeClipIds: [row.id, ...siblingRows.map((sibling) => sibling.id)],
          });
          // 复制只新增时间线引用：源版本/二进制原件保持不变（不触碰 assets / asset_versions）。
          const copyId = operation.createdClipId ?? `clp_${randomUUID()}`;
          const newGroupId = row.avGroupId === null ? null : `avgp_${randomUUID()}`;
          const copyRange = mediaRangeSchema.parse({ start: mediaTimeOf(candidate.start, timebase), end: mediaTimeOf(candidate.end, timebase) });
          const copyRow = {
            id: copyId, workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId,
            assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId, sourceStreamId: row.sourceStreamId,
            sourceRange: mediaRangeSchema.parse(row.sourceRange), sequenceRange: copyRange, timeMapping: row.timeMapping,
            avGroupId: newGroupId, parentClipId: row.id, parameters: row.parameters, createdAt: new Date(), updatedAt: new Date(),
          };
          await tx.insert(sequenceClips).values(copyRow);
          eventDrafts.push({ action: 'DUPLICATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: copyRow.id, patch: { ...operation, after: clipSnapshot(copyRow) } });
          // AV 同步：关联的音频片段在同一位置复制一份，并组成新的关联对。
          if (newGroupId !== null) {
            for (const sibling of siblingRows) {
              const siblingTrack = await loadTrack(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: sibling.trackId });
              const siblingSpan = ticksInRange(sibling.sequenceRange, timebase);
              const siblingCandidate = { start: anchorSpan.end, end: anchorSpan.end + (siblingSpan.end - siblingSpan.start) };
              if (siblingCandidate.end > durationTicks) {
                throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'duplicate exceeds sequence duration（扩展序列属 N03-04）', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
              }
              await assertNoTrackOverlap(tx, {
                workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, trackId: siblingTrack.id, timebase,
                candidate: siblingCandidate, excludeClipIds: [sibling.id],
              });
              const siblingCopy = {
                ...copyRow, id: operation.createdAudioClipId ?? `clp_${randomUUID()}`, trackId: siblingTrack.id,
                sourceRange: mediaRangeSchema.parse(sibling.sourceRange),
                sequenceRange: mediaRangeSchema.parse({ start: mediaTimeOf(siblingCandidate.start, timebase), end: mediaTimeOf(siblingCandidate.end, timebase) }),
              };
              await tx.insert(sequenceClips).values(siblingCopy);
              eventDrafts.push({ action: 'INSERT_CLIP', sceneId: null, objectKind: 'CLIP', objectId: siblingCopy.id, patch: { op: 'insert_clip', clipId: siblingCopy.id, after: clipSnapshot(siblingCopy) } });
            }
          }
          break;
        }

        case 'replace_clip_source': {
          const { row } = await loadEditableClip(tx, { workspaceId: input.workspaceId, projectId: input.projectId, clipId: operation.clipId });
          await assertObjectLockAllows(tx, { workspaceId: input.workspaceId, projectId: input.projectId, objectKind: 'CLIP', objectId: row.id, dimensions: ['CONTENT', 'DURATION'] });
          const sourceRange = mediaRangeSchema.parse(operation.sourceRange);
          // 时长检查：替换源不得隐式改变片段在序列上的长度（改长度要用 trim_clip）。
          if (compareFraction(rangeDuration(sourceRange), rangeDuration(mediaRangeSchema.parse(row.sequenceRange))) !== 0) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'replacement source duration must match the clip duration', 422, { reason: 'SOURCE_DURATION_MISMATCH' });
          }
          await assertSourceRangeUsable(tx, {
            workspaceId: input.workspaceId, projectId: input.projectId, assetVersionId: operation.assetVersionId,
            nestedSequenceId: operation.nestedSequenceId, range: sourceRange,
          });
          // 源基音频区域：源时钟已变，需重算（N03-06）→ fail-closed。
          for (const region of await clipBoundAudioRegions(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: row.sequenceId, clipId: row.id })) {
            if ((region.timeBinding as { basis?: string }).basis === 'SOURCE') {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'clip-bound audio region follows the replaced source clock', 409, { reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED', audioRegionId: region.id });
            }
          }
          const before = clipSnapshot(row);
          const after = clipSnapshot({
            ...row, assetVersionId: operation.assetVersionId, nestedSequenceId: operation.nestedSequenceId,
            sourceStreamId: operation.sourceStreamId, sourceRange, updatedAt: new Date(),
          });
          await tx.update(sequenceClips).set({
            assetVersionId: operation.assetVersionId, nestedSequenceId: operation.nestedSequenceId,
            sourceStreamId: operation.sourceStreamId, sourceRange, updatedAt: new Date(),
          }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'REPLACE_CLIP_SOURCE', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after } });
          // AV 同步：关联片段换用同一新源，保持声画一致。
          for (const sibling of await avSiblingsOf(tx, { workspaceId: input.workspaceId, projectId: input.projectId, row })) {
            const siblingBefore = clipSnapshot(sibling);
            const siblingAfter = clipSnapshot({
              ...sibling, assetVersionId: operation.assetVersionId, nestedSequenceId: operation.nestedSequenceId,
              sourceStreamId: operation.sourceStreamId, sourceRange, updatedAt: new Date(),
            });
            await tx.update(sequenceClips).set({
              assetVersionId: operation.assetVersionId, nestedSequenceId: operation.nestedSequenceId,
              sourceStreamId: operation.sourceStreamId, sourceRange, updatedAt: new Date(),
            }).where(eq(sequenceClips.id, sibling.id));
            eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: sibling.id, patch: { op: 'update_clip', clipId: sibling.id, before: siblingBefore, after: siblingAfter } });
          }
          break;
        }

        case 'update_clip': {
          const rows = await tx.select().from(sequenceClips).where(and(
            eq(sequenceClips.id, operation.clipId),
            eq(sequenceClips.workspaceId, input.workspaceId),
            eq(sequenceClips.projectId, input.projectId),
          )).limit(1);
          const row = rows[0];
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip not found', 404);
          const before = clipSnapshot(row);
          const candidate = clipSnapshot({ ...row, ...operation.changes, updatedAt: new Date() });
          const trackRows = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.id, candidate.trackId),
            eq(sequenceTracks.workspaceId, input.workspaceId),
            eq(sequenceTracks.projectId, input.projectId),
            eq(sequenceTracks.sequenceId, row.sequenceId),
          )).limit(1);
          const track = trackRows[0];
          if (!track) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip track not found', 404);
          if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
          const sequenceRows = await tx.select().from(projectSequences).where(and(
            eq(projectSequences.id, row.sequenceId),
            eq(projectSequences.workspaceId, input.workspaceId),
            eq(projectSequences.projectId, input.projectId),
          )).limit(1);
          const sequence = sequenceRows[0];
          if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'clip sequence not found', 404);
          const zero = { ticks: '0', timebase: candidate.sequenceRange.start.timebase };
          if (compareMediaTime(candidate.sequenceRange.start, zero) < 0 || compareMediaTime(candidate.sequenceRange.end, mediaTimeSchema.parse(sequence.duration)) > 0) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip sequence range exceeds sequence bounds', 422, { reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' });
          }
          if (candidate.assetVersionId !== null) {
            const sourceRows = await tx.select({
              durationMs: assetVersions.durationMs,
              status: assetVersions.status,
              checksumSha256: assetVersions.checksumSha256,
            }).from(assetVersions).where(and(
              eq(assetVersions.id, candidate.assetVersionId), eq(assetVersions.workspaceId, input.workspaceId),
            )).limit(1);
            const source = sourceRows[0];
            if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset version not found', 404);
            if (source.status !== 'READY' || source.durationMs === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version is not ready with known duration', 409);
            if (source.checksumSha256 === null) {
              throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'asset version has no immutable checksum', 409, { reason: 'SOURCE_CHECKSUM_MISSING' });
            }
            if (compareMediaTime(candidate.sourceRange.start, { ticks: '0', timebase: candidate.sourceRange.start.timebase }) < 0 || compareMediaTime(candidate.sourceRange.end, legacyMillisecondsToMediaTime(source.durationMs)) > 0) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds asset duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
            }
          } else if (candidate.nestedSequenceId !== null) {
            const nestedRows = await tx.select({ duration: projectSequences.duration }).from(projectSequences).where(and(
              eq(projectSequences.id, candidate.nestedSequenceId), eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId),
            )).limit(1);
            const nested = nestedRows[0];
            if (!nested || compareMediaTime(candidate.sourceRange.end, mediaTimeSchema.parse(nested.duration)) > 0) {
              throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'clip source range exceeds nested sequence duration', 422, { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' });
            }
          }
          if (candidate.parentClipId !== null) {
            const parent = await tx.select({ id: sequenceClips.id }).from(sequenceClips).where(and(
              eq(sequenceClips.id, candidate.parentClipId), eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId), eq(sequenceClips.sequenceId, row.sequenceId),
            )).limit(1);
            if (!parent[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'parent clip not found', 404);
          }
          assertLinearClipMapping(candidate.sourceRange, candidate.sequenceRange, candidate.timeMapping.rate);
          await tx.update(sequenceClips).set({
            trackId: candidate.trackId,
            sourceStreamId: candidate.sourceStreamId,
            sourceRange: candidate.sourceRange,
            sequenceRange: candidate.sequenceRange,
            timeMapping: candidate.timeMapping,
            avGroupId: candidate.avGroupId,
            parentClipId: candidate.parentClipId,
            updatedAt: new Date(),
          }).where(eq(sequenceClips.id, row.id));
          eventDrafts.push({ action: 'UPDATE_CLIP', sceneId: null, objectKind: 'CLIP', objectId: row.id, patch: { ...operation, before, after: candidate } });
          break;
        }

        case 'update_animation': {
          const rows = await tx.select().from(compositionAnimationBindings).where(and(
            eq(compositionAnimationBindings.id, operation.animationId),
            eq(compositionAnimationBindings.workspaceId, input.workspaceId),
            eq(compositionAnimationBindings.projectId, input.projectId),
          )).limit(1);
          const row = rows[0];
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'animation binding not found', 404);
          if (row.targetKind !== operation.targetKind || row.targetId !== operation.targetId) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'animation target does not match the stored binding', 409, { reason: 'ANIMATION_TARGET_MISMATCH' });
          }
          const before = animationSnapshot(row);
          const candidate = animationBindingSchema.parse({ ...before, keyframes: operation.keyframes });
          await assertAnimationKeyframesWithinTarget({ ...deps, db: tx as unknown as NodePgDatabase }, {
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            targetKind: candidate.targetKind,
            targetId: candidate.targetId,
            timeBinding: candidate.timeBinding,
            keyframes: candidate.keyframes,
          });
          await tx.update(compositionAnimationBindings).set({ keyframes: candidate.keyframes, updatedAt: new Date() }).where(eq(compositionAnimationBindings.id, row.id));
          eventDrafts.push({ action: 'UPDATE_ANIMATION', sceneId: null, objectKind: 'ANIMATION', objectId: row.id, patch: { ...operation, before, after: candidate } });
          break;
        }

        case 'apply_audio_crossfade': {
          const load = async (regionId: string) => {
            const rows = await tx.select().from(compositionAudioRegions).where(and(
              eq(compositionAudioRegions.id, regionId),
              eq(compositionAudioRegions.workspaceId, input.workspaceId),
              eq(compositionAudioRegions.projectId, input.projectId),
            )).limit(1);
            const row = rows[0];
            if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio region not found', 404);
            return row;
          };
          const left = await load(operation.leftRegionId);
          const right = await load(operation.rightRegionId);
          if (left.sequenceId !== right.sequenceId) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade requires both regions in the same sequence', 422, { reason: 'CROSSFADE_REGIONS_NOT_ADJACENT' });
          }
          const { timebase } = await loadSequenceTimebase(tx, { workspaceId: input.workspaceId, projectId: input.projectId, sequenceId: left.sequenceId });
          const leftSpan = ticksInRange(left.sequenceRange, timebase);
          const rightSpan = ticksInRange(right.sequenceRange, timebase);
          if (leftSpan.end !== rightSpan.start) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade requires adjacent regions (no gap, no overlap)', 422, { reason: 'CROSSFADE_REGIONS_NOT_ADJACENT' });
          }
          const durationTicks = exactTicks(timeFraction(mediaTimeSchema.parse(operation.duration)), timebase);
          const leftDuration = leftSpan.end - leftSpan.start;
          const rightDuration = rightSpan.end - rightSpan.start;
          if (durationTicks <= 0n || durationTicks > leftDuration || durationTicks > rightDuration) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'crossfade duration must fit both regions', 422, { reason: 'CROSSFADE_DURATION_OUT_OF_RANGE' });
          }
          const fade = mediaTimeOf(durationTicks, timebase);
          const now = new Date();
          for (const [row, changes] of [[left, { fadeOut: fade }], [right, { fadeIn: fade }]] as const) {
            const before = audioRegionSnapshot(row);
            const after = audioRegionSnapshot({ ...row, ...changes, updatedAt: now });
            await tx.update(compositionAudioRegions).set({ ...changes, updatedAt: now }).where(eq(compositionAudioRegions.id, row.id));
            eventDrafts.push({
              action: 'APPLY_AUDIO_CROSSFADE', sceneId: null, objectKind: 'AUDIO_REGION', objectId: row.id,
              patch: { ...operation, audioRegionId: row.id, before, after },
            });
          }
          break;
        }

        case 'update_audio_region': {
          // 原声保护：改源流或局部时间会改变语言内容，策略开启时拒绝（增益/淡入淡出/声像不受影响）。
          // 补偿路径（undo/redo）**不受限**：它是把工程恢复到此前已被接受的状态，不是新的内容改动。
          if (input.compensation === undefined) {
            await assertOriginalSpeechPreserved(tx, {
              workspaceId: input.workspaceId, projectId: input.projectId,
              touchesSourceClock: operation.changes.sourceStreamId !== undefined
                || operation.changes.localRange !== undefined
                || operation.changes.timeBinding !== undefined,
            });
          }
          const rows = await tx.select().from(compositionAudioRegions).where(and(
            eq(compositionAudioRegions.id, operation.audioRegionId),
            eq(compositionAudioRegions.workspaceId, input.workspaceId),
            eq(compositionAudioRegions.projectId, input.projectId),
          )).limit(1);
          const row = rows[0];
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio region not found', 404);
          const before = audioRegionSnapshot(row);
          const candidate = audioRegionSchema.parse({ ...before, ...operation.changes });
          const tracks = await tx.select().from(sequenceTracks).where(and(
            eq(sequenceTracks.id, candidate.trackId), eq(sequenceTracks.workspaceId, input.workspaceId), eq(sequenceTracks.projectId, input.projectId), eq(sequenceTracks.sequenceId, row.sequenceId),
          )).limit(1);
          const track = tracks[0];
          if (!track || track.kind !== 'AUDIO') throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'audio track not found', 404);
          if (track.locked) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'track is locked', 409, { reason: 'TRACK_LOCKED' });
          const sourceChannels = new Set(candidate.channelMapping.map((item) => item.sourceChannel));
          if (sourceChannels.size !== candidate.channelMapping.length) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'each source channel may be mapped once', 422, { reason: 'DUPLICATE_SOURCE_CHANNEL' });
          const duration = rangeDuration(candidate.localRange);
          const fade = (time: ReturnType<typeof mediaTimeSchema.parse>): Fraction => ({ num: BigInt(time.ticks) * BigInt(time.timebase.num), den: BigInt(time.timebase.den) });
          const fadeIn = fade(candidate.fadeIn);
          const fadeOut = fade(candidate.fadeOut);
          if ((fadeIn.num * fadeOut.den + fadeOut.num * fadeIn.den) * duration.den > duration.num * fadeIn.den * fadeOut.den) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'audio fades exceed the local region duration', 422, { reason: 'AUDIO_FADE_OUT_OF_BOUNDS' });
          }
          await tx.update(compositionAudioRegions).set({
            trackId: candidate.trackId,
            timeBinding: candidate.timeBinding,
            localRange: candidate.localRange,
            sequenceRange: candidate.sequenceRange,
            sourceStreamId: candidate.sourceStreamId,
            channelMapping: candidate.channelMapping,
            gainDb: String(candidate.gainDb),
            pan: String(candidate.pan),
            fadeIn: candidate.fadeIn,
            fadeOut: candidate.fadeOut,
            parameters: candidate.parameters,
            updatedAt: new Date(),
          }).where(eq(compositionAudioRegions.id, row.id));
          eventDrafts.push({ action: 'UPDATE_AUDIO_REGION', sceneId: null, objectKind: 'AUDIO_REGION', objectId: row.id, patch: { ...operation, before, after: candidate } });
          break;
        }

        case 'restore_scene': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          if (operation.toRevision === row.revision) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '场景已处于该 revision（无需恢复）', 409);
          }
          if (operation.toRevision > row.revision) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'toRevision 超出当前 revision', 409);
          }
          const events = await loadSceneEventsAsc();
          const target = replaySceneContent(events, row.id, operation.toRevision);
          if (target === null) {
            throw new ApiFailure(
              ERROR_CODES.PRECONDITION_FAILED,
              '无法重建指定 revision（缺少完整历史：场景可能早于事件记录创建）',
              409,
            );
          }
          const before = contentOf(row);
          // 内容与 Lock 一并恢复为目标 revision 的状态（当前行已在上面确认未锁定）
          applyContent(row, { ...target, locked: row.locked, status: target.status });
          row.locked = target.locked;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'RESTORE_SCENE',
            sceneId: row.id,
            patch: { ...operation, before, after: contentOf(row) },
          });
          break;
        }

        case 'restore_project_version': {
          const versionRows = await tx
            .select()
            .from(projectVersions)
            .where(
              and(
                eq(projectVersions.id, operation.versionId),
                eq(projectVersions.projectId, input.projectId),
                eq(projectVersions.workspaceId, input.workspaceId),
              ),
            )
            .limit(1);
          const versionRow = versionRows[0];
          if (!versionRow) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project version not found', 404);
          const snapshot = projectVersionSnapshotSchema.parse(versionRow.snapshot);
          const beforeVersionId = project.currentVersionId;
          await restoreNormalizedSnapshot(txDb, input, snapshot);
          const desiredScenes = snapshot.graph.scenes;
          const desiredIds = new Set(desiredScenes.map((scene) => scene.id));

          // 移除不在快照中的场景
          for (const row of [...ordered]) {
            if (!desiredIds.has(row.id)) {
              ordered.splice(
                ordered.findIndex((candidate) => candidate.id === row.id),
                1,
              );
              byId.delete(row.id);
              affectedSceneIds.add(row.id);
            }
          }

          // 按快照内容/顺序重建场景集
          const rebuilt: SceneRow[] = [];
          const recreatedScenes: { sceneId: string; after: SceneContentSnapshot }[] = [];
          for (const snapshotScene of desiredScenes) {
            const existing = byId.get(snapshotScene.id);
            const content = contentOfScene(snapshotScene);
            if (existing) {
              applyContent(existing, content);
              existing.revision += 1;
              dirtySceneIds.add(existing.id);
              affectedSceneIds.add(existing.id);
              rebuilt.push(existing);
            } else {
              const now = new Date();
              const recreated: SceneRow = {
                id: snapshotScene.id,
                workspaceId: input.workspaceId,
                projectId: input.projectId,
                revision: 1,
                position: 0,
                startMs: 0,
                durationMs: content.durationMs,
                semanticType: content.semanticType,
                sceneType: content.sceneType,
                narrationBlockIds: [...snapshotScene.narrationBlockIds],
                narration: content.narration,
                visualIntent: content.visualIntent,
                componentId: content.componentId,
                componentVersion: content.componentVersion,
                props: structuredClone(content.props),
                providerRequirement: content.providerRequirement === null ? null : structuredClone(content.providerRequirement),
                sourceBindings: structuredClone(content.sourceBindings),
                dataBindings: structuredClone(content.dataBindings),
                assetBindings: structuredClone(snapshotScene.assetBindings),
                transition: structuredClone(content.transition),
                locked: content.locked,
                approved: snapshotScene.approved,
                needsReview: snapshotScene.needsReview,
                status: content.status,
                createdAt: now,
                updatedAt: now,
              };
              byId.set(recreated.id, recreated);
              createdSceneIds.push(recreated.id);
              affectedSceneIds.add(recreated.id);
              recreatedScenes.push({ sceneId: recreated.id, after: contentOf(recreated) });
              rebuilt.push(recreated);
            }
          }
          ordered.splice(0, ordered.length, ...rebuilt);
          restoreSnapshotReason = 'RESTORE';
          eventDrafts.push({
            action: 'RESTORE_PROJECT_VERSION',
            sceneId: null,
            patch: { ...operation, beforeVersionId, recreatedScenes },
          });
          break;
        }

        case 'replace_asset': {
          requireExpectedOnce(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          if (operation.newAssetId !== null) {
            await assertAssetBindable(deps, {
              workspaceId: input.workspaceId,
              assetId: operation.newAssetId,
              projectId: input.projectId,
            });
          }
          const before = contentOf(row);
          const bindings = structuredClone(row.assetBindings) as { assetId: string; role: string }[];
          const index = bindings.findIndex((binding) => binding.role === operation.role);
          const beforeAssetId = index >= 0 ? (bindings[index]?.assetId ?? null) : null;
          if (operation.newAssetId === null) {
            if (index >= 0) bindings.splice(index, 1);
          } else if (index >= 0) {
            bindings[index] = { assetId: operation.newAssetId, role: operation.role };
          } else {
            bindings.push({ assetId: operation.newAssetId, role: operation.role });
          }
          row.assetBindings = bindings;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({
            action: 'REPLACE_ASSET',
            sceneId: row.id,
            patch: {
              ...operation,
              before,
              after: contentOf(row),
              beforeAssetId,
              afterAssetId: operation.newAssetId,
            },
          });
          break;
        }

        default: {
          throw new ApiFailure(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            `操作 ${(operation as EditOperation).op} 尚未接入处理器`,
            501,
          );
        }
      }
    }

    const now = new Date();

    // Persist only lock targets touched by this request. Candidate simulation has
    // already applied the complete ordered batch, including explicit unlocks.
    for (const target of touchedObjectLocks.values()) {
      const finalLock = candidateResult.locks.find((lock) => lock.objectKind === target.objectKind && lock.objectId === target.objectId);
      if (finalLock === undefined) {
        await tx.delete(projectObjectLocks).where(and(
          eq(projectObjectLocks.projectId, input.projectId),
          eq(projectObjectLocks.objectKind, target.objectKind),
          eq(projectObjectLocks.objectId, target.objectId),
        ));
      } else {
        await tx.insert(projectObjectLocks).values({
          id: `lck_${randomUUID()}`,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          objectKind: finalLock.objectKind,
          objectId: finalLock.objectId,
          dimensions: finalLock.dimensions,
          reason: finalLock.reason ?? null,
          createdAt: now,
          updatedAt: now,
        }).onConflictDoUpdate({
          target: [projectObjectLocks.projectId, projectObjectLocks.objectKind, projectObjectLocks.objectId],
          set: { dimensions: finalLock.dimensions, reason: finalLock.reason ?? null, updatedAt: now },
        });
      }
    }

    // 1) 脏 Scene 的条件更新（WHERE revision = 事务内读取值；行锁下必中，作为最终防线）
    for (const sceneId of dirtySceneIds) {
      const row = byId.get(sceneId);
      if (!row) continue;
      const initialRevision = initialRevisions.get(row.id);
      // New scenes are inserted below with their final candidate state.
      if (initialRevision === undefined) continue;
      const result = await tx
        .update(scenes)
        .set({
          narration: row.narration,
          visualIntent: row.visualIntent,
          sceneType: row.sceneType,
          semanticType: row.semanticType,
          durationMs: row.durationMs,
          componentId: row.componentId,
          componentVersion: row.componentVersion,
          props: row.props,
          providerRequirement: row.providerRequirement,
          transition: row.transition,
          sourceBindings: row.sourceBindings,
          dataBindings: row.dataBindings,
          assetBindings: row.assetBindings,
          locked: row.locked,
          status: row.status,
          revision: row.revision,
          updatedAt: now,
        })
        .where(and(eq(scenes.id, row.id), eq(scenes.revision, initialRevision)))
        .returning({ id: scenes.id });
      if (result.length === 0) {
        throw versionConflict('scene concurrent modification detected', project.revision, { [row.id]: row.revision });
      }
    }

    // 2) 删除已移除的 Scene
    const removedIds = sceneRows.filter((row) => !byId.has(row.id)).map((row) => row.id);
    if (removedIds.length > 0) {
      await tx.delete(scenes).where(inArray(scenes.id, removedIds));
    }

    // 3) 插入新 Scene 并统一重算 position/startMs（派生变化，不递增既有 Scene revision）
    const newSceneIds = new Set(createdSceneIds);
    let startMs = 0;
    for (const [index, row] of ordered.entries()) {
      const derivedChanged = row.position !== index || row.startMs !== startMs;
      if (newSceneIds.has(row.id)) {
        await tx.insert(scenes).values({ ...row, position: index, startMs });
      } else if (derivedChanged) {
        await tx.update(scenes).set({ position: index, startMs, updatedAt: now }).where(eq(scenes.id, row.id));
      }
      row.position = index;
      row.startMs = startMs;
      startMs += row.durationMs;
    }

    // 4) Project revision 原子递增（本次请求一次）
    const bumped = await tx
      .update(projects)
      .set({
        revision: project.revision + 1,
        updatedAt: now,
        title: project.title,
        targetDurationMs: project.targetDurationMs,
      })
      .where(eq(projects.id, input.projectId))
      .returning();
    const bumpedRow = bumped[0];
    if (!bumpedRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'project update failed', 500);

    // 5) EditEvent 逐操作落库（与状态、Outbox 同事务；补偿链路加前缀并记录指向）
    const eventRows: (typeof editEvents.$inferSelect)[] = [];
    for (const draft of eventDrafts) {
      const compensationPrefix =
        input.compensation === undefined ? '' : input.compensation.kind === 'UNDO' ? 'UNDO_' : 'REDO_';
      const patch: Record<string, unknown> = { ...draft.patch };
      if (input.compensation !== undefined) {
        patch['originalAction'] = input.compensation.originalAction;
      }
      if (input.compensation?.originalOperation !== undefined) {
        patch['originalOperation'] = input.compensation.originalOperation;
      }
      const inserted = await tx
        .insert(editEvents)
        .values({
          id: `evt_${randomUUID()}`,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sceneId: draft.sceneId,
          objectKind: draft.objectKind ?? (draft.sceneId === null ? null : 'SCENE'),
          objectId: draft.objectId ?? draft.sceneId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: `${compensationPrefix}${draft.action}`,
          compensatesEventId: input.compensation?.originalEventId ?? null,
          intentText: input.compensation?.intentText ?? request.intent ?? null,
          patch,
          baseRevision: request.baseProjectRevision,
          resultRevision: bumpedRow.revision,
          createdAt: now,
        })
        .returning();
      const eventRow = inserted[0];
      if (eventRow) eventRows.push(eventRow);
    }

    // 6) Outbox（同一事务；消费者为 P02-06 事件通道）
    await tx.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'project.updated',
      payload: {
        projectId: input.projectId,
        revision: bumpedRow.revision,
        operations: request.operations.map((op) => op.op),
        sceneIds: [...affectedSceneIds],
        objectRefs: eventDrafts.flatMap((draft) => {
          const objectKind = draft.objectKind ?? (draft.sceneId === null ? null : 'SCENE');
          const objectId = draft.objectId ?? draft.sceneId;
          return objectKind === null || objectId === null ? [] : [{ objectKind, objectId }];
        }),
        // 通知规则需要发起人（不通知本人）与补偿标记（撤销/重做聚合展示）
        actorId: input.actor.id,
        actorType: input.actor.type,
        ...(input.compensation !== undefined ? { compensation: input.compensation.kind } : {}),
      },
    });

    // 7) 自动快照（§23.2）：AI 重编导前（pre-apply 状态）；RESTORE 后与"每 N 事件"（post-apply）
    const postEventSeq = await currentEventSeq(txDb, input.projectId);
    if (input.actor.type === 'AI' && input.compensation === undefined) {
      const payload = await buildSnapshotPayload(txDb, preApplyProject, preApplyRows, { eventSeq: preApplyEventSeq });
      const versionRows = await tx
        .select({ max: sql<number>`coalesce(max(${projectVersions.versionNumber}), 0)` })
        .from(projectVersions)
        .where(eq(projectVersions.projectId, input.projectId));
      const versionNumber = Number(versionRows[0]?.max ?? 0) + 1;
      const versionId = `pv_${randomUUID()}`;
      await tx.insert(projectVersions).values({
        id: versionId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        versionNumber,
        snapshot: payload,
        reason: 'AI_REDIRECT',
        note: 'AI 重编导前自动快照',
        // createdBy 指向真实用户（外键到 user）；AI/SYSTEM 触发时为空（发起人可经 EditEvent.actorId 追溯）
        createdBy: null,
      });
      await tx.update(projects).set({ currentVersionId: versionId }).where(eq(projects.id, input.projectId));
    }

    let shouldSnapshot = restoreSnapshotReason !== null;
    let snapshotReason: string = restoreSnapshotReason ?? 'AUTO_EVERY_N_EVENTS';
    if (!shouldSnapshot) {
      const interval = deps.autoSnapshotEveryEvents ?? AUTO_SNAPSHOT_INTERVAL;
      const latestVersionRows = await tx
        .select()
        .from(projectVersions)
        .where(eq(projectVersions.projectId, input.projectId))
        .orderBy(desc(projectVersions.versionNumber))
        .limit(1);
      const latest = latestVersionRows[0];
      const watermark =
        latest === undefined ? 0 : Number(projectVersionSnapshotSchema.parse(latest.snapshot).meta['eventSeq'] ?? 0);
      const countRows = await tx
        .select({ count: sql<number>`count(*)::int` })
        .from(editEvents)
        .where(and(eq(editEvents.projectId, input.projectId), gt(editEvents.seq, watermark)));
      if (Number(countRows[0]?.count ?? 0) >= interval) {
        shouldSnapshot = true;
        snapshotReason = 'AUTO_EVERY_N_EVENTS';
      }
    }
    if (shouldSnapshot) {
      const payload = await buildSnapshotPayload(txDb, bumpedRow, ordered, { eventSeq: postEventSeq });
      const versionRows = await tx
        .select({ max: sql<number>`coalesce(max(${projectVersions.versionNumber}), 0)` })
        .from(projectVersions)
        .where(eq(projectVersions.projectId, input.projectId));
      const versionNumber = Number(versionRows[0]?.max ?? 0) + 1;
      const versionId = `pv_${randomUUID()}`;
      await tx.insert(projectVersions).values({
        id: versionId,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        versionNumber,
        snapshot: payload,
        reason: snapshotReason,
        note: snapshotReason === 'RESTORE' ? '恢复后自动快照' : `每 ${String(deps.autoSnapshotEveryEvents ?? AUTO_SNAPSHOT_INTERVAL)} 个编辑事件自动快照`,
        createdBy: null,
      });
      await tx.update(projects).set({ currentVersionId: versionId }).where(eq(projects.id, input.projectId));
    }

    return { project: bumpedRow, sceneRows: ordered, events: eventRows, createdSceneIds };
  });
}

export async function processEdits(deps: DomainDeps, input: ProcessEditsInput): Promise<ProcessEditsResult> {
  const request = editRequestSchema.parse(input.request);
  assertProjectApiSchemaVersion(request.schemaVersion);

  await assertLegacyProjectWriteAllowed(deps, input);

  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

  // Fast candidate pass; the same simulation runs again under the project row lock.
  const [candidateRows, candidateLockRows] = await Promise.all([
    deps.db.select({ id: scenes.id, durationMs: scenes.durationMs, locked: scenes.locked })
      .from(scenes)
      .where(and(eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId))),
    deps.db.select().from(projectObjectLocks)
      .where(and(eq(projectObjectLocks.projectId, input.projectId), eq(projectObjectLocks.workspaceId, input.workspaceId))),
  ]);
  validateEditOperationCandidate({
    scenes: candidateRows,
    operations: request.operations,
    actorType: input.actor.type,
    projectId: input.projectId,
    locks: candidateLockRows.map((row) => ({
      objectKind: row.objectKind as ObjectLockKind,
      objectId: row.objectId,
      dimensions: parseLockDimensions(row.dimensions),
      reason: row.reason,
    })),
  });

  const result = await applyEditsInTransaction(deps, input, request);

  const response = editResponseSchema.parse({
    project: toProjectDto(result.project),
    scenes: result.sceneRows.map(toSceneDto),
    editEvents: result.events.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sceneId: row.sceneId,
      objectKind: row.objectKind,
      objectId: row.objectId,
      actorType: row.actorType,
      actorId: row.actorId,
      action: row.action,
      intentText: row.intentText,
      patch: row.patch,
      baseRevision: row.baseRevision,
      resultRevision: row.resultRevision,
      compensatesEventId: row.compensatesEventId,
      createdAt: row.createdAt.toISOString(),
    })),
  });

  return { response, createdSceneIds: result.createdSceneIds };
}
