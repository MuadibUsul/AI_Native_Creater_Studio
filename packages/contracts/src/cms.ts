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

export const CMS_ERROR_REASONS = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  EMPTY_CONTENT: 'EMPTY_CONTENT',
  FETCH_FAILED: 'FETCH_FAILED',
} as const;

export type CmsErrorReason = (typeof CMS_ERROR_REASONS)[keyof typeof CMS_ERROR_REASONS];
