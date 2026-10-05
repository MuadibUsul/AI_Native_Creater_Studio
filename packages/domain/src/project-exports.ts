import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ASSET_BUNDLE_EXPORT_VERSION,
  ERROR_CODES,
  GRAPH_EXPORT_VERSION,
  PROJECT_EXPORT_ERROR_REASONS,
  assetBundleExportSchema,
  graphExportSchema,
  type AssetBundleEntry,
  type AssetBundleExcluded,
  type AssetBundleExport,
  type GraphExport,
} from '@ancs/contracts';
import { assetVersions, assets, projects, scenes } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { assembleSceneGraph } from './projects.js';
import { loadReferencedSources } from './search.js';

/**
 * 项目导出（P10-06 / 规范 §85、§26；计划 §8）。
 *
 * - **Graph 导出**：当前 Scene Graph 的可移植 JSON（资产以引用形式携带——**不含 URL/存储键/Secret**）
 *   + 被引用的来源（自包含归档）；
 * - **原素材 Bundle**：**清单 + 逐件签名 URL**（裁决记录在契约 delivery 字段：大文件不经服务端聚合；
 *   zip 归档随打包服务 P13）。**缺权素材明确列出**（许可限制/渲染产物/无可用版本三类原因），
 *   **不静默丢弃**；响应**不含存储键**（签名 URL 为短时能力，不是 Secret）。
 */

/** 软删项目不可导出（Trash 语义：不得从废弃内容产出发布物）。 */
async function loadLiveProject(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<{ id: string; title: string; deletedAt: Date | null }> {
  const rows = await deps.db
    .select({ id: projects.id, title: projects.title, deletedAt: projects.deletedAt })
    .from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  if (row.deletedAt !== null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '项目已删除（Trash）：不可导出', 409, { reason: PROJECT_EXPORT_ERROR_REASONS.PROJECT_TRASHED });
  }
  return row;
}

/** Graph 导出（可移植 JSON；来源自包含）。 */
export async function exportProjectGraph(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<GraphExport> {
  const project = await loadLiveProject(deps, input);
  const graph = await assembleSceneGraph(deps, input);
  const referencedSourceIds = graph.scenes.flatMap((scene) => scene.sourceBindings.map((binding) => binding.sourceId));
  const sources = await loadReferencedSources(deps, { ...input, sourceIds: referencedSourceIds });
  return graphExportSchema.parse({
    schemaVersion: GRAPH_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    projectTitle: project.title,
    graph,
    sources,
  });
}

/* ---------- 原素材 Bundle ---------- */

/** 平台生成/渲染产物不属于"原素材"（成片走受控导出包 P07-06）。 */
const RENDER_ASSET_TYPES = new Set(['DRAFT_RENDER', 'FINAL_VIDEO', 'SHORT_VIDEO', 'MANIFEST', 'SUBTITLE', 'THUMBNAIL']);

/** 可直接导出的 origin（用户内容/用户库/来源素材/AI 生成物——生成物归用户）。 */
const EXPORTABLE_ORIGINS = new Set(['USER_UPLOAD', 'USER_LIBRARY', 'SOURCE_DOCUMENT', 'SOURCE_IMPORT', 'GENERATED', 'PROVIDER_GENERATED', 'PROVIDER_IMPORT']);

/** 受许可约束的 origin（需许可未限制再分发才可打包）。 */
const LICENSE_BOUND_ORIGINS = new Set(['LICENSED_STOCK', 'PUBLIC_SOURCE']);

const basenameOfKey = (key: string): string => key.split('/').pop() ?? key;

export async function exportProjectAssetBundle(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; ttlSeconds?: number },
): Promise<AssetBundleExport> {
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：无法签发下载入口（fail-closed）', 501, {
      reason: PROJECT_EXPORT_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }
  const project = await loadLiveProject(deps, input);

  // 场景绑定角色（供条目 role 标注）
  const sceneRows = await deps.db
    .select({ assetBindings: scenes.assetBindings })
    .from(scenes)
    .where(and(eq(scenes.projectId, project.id), eq(scenes.workspaceId, input.workspaceId)));
  const roleByAssetId = new Map<string, string>();
  for (const row of sceneRows) {
    for (const binding of row.assetBindings as { assetId: string; role: string }[]) {
      if (!roleByAssetId.has(binding.assetId)) roleByAssetId.set(binding.assetId, binding.role);
    }
  }

  // 选择：项目归属资产 ∪ 被项目场景绑定的资产（后者可能 projectId 为空——如素材库直传）
  const boundAssetIds = [...roleByAssetId.keys()];
  const [projectAssetRows, boundAssetRows] = await Promise.all([
    deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.workspaceId, input.workspaceId), eq(assets.projectId, project.id), isNull(assets.deletedAt)))
      .orderBy(assets.createdAt),
    boundAssetIds.length === 0
      ? Promise.resolve([] as (typeof assets.$inferSelect)[])
      : deps.db
          .select()
          .from(assets)
          .where(and(eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt), inArray(assets.id, boundAssetIds)))
          .orderBy(assets.createdAt),
  ]);
  const assetRowById = new Map(projectAssetRows.map((row) => [row.id, row]));
  for (const row of boundAssetRows) assetRowById.set(row.id, row);
  const assetRows = [...assetRowById.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());

  const entries: AssetBundleEntry[] = [];
  const excluded: AssetBundleExcluded[] = [];

  for (const asset of assetRows) {
    const license = (asset.license ?? {}) as { type?: unknown; usageRestrictions?: unknown };
    const licenseType = typeof license.type === 'string' ? license.type : null;

    if (RENDER_ASSET_TYPES.has(asset.assetType)) {
      excluded.push({ assetId: asset.id, assetType: asset.assetType, origin: asset.origin, licenseType, reason: 'RENDER_OUTPUT_NOT_SOURCE_MATERIAL', detail: '渲染/成片产物请使用受控导出包（P07-06）' });
      continue;
    }

    if (LICENSE_BOUND_ORIGINS.has(asset.origin)) {
      const restrictions = typeof license.usageRestrictions === 'string' && license.usageRestrictions.trim() !== '' ? license.usageRestrictions : null;
      const restrictionsFromMetadata = (() => {
        const stock = (asset.metadata as Record<string, unknown>)['stockLicense'] as Record<string, unknown> | undefined;
        const value = stock === undefined ? undefined : stock['usageRestrictions'];
        return typeof value === 'string' && value.trim() !== '' ? value : null;
      })();
      const effectiveRestrictions = restrictions ?? restrictionsFromMetadata;
      if (licenseType === null || licenseType === 'UNKNOWN') {
        excluded.push({ assetId: asset.id, assetType: asset.assetType, origin: asset.origin, licenseType, reason: 'LICENSE_RESTRICTS_REDISTRIBUTION', detail: '许可类型未知/未登记——不得默认可再分发（§84）' });
        continue;
      }
      if (effectiveRestrictions !== null) {
        excluded.push({ assetId: asset.id, assetType: asset.assetType, origin: asset.origin, licenseType, reason: 'LICENSE_RESTRICTS_REDISTRIBUTION', detail: `许可限制：${effectiveRestrictions.slice(0, 200)}` });
        continue;
      }
    } else if (!EXPORTABLE_ORIGINS.has(asset.origin)) {
      excluded.push({ assetId: asset.id, assetType: asset.assetType, origin: asset.origin, licenseType, reason: 'LICENSE_RESTRICTS_REDISTRIBUTION', detail: `origin=${asset.origin} 未在可导出清单内——需人工确认权利` });
      continue;
    }

    // 版本：优先 currentVersionId，否则最新未删版本
    const versionRows = await deps.db
      .select()
      .from(assetVersions)
      .where(and(eq(assetVersions.assetId, asset.id), eq(assetVersions.workspaceId, input.workspaceId), isNull(assetVersions.deletedAt)))
      .orderBy(desc(assetVersions.versionNumber));
    const version = asset.currentVersionId === null ? versionRows[0] : versionRows.find((row) => row.id === asset.currentVersionId) ?? versionRows[0];
    if (version === undefined) {
      excluded.push({ assetId: asset.id, assetType: asset.assetType, origin: asset.origin, licenseType, reason: 'NO_READABLE_VERSION', detail: '无可用版本（未完成上传或版本已删除）' });
      continue;
    }

    const metadata = asset.metadata as Record<string, unknown>;
    const displayName = typeof metadata['title'] === 'string' && metadata['title'] !== '' ? metadata['title'] : basenameOfKey(version.storageKey);
    const target = await storage.createDownloadUrl({ key: version.storageKey, ttlSeconds: input.ttlSeconds ?? 15 * 60, downloadFilename: displayName });
    entries.push({
      assetId: asset.id,
      assetVersionId: version.id,
      assetType: asset.assetType,
      origin: asset.origin,
      role: roleByAssetId.get(asset.id) ?? 'library',
      displayName: displayName.slice(0, 200),
      mimeType: version.mimeType,
      sizeBytes: version.sizeBytes,
      sha256: version.checksumSha256,
      downloadUrl: target.url,
      downloadExpiresAt: target.expiresAt,
    });
  }

  return assetBundleExportSchema.parse({
    schemaVersion: ASSET_BUNDLE_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    projectId: project.id,
    delivery: 'MANIFEST_WITH_SIGNED_URLS',
    entries,
    excluded,
    totals: { included: entries.length, excluded: excluded.length },
  });
}
