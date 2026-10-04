import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';

/**
 * Render 记录（P07-03 / 规范 §28、§39）。
 *
 * - 输入 = **不可变快照引用**（project_version_id + master narration + 资产版本清单）：
 *   渲染中编辑当前项目不影响在途渲染（验收点）；
 * - manifest_hash 与产物资产由 P07-04 填充；状态机单向（QUEUED→RENDERING→QA→READY/FAILED/CANCELLED）。
 */

export const renders = pgTable(
  'renders',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    profile: text('profile').notNull(),
    status: text('status').notNull().default('QUEUED'),
    /** 不可变输入（JSONB：projectVersionId/masterNarrationId/assetVersionIds/format） */
    input: jsonb('input').notNull(),
    estimatedCost: jsonb('estimated_cost'),
    manifestHash: text('manifest_hash'),
    outputAssetIds: jsonb('output_asset_ids').notNull().default([]),
    error: jsonb('error'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('renders_project_idx').on(table.projectId, table.createdAt),
    index('renders_status_idx').on(table.status),
  ],
);

/** 渲染状态迁移审计（谁在何时把渲染推进到哪个状态；P07-05 QA/P07-06 审批消费） */
export const renderEvents = pgTable(
  'render_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull(),
    renderId: text('render_id')
      .notNull()
      .references(() => renders.id, { onDelete: 'cascade' }),
    /** 事件序号（渲染内递增） */
    seq: integer('seq').notNull(),
    status: text('status').notNull(),
    note: text('note'),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('render_events_render_idx').on(table.renderId, table.seq)],
);
