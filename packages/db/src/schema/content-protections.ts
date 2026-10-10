import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * N06-07：已确认内容保护指纹。
 *
 * 这不是第二份作品状态：只存"用户确认过的对象在确认时刻的三轴指纹"，用于事后核对
 * （内容/时位/资产是否仍引用相同资产与参数）与阻止意外移位被自动采用。
 */
export const contentProtections = pgTable(
  'content_protections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    label: text('label'),
    /** 采集指纹时的工程 revision（仅作对照） */
    capturedRevision: integer('captured_revision').notNull(),
    scope: text('scope').notNull(),
    objects: jsonb('objects').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('content_protections_project_idx').on(table.workspaceId, table.projectId, table.createdAt),
  ],
);
