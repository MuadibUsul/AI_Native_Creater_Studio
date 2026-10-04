import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

/**
 * Provider 结果回收与 Webhook 事件（P03-06）。
 *
 * - `webhook_events`：**replay 防护**的唯一键 (provider_id, provider_event_id)——
 *   重复回调返回已有记录（幂等 ack），伪造载荷不落库（验签失败直接拒绝）；
 * - `provider_result_states`：每个任务的"待回收结果"状态（临时 URL 与其过期时间不落库为永久标识：
 *   仅保存元数据用于**过期预警**与回收重试；实际内容回收成功即写 asset，URL 不再使用）。
 */

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    /** VERIFIED | REJECTED | DUPLICATE | PROCESSED */
    status: text('status').notNull().default('VERIFIED'),
    payloadHash: text('payload_hash').notNull(),
    jobId: text('job_id'),
    attempt: integer('attempt'),
    note: text('note'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_events_provider_event_uq').on(table.providerId, table.providerEventId),
    index('webhook_events_received_idx').on(table.receivedAt),
    index('webhook_events_job_idx').on(table.jobId),
  ],
);

export const providerResultStates = pgTable(
  'provider_result_states',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    jobId: text('job_id').notNull(),
    providerId: text('provider_id').notNull(),
    providerJobId: text('provider_job_id').notNull(),
    attempt: integer('attempt').notNull().default(0),
    /** PENDING（待回收）| COLLECTED | EXPIRED | FAILED */
    status: text('status').notNull().default('PENDING'),
    /** 待回收结果的元数据（URL 只用于一次性下载；此处保留以便重试回收，不作永久标识） */
    results: jsonb('results').notNull().default([]),
    /** 最早的临时 URL 过期时间（过期预警依据） */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** 回收尝试次数与最后错误（下载失败只重试回收） */
    collectAttempts: integer('collect_attempts').notNull().default(0),
    lastError: jsonb('last_error'),
    bytesCollected: bigint('bytes_collected', { mode: 'number' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    collectedAt: timestamp('collected_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('provider_result_states_workspace_job_uq').on(table.workspaceId, table.jobId),
    index('provider_result_states_status_expiry_idx').on(table.status, table.expiresAt),
  ],
);
