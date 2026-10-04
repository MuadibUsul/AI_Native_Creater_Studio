import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  ApiFailure,
  editRequestSchema,
  editResponseSchema,
  ERROR_CODES,
  versionConflictDetailsSchema,
  type EditOperation,
  type EditRequest,
  type EditResponse,
  type SceneChanges,
} from '@ancs/contracts';
import { editEvents, outboxEvents, projects, scenes } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { toProjectDto, toSceneDto, type ProjectRow, type SceneRow } from './mappers.js';

/**
 * 编辑事务处理器（P02-02 / 计划 §4.6、§4.7；规范 §23）。
 *
 * 处理顺序（§4.6，鉴权与 Schema 校验已在 API 层完成）：
 *   幂等（中间件）→ 加载聚合与预期 revision → Lock/合法性检查 →
 *   事务内条件更新（新状态 + revision + EditEvent + Outbox 同事务）→ 返回权威结果。
 *
 * 并发规则（§4.6）：
 *   - 同一 Scene 的竞争修改：按 expectedSceneRevisions 条件更新，只允许一个成功；
 *   - 不同 Scene 的独立修改：在各自预期未变时可合并（本实现以 Project 行锁串行化写入，
 *     再逐 Scene 校验预期 revision，因此两者都成功且不丢更新）；
 *   - 结构性操作（insert/delete/duplicate/split/reorder/restore）：要求 baseProjectRevision 精确匹配；
 *   - 冲突返回 409 VERSION_CONFLICT，details 携带刷新所需的 currentProjectRevision 与冲突 Scene revision。
 *
 * 派生变化：结构性操作导致的 position/startMs 重算**不**递增 Scene revision
 * （内容/类型/Lock 变更才递增）——避免位置平移误伤其他客户端的预期 revision。
 */

const UNIMPLEMENTED_OPERATIONS: Readonly<Record<string, string>> = {
  update_script: 'P04（Script/ContentBlock 模型）',
  replace_asset: 'P02-04（资产）',
  update_caption: 'P06-06（字幕）',
  update_audio_track: 'P06-06（混音）',
  restore_scene: 'P02-03（历史恢复）',
  restore_project_version: 'P02-03（历史恢复）',
};

const STRUCTURAL_OPERATIONS = new Set([
  'insert_scene',
  'delete_scene',
  'duplicate_scene',
  'split_scene',
  'reorder_scenes',
]);

// 修改既有 Scene 的操作（update/delete/split/set_scene_lock）必须携带 expectedSceneRevisions；
// 锁定 Scene 除显式 set_scene_lock 外不可改——两条规则分别在下列分支中以 requireExpected 与
// locked 检查实现。

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
}

export interface ProcessEditsResult {
  response: EditResponse;
  /** 本次创建的新 Scene（insert/duplicate/split 产生），供调用方定位 */
  createdSceneIds: string[];
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
      return operation.sceneId;
    default:
      return null;
  }
};

function applySceneChanges(row: SceneRow, changes: SceneChanges): void {
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
}

function cloneSceneForNewRow(source: SceneRow, workspaceId: string, projectId: string, overrides: Partial<SceneRow>): SceneRow {
  const now = new Date();
  return {
    ...source,
    id: `scn_${randomUUID()}`,
    workspaceId,
    projectId,
    revision: 1,
    createdAt: now,
    updatedAt: now,
    ...overrides,
    // 克隆的数组/对象做拷贝，避免共享引用（jsonb 列在类型层为 unknown）
    narrationBlockIds: [...(source.narrationBlockIds as string[])],
    props: structuredClone(source.props),
    sourceBindings: structuredClone(source.sourceBindings),
    dataBindings: structuredClone(source.dataBindings),
    assetBindings: structuredClone(source.assetBindings),
    transition: structuredClone(source.transition),
  };
}

/** 事务内最终校验 + 应用 + 落盘（新状态/revision/EditEvent/Outbox 同事务）。 */
async function applyEditsInTransaction(
  db: NodePgDatabase,
  input: ProcessEditsInput,
  request: EditRequest,
): Promise<{ project: ProjectRow; sceneRows: SceneRow[]; events: (typeof editEvents.$inferSelect)[]; createdSceneIds: string[] }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);

    const projectRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
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

    // 同一请求同一 Scene 只允许一个操作（避免批内预期 revision 歧义）
    const touched = new Set<string>();
    const dirtySceneIds = new Set<string>();
    const createdSceneIds: string[] = [];
    const ordered: SceneRow[] = [...sceneRows];
    const eventDrafts: { action: string; sceneId: string | null; patch: Record<string, unknown> }[] = [];
    const affectedSceneIds = new Set<string>();

    const requireExpected = (sceneId: string): number => {
      const expected = request.expectedSceneRevisions[sceneId];
      if (expected === undefined) {
        throw new ApiFailure(
          ERROR_CODES.VALIDATION_FAILED,
          `必须提供 expectedSceneRevisions["${sceneId}"]（§4.6 并发协议）`,
          400,
        );
      }
      return expected;
    };

    const markTouched = (sceneId: string): void => {
      if (touched.has(sceneId)) {
        throw new ApiFailure(
          ERROR_CODES.VALIDATION_FAILED,
          `同一请求中对同一 Scene 只允许一个操作（重复：${sceneId}）`,
          400,
        );
      }
      touched.add(sceneId);
    };

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
          if (operation.changes.title !== undefined || operation.changes.targetDurationMs !== undefined) {
            const updated = await tx
              .update(projects)
              .set({
                title: operation.changes.title ?? project.title,
                targetDurationMs:
                  operation.changes.targetDurationMs !== undefined
                    ? operation.changes.targetDurationMs
                    : project.targetDurationMs,
                updatedAt: new Date(),
              })
              .where(eq(projects.id, input.projectId))
              .returning();
            const updatedRow = updated[0];
            if (updatedRow) {
              project.title = updatedRow.title;
              project.targetDurationMs = updatedRow.targetDurationMs;
            }
          }
          eventDrafts.push({ action: 'UPDATE_PROJECT', sceneId: null, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'update_scene': {
          markTouched(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          const expected = requireExpected(operation.sceneId);
          if (row.revision !== expected) {
            throw versionConflict('scene has changed since expected revision', project.revision, {
              [operation.sceneId]: row.revision,
            });
          }
          applySceneChanges(row, operation.changes);
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({ action: 'UPDATE_SCENE', sceneId: row.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'insert_scene': {
          if (operation.afterSceneId !== null && !byId.has(operation.afterSceneId)) {
            throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'afterSceneId 指向的 scene 不存在', 404);
          }
          const now = new Date();
          const draft = operation.sceneDraft;
          const newRow: SceneRow = {
            id: `scn_${randomUUID()}`,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            revision: 1,
            position: 0,
            startMs: 0,
            durationMs: draft.durationMs,
            semanticType: draft.semanticType,
            sceneType: draft.sceneType,
            narrationBlockIds: [],
            narration: draft.narration,
            visualIntent: draft.visualIntent,
            componentId: draft.componentId,
            componentVersion: draft.componentVersion,
            props: draft.props,
            providerRequirement: draft.providerRequirement,
            sourceBindings: draft.sourceBindings,
            dataBindings: draft.dataBindings,
            assetBindings: [],
            transition: { in: null, out: null },
            locked: false,
            approved: false,
            needsReview: false,
            status: 'EMPTY',
            createdAt: now,
            updatedAt: now,
          };
          const insertIndex =
            operation.afterSceneId === null
              ? 0
              : ordered.findIndex((row) => row.id === operation.afterSceneId) + 1;
          ordered.splice(insertIndex, 0, newRow);
          byId.set(newRow.id, newRow);
          createdSceneIds.push(newRow.id);
          affectedSceneIds.add(newRow.id);
          eventDrafts.push({ action: 'INSERT_SCENE', sceneId: newRow.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'delete_scene': {
          markTouched(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          const expected = requireExpected(operation.sceneId);
          if (row.revision !== expected) {
            throw versionConflict('scene has changed since expected revision', project.revision, {
              [operation.sceneId]: row.revision,
            });
          }
          ordered.splice(ordered.findIndex((candidate) => candidate.id === row.id), 1);
          byId.delete(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({ action: 'DELETE_SCENE', sceneId: row.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'duplicate_scene': {
          // 复制不修改源 Scene（无需 expected revision，也不占用"同一 Scene 一个操作"名额）
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          const copy = cloneSceneForNewRow(row, input.workspaceId, input.projectId, {});
          const insertIndex =
            operation.afterSceneId === null
              ? ordered.findIndex((candidate) => candidate.id === row.id) + 1
              : ordered.findIndex((candidate) => candidate.id === operation.afterSceneId) + 1;
          ordered.splice(insertIndex, 0, copy);
          byId.set(copy.id, copy);
          createdSceneIds.push(copy.id);
          affectedSceneIds.add(copy.id);
          eventDrafts.push({ action: 'DUPLICATE_SCENE', sceneId: copy.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'split_scene': {
          markTouched(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          if (row.locked) {
            throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'scene is locked；请先显式解锁（set_scene_lock）', 409);
          }
          const expected = requireExpected(operation.sceneId);
          if (row.revision !== expected) {
            throw versionConflict('scene has changed since expected revision', project.revision, {
              [operation.sceneId]: row.revision,
            });
          }
          if (operation.atMs <= 0 || operation.atMs >= row.durationMs) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'split_scene 的 atMs 必须位于 (0, durationMs) 内', 400);
          }
          const tailDuration = row.durationMs - operation.atMs;
          const tail = cloneSceneForNewRow(row, input.workspaceId, input.projectId, {
            // TODO(P06-03)：有 Alignment 后按旁白边界切分并复用音频；当前仅切时长
            narration: '',
            durationMs: tailDuration,
            status: 'EMPTY',
          });
          row.durationMs = operation.atMs;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          const insertIndex = ordered.findIndex((candidate) => candidate.id === row.id) + 1;
          ordered.splice(insertIndex, 0, tail);
          byId.set(tail.id, tail);
          createdSceneIds.push(tail.id);
          affectedSceneIds.add(row.id);
          affectedSceneIds.add(tail.id);
          eventDrafts.push({ action: 'SPLIT_SCENE', sceneId: row.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'reorder_scenes': {
          const currentIds = ordered.map((row) => row.id).sort();
          const requestedIds = [...operation.orderedSceneIds].sort();
          if (currentIds.length !== requestedIds.length || currentIds.some((id, index) => id !== requestedIds[index])) {
            throw new ApiFailure(
              ERROR_CODES.VALIDATION_FAILED,
              'reorder_scenes 必须包含当前全部 Scene 且不重不漏',
              400,
            );
          }
          ordered.sort(
            (a, b) =>
              operation.orderedSceneIds.indexOf(a.id) - operation.orderedSceneIds.indexOf(b.id),
          );
          for (const row of ordered) affectedSceneIds.add(row.id);
          eventDrafts.push({ action: 'REORDER_SCENES', sceneId: null, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        case 'set_scene_lock': {
          markTouched(operation.sceneId);
          const row = byId.get(operation.sceneId);
          if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'scene not found', 404);
          const expected = requireExpected(operation.sceneId);
          if (row.revision !== expected) {
            throw versionConflict('scene has changed since expected revision', project.revision, {
              [operation.sceneId]: row.revision,
            });
          }
          row.locked = operation.locked;
          row.revision += 1;
          dirtySceneIds.add(row.id);
          affectedSceneIds.add(row.id);
          eventDrafts.push({ action: 'SET_SCENE_LOCK', sceneId: row.id, patch: operation as unknown as Record<string, unknown> });
          break;
        }

        default: {
          // 已知但未排期的操作已在进入 switch 前按阶段拒绝；此处兜底防御契约新增操作
          throw new ApiFailure(
            ERROR_CODES.CAPABILITY_UNAVAILABLE,
            `操作 ${(operation as EditOperation).op} 尚未接入处理器`,
            501,
          );
        }
      }
    }

    const now = new Date();

    // 1) 脏 Scene 的条件更新（WHERE revision = 读取值；行锁下必中，作为最终防线）
    for (const sceneId of dirtySceneIds) {
      const row = byId.get(sceneId);
      if (!row) continue;
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
          locked: row.locked,
          revision: row.revision,
          updatedAt: now,
        })
        .where(and(eq(scenes.id, row.id), eq(scenes.revision, row.revision - 1)))
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
      .set({ revision: project.revision + 1, updatedAt: now })
      .where(eq(projects.id, input.projectId))
      .returning();
    const bumpedRow = bumped[0];
    if (!bumpedRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'project update failed', 500);

    // 5) EditEvent 逐操作落库（与状态、Outbox 同事务）
    const eventRows: (typeof editEvents.$inferSelect)[] = [];
    for (const draft of eventDrafts) {
      const inserted = await tx
        .insert(editEvents)
        .values({
          id: `evt_${randomUUID()}`,
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          sceneId: draft.sceneId,
          actorType: input.actor.type,
          actorId: input.actor.id,
          action: draft.action,
          intentText: request.intent ?? null,
          patch: draft.patch,
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
      },
    });

    return { project: bumpedRow, sceneRows: ordered, events: eventRows, createdSceneIds };
  });
}

export async function processEdits(deps: DomainDeps, input: ProcessEditsInput): Promise<ProcessEditsResult> {
  const request = editRequestSchema.parse(input.request);

  const projectRows = await deps.db
    .select()
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
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

  const result = await applyEditsInTransaction(deps.db, input, request);

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
      createdAt: row.createdAt.toISOString(),
    })),
  });

  return { response, createdSceneIds: result.createdSceneIds };
}
