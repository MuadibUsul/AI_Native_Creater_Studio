import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import type { ValidationResult } from './extensions.js';

/**
 * 发布契约（规范 §42 / §90 / P01-06，DEC-06：V1 完成契约、能力分级与幂等键类型；
 * 真实发布体验在 Publishing Pack 阶段（P13）验收）。
 */

/** Capability Tier（§42.1）：P 级来自 Capability Registry 的运行时数据，禁止硬编码 */
export const PUBLISH_CAPABILITY_TIERS = [
  'P1_DIRECT_PUBLISH',
  'P2_AUTHORIZED_PUBLISH',
  'P3_UPLOAD_DRAFT',
  'P4_EXPORT_PACKAGE',
] as const;

export const publishCapabilityTierSchema = z.enum(PUBLISH_CAPABILITY_TIERS);
export type PublishCapabilityTier = z.infer<typeof publishCapabilityTierSchema>;

/** 平台能力枚举（§42.2） */
export const DISTRIBUTION_CAPABILITIES = [
  'DIRECT_PUBLISH',
  'CONFIRM_TO_PUBLISH',
  'UPLOAD_DRAFT',
  'EXPORT_PACKAGE',
  'SCHEDULING',
  'THUMBNAIL',
  'CAPTION_DESCRIPTION',
  'ANALYTICS',
  'DELETE_REMOTE',
  'UPDATE_METADATA',
  'AIGC_DISCLOSURE',
] as const;

export const distributionCapabilitySchema = z.enum(DISTRIBUTION_CAPABILITIES);
export type DistributionCapability = z.infer<typeof distributionCapabilitySchema>;

export const distributionCapabilitiesSchema = z.object({
  tier: publishCapabilityTierSchema,
  capabilities: z.array(distributionCapabilitySchema).default([]),
  notes: z.string().nullable().default(null),
});

export type DistributionCapabilities = z.infer<typeof distributionCapabilitiesSchema>;

/** 发布状态机（§90） */
export const PUBLICATION_STATES = ['DRAFT', 'QUEUED', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'DELETED_REMOTE'] as const;

export const publicationStatusSchema = z.object({
  state: z.enum(PUBLICATION_STATES),
  remoteId: z.string().nullable().default(null),
  remoteUrl: z.string().nullable().default(null),
  publishedAt: isoDateTimeSchema.nullable().default(null),
});

export type PublicationStatus = z.infer<typeof publicationStatusSchema>;

/** 发布幂等键（§90 MUST：platform + account + projectVersion + outputAsset） */
export const publicationKeySchema = z.object({
  platformId: z.string().min(1),
  accountId: z.string().min(1),
  projectVersionId: opaqueIdSchema,
  outputAssetId: opaqueIdSchema,
});

export type PublicationKey = z.infer<typeof publicationKeySchema>;

export const publicationRequestSchema = z.object({
  publicationKey: publicationKeySchema,
  title: z.string().min(1).max(300),
  description: z.string().max(5000).nullable().default(null),
  tags: z.array(z.string().min(1).max(60)).default([]),
  scheduledAt: isoDateTimeSchema.nullable().default(null),
  /** AIGC 披露文本等（平台政策要求时） */
  disclosure: z.string().nullable().default(null),
});

export type PublicationRequest = z.infer<typeof publicationRequestSchema>;

export const draftTransferResultSchema = z.object({
  transferId: z.string().min(1),
  /** 在目标平台打开 Draft 的地址（如可用） */
  openUrl: z.string().nullable().default(null),
  instructions: z.string().nullable().default(null),
});

export type DraftTransferResult = z.infer<typeof draftTransferResultSchema>;

/** ---------- DistributionProvider 接口数据形状（§42.2；字段随 P13 接入时增量扩展） ---------- */

export const providerContextSchema = z.object({
  workspaceId: opaqueIdSchema,
  providerConnectionId: opaqueIdSchema.nullable().default(null),
});

export type ProviderContext = z.infer<typeof providerContextSchema>;

export const authorizationRequestSchema = z.object({
  redirectUri: z.string().min(1),
  scopes: z.array(z.string().min(1)).default([]),
});

export const authorizationResultSchema = z.object({
  authorizationUrl: z.string().min(1),
});

export const publicationJobSchema = z.object({
  jobId: z.string().min(1),
  state: z.enum(PUBLICATION_STATES),
});

export const updatePublicationRequestSchema = z.object({
  remoteId: z.string().min(1),
  title: z.string().min(1).max(300).nullable().default(null),
  description: z.string().max(5000).nullable().default(null),
});

export const analyticsRequestSchema = z.object({
  remoteId: z.string().min(1),
  from: isoDateTimeSchema.nullable().default(null),
  to: isoDateTimeSchema.nullable().default(null),
});

export type AnalyticsRequest = z.infer<typeof analyticsRequestSchema>;

export const platformAnalyticsSchema = z.object({
  platformId: z.string().min(1),
  fetchedAt: isoDateTimeSchema,
  /** 指标口径随平台而异；缺失数据保持未知（不写零，§41） */
  metrics: z.record(z.string(), z.unknown()),
});

export type PlatformAnalytics = z.infer<typeof platformAnalyticsSchema>;

export const revokeRequestSchema = z.object({
  remoteId: z.string().min(1),
});

export const validatePublicationSchema = publicationRequestSchema;

/**
 * DistributionProvider 行为接口（§42.2 原文方法集）：
 * 可选方法以能力分级决定是否实现（例如 P4 平台不提供 publish/uploadDraft）。
 */
export interface DistributionProvider {
  providerId: string;
  capabilities(ctx: ProviderContext): Promise<DistributionCapabilities>;
  authorize?(req: AuthorizationRequest): Promise<AuthorizationResult>;
  validate(req: PublicationRequest): Promise<ValidationResult>;
  publish?(req: PublicationRequest): Promise<PublicationJob>;
  uploadDraft?(req: PublicationRequest): Promise<DraftTransferResult>;
  getStatus?(remoteId: string): Promise<PublicationStatus>;
  updateMetadata?(req: UpdatePublicationRequest): Promise<void>;
  fetchAnalytics?(req: AnalyticsRequest): Promise<PlatformAnalytics>;
  revoke?(req: RevokeRequest): Promise<void>;
}

export type AuthorizationRequest = z.infer<typeof authorizationRequestSchema>;
export type AuthorizationResult = z.infer<typeof authorizationResultSchema>;
export type PublicationJob = z.infer<typeof publicationJobSchema>;
export type UpdatePublicationRequest = z.infer<typeof updatePublicationRequestSchema>;
export type RevokeRequest = z.infer<typeof revokeRequestSchema>;

/** 注册表中的分发 Provider 描述（/capabilities 端点使用） */
export const distributionProviderRegistrationSchema = z.object({
  providerId: z.string().min(1),
  capabilities: distributionCapabilitiesSchema,
});

export type DistributionProviderRegistration = z.infer<typeof distributionProviderRegistrationSchema>;
