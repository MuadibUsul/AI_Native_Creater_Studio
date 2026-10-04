import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Provider 结果回收与 Webhook 契约（P03-06 / 规范 §30、§31、§33.4、§75 第 5 条）。
 *
 * 纪律（本任务验收）：
 * - **结果必须立即拉回自有存储**：Provider/临时 URL 只用于一次性下载，DB 只留 storage_key
 *   （AC-10：Provider URL 失效后已完成资产仍可用）；
 * - **下载失败不重生成**（AC-09）：回收失败只重试回收（不再向 Provider 提交付费请求）；
 * - **Webhook 必须校验签名 / 防 replay / 幂等处理**（§33.4、AC-08）：伪造被拒；重复事件只生效一次；
 *   迟到结果登记但不得覆盖不匹配的输入（AC-05）。
 */

export const WEBHOOK_VERIFICATION_STATUSES = ['VERIFIED', 'REJECTED', 'DUPLICATE', 'PROCESSED'] as const;
export const webhookVerificationStatusSchema = z.enum(WEBHOOK_VERIFICATION_STATUSES);
export type WebhookVerificationStatus = z.infer<typeof webhookVerificationStatusSchema>;

/** Webhook 事件记录（审计与 replay 防护的事实来源） */
export const webhookEventSchema = z.object({
  id: opaqueIdSchema,
  providerId: z.string().min(1).max(100),
  /** Provider 侧事件 id（replay 防护的键：同 Provider 同事件只生效一次） */
  providerEventId: z.string().min(1).max(200),
  status: webhookVerificationStatusSchema,
  /** 载荷摘要（原始载荷不落库；必要时经加密存储另行处理） */
  payloadHash: z.string().min(1).max(128),
  jobId: z.string().nullable().default(null),
  attempt: z.number().int().nonnegative().nullable().default(null),
  receivedAt: isoDateTimeSchema,
  processedAt: isoDateTimeSchema.nullable().default(null),
  note: z.string().max(500).nullable().default(null),
});

export type WebhookEvent = z.infer<typeof webhookEventSchema>;

/** Provider 回调载荷（V1 统一形态；各适配器在吸收版本差异后归一化，§45） */
export const providerCallbackSchema = z.object({
  /** Provider 侧事件 id（幂等键） */
  eventId: z.string().min(1).max(200),
  eventType: z.enum(['job.succeeded', 'job.failed', 'job.progress']),
  providerJobId: z.string().min(1).max(200),
  /** 生成尝试序号（乱序/迟到判定：小于当前 attempt 的结果只登记不应用） */
  attempt: z.number().int().nonnegative().default(0),
  /** 结果描述（成功时）：URL 均为**临时**地址，必须立即回收（§75 第 5 条） */
  results: z
    .array(
      z.object({
        /** 临时下载地址（Provider/签名 URL） */
        url: z.string().min(1),
        contentType: z.string().min(1).max(120),
        sizeBytes: z.number().int().nonnegative().nullable().default(null),
        checksumSha256: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .nullable()
          .default(null),
        /** 资产类型（回收后落库的 Asset.assetType） */
        assetType: z.string().min(1).max(40).default('GENERATED_VIDEO'),
        /** 临时 URL 的过期时间（过期预警依据） */
        expiresAt: isoDateTimeSchema.nullable().default(null),
      }),
    )
    .default([]),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
});

export type ProviderCallback = z.infer<typeof providerCallbackSchema>;

/** 回收结果（服务层返回；含落库后的资产引用） */
export const resultCollectionSchema = z.object({
  jobId: z.string().min(1),
  collected: z.number().int().nonnegative(),
  assets: z
    .array(
      z.object({
        assetId: opaqueIdSchema,
        assetVersionId: opaqueIdSchema,
        storageKey: z.string().min(1),
        mimeType: z.string().min(1),
        sizeBytes: z.number().int().nonnegative(),
        checksumSha256: z.string().min(1),
      }),
    )
    .default([]),
  /** 回收失败时的可重试信息（下载失败 → 只重试回收，不重新生成） */
  failure: z
    .object({
      reason: z.string().min(1),
      message: z.string().max(500),
      retryable: z.boolean(),
    })
    .nullable()
    .default(null),
});

export type ResultCollection = z.infer<typeof resultCollectionSchema>;

export const collectRequestSchema = z.object({
  /** 人工恢复入口（§5.5：回调/轮询/人工恢复共用同一状态迁移服务） */
  providerJobId: z.string().min(1).max(200),
  results: providerCallbackSchema.shape.results,
});

export type CollectRequest = z.infer<typeof collectRequestSchema>;

/**
 * 结果拉取器（HTTP 等 I/O 由宿主注入；domain 不直接访问网络）。
 * 实现：apps/worker 的 HTTP 实现（fetch + 大小上限）；测试注入脚本化实现。
 */
export interface ResultFetcher {
  readonly kind: string;
  fetch(input: { url: string; maxBytes?: number }): Promise<{ bytes: Uint8Array; contentType: string | null }>;
}

/**
 * Webhook 验签器：按 providerId 匹配（V1 提供 HMAC-SHA256 + 时间窗 的通用实现；
 * 各 Provider 的签名细节由适配器在 P06 归一化后复用同一接口）。
 */
export interface WebhookVerifier {
  providerId: string;
  verify(input: {
    headers: Record<string, string | undefined>;
    rawBody: string;
    now?: Date;
  }): { ok: boolean; reason?: string };
}

/** 默认验签头（可被适配器覆盖）：X-ANCS-Timestamp / X-ANCS-Signature = HMAC-SHA256(ts + '.' + body) */
export const WEBHOOK_SIGNATURE_HEADER = 'x-ancs-signature';
export const WEBHOOK_TIMESTAMP_HEADER = 'x-ancs-timestamp';
export const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;

export const WEBHOOK_REJECTION_REASONS = {
  UNKNOWN_PROVIDER: 'UNKNOWN_PROVIDER',
  MISSING_SIGNATURE: 'MISSING_SIGNATURE',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  TIMESTAMP_OUT_OF_WINDOW: 'TIMESTAMP_OUT_OF_WINDOW',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
} as const;
