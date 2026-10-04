import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  editRequestSchema,
  editResponseSchema,
  ERROR_CODES,
  projectVersionSnapshotSchema,
  versionConflictDetailsSchema,
  type EditOperation,
  type EditRequest,
  type EditResponse,
  type Scene,
  type SceneChanges,
} from '@ancs/contracts';
import { editEvents, outboxEvents, projectVersions, projects, scenes } from '@ancs/db';
import { assertAssetBindable } from './assets.js';
import type { DomainDeps } from './channels.js';
import { toProjectDto, toSceneDto, type ProjectRow, type SceneRow } from './mappers.js';
import { AUTO_SNAPSHOT_INTERVAL, buildSnapshotPayload, currentEventSeq } from './versions.js';

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

const UNIMPLEMENTED_OPERATIONS: Readonly<Record<string, string>> = {
  update_script: 'P04（Script/ContentBlock 模型）',
  update_caption: 'P06-06（字幕）',
  update_audio_track: 'P06-06（混音）',
};

const STRUCTURAL_OPERATIONS = new Set([
  'insert_scene',
  'delete_scene',
  'duplicate_scene',
  'split_scene',
  'reorder_scenes',
  'restore_scene',
  'restore_project_version',
]);

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
  patch: Record<string, unknown>;
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
    let restoreSnapshotReason: 'RESTORE' | null = null;

    const requireExpectedOnce = (sceneId: string): void => {
      if (expectedValidated.has(sceneId)) return;
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
      const unimplementedPhase = UNIMPLEMENTED_OPERATIONS[operation.op];
      if (unimplementedPhase !== undefined) {
        throw new ApiFailure(
          ERROR_CODES.CAPABILITY_UNAVAILABLE,
          `操作 ${operation.op} 当前不可用（计划阶段：${unimplementedPhase}）`,
          501,
          { operation: operation.op, plannedPhase: unimplementedPhase },
        );
      }

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
          const newId = operation.restoreSceneId ?? `scn_${randomUUID()}`;
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
          const copyId = operation.restoreSceneId ?? `scn_${randomUUID()}`;
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
          const tailId = operation.restoreTailSceneId ?? `scn_${randomUUID()}`;
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

    // 1) 脏 Scene 的条件更新（WHERE revision = 事务内读取值；行锁下必中，作为最终防线）
    for (const sceneId of dirtySceneIds) {
      const row = byId.get(sceneId);
      if (!row) continue;
      const initialRevision = initialRevisions.get(row.id) ?? row.revision - 1;
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

  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt)))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

  // 事务前快速校验（完整校验在事务内以锁定后的权威状态重复执行）
  const existingSceneIds = new Set(
    (
      await deps.db
        .select({ id: scenes.id })
        .from(scenes)
        .where(eq(scenes.projectId, input.projectId))
    ).map((row) => row.id),
  );
  for (const operation of request.operations) {
    const phase = UNIMPLEMENTED_OPERATIONS[operation.op];
    if (phase !== undefined) {
      throw new ApiFailure(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `操作 ${operation.op} 当前不可用（计划阶段：${phase}）`,
        501,
        { operation: operation.op, plannedPhase: phase },
      );
    }
    const targetId = sceneTargetId(operation);
    if (targetId !== null && !existingSceneIds.has(targetId)) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, `scene "${targetId}" 不存在`, 404);
    }
  }

  const result = await applyEditsInTransaction(deps, input, request);

  const response = editResponseSchema.parse({
    project: toProjectDto(result.project),
    scenes: result.sceneRows.map(toSceneDto),
    editEvents: result.events.map((row) => ({
      id: row.id,
      workspaceId: row.workspaceId,
      projectId: row.projectId,
      sceneId: row.sceneId,
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

const sceneTargetId = (operation: EditOperation): string | null => {
  switch (operation.op) {
    case 'insert_scene':
      return operation.afterSceneId; // 仅用于存在性校验；新 Scene 尚未创建
    case 'update_scene':
    case 'delete_scene':
    case 'duplicate_scene':
    case 'split_scene':
    case 'set_scene_lock':
    case 'restore_scene':
    case 'replace_asset':
      return operation.sceneId;
    default:
      return null;
  }
};
