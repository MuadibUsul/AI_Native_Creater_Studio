import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  ERROR_CODES,
  OBJECT_LOCK_DIMENSIONS,
  editRequestSchema,
  type EditOperation,
  type ObjectLockKind,
} from '@ancs/contracts';
import { isKernelTimelineOperation, type KernelTimelineOperation, type TimelineState } from '@ancs/kernel';
import { projectObjectLocks, projects, scenes, sequenceClips } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { validateEditOperationCandidate } from './edit-operation-registry.js';
import { processEdits, versionConflict } from './edits.js';
import { simulateKernelBatch } from './kernel-timeline.js';

/**
 * 试改引擎（V5 §9，M2）：回答"这批操作在当前作品上执行会得到什么"，**绝不改工程**。
 *
 * - KERNEL_MEMORY：全部为内核操作时，在一致性快照（REPEATABLE READ 只读事务）上加载一次状态，
 *   内核内存执行整批；不写库、不取项目行锁，与正式编辑互不阻塞。
 *   前置校验与 processEdits 同序：项目存在 → 候选校验（锁/场景）→ 结构性操作的 base revision → 内核规则。
 * - TRANSACTION_ROLLBACK：含非内核操作（Scene、对象锁、动画、版本恢复）时，在事务内跑真实执行器后无条件回滚。
 * 两条路径对同一批内核操作产生相同的事件序列与片段行（等价性由集成测试守护）。
 * 错误原样抛出（ApiFailure = 业务拒绝；其他 = 服务端故障），由调用方分类。
 */

type ClipRow = typeof sequenceClips.$inferSelect;

export type EditTrialEngine = 'KERNEL_MEMORY' | 'TRANSACTION_ROLLBACK';

export interface EditTrialOutcome {
  engine: EditTrialEngine;
  /** 若采用，将得到的项目 revision */
  revision: number;
  events: { action: string; objectKind: string | null; objectId: string | null; summary: string }[];
  /** 试改后的全部片段行 */
  clips: ClipRow[];
  /** KERNEL_MEMORY：试改后的完整内核状态（只读视图用，例如 AI 草稿时间线） */
  timeline?: TimelineState;
}

export interface EditTrialInput {
  workspaceId: string;
  projectId: string;
  baseProjectRevision: number;
  operations: readonly EditOperation[];
  actorId: string;
  /** 默认 AUTO：可内存执行则内存执行 */
  engine?: 'AUTO' | EditTrialEngine;
}

const STRUCTURAL = new Set(Object.values(EDIT_OPERATION_REGISTRY).filter((definition) => definition.structural).map((definition) => definition.operation));

const parseLockDimensions = (value: unknown) =>
  Array.isArray(value) ? OBJECT_LOCK_DIMENSIONS.filter((dimension) => value.includes(dimension)) : [];

const summaryOf = (patch: Record<string, unknown>): string => (typeof patch['op'] === 'string' ? patch['op'] : '');

async function runInMemory(deps: DomainDeps, input: EditTrialInput, operations: readonly KernelTimelineOperation[]): Promise<EditTrialOutcome> {
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as NodePgDatabase;
    await db.execute(sql`set transaction isolation level repeatable read read only`);
    const projectRows = await db.select({ revision: projects.revision }).from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
    const project = projectRows[0];
    if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

    const sceneRows = await db.select({ id: scenes.id, durationMs: scenes.durationMs, locked: scenes.locked }).from(scenes)
      .where(and(eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)));
    const lockRows = await db.select().from(projectObjectLocks)
      .where(and(eq(projectObjectLocks.projectId, input.projectId), eq(projectObjectLocks.workspaceId, input.workspaceId)));
    validateEditOperationCandidate({
      scenes: sceneRows,
      operations: [...operations],
      actorType: 'USER',
      projectId: input.projectId,
      locks: lockRows.map((row) => ({
        objectKind: row.objectKind as ObjectLockKind,
        objectId: row.objectId,
        dimensions: parseLockDimensions(row.dimensions),
        reason: row.reason,
      })),
    });
    if (operations.some((operation) => STRUCTURAL.has(operation.op)) && project.revision !== input.baseProjectRevision) {
      throw versionConflict('project has changed since baseProjectRevision', project.revision);
    }

    const simulated = await simulateKernelBatch(db, { workspaceId: input.workspaceId, projectId: input.projectId }, operations);
    return {
      engine: 'KERNEL_MEMORY' as const,
      revision: project.revision + 1,
      events: simulated.events.map((event) => ({ action: event.action, objectKind: event.objectKind, objectId: event.objectId, summary: summaryOf(event.patch) })),
      clips: simulated.clips,
      timeline: simulated.state,
    };
  });
}

async function runWithRollback(deps: DomainDeps, input: EditTrialInput, operations: readonly EditOperation[]): Promise<EditTrialOutcome> {
  class RollbackSentinel extends Error {
    constructor(readonly outcome: EditTrialOutcome) {
      super('trial-rollback');
    }
  }
  try {
    await deps.db.transaction(async (tx) => {
      const result = await processEdits({ ...deps, db: tx }, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        actor: { type: 'USER', id: input.actorId },
        request: {
          schemaVersion: '1.0',
          baseProjectRevision: input.baseProjectRevision,
          expectedSceneRevisions: {},
          operations: [...operations],
          idempotencyKey: `trial_${randomUUID()}`,
        },
      });
      const clips = await tx.select().from(sequenceClips).where(and(
        eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId),
      ));
      // 无条件回滚：试改绝不落地
      throw new RollbackSentinel({
        engine: 'TRANSACTION_ROLLBACK',
        revision: result.response.project.revision,
        events: result.response.editEvents.map((event) => ({
          action: event.action, objectKind: event.objectKind ?? null, objectId: event.objectId ?? null, summary: summaryOf(event.patch),
        })),
        clips,
      });
    });
  } catch (error) {
    if (error instanceof RollbackSentinel) return error.outcome;
    throw error;
  }
  // 事务未回滚是不可能的（上面必然 throw）；保守 fail-closed
  throw new ApiFailure(ERROR_CODES.INTERNAL, 'edit trial did not roll back', 500);
}

/** 当前工程时间线的只读内核快照（一致性快照，不取锁、不写库）；供 AI 读取空草稿时的时间线。 */
export async function readTimelineSnapshot(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<{ revision: number; timeline: TimelineState }> {
  return deps.db.transaction(async (tx) => {
    const db = tx as unknown as NodePgDatabase;
    await db.execute(sql`set transaction isolation level repeatable read read only`);
    const projectRows = await db.select({ revision: projects.revision }).from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
    const project = projectRows[0];
    if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
    const simulated = await simulateKernelBatch(db, { workspaceId: input.workspaceId, projectId: input.projectId }, []);
    return { revision: project.revision, timeline: simulated.state };
  });
}

export async function runEditTrial(deps: DomainDeps, input: EditTrialInput): Promise<EditTrialOutcome> {
  // 与正式编辑同一请求校验（含操作默认值）
  const request = editRequestSchema.parse({
    schemaVersion: '1.0',
    baseProjectRevision: input.baseProjectRevision,
    expectedSceneRevisions: {},
    operations: input.operations,
    idempotencyKey: `trial_${randomUUID()}`,
  });
  const engine = input.engine ?? 'AUTO';
  const kernelOnly = request.operations.length > 0 && request.operations.every(isKernelTimelineOperation);
  if (engine === 'KERNEL_MEMORY' && !kernelOnly) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'in-memory trial requires kernel timeline operations only', 500);
  }
  if (engine !== 'TRANSACTION_ROLLBACK' && kernelOnly) {
    return runInMemory(deps, input, request.operations as KernelTimelineOperation[]);
  }
  return runWithRollback(deps, input, request.operations);
}
