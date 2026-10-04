import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
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
    /** 抽取结果（P04-02：claims/citations/numericMentions/timeline；确定性抽取的完整载荷） */
    extractions: jsonb('extractions').notNull().default({}),
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

/**
 * 证据与数据（P04-02 / 规范 §10.3、§85）。
 *
 * - `claims`：事实/分析/观点/不确定（factuality）+ 来源引用 + 结构化数据引用 + 锁定标记；
 *   **fact 类必须可追溯**（服务层强制 ≥1 来源）；
 * - `source_citations`：Claim → Source 的定位（块 ID + 字符区间 + 引文）；
 * - `structured_datasets`：事实图表唯一可绑定的数据形态（含 source_ids；synthetic 永不可绑定事实图表）。
 */

export const claims = pgTable(
  'claims',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id'),
    blockId: text('block_id'),
    text: text('text').notNull(),
    /** fact | analysis | opinion | uncertain */
    factuality: text('factuality').notNull(),
    /** 来源引用（Source id 列表；图表/来源卡展示依据） */
    sourceIds: jsonb('source_ids').notNull().default([]),
    /** 结构化数据引用（datasetId/seriesId；数值只能来自真实数据） */
    structuredData: jsonb('structured_data').notNull().default([]),
    /** 作者锁定：锁定后不得静默修改（§8.2） */
    locked: boolean('locked').notNull().default(false),
    /** 抽取元数据（method/confidence/sourceText） */
    extraction: jsonb('extraction').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('claims_project_idx').on(table.projectId, table.createdAt),
    index('claims_document_idx').on(table.documentId),
    index('claims_workspace_idx').on(table.workspaceId),
  ],
);

export const sourceCitations = pgTable(
  'source_citations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => claims.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => projectSources.id, { onDelete: 'cascade' }),
    /** 定位（blk_xxx 或 blk_xxx:start-end） */
    locator: text('locator').notNull(),
    quotedText: text('quoted_text'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('source_citations_claim_idx').on(table.claimId),
    index('source_citations_source_idx').on(table.sourceId),
  ],
);

export const structuredDatasets = pgTable(
  'structured_datasets',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    unit: text('unit').notNull(),
    sourceIds: jsonb('source_ids').notNull().default([]),
    /** 演示数据：允许存在，但**永不可绑定事实图表**（§10.3 + datasets 契约） */
    synthetic: boolean('synthetic').notNull().default(false),
    note: text('note'),
    /** series → points（值对象；图表与校验读此字段） */
    series: jsonb('series').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('structured_datasets_project_idx').on(table.projectId, table.createdAt),
    index('structured_datasets_workspace_idx').on(table.workspaceId),
  ],
);
