import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PLATFORM_CAPABILITY_MATRIX,
  PLATFORM_EXPORT_CHECKLISTS,
  PUBLICATION_ERROR_REASONS,
  exportPackageRecordSchema,
  type ExportPackageRecord,
} from '@ancs/contracts';
import { exportPackages } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assertPublicationApproval } from './publications.js';

/**
 * P4 导出包（P13-04 / §42；计划 §8 P13）。
 *
 * - **仅适用于矩阵声明 EXPORT_PACKAGE 的平台**（当前：抖音/X——P4 归类）；
 * - 包 = 视频资产引用 + 可选封面 + 文案（标题/描述/标签）+ **AIGC 披露逐字** + 平台手工清单；
 * - **最后一步恒为"由用户在平台完成发布"**（finalStepByUser=true——本系统不代发 P4 平台，
 *   导出包绝不显示为 Published）；
 * - 批准闸门与发布同源（未批准版本不能打包）。
 */

const toDto = (row: typeof exportPackages.$inferSelect): ExportPackageRecord =>
  exportPackageRecordSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    platformId: row.platformId,
    payload: row.payload,
    createdAt: row.createdAt.toISOString(),
  });

/** 导出包列表（新→旧）。 */
export async function listExportPackages(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ExportPackageRecord[]> {
  const rows = await deps.db
    .select()
    .from(exportPackages)
    .where(and(eq(exportPackages.workspaceId, input.workspaceId), eq(exportPackages.projectId, input.projectId)))
    .orderBy(desc(exportPackages.createdAt));
  return rows.map(toDto);
}

/** 平台手工清单（数据驱动；声明 EXPORT_PACKAGE 但无清单 → fail-closed，不编造步骤）。 */
function checklistFor(platformId: string): string[] {
  const checklist = PLATFORM_EXPORT_CHECKLISTS[platformId];
  if (checklist === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `平台 ${platformId} 声明 EXPORT_PACKAGE 但缺少手工清单数据（不编造步骤）`, 422, {
      reason: PUBLICATION_ERROR_REASONS.EXPORT_PACKAGE_UNAVAILABLE,
      platformId,
    });
  }
  return [...checklist];
}

/**
 * 创建 P4 导出包：
 * 平台矩阵声明 EXPORT_PACKAGE → 批准闸门（同发布）→ 清单（数据驱动，末步由用户）→ 落库。
 */
export async function createExportPackage(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string;
    platformId: string;
    projectVersionId: string;
    outputAssetId: string;
    coverAssetId: string | null;
    title: string;
    description: string | null;
    tags: string[];
    disclosure: string | null;
  },
): Promise<ExportPackageRecord> {
  // 1) 平台矩阵必须声明 EXPORT_PACKAGE（P4 平台才走导出包路径）
  const matrixEntry = PLATFORM_CAPABILITY_MATRIX.find((entry) => entry.platformId === input.platformId);
  if (matrixEntry === undefined || !matrixEntry.declaredCapabilities.includes('EXPORT_PACKAGE')) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `平台 ${input.platformId} 不适用 P4 导出包（矩阵未声明 EXPORT_PACKAGE）`, 422, {
      reason: PUBLICATION_ERROR_REASONS.EXPORT_PACKAGE_UNAVAILABLE,
      platformId: input.platformId,
    });
  }
  // 2) 批准闸门（与发布同源——未批准版本不能打包）
  await assertPublicationApproval(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    projectVersionId: input.projectVersionId,
    outputAssetId: input.outputAssetId,
  });
  // 3) 清单（数据驱动；末步恒为"由用户完成"）
  const checklist = checklistFor(input.platformId);
  const inserted = await deps.db
    .insert(exportPackages)
    .values({
      id: `exp_${randomUUID()}`,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      platformId: input.platformId,
      payload: {
        platformId: input.platformId,
        projectVersionId: input.projectVersionId,
        videoAssetId: input.outputAssetId,
        coverAssetId: input.coverAssetId,
        coverNote: input.coverAssetId === null ? '封面未生成（可经输出增强链路生成真实静帧）' : null,
        title: input.title,
        description: input.description,
        tags: input.tags,
        disclosure: input.disclosure,
        checklist,
        finalStepByUser: true,
      },
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'export package insert failed', 500);
  return toDto(row);
}
