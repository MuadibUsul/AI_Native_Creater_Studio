import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 输入归一化与内容来源（P04-01 / 规范 §7、§22.1、§22.2、§85）。
 *
 * - `content_documents`：规范化后的 ContentDocument 头（标题/语言/作者/来源/发布时间 + 归一化元数据）；
 * - `content_blocks`：文档块（**规范化记录**，不把整篇塞进一个大 JSON 作为唯一状态）；
 * - `project_sources`：外部来源与快照事实（contentHash 为"存储摘录"的 sha256，见 §85 契约注释）。
 *
 * 所有表携带 workspace_id（§4.3 不变量 1）。
 */

export const contentDocuments = pgTable(
  'content_documents',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** URL_ARTICLE | PASTED_TEXT | MANUAL_SCRIPT */
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id'),
    title: text('title').notNull(),
    language: text('language').notNull(),
    author: text('author'),
    sourceUrl: text('source_url'),
    publishedAt: text('published_at'),
    /** 归一化过程的元数据（charset/finalUrl/notes/计数等；不含原始 HTML） */
    normalization: jsonb('normalization').notNull().default({}),
    schemaVersion: text('schema_version').notNull().default('0.1'),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('content_documents_project_idx').on(table.projectId, table.createdAt),
    index('content_documents_workspace_idx').on(table.workspaceId),
  ],
);

export const contentBlocks = pgTable(
  'content_blocks',
  {
    id: text('id').primaryKey(),
    documentId: text('document_id')
      .notNull()
      .references(() => contentDocuments.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    /** heading | paragraph | quote | list | table | image | chart | embed */
    blockType: text('block_type').notNull(),
    level: integer('level'),
    text: text('text'),
    items: jsonb('items'),
    table: jsonb('table'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('content_blocks_document_position_uq').on(table.documentId, table.position),
    index('content_blocks_document_idx').on(table.documentId, table.position),
    index('content_blocks_workspace_idx').on(table.workspaceId),
  ],
);

export const projectSources = pgTable(
  'project_sources',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    url: text('url').notNull(),
    title: text('title').notNull(),
    publisher: text('publisher').notNull(),
    author: text('author'),
    publishedAt: text('published_at'),
    retrievedAt: timestamp('retrieved_at', { withTimezone: true }).notNull().defaultNow(),
    /** 摘录（存储文本）的 sha256（§85 契约注释：不是对线上页面的实时哈希） */
    contentHash: text('content_hash').notNull(),
    excerpt: text('excerpt').notNull(),
    /** live_fetch | fixture_reconstruction */
    snapshotKind: text('snapshot_kind').notNull().default('live_fetch'),
    snapshotAssetId: text('snapshot_asset_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('project_sources_project_idx').on(table.projectId, table.createdAt),
    index('project_sources_workspace_idx').on(table.workspaceId),
  ],
);
