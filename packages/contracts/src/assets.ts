import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { uploadTargetSchema } from './storage.js';

/**
 * 资产契约（P02-04 / 规范 §22.5、§26、§27；计划 §4.2"资产"：Asset、AssetVersion、
 * UploadIntent、LicenseMetadata、RetentionClass）。
 *
 * - Asset = 逻辑身份（类型/来源/授权/保留策略/当前版本）；AssetVersion = 不可变的对象事实
 *   （storage_key/size/checksum/探测元数据）——替换内容 = 新版本，不覆盖旧行；
 * - 数据库只存 storage_key；下载经 Signed URL（CDN/对象存储），不经 API 流式代理（§26.2）；
 * - workspace 内按 SHA-256 去重（§26.3）；不做跨 Workspace 物理去重。
 */

export const ASSET_TYPES = [
  'SOURCE_DOCUMENT',
  'SOURCE_IMAGE',
  'USER_UPLOAD',
  'AVATAR_CLIP',
  'VOICE_AUDIO',
  'MUSIC',
  'GENERATED_IMAGE',
  'GENERATED_VIDEO',
  'CHART_RENDER',
  'CUSTOM_MOTION_RENDER',
  'SUBTITLE',
  'DRAFT_RENDER',
  'FINAL_VIDEO',
  'SHORT_VIDEO',
  'THUMBNAIL',
  'MANIFEST',
] as const;

export const assetTypeSchema = z.enum(ASSET_TYPES);
export type AssetType = z.infer<typeof assetTypeSchema>;

export const ASSET_ORIGINS = [
  'USER_UPLOAD',
  /** §84 新枚举：用户素材库 */
  'USER_LIBRARY',
  /** §84：来源文档（与旧值 SOURCE_IMPORT 并存） */
  'SOURCE_DOCUMENT',
  /** §84：授权素材库（需 license_reference） */
  'LICENSED_STOCK',
  /** §84：公开来源（需 source_url 与署名判断） */
  'PUBLIC_SOURCE',
  /** §84：AI 生成（**不得冒充证据**） */
  'GENERATED',
  /** §84：Provider 导入 */
  'PROVIDER_IMPORT',
  // —— P02-04 旧值（向后兼容；新代码不新增使用） ——
  'SOURCE_IMPORT',
  'PROVIDER_GENERATED',
  'SYSTEM_RENDER',
] as const;
export const assetOriginSchema = z.enum(ASSET_ORIGINS);
export type AssetOrigin = z.infer<typeof assetOriginSchema>;

export const ASSET_STATUSES = ['PENDING_UPLOAD', 'PROCESSING', 'READY', 'FAILED', 'DELETED'] as const;
export const assetStatusSchema = z.enum(ASSET_STATUSES);
export type AssetStatus = z.infer<typeof assetStatusSchema>;

export const ASSET_VERSION_STATUSES = ['UPLOADING', 'READY', 'FAILED', 'SUPERSEDED'] as const;
export const assetVersionStatusSchema = z.enum(ASSET_VERSION_STATUSES);
export type AssetVersionStatus = z.infer<typeof assetVersionStatusSchema>;

export const MEDIA_PROBE_STATUSES = ['NOT_REQUIRED', 'PENDING', 'PROCESSING', 'READY', 'FAILED'] as const;
export const mediaProbeStatusSchema = z.enum(MEDIA_PROBE_STATUSES);
export type MediaProbeStatus = z.infer<typeof mediaProbeStatusSchema>;

export const MEDIA_CAPABILITY_STATES = ['AVAILABLE', 'PROXY_REQUIRED', 'TRANSCODE_REQUIRED', 'UNAVAILABLE', 'UNKNOWN'] as const;
export const mediaCapabilityStateSchema = z.enum(MEDIA_CAPABILITY_STATES);
export type MediaCapabilityState = z.infer<typeof mediaCapabilityStateSchema>;

const integerStringSchema = z.string().regex(/^-?\d+$/);
export const mediaRationalSchema = z.object({
  numerator: z.number().int(),
  denominator: z.number().int().positive(),
});
export type MediaRational = z.infer<typeof mediaRationalSchema>;

export const mediaStreamProbeSchema = z.object({
  index: z.number().int().nonnegative(),
  type: z.enum(['VIDEO', 'AUDIO', 'SUBTITLE', 'DATA', 'ATTACHMENT', 'UNKNOWN']),
  codecName: z.string().nullable(),
  codecLongName: z.string().nullable(),
  profile: z.string().nullable(),
  timeBase: mediaRationalSchema.nullable(),
  startPts: integerStringSchema.nullable(),
  durationTicks: integerStringSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  rotationDegrees: z.number().int().min(-360).max(360).nullable(),
  pixelFormat: z.string().nullable(),
  colorRange: z.string().nullable(),
  colorSpace: z.string().nullable(),
  colorTransfer: z.string().nullable(),
  colorPrimaries: z.string().nullable(),
  nominalFrameRate: mediaRationalSchema.nullable(),
  averageFrameRate: mediaRationalSchema.nullable(),
  frameCount: integerStringSchema.nullable(),
  sampleRate: z.number().int().positive().nullable(),
  channels: z.number().int().positive().nullable(),
  channelLayout: z.string().nullable(),
  cadence: z.enum(['CONSTANT', 'VARIABLE', 'UNKNOWN']),
  sampledPacketCount: z.number().int().nonnegative(),
  sampledPtsDeltaTicks: z.array(integerStringSchema).max(32),
});
export type MediaStreamProbe = z.infer<typeof mediaStreamProbeSchema>;

export const mediaCapabilitySummarySchema = z.object({
  upload: mediaCapabilityStateSchema,
  decode: mediaCapabilityStateSchema,
  preview: mediaCapabilityStateSchema,
  export: mediaCapabilityStateSchema,
  reasons: z.array(
    z.object({
      code: z.string().min(1).max(80),
      message: z.string().min(1).max(500),
      nextAction: z.string().min(1).max(500).nullable(),
    }),
  ),
});
export type MediaCapabilitySummary = z.infer<typeof mediaCapabilitySummarySchema>;

export const sourceMediaProbeResultSchema = z.object({
  schemaVersion: z.literal('1.0'),
  status: z.enum(['READY', 'FAILED']),
  formatNames: z.array(z.string().min(1)).max(20),
  formatLongName: z.string().nullable(),
  startTimeMs: z.number().int().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  bitRate: z.number().int().nonnegative().nullable(),
  streams: z.array(mediaStreamProbeSchema).max(128),
  decodeCheck: z.object({
    status: z.enum(['PASSED', 'FAILED']),
    errorCode: z.string().max(80).nullable(),
    message: z.string().max(500).nullable(),
  }),
  capabilities: mediaCapabilitySummarySchema,
});
export type SourceMediaProbeResult = z.infer<typeof sourceMediaProbeResultSchema>;

export const mediaProbeJobInputSchema = z.object({
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  storageKey: z.string().min(1).max(512),
  declaredMimeType: z.string().min(3).max(120),
});
export type MediaProbeJobInput = z.infer<typeof mediaProbeJobInputSchema>;

/** Worker I/O seam；实现必须在隔离子进程中探测，不让解析器在 API/domain 进程内执行。 */
export interface SourceMediaProbe {
  readonly kind: string;
  probe(input: { filePath: string; declaredMimeType: string }): Promise<SourceMediaProbeResult>;
}

/** Scene 资产绑定角色（与 assetBindingSchema.role 对齐；P02-04 定稿） */
export const ASSET_ROLES = ['visual', 'audio', 'avatar', 'broll', 'music', 'thumbnail', 'voice_sample', 'source', 'chart', 'subtitle'] as const;
export const assetRoleSchema = z.enum(ASSET_ROLES);
export type AssetRole = z.infer<typeof assetRoleSchema>;

/** 保留策略类（规范 §27 默认表；TTL 的执行属清理 Worker，P02-05） */
export const RETENTION_CLASSES = [
  'KEEP_FINAL',
  'KEEP_USER_SOURCE',
  'KEEP_PAID_GENERATED',
  'DRAFT_RENDER_30D',
  'PREVIEW_CACHE_7D',
  'TEMP_TRANSCODE_72H',
  'PROVIDER_TEMP',
] as const;

export const retentionClassSchema = z.enum(RETENTION_CLASSES);
export type RetentionClass = z.infer<typeof retentionClassSchema>;

export const RETENTION_TTL_SECONDS: Readonly<Record<RetentionClass, number | null>> = {
  KEEP_FINAL: null,
  KEEP_USER_SOURCE: null,
  KEEP_PAID_GENERATED: null,
  DRAFT_RENDER_30D: 30 * 24 * 60 * 60,
  PREVIEW_CACHE_7D: 7 * 24 * 60 * 60,
  TEMP_TRANSCODE_72H: 72 * 60 * 60,
  PROVIDER_TEMP: 24 * 60 * 60,
};

/** 资产类型的默认保留类（规范 §27；Preview Cache 属 DRAFT_RENDER 之外的系统缓存，随 P05-04 接入时另立类型） */
export const ASSET_DEFAULT_RETENTION: Readonly<Record<AssetType, RetentionClass>> = {
  SOURCE_DOCUMENT: 'KEEP_USER_SOURCE',
  SOURCE_IMAGE: 'KEEP_USER_SOURCE',
  USER_UPLOAD: 'KEEP_USER_SOURCE',
  AVATAR_CLIP: 'KEEP_PAID_GENERATED',
  VOICE_AUDIO: 'KEEP_PAID_GENERATED',
  MUSIC: 'KEEP_USER_SOURCE',
  GENERATED_IMAGE: 'KEEP_PAID_GENERATED',
  GENERATED_VIDEO: 'KEEP_PAID_GENERATED',
  CHART_RENDER: 'KEEP_FINAL',
  CUSTOM_MOTION_RENDER: 'KEEP_FINAL',
  SUBTITLE: 'KEEP_FINAL',
  DRAFT_RENDER: 'DRAFT_RENDER_30D',
  FINAL_VIDEO: 'KEEP_FINAL',
  SHORT_VIDEO: 'KEEP_FINAL',
  THUMBNAIL: 'KEEP_FINAL',
  MANIFEST: 'KEEP_FINAL',
};

/** 授权元数据（LicenseMetadata）：用于资产来源/授权状态审计（§24、§67） */
export const LICENSE_TYPES = ['USER_OWNED', 'LICENSED', 'PUBLIC_DOMAIN', 'PROVIDER_TERMS', 'UNKNOWN'] as const;
export const ASSET_PERMITTED_USES = ['EDIT', 'PUBLISH', 'COMMERCIAL', 'AI_ANALYSIS', 'MODEL_TRAINING'] as const;
export const assetPermittedUseSchema = z.enum(ASSET_PERMITTED_USES);
export const ASSET_SENSITIVITY_CLASSES = ['PUBLIC', 'INTERNAL', 'SENSITIVE', 'RESTRICTED'] as const;
export const assetSensitivityClassSchema = z.enum(ASSET_SENSITIVITY_CLASSES);
export const licenseMetadataSchema = z.object({
  type: z.enum(LICENSE_TYPES),
  holder: z.string().max(200).nullable().default(null),
  attribution: z.string().max(500).nullable().default(null),
  sourceUrl: z.string().max(2000).nullable().default(null),
  termsUrl: z.string().max(2000).nullable().default(null),
  notes: z.string().max(1000).nullable().default(null),
  confirmedBy: z.string().nullable().default(null),
  confirmedAt: isoDateTimeSchema.nullable().default(null),
  userOwnedDeclared: z.boolean().default(false),
  permittedUses: z.array(assetPermittedUseSchema).max(ASSET_PERMITTED_USES.length).default(['EDIT', 'PUBLISH']),
  expiresAt: isoDateTimeSchema.nullable().default(null),
});

export type LicenseMetadata = z.infer<typeof licenseMetadataSchema>;

/** 上传意图阶段的授权声明（仅创作者可填写；服务端按来源设置默认值与 confirmedAt） */
export const licenseInputSchema = z.object({
  type: z.enum(LICENSE_TYPES),
  holder: z.string().max(200).optional(),
  attribution: z.string().max(500).optional(),
  sourceUrl: z.string().max(2000).optional(),
  termsUrl: z.string().max(2000).optional(),
  notes: z.string().max(1000).optional(),
  userOwnedDeclared: z.boolean().optional(),
  permittedUses: z.array(assetPermittedUseSchema).max(ASSET_PERMITTED_USES.length).optional(),
  expiresAt: isoDateTimeSchema.nullable().optional(),
});

export const updateAssetRightsRequestSchema = z.object({
  type: z.enum(LICENSE_TYPES),
  holder: z.string().trim().max(200).nullable(),
  attribution: z.string().trim().max(500).nullable(),
  sourceUrl: z.string().url().max(2000).nullable(),
  termsUrl: z.string().url().max(2000).nullable(),
  notes: z.string().trim().max(1000).nullable(),
  userOwnedDeclared: z.boolean(),
  permittedUses: z.array(assetPermittedUseSchema).max(ASSET_PERMITTED_USES.length),
  expiresAt: isoDateTimeSchema.nullable(),
  sensitivityClass: assetSensitivityClassSchema,
}).strict().superRefine((value, context) => {
  if (value.type === 'USER_OWNED' && !value.userOwnedDeclared) {
    context.addIssue({ code: 'custom', path: ['userOwnedDeclared'], message: '自有素材必须明确声明权利' });
  }
  if (value.type !== 'USER_OWNED' && value.userOwnedDeclared) {
    context.addIssue({ code: 'custom', path: ['userOwnedDeclared'], message: '仅自有素材可作自有权利声明' });
  }
});
export type UpdateAssetRightsRequest = z.infer<typeof updateAssetRightsRequestSchema>;

export const assetVersionSchema = z.object({
  id: opaqueIdSchema,
  assetId: opaqueIdSchema,
  versionNumber: z.number().int().positive(),
  /** 只存 storage_key（§26：不得把 Object URL 作为永久标识） */
  storageKey: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  /** READY 版本必有（服务端计算/校验）；UPLOADING/FAILED 为空 */
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable()
    .default(null),
  durationMs: z.number().int().nonnegative().nullable().default(null),
  width: z.number().int().positive().nullable().default(null),
  height: z.number().int().positive().nullable().default(null),
  status: assetVersionStatusSchema,
  probeStatus: mediaProbeStatusSchema.default('NOT_REQUIRED'),
  mediaProbe: sourceMediaProbeResultSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema,
});

export type AssetVersion = z.infer<typeof assetVersionSchema>;

export const assetSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema.nullable().default(null),
  sceneId: opaqueIdSchema.nullable().default(null),
  assetType: assetTypeSchema,
  origin: assetOriginSchema,
  provider: z.string().nullable().default(null),
  providerAssetId: z.string().nullable().default(null),
  status: assetStatusSchema,
  retentionClass: retentionClassSchema,
  license: licenseMetadataSchema,
  sensitivityClass: assetSensitivityClassSchema.default('INTERNAL'),
  privacyDeletionRequestedAt: isoDateTimeSchema.nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  currentVersionId: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Asset = z.infer<typeof assetSchema>;

export const assetDetailSchema = assetSchema.extend({
  versions: z.array(assetVersionSchema),
});

export type AssetDetail = z.infer<typeof assetDetailSchema>;

export const assetReferenceSchema = z.object({
  kind: z.enum(['SCENE', 'PROJECT_VERSION']),
  projectId: opaqueIdSchema,
  projectTitle: z.string().min(1),
  projectRevision: z.number().int().nonnegative(),
  sceneId: opaqueIdSchema.nullable(),
  sceneRevision: z.number().int().nonnegative().nullable(),
  role: assetRoleSchema.nullable(),
  projectVersionId: opaqueIdSchema.nullable(),
  versionNumber: z.number().int().positive().nullable(),
  versionReason: z.string().nullable(),
});
export type AssetReference = z.infer<typeof assetReferenceSchema>;

export const assetDerivationSchema = z.object({
  direction: z.enum(['SOURCE', 'DERIVED']),
  kind: z.string().min(1).max(80),
  assetId: opaqueIdSchema,
  assetVersionId: opaqueIdSchema,
  relatedAssetId: opaqueIdSchema,
  relatedAssetVersionId: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
});
export type AssetDerivation = z.infer<typeof assetDerivationSchema>;

export const assetLicenseStateSchema = z.enum(['ACTIVE', 'EXPIRED', 'PUBLISH_NOT_PERMITTED', 'UNCONFIRMED']);
export const assetLifecycleSchema = z.object({
  asset: assetSchema,
  licenseState: assetLicenseStateSchema,
  references: z.array(assetReferenceSchema),
  derivations: z.array(assetDerivationSchema),
  gcProtected: z.boolean(),
  gcProtectionReasons: z.array(z.enum(['ACTIVE_SCENE_REFERENCE', 'FROZEN_VERSION_REFERENCE', 'DERIVATION_REFERENCE'])),
});
export type AssetLifecycle = z.infer<typeof assetLifecycleSchema>;

export const requestAssetPrivacyDeletionSchema = z.object({
  confirmationAssetId: opaqueIdSchema,
  reason: z.string().trim().min(1).max(500),
}).strict();
export type RequestAssetPrivacyDeletion = z.infer<typeof requestAssetPrivacyDeletionSchema>;

export const assetPrivacyDeletionResultSchema = z.object({
  assetId: opaqueIdSchema,
  status: z.enum(['SCHEDULED', 'DEFERRED_BY_REFERENCES']),
  requestedAt: isoDateTimeSchema,
  missingDependencies: z.array(assetReferenceSchema),
});
export type AssetPrivacyDeletionResult = z.infer<typeof assetPrivacyDeletionResultSchema>;

/** 单文件上限 5 GiB（§26.1：大文件必须直传对象存储，不经 Web App Server） */
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_UPLOAD_PART_SIZE_BYTES = 8 * 1024 * 1024;
export const MAX_UPLOAD_PARTS = 10_000;
export const MULTIPART_UPLOAD_INTENT_TTL_SECONDS = 24 * 60 * 60;

export const uploadModeSchema = z.enum(['SINGLE', 'MULTIPART']);
export type UploadMode = z.infer<typeof uploadModeSchema>;

export const createUploadIntentRequestSchema = z.object({
  assetType: assetTypeSchema,
  filename: z.string().min(1).max(255),
  /** 声明的内容类型（可能被嗅探结果推翻；白名单见 ASSET_MIME_ALLOWLIST） */
  contentType: z.string().min(3).max(120),
  sizeBytes: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  projectId: opaqueIdSchema.nullable().default(null),
  sceneId: opaqueIdSchema.nullable().default(null),
  /** 客户端预计算的 SHA-256（可选；提供则用于上传前去重与完整性校验） */
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  license: licenseInputSchema.optional(),
  /** 新客户端统一使用 MULTIPART；SINGLE 仅保留旧 SDK/API 兼容。 */
  uploadMode: uploadModeSchema.default('SINGLE'),
  partSizeBytes: z.number().int().min(256 * 1024).max(64 * 1024 * 1024).optional(),
});

export type CreateUploadIntentRequest = z.infer<typeof createUploadIntentRequestSchema>;
/** 请求入参（含 default 字段可省略）：服务层/SDK 对外签名使用 */
export type CreateUploadIntentInput = z.input<typeof createUploadIntentRequestSchema>;

export const uploadIntentResponseSchema = z
  .object({
    /** 直传意图（命中 workspace 内哈希去重时为 null：未创建对象，直接绑定 existingAsset） */
    intentId: opaqueIdSchema.nullable(),
    /** 直传目标（Signed URL，带作用域与 TTL） */
    upload: uploadTargetSchema.nullable(),
    expiresAt: isoDateTimeSchema.nullable(),
    /** 命中 workspace 内哈希去重：未创建新对象，客户端可直接绑定 asset */
    deduped: z.boolean(),
    asset: assetSchema,
    uploadMode: uploadModeSchema.default('SINGLE'),
    partSizeBytes: z.number().int().positive().nullable().default(null),
    partCount: z.number().int().positive().nullable().default(null),
  })
  .refine((value) => (value.deduped ? value.upload === null && value.intentId === null : value.intentId !== null), {
    message: 'deduped 与 upload/intentId 必须一致（去重时无直传目标）',
  })
  .refine((value) => (value.deduped || value.uploadMode !== 'MULTIPART' ? true : value.upload === null && value.partSizeBytes !== null && value.partCount !== null), {
    message: 'MULTIPART 意图必须返回分片参数且不返回整对象上传地址',
  });

export type UploadIntentResponse = z.infer<typeof uploadIntentResponseSchema>;

export const uploadPartStatusSchema = z.enum(['PENDING', 'COMPLETED']);
export const uploadPartSchema = z.object({
  partNumber: z.number().int().positive(),
  status: uploadPartStatusSchema,
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().default(null),
  completedAt: isoDateTimeSchema.nullable().default(null),
});
export type UploadPart = z.infer<typeof uploadPartSchema>;

export const uploadIntentStatusSchema = z.object({
  intentId: opaqueIdSchema,
  assetId: opaqueIdSchema,
  status: z.enum(['PENDING', 'COMPLETED', 'EXPIRED', 'FAILED', 'CANCELLED']),
  uploadMode: uploadModeSchema,
  partSizeBytes: z.number().int().positive().nullable(),
  partCount: z.number().int().positive().nullable(),
  expiresAt: isoDateTimeSchema,
  parts: z.array(uploadPartSchema),
});
export type UploadIntentStatus = z.infer<typeof uploadIntentStatusSchema>;

export const uploadPartTargetResponseSchema = z.object({
  partNumber: z.number().int().positive(),
  alreadyCompleted: z.boolean(),
  upload: uploadTargetSchema.nullable(),
});
export type UploadPartTargetResponse = z.infer<typeof uploadPartTargetResponseSchema>;

export const completeUploadPartRequestSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type CompleteUploadPartRequest = z.infer<typeof completeUploadPartRequestSchema>;

export const confirmUploadRequestSchema = z.object({
  checksumSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  /** 媒体元数据（服务端能真实探测的字段以探测为准；其余按声明记录于 declared 元数据） */
  durationMs: z.number().int().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export type ConfirmUploadRequest = z.infer<typeof confirmUploadRequestSchema>;

export const downloadUrlResponseSchema = z.object({
  assetId: opaqueIdSchema,
  versionId: opaqueIdSchema,
  url: z.string().min(1),
  expiresAt: isoDateTimeSchema,
});

export type DownloadUrlResponse = z.infer<typeof downloadUrlResponseSchema>;

/** 可经上传意图**直传**的资产类型（生成类资产由 Provider 回收链路创建，P03-06/P06） */
export const DIRECT_UPLOAD_ASSET_TYPES: readonly AssetType[] = [
  'SOURCE_DOCUMENT',
  'SOURCE_IMAGE',
  'USER_UPLOAD',
  'AVATAR_CLIP',
  'VOICE_AUDIO',
  'MUSIC',
  'THUMBNAIL',
  'SUBTITLE',
];
