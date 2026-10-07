import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { contentDocuments } from './content.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * CMS 摄取记录（P13-06 / §88；计划 §8 P13）：
 * - **事件幂等唯一索引**（workspace + source + externalId + contentHash）——重放不重复建项目/文档；
 * - 同 externalId 不同 contentHash = 正文变化 → 新来源版本（新 ContentDocument，同项目）。
 */
export const cmsIngestions = pgTable(
  'cms_ingestions',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    source: text('source').notNull(),
    externalId: text('external_id').notNull(),
    contentHash: text('content_hash').notNull(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    documentId: text('document_id')
      .notNull()
      .references(() => contentDocuments.id, { onDelete: 'cascade' }),
    status: text('status').notNull().default('INGESTED'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('cms_ingestions_event_uq').on(table.workspaceId, table.source, table.externalId, table.contentHash),
    index('cms_ingestions_lookup_idx').on(table.workspaceId, table.source, table.externalId),
  ],
);
