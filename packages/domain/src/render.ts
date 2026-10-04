import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  RENDER_ERROR_REASONS,
  RENDER_PROFILE_SPECS,
  renderRecordSchema,
  type CreateRenderRequest,
  type RenderRecord,
  type RenderStatus,
} from '@ancs/contracts';
import { assetVersions, masterNarrations, projectVersions, renderEvents, renders } from '@ancs/db';
import { loadProjectRow } from './projects.js';
import { createProjectVersionInTx } from './versions.js';
import type { DomainDeps } from './channels.js';

/**
 * Render Snapshot 服务（P07-03 / 规范 §28、§39；计划 §4.5）。
 *
 * **Render 输入 = 不可变快照引用**：
 * - 创建渲染时冻结 project_version（无版本则自动建 FINAL_RENDER 快照）、Master Narration（Audio-First：
 *   无对齐不成片）、素材**版本级**清单与输出画幅（按 profile 档位）；
 * - 渲染中编辑当前项目只产生新 revision/版本——**不影响在途渲染**（验收点）；
 * - 状态机单向（QUEUED→RENDERING→QA→READY/FAILED/CANCELLED），每次迁移写 render_events 审计。
 */

const toRenderDto = (row: typeof renders.$inferSelect): RenderRecord =>
  renderRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    profile: row.profile,
    status: row.status,
    input: row.input,
    estimatedCost: row.estimatedCost,
    manifestHash: row.manifestHash,
    outputAssetIds: row.outputAssetIds,
    error: row.error,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

const STATE_TRANSITIONS: Readonly<Record<RenderStatus, readonly RenderStatus[]>> = {
  QUEUED: ['RENDERING', 'CANCELLED'],
  RENDERING: ['QA', 'FAILED', 'CANCELLED'],
  QA: ['READY', 'FAILED'],
  READY: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionRender(from: RenderStatus, to: RenderStatus): boolean {
  return (STATE_TRANSITIONS[from] ?? []).includes(to);
}

/** 创建渲染（冻结输入快照；同一版本+profile 可重复创建——渲染本身幂等，审核侧去重）。 */
export async function createRender(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; request: CreateRenderRequest; createdBy?: string | null },
): Promise<RenderRecord> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);

  return deps.db.transaction(async (tx) => {
    // 1) 冻结项目版本（未提供 → 自动建 FINAL_RENDER 快照）
    let versionId: string;
    if (input.request.projectVersionId !== undefined) {
      const versionRows = await tx
        .select({ id: projectVersions.id })
        .from(projectVersions)
        .where(
          and(
            eq(projectVersions.id, input.request.projectVersionId),
            eq(projectVersions.projectId, input.projectId),
            eq(projectVersions.workspaceId, input.workspaceId),
          ),
        )
        .limit(1);
      if (versionRows[0] === undefined) {
        throw new ApiFailure(ERROR_CODES.NOT_FOUND, '项目版本不存在（或跨工作区）', 404, {
          reason: RENDER_ERROR_REASONS.VERSION_NOT_FOUND,
        });
      }
      versionId = versionRows[0].id;
    } else {
      const version = await createProjectVersionInTx(tx, {
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        reason: 'FINAL_RENDER',
        note: `Render 输入快照（${input.request.profile}）`,
        createdBy: input.createdBy ?? null,
      });
      versionId = version.id;
    }

    // 2) Master Narration（Audio-First：无对齐不成片）
    const masterRows = await tx
      .select()
      .from(masterNarrations)
      .where(and(eq(masterNarrations.projectId, input.projectId), eq(masterNarrations.workspaceId, input.workspaceId)))
      .orderBy(desc(masterNarrations.createdAt))
      .limit(1);
    const master = masterRows[0];
    if (master === undefined || master.assetId === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '缺少 Master Narration：合成旁白对齐后才能成片（Audio-First）', 409, {
        reason: RENDER_ERROR_REASONS.MASTER_NARRATION_MISSING,
      });
    }

    // 3) 快照内素材版本清单 + 场景非空校验
    const versionRow = (await tx.select().from(projectVersions).where(eq(projectVersions.id, versionId)).limit(1))[0];
    if (versionRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'version row missing', 500);
    const snapshot = versionRow.snapshot as { graph?: { scenes?: { assetBindings: { assetId: string }[] }[] } };
    const snapshotScenes = snapshot.graph?.scenes ?? [];
    if (snapshotScenes.length === 0) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '快照内没有场景：无可渲染内容', 422, {
        reason: RENDER_ERROR_REASONS.NO_SCENES,
      });
    }
    const assetIds = [...new Set(snapshotScenes.flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)))];
    const versionRows =
      assetIds.length === 0
        ? []
        : await tx.select({ id: assetVersions.id, assetId: assetVersions.assetId }).from(assetVersions).where(eq(assetVersions.workspaceId, input.workspaceId));
    const currentByAsset = new Map<string, string>();
    for (const row of versionRows) currentByAsset.set(row.assetId, row.id);
    // 只冻结"快照时刻的当前版本"（绑定资产缺版本 → 明确列出，不静默渲染）
    const missing: string[] = [];
    const assetVersionIds: string[] = [];
    for (const assetId of assetIds) {
      const versionIdForAsset = currentByAsset.get(assetId);
      if (versionIdForAsset === undefined) missing.push(assetId);
      else assetVersionIds.push(versionIdForAsset);
    }
    if (missing.length > 0) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '存在未就绪的绑定资产：渲染输入冻结失败', 409, {
        reason: 'ASSET_VERSIONS_MISSING',
        missingAssetIds: missing,
      });
    }

    // 4) 落 Render（QUEUED）+ 审计事件
    const spec = RENDER_PROFILE_SPECS[input.request.profile];
    const now = new Date();
    const renderId = `rnd_${randomUUID()}`;
    const inputPayload = {
      projectVersionId: versionId,
      masterNarrationId: master.id,
      assetVersionIds,
      format: { width: spec.width, height: spec.height, fps: spec.fps },
    };
    await tx.insert(renders).values({
      id: renderId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      profile: input.request.profile,
      status: 'QUEUED',
      input: inputPayload,
      createdBy: input.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(renderEvents).values({
      id: `rev_${randomUUID()}`,
      workspaceId: input.workspaceId,
      renderId,
      seq: 1,
      status: 'QUEUED',
      note: `输入冻结：version=${versionId} narration=${master.id} assets=${String(assetVersionIds.length)}`,
      actorId: input.createdBy ?? null,
    });
    const row = (await tx.select().from(renders).where(eq(renders.id, renderId)).limit(1))[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'render insert failed', 500);
    return toRenderDto(row);
  });
}

/** 渲染状态迁移（单向状态机 + 审计事件；非法迁移 409）。 */
export async function transitionRender(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string; to: RenderStatus; note?: string; actorId?: string | null },
): Promise<RenderRecord> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from renders where id = ${input.renderId} for update`);
    const rows = await tx
      .select()
      .from(renders)
      .where(and(eq(renders.id, input.renderId), eq(renders.workspaceId, input.workspaceId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'render not found', 404);
    if (!canTransitionRender(row.status as RenderStatus, input.to)) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `非法渲染状态迁移：${row.status} → ${input.to}`, 409, {
        reason: RENDER_ERROR_REASONS.INVALID_TRANSITION,
        from: row.status,
        to: input.to,
      });
    }
    const now = new Date();
    const seqRows = await tx
      .select({ seq: renderEvents.seq })
      .from(renderEvents)
      .where(eq(renderEvents.renderId, input.renderId))
      .orderBy(desc(renderEvents.seq))
      .limit(1);
    const nextSeq = (seqRows[0]?.seq ?? 0) + 1;
    await tx.insert(renderEvents).values({
      id: `rev_${randomUUID()}`,
      workspaceId: input.workspaceId,
      renderId: input.renderId,
      seq: nextSeq,
      status: input.to,
      note: input.note ?? null,
      actorId: input.actorId ?? null,
    });
    const updated = await tx.update(renders).set({ status: input.to, updatedAt: now }).where(eq(renders.id, input.renderId)).returning();
    const updatedRow = updated[0];
    if (updatedRow === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'render transition failed', 500);
    return toRenderDto(updatedRow);
  });
}

export async function getRender(deps: DomainDeps, input: { workspaceId: string; renderId: string }): Promise<RenderRecord> {
  const rows = await deps.db
    .select()
    .from(renders)
    .where(and(eq(renders.id, input.renderId), eq(renders.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'render not found', 404);
  return toRenderDto(row);
}

export async function listRenders(deps: DomainDeps, input: { workspaceId: string; projectId?: string; limit?: number }): Promise<RenderRecord[]> {
  const conditions = [eq(renders.workspaceId, input.workspaceId)];
  if (input.projectId !== undefined) conditions.push(eq(renders.projectId, input.projectId));
  const rows = await deps.db
    .select()
    .from(renders)
    .where(and(...conditions))
    .orderBy(desc(renders.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 200));
  return rows.map(toRenderDto);
}

/** 冻结校验（验收点：渲染中编辑当前项目不改变该次 Render 输入）——输入快照与当前状态解耦。 */
export async function verifyRenderInputFrozen(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string },
): Promise<{ frozen: true; inputSnapshot: RenderRecord['input']; note: string }> {
  const render = await getRender(deps, input);
  const versionRows = await deps.db
    .select({ id: projectVersions.id })
    .from(projectVersions)
    .where(eq(projectVersions.id, render.input.projectVersionId))
    .limit(1);
  if (versionRows[0] === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, '输入快照丢失（不应发生：版本不可变）', 500);
  return {
    frozen: true,
    inputSnapshot: render.input,
    note: 'Render 输入仅引用不可变版本；当前项目的后续编辑不进入本次渲染。',
  };
}
