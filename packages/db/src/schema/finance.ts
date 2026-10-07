import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';

export const financeDataSources = pgTable('finance_data_sources', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  sourceUrl: text('source_url'),
  license: jsonb('license').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('finance_data_sources_workspace_idx').on(table.workspaceId, table.createdAt)]);

export const financeTemplates = pgTable('finance_templates', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  version: integer('version').notNull(),
  name: text('name').notNull(),
  visualizationType: text('visualization_type').notNull(),
  config: jsonb('config').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('finance_templates_key_version_uq').on(table.workspaceId, table.key, table.version),
  index('finance_templates_workspace_idx').on(table.workspaceId, table.createdAt),
]);

export const financeArtifacts = pgTable('finance_artifacts', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  visualizationType: text('visualization_type').notNull(),
  title: text('title').notNull(),
  dataSourceSnapshot: jsonb('data_source_snapshot').notNull(),
  templateSnapshot: jsonb('template_snapshot').notNull(),
  data: jsonb('data').notNull(),
  relations: jsonb('relations').notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [index('finance_artifacts_workspace_idx').on(table.workspaceId, table.createdAt)]);
