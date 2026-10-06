import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 发布记录（P13-01 / §90；计划 §8 P13）。
 *
 * - **幂等键固定四元组唯一**（platform + account + projectVersion + outputAsset）——
 *   重复请求只形成一个逻辑发布（冲突 → 返回既有行，deduped=true）；
 * - 状态机单向（QUEUED→PUBLISHING→PUBLISHED/FAILED）；**结果未知时先查询和对账，不自动重发**
 *   （reconcile 以 Provider getStatus 为准回填，绝不重发）；
 * - 未批准版本不能发布（闸门在 domain：Render 批准 + manifestHash 对账）。
 */
export const publications = pgTable(
  'publications',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    platformId: text('platform_id').notNull(),
    accountId: text('account_id').notNull(),
    projectVersionId: text('project_version_id').notNull(),
    outputAssetId: text('output_asset_id').notNull(),
    /** QUEUED→PUBLISHING→PUBLISHED/FAILED（状态机单向，§90） */
    state: text('state').notNull().default('QUEUED'),
    remoteId: text('remote_id'),
    remoteUrl: text('remote_url'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    title: text('title').notNull(),
    description: text('description'),
    tags: jsonb('tags').notNull().default([]),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
    disclosure: text('disclosure'),
    lastError: text('last_error'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('publications_platform_account_version_output_uq').on(
      table.platformId,
      table.accountId,
      table.projectVersionId,
      table.outputAssetId,
    ),
    index('publications_project_idx').on(table.projectId, table.createdAt),
  ],
);
