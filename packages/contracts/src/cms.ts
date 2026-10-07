import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * CMS 输入契约（P13-06 / §4.2、§88；计划 §8 P13）。
 *
 * 纪律（验收："同一 CMS 事件重放不重复建项目；正文变化产生新来源版本"）：
 * - **事件幂等 = (workspace, source, externalId, contentHash) 唯一索引**——重放（同内容）返回既有摄取
 *   （deduped=true，不重复建项目/文档）；
 * - **正文变化 = 同 externalId 新 contentHash** → 摄取进**同一项目**为**新 ContentDocument**（新来源版本——
 *   旧来源版本不被覆盖，来源版本历史保留）；
 * - contentHash 基于**内容字节**（HTML/抓取结果），而非 URL（同文异链不误判为变化）。
 */

export const CMS_SOURCES = ['RSS', 'CMS_WEBHOOK', 'ARTICLE_PUBLISH'] as const;
export const cmsSourceSchema = z.enum(CMS_SOURCES);
export type CmsSource = z.infer<typeof cmsSourceSchema>;

export const CMS_INGESTION_STATUSES = ['INGESTED', 'NEW_SOURCE_VERSION'] as const;
export const cmsIngestionStatusSchema = z.enum(CMS_INGESTION_STATUSES);
export type CmsIngestionStatus = z.infer<typeof cmsIngestionStatusSchema>;

/** 事件内容（二选一：URL 交给抓取器 / HTML 直供） */
export const cmsEventContentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('URL'), url: z.string().min(1).max(2048) }),
  z.object({ kind: z.literal('HTML'), html: z.string().min(1).max(2_000_000) }),
]);

export type CmsEventContent = z.infer<typeof cmsEventContentSchema>;

export const ingestCmsEventRequestSchema = z.object({
  source: cmsSourceSchema,
  /** CMS 侧文章唯一 ID（幂等/版本键的一半） */
  externalId: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  /** 摄取目标栏目（机器创建项目归入该栏目） */
  channelId: opaqueIdSchema,
  content: cmsEventContentSchema,
});

export type IngestCmsEventRequest = z.infer<typeof ingestCmsEventRequestSchema>;

export const cmsIngestionRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  source: cmsSourceSchema,
  externalId: z.string().min(1).max(200),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  projectId: opaqueIdSchema,
  documentId: opaqueIdSchema,
  status: cmsIngestionStatusSchema,
  createdAt: isoDateTimeSchema,
});

export type CmsIngestionRecord = z.infer<typeof cmsIngestionRecordSchema>;

/** 摄取响应 = 记录 + deduped（重放命中既有摄取——不重复建项目）+ 项目/文档引用 */
export const ingestCmsEventResponseSchema = z.object({
  ingestion: cmsIngestionRecordSchema,
  deduped: z.boolean(),
  projectId: opaqueIdSchema,
  documentId: opaqueIdSchema,
  /** 正文变化 = 新来源版本（同项目新 ContentDocument） */
  newSourceVersion: z.boolean(),
});

export type IngestCmsEventResponse = z.infer<typeof ingestCmsEventResponseSchema>;

export const cmsIngestionListSchema = z.object({
  items: z.array(cmsIngestionRecordSchema),
});

export type CmsIngestionList = z.infer<typeof cmsIngestionListSchema>;

/** ---------- CMS 回写（P13-07 / §88） ---------- */

export const CMS_WRITEBACK_JOB_TYPE = 'CMS_WRITEBACK';
export const CMS_WRITEBACK_EVENT_TYPE = 'creator_video.render.ready_for_review';
export const CMS_WRITEBACK_SIGNATURE_HEADER = 'x-ancs-signature';
export const CMS_WRITEBACK_TIMESTAMP_HEADER = 'x-ancs-timestamp';
export const CMS_WRITEBACK_DELIVERY_HEADER = 'x-ancs-delivery-id';
export const CMS_WRITEBACK_EVENT_HEADER = 'x-ancs-event';

export const CMS_WRITEBACK_TARGET_STATUSES = ['ACTIVE', 'DISABLED'] as const;
export const cmsWritebackTargetStatusSchema = z.enum(CMS_WRITEBACK_TARGET_STATUSES);
export type CmsWritebackTargetStatus = z.infer<typeof cmsWritebackTargetStatusSchema>;

export const CMS_WRITEBACK_ATTEMPT_STATUSES = ['PENDING', 'SUCCEEDED', 'FAILED_RETRYABLE', 'FAILED_FINAL', 'UNKNOWN'] as const;
export const cmsWritebackAttemptStatusSchema = z.enum(CMS_WRITEBACK_ATTEMPT_STATUSES);
export type CmsWritebackAttemptStatus = z.infer<typeof cmsWritebackAttemptStatusSchema>;

export const cmsWritebackTargetSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  callbackUrl: z.string().url().max(2048),
  status: cmsWritebackTargetStatusSchema,
  maskedSecret: z.string().min(1).max(64),
  keyVersion: z.string().min(1).max(32),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  rotatedAt: isoDateTimeSchema.nullable().default(null),
});
export type CmsWritebackTarget = z.infer<typeof cmsWritebackTargetSchema>;

export const upsertCmsWritebackTargetRequestSchema = z
  .object({
    callbackUrl: z.string().min(1).max(2048).optional(),
    /** 仅入站；服务端立即加密且永不回显。 */
    signingSecret: z.string().min(16).max(4096).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.callbackUrl !== undefined || value.signingSecret !== undefined || value.enabled !== undefined, {
    message: '至少提供 callbackUrl、signingSecret 或 enabled 之一',
  });
export type UpsertCmsWritebackTargetRequest = z.infer<typeof upsertCmsWritebackTargetRequestSchema>;

export const cmsWritebackPayloadSchema = z.object({
  schemaVersion: z.literal('1.0'),
  eventType: z.literal(CMS_WRITEBACK_EVENT_TYPE),
  deliveryId: opaqueIdSchema,
  occurredAt: isoDateTimeSchema,
  workspaceId: opaqueIdSchema,
  source: z.object({
    type: cmsSourceSchema,
    externalId: z.string().min(1).max(200),
  }),
  artifact: z.object({
    projectId: opaqueIdSchema,
    projectVersionId: opaqueIdSchema,
    renderId: opaqueIdSchema,
    renderStatus: z.literal('READY'),
    approvalRequired: z.literal(true),
    manifestHash: z.string().min(1),
    outputAssetIds: z.array(opaqueIdSchema),
  }),
});
export type CmsWritebackPayload = z.infer<typeof cmsWritebackPayloadSchema>;

export const cmsWritebackAttemptSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  targetId: opaqueIdSchema,
  ingestionId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  renderId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  deliveryId: opaqueIdSchema,
  attemptNumber: z.number().int().positive(),
  jobAttempt: z.number().int().positive(),
  status: cmsWritebackAttemptStatusSchema,
  requestUrl: z.string().url().max(2048),
  requestPayload: cmsWritebackPayloadSchema,
  requestBodySha256: z.string().regex(/^[0-9a-f]{64}$/),
  signatureKeyVersion: z.string().min(1).max(32).nullable().default(null),
  responseStatus: z.number().int().min(100).max(599).nullable().default(null),
  responseHeaders: z.record(z.string(), z.string()).default({}),
  responseBodyPreview: z.string().max(16_384).nullable().default(null),
  responseTruncated: z.boolean().default(false),
  errorReason: z.string().max(100).nullable().default(null),
  errorMessage: z.string().max(500).nullable().default(null),
  startedAt: isoDateTimeSchema.nullable().default(null),
  completedAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});
export type CmsWritebackAttempt = z.infer<typeof cmsWritebackAttemptSchema>;

export const cmsWritebackAttemptListSchema = z.object({ items: z.array(cmsWritebackAttemptSchema) });
export type CmsWritebackAttemptList = z.infer<typeof cmsWritebackAttemptListSchema>;

export const retryCmsWritebackResponseSchema = z.object({
  deliveryId: opaqueIdSchema,
  jobId: opaqueIdSchema,
  status: z.literal('QUEUED'),
});
export type RetryCmsWritebackResponse = z.infer<typeof retryCmsWritebackResponseSchema>;

export interface CmsWritebackSender {
  readonly kind: string;
  send(input: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
    timeoutMs: number;
    maxResponseBytes: number;
  }): Promise<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: string;
    truncated: boolean;
  }>;
}

export const CMS_ERROR_REASONS = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  FETCH_FAILED: 'FETCH_FAILED',
  WRITEBACK_TARGET_NOT_CONFIGURED: 'WRITEBACK_TARGET_NOT_CONFIGURED',
  WRITEBACK_TARGET_DISABLED: 'WRITEBACK_TARGET_DISABLED',
  WRITEBACK_DELIVERY_NOT_FOUND: 'WRITEBACK_DELIVERY_NOT_FOUND',
  WRITEBACK_NOT_RETRYABLE: 'WRITEBACK_NOT_RETRYABLE',
  WRITEBACK_BLOCKED_TARGET: 'WRITEBACK_BLOCKED_TARGET',
  WRITEBACK_HTTP_ERROR: 'WRITEBACK_HTTP_ERROR',
  WRITEBACK_NETWORK_ERROR: 'WRITEBACK_NETWORK_ERROR',
} as const;

export type CmsErrorReason = (typeof CMS_ERROR_REASONS)[keyof typeof CMS_ERROR_REASONS];
