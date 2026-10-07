import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { contentDocuments } from './content.js';
import { jobs } from './jobs.js';
import { projects } from './projects.js';
import { renders } from './renders.js';
import { workspaces } from './workspaces.js';

/**
 * CMS 摄取记录（P13-06 / §88；计划 §8 P13）：
 * - **事件幂等唯一索引**（workspace + source + externalId + contentHash）——重放不重复建项目/文档；
 * - 同 externalId 不同 contentHash = 正文变化 → 新来源版本（新 ContentDocument，同项目）。
 */
export const cmsIngestions = pgTable(
  'cms_ingestions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    contentHash: text('content_hash').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => contentDocuments.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('INGESTED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cms_ingestions_event_uq').on(table.workspaceId, table.source, table.externalId, table.contentHash),
    index('cms_ingestions_lookup_idx').on(table.workspaceId, table.source, table.externalId),
  ],
);

/**
 * CMS 回写目标（P13-07）：V1 每 workspace 一个；Secret 仅保存 AES-256-GCM 密文封套。
 */
export const cmsWritebackTargets = pgTable(
  'cms_writeback_targets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    callbackUrl: text('callback_url').notNull(),
    encryptedSigningSecret: jsonb('encrypted_signing_secret').notNull(),
    maskedSecret: text('masked_secret').notNull(),
    keyVersion: text('key_version').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('cms_writeback_targets_workspace_uq').on(table.workspaceId),
    index('cms_writeback_targets_status_idx').on(table.workspaceId, table.status),
  ],
);

/** 每次物理发送一行；deliveryId 跨自动/人工重试保持不变。 */
export const cmsWritebackAttempts = pgTable(
  'cms_writeback_attempts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    targetId: text('target_id')
      .notNull()
      .references(() => cmsWritebackTargets.id, { onDelete: 'cascade' }),
    ingestionId: text('ingestion_id')
      .notNull()
      .references(() => cmsIngestions.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    renderId: text('render_id')
      .notNull()
      .references(() => renders.id, { onDelete: 'cascade' }),
    jobId: text('job_id')
      .notNull()
      .references(() => jobs.id, { onDelete: 'cascade' }),
    deliveryId: text('delivery_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    jobAttempt: integer('job_attempt').notNull(),
    status: text('status').notNull().default('PENDING'),
    requestUrl: text('request_url').notNull(),
    requestPayload: jsonb('request_payload').notNull(),
    requestBodySha256: text('request_body_sha256').notNull(),
    signatureKeyVersion: text('signature_key_version'),
    responseStatus: integer('response_status'),
    responseHeaders: jsonb('response_headers').notNull().default({}),
    responseBodyPreview: text('response_body_preview'),
    responseTruncated: boolean('response_truncated').notNull().default(false),
    errorReason: text('error_reason'),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cms_writeback_attempts_delivery_attempt_uq').on(table.deliveryId, table.attemptNumber),
    uniqueIndex('cms_writeback_attempts_job_attempt_uq').on(table.jobId, table.jobAttempt),
    uniqueIndex('cms_writeback_attempts_first_delivery_uq')
      .on(table.targetId, table.renderId)
      .where(sql`${table.attemptNumber} = 1`),
    index('cms_writeback_attempts_workspace_idx').on(table.workspaceId, table.createdAt),
    index('cms_writeback_attempts_render_idx').on(table.renderId, table.attemptNumber),
  ],
);
