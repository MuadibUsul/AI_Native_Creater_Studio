import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { moneySchema } from './common/money.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Provider Catalog 契约（P03-03 / 计划 P03-03；规范 §14 的 Provider 定位）。
 *
 * 原则：
 * - **数据驱动**：Provider 模型 ID 不得成为核心枚举（§75 第 10 条）——一律以字符串承载，
 *   由 Catalog 版本描述；
 * - **版本化**：任何能力/价格/限额/地区/保留策略变更产生新的 Catalog 版本（与 ChannelStyleVersion 同模式）；
 * - **核验时间**：每个模型条目带 `verifiedAt`；超过 `maxVerificationAgeDays`（默认 30）视为
 *   **过期（stale）**，路由与真实调用必须被明确阻止（"无有效配置时明确阻止真实调用"）；
 * - Catalog 为**平台级配置**（不含 workspace_id；§4.3 不变量针对租户数据）。
 */

export const PROVIDER_KINDS = ['LLM', 'TTS', 'AVATAR', 'AI_VIDEO', 'MUSIC', 'RENDER', 'STORAGE', 'DISTRIBUTION'] as const;
export const providerKindSchema = z.enum(PROVIDER_KINDS);
export type ProviderKind = z.infer<typeof providerKindSchema>;

/** 能力标识（字符串；示例值——新增能力不需要枚举变更） */
export const PROVIDER_CAPABILITIES = [
  'text.generate',
  'text.embed',
  'speech.synthesize',
  'speech.clone',
  'avatar.render',
  'video.generate',
  'video.image_to_video',
  'music.generate',
  'render.video',
  'storage.object',
  'publish.draft',
] as const;

/** 数据保留策略（§75 敏感资料与 Provider 保留） */
export const DATA_RETENTION_POLICIES = ['ZERO_RETENTION', 'STANDARD', 'EXTENDED', 'UNKNOWN'] as const;
export const dataRetentionPolicySchema = z.enum(DATA_RETENTION_POLICIES);
export type DataRetentionPolicy = z.infer<typeof dataRetentionPolicySchema>;

export const MODEL_STATUSES = ['ACTIVE', 'DEPRECATED', 'UNVERIFIED'] as const;
export const modelStatusSchema = z.enum(MODEL_STATUSES);
export type ModelStatus = z.infer<typeof modelStatusSchema>;

/** 计价单位（与 P03-05 成本账本对齐；金额为定点十进制字符串，禁止浮点累计） */
export const PRICE_UNITS = ['CALL', 'SECOND', 'MINUTE', 'CHARACTER', 'IMAGE', 'MILLION_TOKEN', 'GB_MONTH'] as const;
export const priceUnitSchema = z.enum(PRICE_UNITS);
export type PriceUnit = z.infer<typeof priceUnitSchema>;

export const priceProfileSchema = z.object({
  unit: priceUnitSchema,
  /** 单价（定点十进制字符串 + ISO 4217 币种；禁止浮点，钱不丢精度） */
  unitPrice: moneySchema,
  /** 可选：最低计费单位（如按秒但最少 5 秒） */
  minimumUnits: z.number().nonnegative().default(0),
  note: z.string().max(500).nullable().default(null),
});

export type PriceProfile = z.infer<typeof priceProfileSchema>;

export const modelLimitsSchema = z.object({
  /** 并发信号量（REQ-19-03：Provider 并发许可覆盖实际在途任务） */
  maxConcurrency: z.number().int().positive().nullable().default(null),
  maxInputSeconds: z.number().int().positive().nullable().default(null),
  maxInputCharacters: z.number().int().positive().nullable().default(null),
  /** 平台侧限流（每分钟请求） */
  maxRequestsPerMinute: z.number().int().positive().nullable().default(null),
});

export type ModelLimits = z.infer<typeof modelLimitsSchema>;

export const providerModelSchema = z.object({
  /** Provider 内部模型 ID（字符串承载，不做核心枚举） */
  modelId: z.string().min(1).max(200),
  displayName: z.string().min(1).max(200),
  status: modelStatusSchema,
  capabilities: z.array(z.string().min(1)).min(1),
  price: priceProfileSchema,
  limits: modelLimitsSchema.default({ maxConcurrency: null, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null }),
  /** 可用地区（空数组 = 未限定） */
  regions: z.array(z.string().min(1)).default([]),
  dataRetention: dataRetentionPolicySchema,
  residency: z.array(z.string().min(1)).default([]),
  /** 最近一次与真实账号/文档核对的时间（staleness 依据） */
  verifiedAt: isoDateTimeSchema,
  deprecatedAt: isoDateTimeSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProviderModel = z.infer<typeof providerModelSchema>;

export const providerCatalogEntrySchema = z.object({
  providerId: z.string().min(1).max(100),
  providerName: z.string().min(1).max(200),
  kind: providerKindSchema,
  /** 该 Provider 是否需要用户/平台凭据（BYOK 或平台凭据；凭据管理属 P03-04） */
  connectionRequired: z.boolean().default(true),
  /** 支持的保留策略上限（如 ElevenLabs 零保留与不训练分别展示的承载位，规范 §45） */
  capabilities: z.array(z.string().min(1)).default([]),
  models: z.array(providerModelSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ProviderCatalogEntry = z.infer<typeof providerCatalogEntrySchema>;

export const providerCatalogSchema = z.object({
  /** Catalog 版本号（平台级单调递增；变更即新版本） */
  version: z.number().int().positive(),
  entries: z.array(providerCatalogEntrySchema),
  createdAt: isoDateTimeSchema,
  note: z.string().max(500).nullable().default(null),
  createdBy: z.string().nullable().default(null),
});

export type ProviderCatalog = z.infer<typeof providerCatalogSchema>;

/** 模型条目对 Router 的可用性判定（能力筛选 + 状态 + 核验时效 + 地区） */
export const modelAvailabilitySchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  callable: z.boolean(),
  /** 不可调用原因：MISSING / STATUS_UNVERIFIED / STATUS_DEPRECATED / STALE_VERIFICATION / REGION_NOT_ALLOWED */
  reasons: z.array(z.string().min(1)),
  verifiedAt: isoDateTimeSchema,
  verificationAgeDays: z.number().nonnegative(),
});

export type ModelAvailability = z.infer<typeof modelAvailabilitySchema>;

export const DEFAULT_MAX_VERIFICATION_AGE_DAYS = 30;

export const catalogResponseSchema = z.object({
  catalog: providerCatalogSchema.nullable(),
  exists: z.boolean(),
  note: z.string().default(''),
});

export type CatalogResponse = z.infer<typeof catalogResponseSchema>;

export const capabilitySelectionSchema = z.object({
  capability: z.string().min(1),
  region: z.string().min(1).optional(),
  /** 仅返回可真实调用的模型（默认 true：无有效配置时不得静默降级） */
  callableOnly: z.boolean().default(true),
  candidates: z.array(modelAvailabilitySchema),
});

export type CapabilitySelection = z.infer<typeof capabilitySelectionSchema>;

export const catalogSeedRequestSchema = z.object({
  note: z.string().max(500).optional(),
  entries: z.array(providerCatalogEntrySchema).min(1),
});

export type CatalogSeedRequest = z.infer<typeof catalogSeedRequestSchema>;

export const CATALOG_ERROR_REASONS = {
  CATALOG_MISSING: 'CATALOG_MISSING',
  MODEL_NOT_FOUND: 'MODEL_NOT_FOUND',
  MODEL_NOT_CALLABLE: 'MODEL_NOT_CALLABLE',
} as const;

export const catalogApiId = { providerIdExample: opaqueIdSchema };
