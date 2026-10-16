import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { user } from './auth.js';
import { projectSequences } from './composition.js';
import { jobs } from './jobs.js';
import { projects } from './projects.js';
import { proposals } from './proposals.js';
import { workspaces } from './workspaces.js';

/**
 * V6 §7.4：低清预览（改哪里渲染哪里）。
 *
 * - `sequence_previews`：一次预览请求（当前版本或某个提案）。计划（RenderPlan）随行冻结——提案的试改计划
 *   在事务内编译后回滚，工程不变；同一序列 + 同一计划哈希只渲一次（部分唯一索引）。
 * - `preview_segments`：按内容哈希缓存的已渲染片段（视频时间窗 / 整条声音），跨版本、跨提案复用。
 *   缓存键 = 切片计划哈希 + 预览档位 + 后端；片段对象可按最近使用时间回收（不是权威产物）。
 */
export const sequencePreviews = pgTable(
  'sequence_previews',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id').notNull().references(() => projectSequences.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    projectRevision: integer('project_revision').notNull(),
    proposalId: text('proposal_id').references(() => proposals.id, { onDelete: 'set null' }),
    planHash: text('plan_hash').notNull(),
    plan: jsonb('plan').notNull(),
    profile: jsonb('profile').notNull(),
    status: text('status').notNull().default('QUEUED'),
    storageKey: text('storage_key'),
    segmentsTotal: integer('segments_total').notNull().default(0),
    segmentsReused: integer('segments_reused').notNull().default(0),
    segmentsRendered: integer('segments_rendered').notNull().default(0),
    renderMs: integer('render_ms'),
    error: jsonb('error'),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('sequence_previews_plan_uq').on(table.workspaceId, table.sequenceId, table.planHash).where(sql`${table.status} in ('QUEUED','RENDERING','READY')`),
    index('sequence_previews_sequence_idx').on(table.sequenceId, table.createdAt),
    check('sequence_previews_source_ck', sql`${table.source} in ('REVISION','PROPOSAL')`),
    check('sequence_previews_status_ck', sql`${table.status} in ('QUEUED','RENDERING','READY','FAILED')`),
    check('sequence_previews_plan_hash_ck', sql`${table.planHash} ~ '^[0-9a-f]{64}$'`),
  ],
);

export const previewSegments = pgTable(
  'preview_segments',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    cacheKey: text('cache_key').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('preview_segments_key_uq').on(table.workspaceId, table.kind, table.cacheKey),
    index('preview_segments_last_used_idx').on(table.workspaceId, table.lastUsedAt),
    check('preview_segments_kind_ck', sql`${table.kind} in ('VIDEO','AUDIO')`),
    check('preview_segments_cache_key_ck', sql`${table.cacheKey} ~ '^[0-9a-f]{64}$'`),
  ],
);
