import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  animationBindingSchema,
  assetRoleSchema,
  audioRegionSchema,
  clipSchema,
  mediaRangeSchema,
  mediaTimeSchema,
  captionSpanSchema,
  objectLockKindSchema,
  trackSchema,
  visualCropSchema,
  visualTransformSchema,
  type EditOperation,
  type EditRequest,
  type ObjectLockDimension,
} from '@ancs/contracts';
import { editEvents, projects, scenes } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { contentToChanges, processEdits, type ProcessEditsResult, type SceneContentSnapshot } from './edits.js';

/**
 * Undo / Redo（P02-03 / §4.8；规范 §23）。
 *
 * 语义（compensating events）：
 * - 历史不改写：撤销/重做都产生**新事件**（action 前缀 UNDO_/REDO_ + compensatesEventId），
 *   状态变化以新 revision 落库；
 * - 撤销目标 = 最近的"仍生效"事件（跳过补偿事件；已被撤销且未重做的事件不生效）；
 * - 重做 = 重新施加"最近一次撤销"所记录的原始操作（LIFO）；新的编辑会结束重做分支（§4.8）；
 * - 事件按 seq 定序（同一事务内多事件 createdAt 相同）。
 */

type Actor = { type: 'USER' | 'AI' | 'SYSTEM'; id: string | null };

interface EventRow {
  id: string;
  seq: number;
  action: string;
  sceneId: string | null;
  objectKind: string | null;
  objectId: string | null;
  patch: unknown;
  compensatesEventId: string | null;
}

/** EditEvent.patch 的已知字段（处理器写入；其余字段按事件类型可选读取）。 */
interface StoredPatch {
  before?: unknown;
  after?: unknown;
  afterSceneId?: unknown;
  sceneId?: unknown;
  tailSceneId?: unknown;
  toRevision?: unknown;
  atMs?: unknown;
  versionId?: unknown;
  beforeVersionId?: unknown;
  originalAction?: unknown;
  originalOperation?: unknown;
  role?: unknown;
  beforeAssetId?: unknown;
  afterAssetId?: unknown;
  /** N03-02 时间线原语：补丁即显式操作对象本身（含 clipId／范围／切分点等字段）。 */
  clipId?: unknown;
  at?: unknown;
  createdClipId?: unknown;
  createdAudioClipId?: unknown;
  afterClipId?: unknown;
  trackId?: unknown;
  sourceRange?: unknown;
  sequenceRange?: unknown;
  assetVersionId?: unknown;
  nestedSequenceId?: unknown;
  sourceStreamId?: unknown;
  /** N03-03 精剪：滑移/滑动/卷动/涟漪/J-L cut 的参数字段。 */
  offset?: unknown;
  leftClipId?: unknown;
  rightClipId?: unknown;
  videoClipId?: unknown;
  audioClipId?: unknown;
  kind?: unknown;
  action?: unknown;
  amount?: unknown;
  closeAcrossTracks?: unknown;
  createdVideoClipId?: unknown;
  /** N03-04 轨道与 AV 链接 */
  changes?: unknown;
  clipIds?: unknown;
  linked?: unknown;
  position?: unknown;
  track?: unknown;
  sequenceId?: unknown;
  restoreTrackId?: unknown;
  nonEmptyPolicy?: unknown;
  destinationTrackId?: unknown;
  /** N03-07 字幕 */
  atWordIndex?: unknown;
  wordFrom?: unknown;
  wordTo?: unknown;
  mode?: unknown;
  createdCaptionId?: unknown;
  createdCaption?: unknown;
  caption?: unknown;
  restoreCaptionId?: unknown;
  cutRange?: unknown;
  /** N03-06 crossfade */
  leftRegionId?: unknown;
  rightRegionId?: unknown;
  duration?: unknown;
  /** N03-05 变换参数 */
  transform?: unknown;
  crop?: unknown;
  opacity?: unknown;
}

interface SceneMeta {
  id: string;
  revision: number;
  locked: boolean;
}

const isCompensationAction = (action: string): boolean => action.startsWith('UNDO_') || action.startsWith('REDO_');

const NEEDS_EXPECTED = new Set(['update_scene', 'delete_scene', 'split_scene', 'set_scene_lock', 'restore_scene', 'replace_asset']);
const REQUIRES_UNLOCKED = new Set(['update_scene', 'delete_scene', 'split_scene', 'restore_scene', 'replace_asset']);

function eventPatch(event: EventRow): StoredPatch {
  const patch = event.patch;
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, `事件 ${event.id} 缺少可解析的 patch`, 500);
  }
  return patch as StoredPatch;
}

/** 生效分析：区分"仍生效"与"被撤销未重做"的事件。 */
function analyzeEvents(events: EventRow[]): { active: EventRow[]; undone: { event: EventRow; undo: EventRow }[] } {
  const references = new Map<string, EventRow[]>();
  for (const event of events) {
    if (event.compensatesEventId === null) continue;
    const list = references.get(event.compensatesEventId) ?? [];
    list.push(event);
    references.set(event.compensatesEventId, list);
  }

  const active: EventRow[] = [];
  const undone: { event: EventRow; undo: EventRow }[] = [];
  for (const event of events) {
    if (isCompensationAction(event.action)) continue;
    const undos = (references.get(event.id) ?? []).filter((ref) => ref.action.startsWith('UNDO_'));
    if (undos.length === 0) {
      active.push(event);
      continue;
    }
    const latestUndo = undos.reduce((a, b) => (b.seq > a.seq ? b : a));
    const redone = (references.get(latestUndo.id) ?? []).some((ref) => ref.action.startsWith('REDO_'));
    if (redone) active.push(event);
    else undone.push({ event, undo: latestUndo });
  }
  return { active, undone };
}

async function loadProjectRow(deps: DomainDeps, workspaceId: string, projectId: string) {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return row;
}

async function loadProjectEvents(deps: DomainDeps, projectId: string): Promise<EventRow[]> {
  return deps.db
    .select({
      id: editEvents.id,
      seq: editEvents.seq,
      action: editEvents.action,
      sceneId: editEvents.sceneId,
      objectKind: editEvents.objectKind,
      objectId: editEvents.objectId,
      patch: editEvents.patch,
      compensatesEventId: editEvents.compensatesEventId,
    })
    .from(editEvents)
    .where(eq(editEvents.projectId, projectId))
    .orderBy(asc(editEvents.seq));
}

async function loadSceneMeta(deps: DomainDeps, workspaceId: string, projectId: string): Promise<Map<string, SceneMeta>> {
  const rows = await deps.db
    .select({ id: scenes.id, revision: scenes.revision, locked: scenes.locked })
    .from(scenes)
    .where(and(eq(scenes.projectId, projectId), eq(scenes.workspaceId, workspaceId)));
  return new Map(rows.map((row) => [row.id, row]));
}

const requireScene = (meta: Map<string, SceneMeta>, sceneId: string): SceneMeta => {
  const found = meta.get(sceneId);
  if (!found) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '目标场景已不存在，无法执行该操作', 409, { sceneId });
  }
  return found;
};

type SceneDraft = Extract<EditOperation, { op: 'insert_scene' }>['sceneDraft'];

const draftFromContent = (content: SceneContentSnapshot): SceneDraft => ({
  sceneType: content.sceneType,
  semanticType: content.semanticType,
  narration: content.narration,
  visualIntent: content.visualIntent,
  durationMs: content.durationMs,
  componentId: content.componentId,
  componentVersion: content.componentVersion,
  props: structuredClone(content.props),
  providerRequirement:
    content.providerRequirement === null
      ? null
      : (structuredClone(content.providerRequirement) as SceneDraft['providerRequirement']),
  sourceBindings: structuredClone(content.sourceBindings) as SceneDraft['sourceBindings'],
  dataBindings: structuredClone(content.dataBindings) as SceneDraft['dataBindings'],
  assetBindings: structuredClone(content.assetBindings),
  narrationBlockIds: content.narrationBlockIds ?? [],
  locked: content.locked,
});

/** 内容类事件的逆操作：必要时先解锁（锁定场景只允许显式解锁操作），再恢复内容/锁定状态。 */
function sceneContentUndo(sceneId: string, before: SceneContentSnapshot, meta: Map<string, SceneMeta>): EditOperation[] {
  const current = requireScene(meta, sceneId);
  const operations: EditOperation[] = [];
  if (current.locked) operations.push({ op: 'set_scene_lock', sceneId, locked: false });
  operations.push({ op: 'update_scene', sceneId, changes: contentToChanges(before) });
  if (before.locked) operations.push({ op: 'set_scene_lock', sceneId, locked: true });
  return operations;
}

/** 事件 → 可重放的原始操作（写入 UNDO 事件 patch.originalOperation，供重做重新施加）。 */
function reconstructOperation(event: EventRow): EditOperation | undefined {
  const patch = eventPatch(event);
  switch (event.action) {
    case 'UPDATE_PROJECT': {
      const after = patch.after as { title: string; targetDurationMs: number | null };
      return { op: 'update_project', changes: { title: after.title, targetDurationMs: after.targetDurationMs } };
    }
    case 'UPDATE_SCENE': {
      const after = patch.after as SceneContentSnapshot;
      return { op: 'update_scene', sceneId: event.sceneId ?? '', changes: contentToChanges(after) };
    }
    case 'RESTORE_SCENE':
      return { op: 'restore_scene', sceneId: event.sceneId ?? '', toRevision: patch.toRevision as number };
    case 'SET_SCENE_LOCK':
      return { op: 'set_scene_lock', sceneId: event.sceneId ?? '', locked: (patch.after as { locked: boolean }).locked };
    case 'SET_OBJECT_LOCK': {
      const after = patch.after as { dimensions: ObjectLockDimension[]; reason: string | null } | null;
      const dimensions = after?.dimensions ?? (patch.before as { dimensions: ObjectLockDimension[] } | null)?.dimensions ?? [];
      if (dimensions.length === 0) return undefined;
      return {
        op: 'set_object_lock',
        objectKind: objectLockKindSchema.parse((patch as { objectKind?: unknown }).objectKind),
        objectId: event.objectId ?? String((patch as { objectId?: unknown }).objectId ?? ''),
        locked: after !== null,
        dimensions,
        ...(after?.reason !== undefined ? { reason: after.reason } : {}),
      };
    }
    case 'INSERT_CLIP': {
      // 原操作（供 Redo 重放）：按 patch.after 原样重建同一 id 的片段。
      const after = clipSchema.parse(patch.after);
      return {
        op: 'insert_clip',
        sequenceId: after.sequenceId,
        trackId: after.trackId,
        assetVersionId: after.assetVersionId,
        nestedSequenceId: after.nestedSequenceId,
        sourceStreamId: after.sourceStreamId,
        sourceRange: after.sourceRange,
        mode: 'INSERT',
        sequenceStart: after.sequenceRange.start,
        linkAudio: false,
        audioTrackId: null,
        restoreClipId: event.objectId ?? after.id,
      };
    }
    case 'DELETE_CLIP':
      return { op: 'delete_clip', clipId: event.objectId ?? '' };
    case 'SPLIT_CLIP': {
      // 原操作（供 Redo 重放）：补丁里保留了原切分参数与两段 id，重放同一 id 保持引用稳定。
      return {
        op: 'split_clip',
        clipId: String(patch.clipId ?? event.objectId ?? ''),
        at: mediaTimeSchema.parse(patch.at),
        ...(patch.createdClipId === undefined ? {} : { createdClipId: String(patch.createdClipId) }),
        ...(patch.createdAudioClipId === undefined ? {} : { createdAudioClipId: String(patch.createdAudioClipId) }),
      };
    }
    case 'TRIM_CLIP':
      return {
        op: 'trim_clip',
        clipId: String(patch.clipId ?? event.objectId ?? ''),
        sourceRange: mediaRangeSchema.parse(patch.sourceRange),
        sequenceRange: mediaRangeSchema.parse(patch.sequenceRange),
      };
    case 'MOVE_CLIP':
      return {
        op: 'move_clip',
        clipId: String(patch.clipId ?? event.objectId ?? ''),
        ...(patch.trackId === undefined ? {} : { trackId: String(patch.trackId) }),
        ...(patch.sequenceRange === undefined ? {} : { sequenceRange: mediaRangeSchema.parse(patch.sequenceRange) }),
      };
    case 'DUPLICATE_CLIP':
      return {
        op: 'duplicate_clip',
        clipId: String(patch.clipId ?? ''),
        afterClipId: patch.afterClipId == null ? null : String(patch.afterClipId),
        ...(patch.createdClipId === undefined ? {} : { createdClipId: String(patch.createdClipId) }),
        ...(patch.createdAudioClipId === undefined ? {} : { createdAudioClipId: String(patch.createdAudioClipId) }),
      };
    case 'REPLACE_CLIP_SOURCE':
      return {
        op: 'replace_clip_source',
        clipId: String(patch.clipId ?? event.objectId ?? ''),
        assetVersionId: patch.assetVersionId == null ? null : String(patch.assetVersionId),
        nestedSequenceId: patch.nestedSequenceId == null ? null : String(patch.nestedSequenceId),
        sourceStreamId: patch.sourceStreamId == null ? null : String(patch.sourceStreamId),
        sourceRange: mediaRangeSchema.parse(patch.sourceRange),
      };
    case 'SLIP_CLIP':
      return { op: 'slip_clip', clipId: String(patch.clipId ?? event.objectId ?? ''), sourceRange: mediaRangeSchema.parse(patch.sourceRange) };
    case 'SLIDE_CLIP':
      return { op: 'slide_clip', clipId: String(patch.clipId ?? event.objectId ?? ''), offset: mediaTimeSchema.parse(patch.offset) };
    case 'ROLL_CLIP':
      return {
        op: 'roll_clip',
        leftClipId: String(patch.leftClipId ?? ''),
        rightClipId: String(patch.rightClipId ?? ''),
        at: mediaTimeSchema.parse(patch.at),
      };
    case 'RIPPLE_CLIP': {
      const action = patch.action;
      return {
        op: 'ripple_clip',
        clipId: String(patch.clipId ?? event.objectId ?? ''),
        action: action === 'TRIM_HEAD' || action === 'TRIM_TAIL' ? action : 'DELETE',
        amount: patch.amount === null || patch.amount === undefined ? null : mediaTimeSchema.parse(patch.amount),
        closeAcrossTracks: patch.closeAcrossTracks !== false,
      };
    }
    case 'SPLIT_AV_CUT':
      return {
        op: 'split_av_cut',
        videoClipId: String(patch.videoClipId ?? ''),
        audioClipId: String(patch.audioClipId ?? ''),
        at: mediaTimeSchema.parse(patch.at),
        offset: mediaTimeSchema.parse(patch.offset),
        kind: patch.kind === 'L' ? 'L' : 'J',
        ...(patch.createdVideoClipId === undefined ? {} : { createdVideoClipId: String(patch.createdVideoClipId) }),
        ...(patch.createdAudioClipId === undefined ? {} : { createdAudioClipId: String(patch.createdAudioClipId) }),
      };
    case 'CREATE_TRACK':
      return {
        op: 'create_track',
        sequenceId: String(patch.sequenceId ?? ''),
        track: patch.track as { kind: 'VIDEO' | 'AUDIO' | 'GRAPHIC' | 'CAPTION'; position: number; name: string },
        restoreTrackId: String(patch.restoreTrackId ?? event.objectId ?? ''),
      };
    case 'MOVE_TRACK':
      return { op: 'move_track', trackId: String(patch.trackId ?? event.objectId ?? ''), position: Number(patch.position ?? 0) };
    case 'DELETE_TRACK': {
      const before = trackSchema.parse(patch.before);
      return {
        op: 'delete_track',
        trackId: before.id,
        nonEmptyPolicy: patch.nonEmptyPolicy === 'MOVE_CLIPS' ? 'MOVE_CLIPS' : 'REJECT',
        destinationTrackId: patch.destinationTrackId == null ? null : String(patch.destinationTrackId),
      };
    }
    case 'UPDATE_TRACK': {
      const changes = (patch.changes ?? {}) as Record<string, unknown>;
      const before = trackSchema.parse(patch.before);
      const next: Record<string, unknown> = {};
      for (const key of ['name', 'position', 'locked', 'muted', 'hidden', 'solo', 'syncLocked'] as const) {
        const value = changes[key];
        if (value !== undefined) next[key] = key === 'name' ? before.name : value;
      }
      return { op: 'update_track', trackId: String(patch.trackId ?? event.objectId ?? ''), changes: next as never };
    }
    case 'SET_AV_LINK': {
      const before = clipSchema.parse(patch.before);
      return { op: 'set_av_link', linked: patch.linked === true, clipIds: [before.id] };
    }
    case 'APPLY_AUDIO_CROSSFADE':
      return {
        op: 'apply_audio_crossfade',
        leftRegionId: String(patch.leftRegionId ?? ''),
        rightRegionId: String(patch.rightRegionId ?? ''),
        duration: mediaTimeSchema.parse(patch.duration),
      };
    case 'UPDATE_CAPTION': {
      const after = captionSpanSchema.parse(patch.after);
      return { op: 'update_caption', captionId: after.id, changes: { text: after.text, style: after.style, sequenceRange: after.sequenceRange, words: after.words } };
    }
    case 'SPLIT_CAPTION': {
      const after = captionSpanSchema.parse(patch.after);
      return {
        op: 'split_caption',
        captionId: after.id,
        atWordIndex: (patch.atWordIndex as number | undefined) ?? (after.words?.length ?? 1),
        createdCaptionId: String(patch.createdCaptionId ?? ''),
      };
    }
    case 'CUT_CAPTION_RANGE': {
      const after = captionSpanSchema.parse(patch.after);
      return {
        op: 'cut_caption_range',
        captionId: after.id,
        wordFrom: Number(patch.wordFrom ?? 0),
        wordTo: Number(patch.wordTo ?? 1),
        mode: patch.mode === 'CUT_CONTENT' ? 'CUT_CONTENT' : 'CAPTION_ONLY',
        closeAcrossTracks: patch.closeAcrossTracks !== false,
      };
    }
    case 'DELETE_CAPTION':
      return { op: 'delete_caption', captionId: event.objectId ?? '' };
    case 'SET_CLIP_TRANSFORM':
      return { op: 'set_clip_transform', clipId: String(patch.clipId ?? event.objectId ?? ''), transform: visualTransformSchema.parse(patch.transform) };
    case 'SET_CLIP_CROP':
      return { op: 'set_clip_crop', clipId: String(patch.clipId ?? event.objectId ?? ''), crop: visualCropSchema.parse(patch.crop) };
    case 'SET_CLIP_OPACITY':
      return { op: 'set_clip_opacity', clipId: String(patch.clipId ?? event.objectId ?? ''), opacity: Number(patch.opacity ?? 1) };
    case 'UPDATE_CLIP': {
      const after = clipSchema.parse(patch.after);
      return { op: 'update_clip', clipId: after.id, changes: {
        trackId: after.trackId,
        sourceStreamId: after.sourceStreamId,
        sourceRange: after.sourceRange,
        sequenceRange: after.sequenceRange,
        timeMapping: after.timeMapping,
        avGroupId: after.avGroupId,
        parentClipId: after.parentClipId,
      } };
    }
    case 'UPDATE_ANIMATION': {
      const after = animationBindingSchema.parse(patch.after);
      return { op: 'update_animation', animationId: after.id, targetKind: after.targetKind, targetId: after.targetId, keyframes: after.keyframes };
    }
    case 'UPDATE_AUDIO_REGION': {
      const after = audioRegionSchema.parse(patch.after);
      return { op: 'update_audio_region', audioRegionId: after.id, changes: {
        trackId: after.trackId,
        timeBinding: after.timeBinding,
        localRange: after.localRange,
        sequenceRange: after.sequenceRange,
        sourceStreamId: after.sourceStreamId,
        channelMapping: after.channelMapping,
        gainDb: after.gainDb,
        pan: after.pan,
        fadeIn: after.fadeIn,
        fadeOut: after.fadeOut,
        parameters: after.parameters,
      } };
    }
    case 'INSERT_SCENE':
      return {
        op: 'insert_scene',
        afterSceneId: (patch.afterSceneId as string | null | undefined) ?? null,
        sceneDraft: draftFromContent(patch.after as SceneContentSnapshot),
        // 复用原 id：Redo 重新插入后与既有历史事件、绑定引用保持一致
        restoreSceneId: event.sceneId ?? undefined,
      };
    case 'DUPLICATE_SCENE':
      return {
        op: 'duplicate_scene',
        sceneId: patch.sceneId as string,
        afterSceneId: (patch.afterSceneId as string | null | undefined) ?? null,
        restoreSceneId: event.sceneId ?? undefined,
      };
    case 'DELETE_SCENE':
      return { op: 'delete_scene', sceneId: event.sceneId ?? '' };
    case 'SPLIT_SCENE':
      return {
        op: 'split_scene',
        sceneId: event.sceneId ?? '',
        atMs: patch.atMs as number,
        restoreTailSceneId: patch.tailSceneId as string,
      };
    case 'REORDER_SCENES':
      return { op: 'reorder_scenes', orderedSceneIds: (patch.after as { order: string[] }).order };
    case 'RESTORE_PROJECT_VERSION':
      return { op: 'restore_project_version', versionId: patch.versionId as string };
    case 'REPLACE_ASSET':
      return {
        op: 'replace_asset',
        sceneId: event.sceneId ?? '',
        role: assetRoleSchema.parse(patch.role),
        newAssetId: (patch.afterAssetId as string | null | undefined) ?? null,
      };
    default:
      return undefined;
  }
}

/** 事件 → 逆操作集合。 */
function planUndo(event: EventRow, meta: Map<string, SceneMeta>): EditOperation[] {
  const patch = eventPatch(event);
  switch (event.action) {
    case 'UPDATE_PROJECT': {
      const before = patch.before as { title: string; targetDurationMs: number | null };
      return [{ op: 'update_project', changes: { title: before.title, targetDurationMs: before.targetDurationMs } }];
    }
    case 'UPDATE_SCENE':
    case 'RESTORE_SCENE':
      return sceneContentUndo(event.sceneId ?? '', patch.before as SceneContentSnapshot, meta);

    case 'SET_SCENE_LOCK': {
      const sceneId = event.sceneId ?? '';
      requireScene(meta, sceneId);
      return [{ op: 'set_scene_lock', sceneId, locked: (patch.before as { locked: boolean }).locked }];
    }

    case 'SET_OBJECT_LOCK': {
      const before = patch.before as { dimensions: ObjectLockDimension[]; reason: string | null } | null;
      const after = patch.after as { dimensions: ObjectLockDimension[]; reason: string | null } | null;
      const objectKind = objectLockKindSchema.parse((patch as { objectKind?: unknown }).objectKind);
      const objectId = event.objectId ?? String((patch as { objectId?: unknown }).objectId ?? '');
      const operations: EditOperation[] = [];
      if (after !== null) operations.push({ op: 'set_object_lock', objectKind, objectId, locked: false, dimensions: after.dimensions });
      if (before !== null) operations.push({ op: 'set_object_lock', objectKind, objectId, locked: true, dimensions: before.dimensions, reason: before.reason });
      return operations;
    }

    case 'UPDATE_CLIP': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: {
        trackId: before.trackId,
        sourceStreamId: before.sourceStreamId,
        sourceRange: before.sourceRange,
        sequenceRange: before.sequenceRange,
        timeMapping: before.timeMapping,
        avGroupId: before.avGroupId,
        parentClipId: before.parentClipId,
      } }];
    }

    case 'UPDATE_ANIMATION': {
      const before = animationBindingSchema.parse(patch.before);
      return [{ op: 'update_animation', animationId: before.id, targetKind: before.targetKind, targetId: before.targetId, keyframes: before.keyframes }];
    }

    case 'UPDATE_AUDIO_REGION': {
      const before = audioRegionSchema.parse(patch.before);
      return [{ op: 'update_audio_region', audioRegionId: before.id, changes: {
        trackId: before.trackId,
        timeBinding: before.timeBinding,
        localRange: before.localRange,
        sequenceRange: before.sequenceRange,
        sourceStreamId: before.sourceStreamId,
        channelMapping: before.channelMapping,
        gainDb: before.gainDb,
        pan: before.pan,
        fadeIn: before.fadeIn,
        fadeOut: before.fadeOut,
        parameters: before.parameters,
      } }];
    }

    case 'INSERT_CLIP': {
      // 逆操作：删除该事件插入的片段（AV 关联的音频片段有自己的事件，按事件粒度逐个撤销）。
      const objectId = event.objectId ?? String((patch as { objectId?: unknown }).objectId ?? '');
      return [{ op: 'delete_clip', clipId: objectId }];
    }
    case 'SPLIT_CLIP': {
      // 逆操作：把左段恢复成切分前的完整片段；右段由它自己的 INSERT_CLIP 事件删除（事件粒度）。
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: {
        sourceRange: before.sourceRange,
        sequenceRange: before.sequenceRange,
      } }];
    }
    case 'TRIM_CLIP': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: {
        sourceRange: before.sourceRange,
        sequenceRange: before.sequenceRange,
      } }];
    }
    case 'MOVE_CLIP': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: {
        trackId: before.trackId,
        sequenceRange: before.sequenceRange,
      } }];
    }
    case 'DUPLICATE_CLIP':
      // 逆操作：删除复制出来的片段（源二进制从未被触碰，无需回滚原件）。
      return [{ op: 'delete_clip', clipId: event.objectId ?? '' }];
    case 'UPDATE_CAPTION': {
      const before = captionSpanSchema.parse(patch.before);
      return [{ op: 'update_caption', captionId: before.id, changes: { text: before.text, style: before.style, sequenceRange: before.sequenceRange, words: before.words } }];
    }
    case 'SPLIT_CAPTION': {
      // 逆操作：左段恢复成切分前的整条；右段（同一次事件创建）按 id 删除。
      const before = captionSpanSchema.parse(patch.before);
      const createdCaptionId = String(patch.createdCaptionId ?? '');
      return [
        { op: 'update_caption', captionId: before.id, changes: { text: before.text, style: before.style, sequenceRange: before.sequenceRange, words: before.words } },
        { op: 'delete_caption', captionId: createdCaptionId },
      ];
    }
    case 'CUT_CAPTION_RANGE': {
      const before = captionSpanSchema.parse(patch.before);
      return [{ op: 'update_caption', captionId: before.id, changes: { text: before.text, style: before.style, sequenceRange: before.sequenceRange, words: before.words } } as never];
    }
    case 'DELETE_CAPTION': {
      const before = captionSpanSchema.parse(patch.before);
      return [{
        op: 'create_caption',
        sequenceId: before.sequenceId,
        trackId: before.trackId,
        timeBinding: before.timeBinding,
        localRange: before.localRange,
        sequenceRange: before.sequenceRange,
        text: before.text,
        languageTag: before.languageTag,
        style: before.style,
        words: before.words,
        speechAnchorId: before.speechAnchorId,
        restoreCaptionId: before.id,
      }];
    }
    case 'CREATE_CAPTION':
      // 逆操作：删除该事件创建的字幕（复原由 DELETE_CAPTION 的反向事件负责）
      return [{ op: 'delete_caption', captionId: event.objectId ?? '' }];
    case 'APPLY_AUDIO_CROSSFADE': {
      // 逆操作：把该区域自己的淡入/淡出恢复到交叉前的值（另一侧由它自己的事件恢复）。
      const before = audioRegionSchema.parse(patch.before);
      return [{ op: 'update_audio_region', audioRegionId: before.id, changes: { fadeIn: before.fadeIn, fadeOut: before.fadeOut } }];
    }
    case 'SET_CLIP_TRANSFORM': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'set_clip_transform', clipId: before.id, transform: (before.parameters ?? { transform: undefined }).transform ?? { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } }];
    }
    case 'SET_CLIP_CROP': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'set_clip_crop', clipId: before.id, crop: (before.parameters ?? { crop: undefined }).crop ?? { left: 0, top: 0, right: 0, bottom: 0 } }];
    }
    case 'SET_CLIP_OPACITY': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'set_clip_opacity', clipId: before.id, opacity: (before.parameters ?? { opacity: 1 }).opacity ?? 1 }];
    }
    case 'CREATE_TRACK':
      // 逆操作：删除新建轨道（非空时由调用方先处理片段，事件粒度）。
      return [{ op: 'delete_track', trackId: event.objectId ?? '', nonEmptyPolicy: 'REJECT', destinationTrackId: null }];
    case 'MOVE_TRACK': {
      const before = trackSchema.parse(patch.before);
      return [{ op: 'move_track', trackId: before.id, position: before.position }];
    }
    case 'DELETE_TRACK': {
      // 逆操作：按原 id/原状态重建轨道（片段由各自的 UPDATE_CLIP 事件回到本轨）。
      const before = trackSchema.parse(patch.before);
      return [{
        op: 'create_track',
        sequenceId: before.sequenceId,
        track: { kind: before.kind, position: before.position, name: before.name, locked: before.locked, muted: before.muted, hidden: before.hidden, solo: before.solo, syncLocked: before.syncLocked },
        restoreTrackId: before.id,
      }];
    }
    case 'UPDATE_TRACK': {
      const before = trackSchema.parse(patch.before);
      const changes = (patch.changes ?? {}) as Record<string, unknown>;
      const restored: Record<string, unknown> = {};
      for (const key of ['name', 'position', 'locked', 'muted', 'hidden', 'solo', 'syncLocked'] as const) {
        if (changes[key] !== undefined) restored[key] = before[key];
      }
      return [{ op: 'update_track', trackId: before.id, changes: restored as never }];
    }
    case 'SET_AV_LINK': {
      // 逆操作：恢复该片段原先的关联状态（含"解链后重新关联"）。
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: { avGroupId: before.avGroupId } }];
    }
    case 'SLIP_CLIP': {
      const before = clipSchema.parse(patch.before);
      return [{ op: 'slip_clip', clipId: before.id, sourceRange: before.sourceRange }];
    }
    case 'SLIDE_CLIP': {
      const before = clipSchema.parse(patch.before);
      const after = clipSchema.parse(patch.after);
      // 逆操作：反向滑动同样位移（邻居由各自的事件恢复）。
      const timebase = before.sequenceRange.start.timebase;
      const deltaTicks = BigInt(after.sequenceRange.start.ticks) - BigInt(before.sequenceRange.start.ticks);
      return [{ op: 'slide_clip', clipId: before.id, offset: { ticks: (-deltaTicks).toString(), timebase } }];
    }
    case 'ROLL_CLIP': {
      // 逆操作：回到原剪辑点。左段事件的 before.end 与右段事件的 before.start 都是原点。
      const before = clipSchema.parse(patch.before);
      const isLeft = String(patch.clipId ?? event.objectId ?? '') === String(patch.leftClipId ?? '');
      return [{
        op: 'roll_clip',
        leftClipId: String(patch.leftClipId ?? ''),
        rightClipId: String(patch.rightClipId ?? ''),
        at: isLeft ? before.sequenceRange.end : before.sequenceRange.start,
      }];
    }
    case 'RIPPLE_CLIP': {
      const before = clipSchema.parse(patch.before);
      if (patch.action === 'TRIM_HEAD' || patch.action === 'TRIM_TAIL') {
        return [{ op: 'update_clip', clipId: before.id, changes: { sourceRange: before.sourceRange, sequenceRange: before.sequenceRange } }];
      }
      // 涟漪删除的逆操作：把被删片段按原 id/原范围重建；被平移片段由各自事件回位。
      return [{
        op: 'insert_clip',
        sequenceId: before.sequenceId,
        trackId: before.trackId,
        assetVersionId: before.assetVersionId,
        nestedSequenceId: before.nestedSequenceId,
        sourceStreamId: before.sourceStreamId,
        sourceRange: before.sourceRange,
        mode: 'INSERT',
        sequenceStart: before.sequenceRange.start,
        linkAudio: false,
        audioTrackId: null,
        restoreClipId: before.id,
      }];
    }
    case 'SPLIT_AV_CUT': {
      // 逆操作：左段恢复成整段；右段由各自的 INSERT_CLIP 事件删除（事件粒度）。
      const before = clipSchema.parse(patch.before);
      return [{ op: 'update_clip', clipId: before.id, changes: { sourceRange: before.sourceRange, sequenceRange: before.sequenceRange } }];
    }
    case 'REPLACE_CLIP_SOURCE': {
      const before = clipSchema.parse(patch.before);
      return [{
        op: 'replace_clip_source',
        clipId: before.id,
        assetVersionId: before.assetVersionId,
        nestedSequenceId: before.nestedSequenceId,
        sourceStreamId: before.sourceStreamId,
        sourceRange: before.sourceRange,
      }];
    }
    case 'DELETE_CLIP': {
      const before = clipSchema.parse(patch.before);
      return [{
        op: 'insert_clip',
        sequenceId: before.sequenceId,
        trackId: before.trackId,
        assetVersionId: before.assetVersionId,
        nestedSequenceId: before.nestedSequenceId,
        sourceStreamId: before.sourceStreamId,
        sourceRange: before.sourceRange,
        mode: 'INSERT',
        sequenceStart: before.sequenceRange.start,
        linkAudio: false,
        audioTrackId: null,
        restoreClipId: before.id,
      }];
    }
    case 'INSERT_SCENE':
    case 'DUPLICATE_SCENE': {
      const sceneId = event.sceneId ?? '';
      const current = requireScene(meta, sceneId);
      const operations: EditOperation[] = [];
      if (current.locked) operations.push({ op: 'set_scene_lock', sceneId, locked: false });
      operations.push({ op: 'delete_scene', sceneId });
      return operations;
    }

    case 'DELETE_SCENE': {
      const before = patch.before as { content: SceneContentSnapshot; prevSceneId: string | null };
      const anchor = before.prevSceneId !== null && meta.has(before.prevSceneId) ? before.prevSceneId : null;
      return [
        {
          op: 'insert_scene',
          afterSceneId: anchor,
          sceneDraft: draftFromContent(before.content),
          // 复用原 id：撤销删除后场景身份不变（引用/历史事件保持有效）
          restoreSceneId: event.sceneId ?? undefined,
        },
      ];
    }

    case 'SPLIT_SCENE': {
      const sceneId = event.sceneId ?? '';
      const tailSceneId = patch.tailSceneId as string;
      const tail = requireScene(meta, tailSceneId);
      const operations: EditOperation[] = [];
      if (tail.locked) operations.push({ op: 'set_scene_lock', sceneId: tailSceneId, locked: false });
      operations.push({ op: 'delete_scene', sceneId: tailSceneId });
      operations.push(...sceneContentUndo(sceneId, patch.before as SceneContentSnapshot, meta));
      return operations;
    }

    case 'REORDER_SCENES':
      return [{ op: 'reorder_scenes', orderedSceneIds: (patch.before as { order: string[] }).order }];

    case 'REPLACE_ASSET': {
      const sceneId = event.sceneId ?? '';
      const current = requireScene(meta, sceneId);
      const operations: EditOperation[] = [];
      if (current.locked) operations.push({ op: 'set_scene_lock', sceneId, locked: false });
      operations.push({
        op: 'replace_asset',
        sceneId,
        role: assetRoleSchema.parse(patch.role),
        newAssetId: (patch.beforeAssetId as string | null | undefined) ?? null,
      });
      return operations;
    }

    case 'RESTORE_PROJECT_VERSION': {
      const beforeVersionId = (patch.beforeVersionId as string | null | undefined) ?? null;
      if (beforeVersionId === null) {
        throw new ApiFailure(
          ERROR_CODES.PRECONDITION_FAILED,
          '该恢复操作之前没有版本快照，无法撤销（恢复前后状态未记录为版本）',
          409,
        );
      }
      return [{ op: 'restore_project_version', versionId: beforeVersionId }];
    }

    default:
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `暂不支持撤销的操作：${event.action}`, 501, {
        action: event.action,
      });
  }
}

function buildExpected(operations: EditOperation[], meta: Map<string, SceneMeta>): Record<string, number> {
  const expected: Record<string, number> = {};
  for (const operation of operations) {
    if (!NEEDS_EXPECTED.has(operation.op)) continue;
    const sceneId = (operation as { sceneId: string }).sceneId;
    const found = meta.get(sceneId);
    if (found) expected[sceneId] = found.revision;
  }
  return expected;
}

/** 重做/施加前对锁定场景的防御性规范化（锁定的场景只允许显式解锁操作）。 */
function normalizeLockedTarget(operations: EditOperation[], meta: Map<string, SceneMeta>): EditOperation[] {
  const first = operations[0];
  if (first === undefined) return operations;
  if (!REQUIRES_UNLOCKED.has(first.op)) return operations;
  const sceneId = (first as { sceneId: string }).sceneId;
  if (meta.get(sceneId)?.locked !== true) return operations;
  return [{ op: 'set_scene_lock', sceneId, locked: false }, ...operations];
}

async function applyCompensation(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; actor: Actor },
  operations: EditOperation[],
  compensation: {
    kind: 'UNDO' | 'REDO';
    originalEventId: string;
    originalAction: string;
    originalOperation?: EditOperation;
    intentText: string;
  },
): Promise<ProcessEditsResult> {
  const project = await loadProjectRow(deps, input.workspaceId, input.projectId);
  const sceneMeta = await loadSceneMeta(deps, input.workspaceId, input.projectId);
  const normalized = normalizeLockedTarget(operations, sceneMeta);
  const request: EditRequest = {
    baseProjectRevision: project.revision,
    expectedSceneRevisions: buildExpected(normalized, sceneMeta),
    // 服务端内部请求：幂等键由服务生成（HTTP 层另有完整的幂等中间件）
    idempotencyKey: `evt_${randomUUID()}`,
    operations: normalized,
  };
  return processEdits(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: input.actor,
    request,
    compensation,
  });
}

export async function undoProject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; actor: Actor },
): Promise<ProcessEditsResult> {
  const events = await loadProjectEvents(deps, input.projectId);
  const { active } = analyzeEvents(events);
  const target = active.length > 0 ? active[active.length - 1] : undefined;
  if (target === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '没有可撤销的操作', 409);
  }
  const sceneMeta = await loadSceneMeta(deps, input.workspaceId, input.projectId);
  const operations = planUndo(target, sceneMeta);
  return applyCompensation(deps, input, operations, {
    kind: 'UNDO',
    originalEventId: target.id,
    originalAction: target.action,
    originalOperation: reconstructOperation(target),
    intentText: `撤销：${target.action}`,
  });
}

export async function redoProject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; actor: Actor },
): Promise<ProcessEditsResult> {
  const events = await loadProjectEvents(deps, input.projectId);
  const { undone } = analyzeEvents(events);
  const latestPlainSeq = events
    .filter((event) => !isCompensationAction(event.action))
    .reduce((max, event) => Math.max(max, event.seq), 0);
  // 重做分支：撤销必须发生在最后一次"普通编辑"之后（新编辑结束重做分支，§4.8）
  const candidates = undone.filter(({ undo }) => undo.seq > latestPlainSeq);
  if (candidates.length === 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '没有可重做的操作（撤销分支已被新的编辑结束）', 409);
  }
  const pick = candidates.reduce((a, b) => (b.undo.seq > a.undo.seq ? b : a));
  const originalOperation = eventPatch(pick.undo).originalOperation as EditOperation | undefined;
  if (originalOperation === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '该撤销记录缺少原始操作，无法重做', 409);
  }
  return applyCompensation(deps, input, [originalOperation], {
    kind: 'REDO',
    originalEventId: pick.undo.id,
    originalAction: pick.undo.action,
    intentText: `重做：${pick.event.action}`,
  });
}
