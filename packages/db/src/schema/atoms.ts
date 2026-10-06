import { index, jsonb, pgTable, text, timestamp, uniqueIndex, integer } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Content Atom 与 Channel Recipe（P11-02 / §93.2—93.4）。
 * - Atom：可独立传播单元；source_refs（claim/source 引用）为追溯载体——**不允许无来源 Atom**；
 * - Recipe：channelKey+version 唯一的**版本化需求数据**（同 Plan 范式；评估引擎只消费 requirements）。
 */
export const contentAtoms = pgTable(
  'content_atoms',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    text: text('text').notNull(),
    sourceRefs: jsonb('source_refs').notNull(),
    payload: jsonb('payload').notNull().default({}),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('content_atoms_project_idx').on(table.projectId, table.createdAt)],
);

export const channelRecipes = pgTable(
  'channel_recipes',
  {
    id: text('id').primaryKey(),
    channelKey: text('channel_key').notNull(),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull(),
    requirements: jsonb('requirements').notNull(),
    status: text('status').notNull().default('ACTIVE'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('channel_recipes_key_version_uq').on(table.channelKey, table.version)],
);
