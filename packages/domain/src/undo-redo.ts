import { randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, type EditOperation, type EditRequest } from '@ancs/contracts';
import { editEvents, projects, scenes } from '@ancs/db';
import type { DomainDeps } from './channels.js';
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
}

interface SceneMeta {
  id: string;
  revision: number;
  locked: boolean;
}

const isCompensationAction = (action: string): boolean => action.startsWith('UNDO_') || action.startsWith('REDO_');

const NEEDS_EXPECTED = new Set(['update_scene', 'delete_scene', 'split_scene', 'set_scene_lock', 'restore_scene']);
const REQUIRES_UNLOCKED = new Set(['update_scene', 'delete_scene', 'split_scene', 'restore_scene']);

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
