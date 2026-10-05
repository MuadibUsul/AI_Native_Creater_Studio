import { z } from 'zod';
import { isoDateTimeSchema } from './common/time.js';
import { assetOriginSchema, type AssetOrigin } from './assets.js';

/**
 * 素材获取契约（P10-03 / 规范 §84、§12、§14；计划 §8）。
 *
 * - **搜索素材有许可状态**：每条结果携带 license（类型/引用/署名要求/限制/来源 URL）；
 *   `licenseType = null`（或 UNKNOWN）**不得视为已授权**——`usable=false` + 明确原因（不冒充）；
 * - **生成图不冒充证据**：`origin` 记录来源类别；GENERATED 素材不得作为"来源/证据"被引用
 *   （QA 检查 `EVIDENCE_ASSET_ORIGIN` 在证据类场景上阻止）；
 * - Runway（AI Video）复用 `GenerationProvider`（P03-07 范式）；真实提交在**凭据 + 端点核验**前 fail-closed。
 */

/** 许可类型（§84：LICENSED_STOCK 需引用；PUBLIC_SOURCE 需来源 URL 与署名判断） */
export const ASSET_LICENSE_TYPES = ['LICENSED_STOCK', 'PUBLIC_SOURCE', 'CREATIVE_COMMONS', 'PUBLIC_DOMAIN', 'UNKNOWN'] as const;
export const assetLicenseTypeSchema = z.enum(ASSET_LICENSE_TYPES);
export type AssetLicenseType = z.infer<typeof assetLicenseTypeSchema>;

/** 素材许可元数据（独立字段；**不得以空值冒充已授权**） */
export const assetLicenseSchema = z.object({
  licenseType: assetLicenseTypeSchema.nullable().default(null),
  /** 许可证编号/购买凭证引用（LICENSED_STOCK 应提供） */
  licenseReference: z.string().max(300).nullable().default(null),
  attributionRequired: z.boolean().default(false),
  /** 需署名时必须有可生成的署名文本（缺失 → 不可用） */
  attributionText: z.string().max(500).nullable().default(null),
  usageRestrictions: z.string().max(500).nullable().default(null),
  sourceUrl: z.string().max(1000).nullable().default(null),
  acquiredAt: isoDateTimeSchema.nullable().default(null),
});

export type AssetLicense = z.infer<typeof assetLicenseSchema>;

/** 可用性判定（纯函数；**空许可/UNKNOWN/缺署名文本 一律不可用**） */
export function stockResultUsability(license: AssetLicense): { usable: boolean; reason: string | null } {
  if (license.licenseType === null) return { usable: false, reason: 'NO_LICENSE' };
  if (license.licenseType === 'UNKNOWN') return { usable: false, reason: 'LICENSE_UNKNOWN' };
  if (license.attributionRequired && (license.attributionText === null || license.attributionText.trim() === '')) {
    return { usable: false, reason: 'ATTRIBUTION_TEXT_MISSING' };
  }
  return { usable: true, reason: null };
}

/** 生成素材不得作为"来源/证据"（§84：真实媒体素材与 AI 生成素材 metadata 可区分） */
export function originMayServeAsEvidence(origin: AssetOrigin): boolean {
  // GENERATED / PROVIDER_GENERATED 均属生成，不得作为来源/证据
  return origin !== 'GENERATED' && origin !== 'PROVIDER_GENERATED';
}

export const STOCK_ASSET_KINDS = ['IMAGE', 'VIDEO', 'MUSIC'] as const;
export const stockAssetKindSchema = z.enum(STOCK_ASSET_KINDS);
export type StockAssetKind = z.infer<typeof stockAssetKindSchema>;

export const stockSearchResultSchema = z.object({
  providerId: z.string().min(1).max(60),
  providerAssetId: z.string().min(1).max(200),
  kind: stockAssetKindSchema,
  title: z.string().min(1).max(300),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  previewUrl: z.string().max(1000).nullable().default(null),
  license: assetLicenseSchema,
  /** 由 stockResultUsability 计算（前端据此禁用"获取"按钮并展示原因） */
  usable: z.boolean(),
  unusableReason: z.string().max(60).nullable().default(null),
});

export type StockSearchResult = z.infer<typeof stockSearchResultSchema>;

/** 获取结果（入库后的资产引用；license/attribution 已固化——供署名自动生成与审计） */
export const stockAcquisitionResultSchema = z.object({
  assetId: z.string().min(1),
  versionId: z.string().min(1),
  origin: assetOriginSchema,
  assetType: z.string().min(1).max(60),
  title: z.string().min(1).max(300),
  providerId: z.string().min(1).max(60),
  providerAssetId: z.string().min(1).max(200),
  license: assetLicenseSchema,
  /** 需署名时的自动署名文本（可直接并入 Description/Sources；null = 无需署名） */
  attributionText: z.string().max(500).nullable().default(null),
});

export type StockAcquisitionResult = z.infer<typeof stockAcquisitionResultSchema>;

export interface StockSearchRequest {
  query: string;
  kind: StockAssetKind;
  limit?: number;
  /** 仅返回 usable 结果（默认 false——不可用结果可见但明确标注） */
  usableOnly?: boolean;
}

/** 素材搜索 seam（真实 Provider 随凭据接入；Mock 同构） */
export interface AssetSearchProvider {
  readonly providerId: string;
  search(input: StockSearchRequest): Promise<StockSearchResult[]>;
  /** 按 Provider 资产 ID 复核（**获取前必须服务端复核许可**——不信任客户端提交的 license 字段） */
  lookup(input: { providerAssetId: string }): Promise<StockSearchResult | null>;
  /** 获取原始字节（服务端入库；**下载凭据不外发客户端**） */
  fetchAsset(input: { providerAssetId: string }): Promise<{ bytes: Uint8Array; contentType: string }>;
}

export const STOCK_ERROR_REASONS = {
  /** 搜索 Provider 未装配（501 fail-closed） */
  SEARCH_PROVIDER_UNAVAILABLE: 'SEARCH_PROVIDER_UNAVAILABLE',
  /** 结果不可用（无许可/UNKNOWN/缺署名）——**不得冒充已授权** */
  LICENSE_REQUIRED: 'LICENSE_REQUIRED',
  /** 结果不存在 */
  RESULT_NOT_FOUND: 'RESULT_NOT_FOUND',
} as const;

export const ASSET_SEARCH_MAX_BYTES = 200 * 1024 * 1024;
