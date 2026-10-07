import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * P4 导出包（P13-04 / §42）：只追加——每个平台包一行（payload 引用资产 + 文案 + 披露 + 手工清单）。
 * **最后一步恒为"由用户在平台完成发布"**（finalStepByUser=true；本系统不代发 P4 平台）。
 */
export const exportPackages = pgTable(
  'export_packages',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    platformId: text('platform_id').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('export_packages_project_idx').on(table.projectId, table.createdAt)],
);
