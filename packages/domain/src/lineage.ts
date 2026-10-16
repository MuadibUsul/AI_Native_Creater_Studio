import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  LINEAGE_ERROR_REASONS,
  derivationLineageSchema,
  derivationListItemSchema,
  type DerivationListItem,
} from '@ancs/contracts';
import { derivationLineage, projectVersions } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getProjectContentCoreState } from './content-core.js';

/**
 * 派生血缘服务（P11-04 / 规范 §93；计划 §8）。
 *
 * - **只追加**：analyze 每次运行记一条 PLAN 行（输入快照：coreInputsDigest + 规模）；
 * - **过期 = 读取时提示**：对照当前核心 digest → stale 标志（不改写行、不撤销状态）；
 * - **已批准不覆盖**：approve 置 APPROVED（幂等拒绝重复）；核心更新后旧行仍保留原状态 + stale 提示。
 */

const toLineageDto = (row: typeof derivationLineage.$inferSelect) =>
  derivationLineageSchema.parse({
    id: row.id,
    projectId: row.projectId,
    packId: row.packId,
    packVersion: row.packVersion,
    channelKey: row.channelKey,
    status: row.status,
    coreInputsDigest: row.coreInputsDigest,
    inputsSnapshot: row.inputsSnapshot,
    summary: row.summary,
    projectVersionId: row.projectVersionId,
    createdAt: row.createdAt.toISOString(),
    approvedAt: row.approvedAt?.toISOString() ?? null,
  });

/** analyze 后记录 PLAN 血缘行（runPackAnalyze 调用；digest 取自受限上下文数据面）。 */
export async function recordPlanLineage(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; packId: string; packVersion: string; channelKey: string | null; coreInputsDigest: string | null; atomCount: number; claimCount: number; summary: string },
): Promise<void> {
  await deps.db.insert(derivationLineage).values({
    id: `lin_${randomUUID()}`,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    packId: input.packId,
    packVersion: input.packVersion,
    channelKey: input.channelKey,
    status: 'PLAN',
    coreInputsDigest: input.coreInputsDigest,
    inputsSnapshot: { atomCount: input.atomCount, claimCount: input.claimCount },
    summary: input.summary.slice(0, 500),
  });
}

/** 血缘列表（新→旧；stale 对照当前核心 digest——提示性，不改状态）。 */
export async function listProjectDerivations(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<DerivationListItem[]> {
  const [rows, state] = await Promise.all([
    deps.db
      .select()
      .from(derivationLineage)
      .where(and(eq(derivationLineage.workspaceId, input.workspaceId), eq(derivationLineage.projectId, input.projectId)))
      .orderBy(desc(derivationLineage.createdAt)),
    getProjectContentCoreState(deps, input),
  ]);
  const currentDigest = state.consistency?.inputsDigest ?? null;
  return rows.map((row) => {
    const dto = toLineageDto(row);
    return derivationListItemSchema.parse({
      ...dto,
      // 核心已迁移且派生时 digest 与当前不同 → 过期提示；派生时无 digest（核心未迁移）→ 无法判定，视为未过期
      stale: dto.coreInputsDigest !== null && currentDigest !== null && dto.coreInputsDigest !== currentDigest,
      currentCoreInputsDigest: currentDigest,
    });
  });
}

/** 批准派生行（PLAN → APPROVED；已批准重复 approve → 409——状态不回退、不覆盖）。 */
export async function approveDerivation(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; lineageId: string; projectVersionId?: string | null },
): Promise<DerivationListItem> {
  const rows = await deps.db
    .select()
    .from(derivationLineage)
    .where(and(eq(derivationLineage.id, input.lineageId), eq(derivationLineage.workspaceId, input.workspaceId), eq(derivationLineage.projectId, input.projectId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '血缘行不存在', 404, { reason: LINEAGE_ERROR_REASONS.LINEAGE_NOT_FOUND });
  }
  if (row.status === 'APPROVED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '该派生行已批准（状态不回退）', 409, { reason: LINEAGE_ERROR_REASONS.ALREADY_APPROVED });
  }
  const projectVersionId = input.projectVersionId ?? null;
  if (projectVersionId !== null) {
    // 来源链闭合：绑定版本必须属于同项目（跨项目/不存在一律 404——不泄露他项目版本存在性）
    const versions = await deps.db
      .select({ id: projectVersions.id })
      .from(projectVersions)
      .where(and(eq(projectVersions.id, projectVersionId), eq(projectVersions.projectId, input.projectId), eq(projectVersions.workspaceId, input.workspaceId)))
      .limit(1);
    if (versions[0] === undefined) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, '绑定的项目版本不存在或不属于该项目', 404, { reason: LINEAGE_ERROR_REASONS.PROJECT_VERSION_NOT_FOUND });
    }
  }
  const updated = await deps.db
    .update(derivationLineage)
    .set({ status: 'APPROVED', approvedAt: new Date(), projectVersionId })
    .where(eq(derivationLineage.id, row.id))
    .returning();
  const next = updated[0];
  if (next === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'lineage approve failed', 500);
  const state = await getProjectContentCoreState(deps, input);
  const currentDigest = state.consistency?.inputsDigest ?? null;
  const dto = toLineageDto(next);
  return derivationListItemSchema.parse({
    ...dto,
    stale: dto.coreInputsDigest !== null && currentDigest !== null && dto.coreInputsDigest !== currentDigest,
    currentCoreInputsDigest: currentDigest,
  });
}

void derivationLineageSchema;
