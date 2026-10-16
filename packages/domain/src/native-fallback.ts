import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  REBIND_ERROR_REASONS,
  providerGenerationSchema,
  rebindExternalResultRequestSchema,
  type ProviderGeneration,
} from '@ancs/contracts';
import { assetVersions, assets, providerGenerations } from '@ancs/db';
import { getProviderGeneration } from './billing.js';
import type { DomainDeps } from './deps.js';

/**
 * Native Fallback：外部处理结果回绑（P06-07 / §39、§40、§45）。
 *
 * 场景：Provider 任务在平台外完成（用户/第三方在 Provider 后台处理）——平台展示**任务引用**，
 * 用户上传产物 → 该文件成为**新 AssetVersion**（上传链路 P02-04 负责，来源/授权随资产保留）→
 * 回绑到任务引用（本服务）→ 场景绑定走编辑协议 replace_asset（EditEvent 可追溯）。
 *
 * 纪律：
 * - 只处理**用户提供的文件**（绝不以内置浏览器自动化冒充 Provider 完成，§75 第 14 条精神）；
 * - 回绑不修改已存在的资产版本（§4.3 不变量 5：内容不可原地覆盖）；
 * - 跨工作区资产/任务一律拒绝（反枚举：任务不存在 → 404）。
 */

const toGenerationDto = (row: typeof providerGenerations.$inferSelect): ProviderGeneration =>
  providerGenerationSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    providerId: row.providerId,
    modelId: row.modelId,
    operation: row.operation,
    credentialMode: row.credentialMode,
    inputHash: row.inputHash,
    status: row.status,
    providerJobId: row.providerJobId,
    latencyMs: row.latencyMs,
    estimatedCost: row.estimatedCost,
    actualCost: row.actualCost,
    estimatedCredits: row.estimatedCredits,
    actualCredits: row.actualCredits,
    attempt: row.attempt,
    error: row.error,
    resultAssetId: row.resultAssetId,
    resultAssetVersionId: row.resultAssetVersionId,
    rebindSource: row.rebindSource,
    reboundAt: row.reboundAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

/** 展示 Provider 任务引用（外部处理入口；`onlyUnfulfilled` 过滤已完成回绑的）。 */
export async function listRebindableGenerations(
  deps: DomainDeps,
  input: { workspaceId: string; projectId?: string; onlyUnfulfilled?: boolean; limit?: number },
): Promise<ProviderGeneration[]> {
  const conditions = [eq(providerGenerations.workspaceId, input.workspaceId)];
  const rows = await deps.db
    .select()
    .from(providerGenerations)
    .where(and(...conditions))
    .orderBy(providerGenerations.createdAt)
    .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
  const dtos = rows.map(toGenerationDto);
  const filtered = input.onlyUnfulfilled === true ? dtos.filter((dto) => dto.resultAssetId === null) : dtos;
  return filtered;
}

/**
 * 回绑外部处理结果：校验任务与资产（同工作区 + READY）→ 记录结果资产与版本 →
 * 返回更新后的任务引用（**不触碰资产内容**；场景绑定由编辑协议完成）。
 */
export async function rebindExternalResult(
  deps: DomainDeps,
  input: { workspaceId: string; generationId: string; request: unknown },
): Promise<ProviderGeneration> {
  const body = rebindExternalResultRequestSchema.parse(input.request);

  // 任务引用（反枚举：不存在/跨租户一律 404）
  const generation = await getProviderGeneration(deps, { workspaceId: input.workspaceId, generationId: input.generationId });

  const assetRows = await deps.db
    .select()
    .from(assets)
    .where(and(eq(assets.id, body.assetId), eq(assets.workspaceId, input.workspaceId)))
    .limit(1);
  const asset = assetRows[0];
  if (!asset) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '资产不存在于该工作区', 404, { reason: REBIND_ERROR_REASONS.ASSET_NOT_IN_WORKSPACE, assetId: body.assetId });
  }
  if (asset.status !== 'READY' || asset.currentVersionId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '资产尚未就绪（READY）：回绑只接受完成上传与探测的资产', 409, {
      reason: REBIND_ERROR_REASONS.ASSET_NOT_READY,
      assetId: asset.id,
      assetStatus: asset.status,
    });
  }
  const versionRows = await deps.db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.id, asset.currentVersionId), eq(assetVersions.workspaceId, input.workspaceId)))
    .limit(1);
  const version = versionRows[0];
  if (version === undefined || version.status !== 'READY') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '资产当前版本未就绪：回绑被拒绝', 409, {
      reason: REBIND_ERROR_REASONS.ASSET_NOT_READY,
      assetId: asset.id,
    });
  }

  const now = new Date();
  const updated = await deps.db
    .update(providerGenerations)
    .set({
      resultAssetId: asset.id,
      resultAssetVersionId: version.id,
      rebindSource: 'EXTERNAL_UPLOAD',
      reboundAt: now,
      updatedAt: now,
      ...(body.note !== undefined ? { error: { ...(generation.error ?? {}), rebindNote: body.note } } : {}),
    })
    .where(and(eq(providerGenerations.id, generation.id), eq(providerGenerations.workspaceId, input.workspaceId)))
    .returning();
  const row = updated[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'provider generation rebind failed', 500);
  return toGenerationDto(row);
}
