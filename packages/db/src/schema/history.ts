import { bigserial, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 编辑历史与事务性 Outbox（P02-02 / 规范 §23、计划 §4.6 第 7 步）。
 *
 * - EditEvent 与状态变更、Outbox **在同一事务提交**（已接受的任务不丢失）；
 * - seq 为单调递增序号：同一事务内多事件 createdAt 相同，恢复重放/Undo 分析依赖 seq 定序；
 * - outbox_events 由消费者（P02-06 事件通道、后续通知）标记 published_at；
 * - Audit Log 是独立的一套（§24），自 P02-06/P08-02 建立。
 */

export const editEvents = pgTable(
  'edit_events',
  {
    id: text('id').primaryKey(),
    /** 单调事件序号（恢复重放与补偿链路的确定性顺序） */
    seq: bigserial('seq', { mode: 'number' }).notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sceneId: text('scene_id'),
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id'),
    action: text('action').notNull(),
    /** 补偿事件指向被补偿的原事件（Undo/Redo 链路，§4.8） */
    compensatesEventId: text('compensates_event_id'),
    intentText: text('intent_text'),
    /** 显式操作对象（不是任意数据库补丁） */
    patch: jsonb('patch').notNull(),
    baseRevision: integer('base_revision').notNull(),
    resultRevision: integer('result_revision').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('edit_events_project_seq_idx').on(table.projectId, table.seq),
    index('edit_events_project_created_idx').on(table.projectId, table.createdAt),
    index('edit_events_workspace_idx').on(table.workspaceId),
  ],
);

export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (table) => [index('outbox_events_pending_idx').on(table.publishedAt, table.createdAt)],
);
