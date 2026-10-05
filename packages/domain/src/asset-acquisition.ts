import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { ApiFailure, ERROR_CODES, ASSET_SEARCH_MAX_BYTES, STOCK_ERROR_REASONS, stockAcquisitionResultSchema, stockSearchResultSchema, type AssetSearchProvider, type StockAcquisitionResult, type StockSearchRequest, type StockSearchResult } from '@ancs/contracts';
import { assetVersions, assets, outboxEvents } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { requireStorage } from './assets.js';

/**
 * 素材获取服务（P10-03 / 规范 §84、§12；计划 §8）。
 *
 * - **搜索素材有许可状态**：结果携带 license 与 `usable/unusableReason`（空许可/UNKNOWN/缺署名文本
 *   一律不可用——**不得冒充已授权**）；
 * - **获取前服务端复核**：`lookup` 重新取许可（**不信任客户端提交的 license 字段**）→ 不可用 → 422；
 * - 入库：origin（LICENSED_STOCK/PUBLIC_SOURCE）+ 许可元数据 + **自动署名文本**随资产固化（供 Description/Sources）；
 * - 生成图不冒充证据：QA 检查 `EVIDENCE_ASSET_ORIGIN`（qa.ts；GENERATED 素材不得绑定证据/数据类场景）。
 */

const MAX_RESULTS = 50;

export async function searchStockAssets(
  deps: DomainDeps,
  input: { workspaceId: string; request: unknown; provider: AssetSearchProvider | undefined },
): Promise<{ providerId: string; items: StockSearchResult[] }> {
  void deps;
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '素材搜索 Provider 未装配（501 fail-closed）', 501, { reason: STOCK_ERROR_REASONS.SEARCH_PROVIDER_UNAVAILABLE });
  }
  const body = (input.request ?? {}) as Partial<StockSearchRequest>;
  const request: StockSearchRequest = {
    query: typeof body.query === 'string' ? body.query.slice(0, 200) : '',
    kind: body.kind === 'VIDEO' || body.kind === 'MUSIC' ? body.kind : 'IMAGE',
    limit: Math.min(Math.max(typeof body.limit === 'number' ? body.limit : 20, 1), MAX_RESULTS),
    usableOnly: body.usableOnly === true,
  };
  const raw = await provider.search(request);
  return { providerId: provider.providerId, items: raw.map((item) => stockSearchResultSchema.parse(item)) };
}

/**
 * 获取素材（下载字节 → 自有存储 → 资产行；许可/署名固化）。
 * **未授权/许可不明 → 422 LICENSE_REQUIRED（不冒充已授权）**。
 */
export async function acquireStockAsset(
  deps: DomainDeps,
  input: {
    workspaceId: string;
    projectId: string | null;
    request: unknown;
    provider: AssetSearchProvider | undefined;
    actorId: string | null;
  },
): Promise<StockAcquisitionResult> {
  const provider = input.provider;
  if (provider === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '素材搜索 Provider 未装配（501 fail-closed）', 501, { reason: STOCK_ERROR_REASONS.SEARCH_PROVIDER_UNAVAILABLE });
  }
  const body = (input.request ?? {}) as { providerAssetId?: unknown };
  if (typeof body.providerAssetId !== 'string' || body.providerAssetId.trim() === '') {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '缺少 providerAssetId', 400);
  }

  // 服务端复核许可（不信任客户端）：lookup 结果才可信
  const result = await provider.lookup({ providerAssetId: body.providerAssetId });
  if (result === null) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, '素材不存在（Provider 复核失败）', 404, { reason: STOCK_ERROR_REASONS.RESULT_NOT_FOUND, providerAssetId: body.providerAssetId });
  }
  if (!result.usable) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `素材许可不可用（${result.unusableReason ?? 'UNKNOWN'}）——不得以未授权素材入库`, 422, {
      reason: STOCK_ERROR_REASONS.LICENSE_REQUIRED,
      unusableReason: result.unusableReason,
      providerAssetId: result.providerAssetId,
    });
  }

  const fetched = await provider.fetchAsset({ providerAssetId: result.providerAssetId });
  if (fetched.bytes.byteLength > ASSET_SEARCH_MAX_BYTES) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '素材超过 200MB 上限', 413, { byteSize: fetched.bytes.byteLength });
  }

  const storage = requireStorage(deps);
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  const storageKey = `workspaces/${input.workspaceId}/library/stock/${provider.providerId}/${assetId}/v1/original.bin`;
  await storage.putObject(storageKey, fetched.bytes);

  const origin = result.license.licenseType === 'LICENSED_STOCK' ? 'LICENSED_STOCK' : 'PUBLIC_SOURCE';
  const assetType = result.kind === 'IMAGE' ? 'SOURCE_IMAGE' : result.kind === 'MUSIC' ? 'MUSIC' : 'SOURCE_IMAGE';
  const now = new Date();
  const checksum = createHash('sha256').update(fetched.bytes).digest('hex');

  await deps.db.transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      assetType,
      origin,
      provider: provider.providerId,
      providerAssetId: result.providerAssetId,
      status: 'READY',
      retentionClass: 'KEEP_USER_SOURCE',
      // 许可列（与 §84 字段对齐；**不得以空值冒充已授权**——不可用素材在入口已被 422 拦截）
      license: {
        type: result.license.licenseType,
        holder: null,
        attribution: result.license.attributionText,
        sourceUrl: result.license.sourceUrl,
        termsUrl: null,
        notes: [result.license.licenseReference !== null ? `许可证引用：${result.license.licenseReference}` : null, result.license.usageRestrictions !== null ? `使用限制：${result.license.usageRestrictions}` : null]
          .filter((value): value is string => value !== null)
          .join('；'),
        confirmedBy: input.actorId,
        confirmedAt: now.toISOString(),
      },
      metadata: { stockProviderId: provider.providerId, stockProviderAssetId: result.providerAssetId, stockLicense: result.license, title: result.title },
      currentVersionId: versionId,
    });
    await tx.insert(assetVersions).values({
      id: versionId,
      assetId,
      workspaceId: input.workspaceId,
      versionNumber: 1,
      storageKey,
      mimeType: fetched.contentType,
      sizeBytes: fetched.bytes.byteLength,
      checksumSha256: checksum,
      durationMs: result.durationMs,
      width: result.width,
      height: result.height,
      createdAt: now,
    });
    await tx.insert(outboxEvents).values({
      id: `obx_${randomUUID()}`,
      workspaceId: input.workspaceId,
      type: 'asset.stock_acquired',
      payload: { assetId, providerId: provider.providerId, providerAssetId: result.providerAssetId, origin, actorType: 'USER', actorId: input.actorId },
    });
  });

  return stockAcquisitionResultSchema.parse({
    assetId,
    versionId,
    origin,
    assetType,
    title: result.title,
    providerId: provider.providerId,
    providerAssetId: result.providerAssetId,
    license: result.license,
    attributionText: result.license.attributionRequired ? result.license.attributionText : null,
  });
}
