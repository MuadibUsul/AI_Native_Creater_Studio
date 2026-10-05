import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { sceneGraphSchema } from './scene-graph.js';
import { outputSourceEntrySchema } from './output-enhancements.js';

/**
 * 工作区搜索与导出契约（P10-06 / 规范 §62、§85、§26；计划 §8）。
 *
 * 硬约束（验收）：**搜索遵守租户与删除状态**（workspace 作用域 + 软删一律排除，测试锁定）；
 * **Bundle 无 Secret**；**缺权素材明确列出**（不打包、不静默丢弃）。
 * Component 维度来自内置目录快照（BUILTIN_COMPONENT_CATALOG，漂移测试锁定）。
 */

export const SEARCH_ENTITY_KINDS = ['PROJECT', 'SCENE', 'SOURCE', 'ASSET', 'COMPONENT'] as const;
export const searchEntityKindSchema = z.enum(SEARCH_ENTITY_KINDS);
export type SearchEntityKind = z.infer<typeof searchEntityKindSchema>;

export const searchResultItemSchema = z.object({
  kind: searchEntityKindSchema,
  id: z.string().min(1).max(128),
  title: z.string().min(1).max(300),
  /** 副标题（类型/发布者/资产类型等；null = 无） */
  subtitle: z.string().max(200).nullable().default(null),
  projectId: opaqueIdSchema.nullable().default(null),
  /** 深链（前端路由；COMPONENT 为 null） */
  path: z.string().max(500).nullable().default(null),
  /** 命中字段（可解释性：不黑箱） */
  matchedFields: z.array(z.string().max(60)).default([]),
});

export type SearchResultItem = z.infer<typeof searchResultItemSchema>;

export const searchResponseSchema = z.object({
  query: z.string().min(1).max(200),
  items: z.array(searchResultItemSchema),
  /** 各维度命中计数（截断前；便于 UI 提示"还有更多"） */
  totals: z.record(z.string(), z.number().int().nonnegative()),
  truncated: z.boolean().default(false),
});

export type SearchResponse = z.infer<typeof searchResponseSchema>;

export const SEARCH_ERROR_REASONS = {
  /** 查询过短（< 2 字符；防止全表扫描与无意义检索） */
  QUERY_TOO_SHORT: 'QUERY_TOO_SHORT',
} as const;

/* ---------- Graph 导出（可移植 JSON；无 Secret/无临时 URL） ---------- */

export const GRAPH_EXPORT_VERSION = 'graph-export-v1' as const;

export const graphExportSchema = z.object({
  schemaVersion: z.literal(GRAPH_EXPORT_VERSION),
  exportedAt: isoDateTimeSchema,
  projectId: opaqueIdSchema,
  projectTitle: z.string().min(1).max(300),
  /** 当前 Scene Graph（资产以引用形式携带：assetId/role——不含任何 URL/Secret/存储键） */
  graph: sceneGraphSchema,
  /** 快照来源（被场景引用的 project_sources；自包含便于归档） */
  sources: z.array(outputSourceEntrySchema),
});

export type GraphExport = z.infer<typeof graphExportSchema>;

/* ---------- 原素材 Bundle（清单 + 逐件签名 URL；缺权明确列出） ---------- */

export const ASSET_BUNDLE_EXPORT_VERSION = 'asset-bundle-v1' as const;

export const assetBundleEntrySchema = z.object({
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  assetType: z.string().min(1).max(60),
  origin: z.string().min(1).max(40),
  /** 场景绑定角色（未绑定 = 'library'） */
  role: z.string().min(1).max(40),
  /** 展示名（metadata.title ?? 存储键文件名；不含存储键原文） */
  displayName: z.string().min(1).max(200),
  mimeType: z.string().min(1).max(120),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
  /** 签名下载入口（TTL 短时；**不含存储键**） */
  downloadUrl: z.string().min(1).max(2000),
  downloadExpiresAt: isoDateTimeSchema.nullable().default(null),
});

export type AssetBundleEntry = z.infer<typeof assetBundleEntrySchema>;

export const assetBundleExcludedSchema = z.object({
  assetId: opaqueIdSchema,
  assetType: z.string().min(1).max(60),
  origin: z.string().min(1).max(40),
  licenseType: z.string().max(40).nullable().default(null),
  /** 明确原因（不静默丢弃） */
  reason: z.enum(['LICENSE_RESTRICTS_REDISTRIBUTION', 'RENDER_OUTPUT_NOT_SOURCE_MATERIAL', 'NO_READABLE_VERSION']),
  detail: z.string().max(300).nullable().default(null),
});

export type AssetBundleExcluded = z.infer<typeof assetBundleExcludedSchema>;

export const assetBundleExportSchema = z.object({
  schemaVersion: z.literal(ASSET_BUNDLE_EXPORT_VERSION),
  exportedAt: isoDateTimeSchema,
  projectId: opaqueIdSchema,
  /** 本任务裁决：**清单 + 逐件签名 URL**（大文件不经服务端聚合；zip 归档随打包服务 P13）。 */
  delivery: z.literal('MANIFEST_WITH_SIGNED_URLS'),
  entries: z.array(assetBundleEntrySchema),
  excluded: z.array(assetBundleExcludedSchema),
  totals: z.object({ included: z.number().int().nonnegative(), excluded: z.number().int().nonnegative() }),
});

export type AssetBundleExport = z.infer<typeof assetBundleExportSchema>;

export const PROJECT_EXPORT_ERROR_REASONS = {
  /** 项目已删除（软删）——不可导出 */
  PROJECT_TRASHED: 'PROJECT_TRASHED',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type ProjectExportErrorReason = (typeof PROJECT_EXPORT_ERROR_REASONS)[keyof typeof PROJECT_EXPORT_ERROR_REASONS];
