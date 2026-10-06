import { jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Pack 生命周期（P11-03 / §92）：安装（平台级，官方随启动幂等）→ 启用（workspace 级，权益门）→
 * 绑定（project 级，**版本锁定**）。manifest 快照随安装固化（运行时以快照能力为准）。
 */
export const packInstallations = pgTable(
  'pack_installations',
  {
    id: text('id').primaryKey(),
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    name: text('name').notNull(),
    capabilities: jsonb('capabilities').notNull().default([]),
    outputFormats: jsonb('output_formats').notNull().default([]),
    official: text('official').notNull().default('true'),
    status: text('status').notNull().default('INSTALLED'),
    manifest: jsonb('manifest').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('pack_installations_pack_version_uq').on(table.packId, table.version)],
);

export const packEnablements = pgTable(
  'pack_enablements',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    enabledAt: timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('pack_enablements_workspace_pack_uq').on(table.workspaceId, table.packId)],
);

export const projectPackBindings = pgTable(
  'project_pack_bindings',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    packId: text('pack_id').notNull(),
    version: text('version').notNull(),
    boundAt: timestamp('bound_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('project_pack_bindings_project_pack_uq').on(table.projectId, table.packId)],
);
