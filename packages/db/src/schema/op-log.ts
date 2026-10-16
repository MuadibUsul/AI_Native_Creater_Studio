import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 项目操作日志（V5 §6.2，M2）：组合（Composition）状态的**权威记录**。
 *
 * - 每个被接受的写批次追加一行；`position` 在项目内从 1 连续递增，唯一键即线性化保证；
 * - `changes` 是物化变更（`put` 完整行 / `delete` id），按顺序折叠即可重建全部组合投影表；
 * - `operations` 是请求的语义操作（审计与将来的内核重放），重建不依赖它；
 * - 首行为 `BASELINE`：日志启用前已存在的组合状态（惰性补齐，见 composition-projector.ts）；
 * - 编辑/补偿/直接写入的 `revision` = 写入后项目 revision，部分唯一索引使并发写在数据库层也只能有一个成功。
 * 投影表（sequence_tracks、sequence_clips 等）只能由投影器写入（arch-check R11）。
 */
export const projectOpLog = pgTable(
  'project_op_log',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    revision: integer('revision').notNull(),
    baseRevision: integer('base_revision').notNull(),
    /** BASELINE | EDIT | COMPENSATION | DIRECT | MIGRATION */
    source: text('source').notNull(),
    operations: jsonb('operations').notNull(),
    changes: jsonb('changes').notNull(),
    actorType: text('actor_type'),
    actorId: text('actor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_op_log_project_position_uq').on(table.projectId, table.position),
    uniqueIndex('project_op_log_project_revision_uq')
      .on(table.projectId, table.revision)
      .where(sql`${table.source} in ('EDIT','COMPENSATION','DIRECT')`),
    index('project_op_log_workspace_idx').on(table.workspaceId),
    check('project_op_log_source_ck', sql`${table.source} in ('BASELINE','EDIT','COMPENSATION','DIRECT','MIGRATION')`),
    check('project_op_log_position_ck', sql`${table.position} >= 1`),
  ],
);

/**
 * 引用图（V5 §14.1，M2）：作品对象 → 被引用对象的边，由投影器随操作日志维护。
 *
 * - `closed_position` 为空 = 当前引用；非空 = 历史引用（对象被删除或改指向时关闭，不删除边）。
 *   历史引用仍受保护：撤销/恢复可以让它重新生效，资产清理必须同时尊重两者；
 * - 日志启用前的引用在迁移时回填（opened_position = 0）。
 */
export const referenceEdges = pgTable(
  'reference_edges',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromKind: text('from_kind').notNull(),
    fromId: text('from_id').notNull(),
    toKind: text('to_kind').notNull(),
    toId: text('to_id').notNull(),
    openedPosition: integer('opened_position').notNull(),
    closedPosition: integer('closed_position'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('reference_edges_open_uq')
      .on(table.projectId, table.fromKind, table.fromId, table.toKind, table.toId)
      .where(sql`${table.closedPosition} is null`),
    index('reference_edges_target_idx').on(table.workspaceId, table.toKind, table.toId),
    index('reference_edges_source_idx').on(table.projectId, table.fromKind, table.fromId),
  ],
);
