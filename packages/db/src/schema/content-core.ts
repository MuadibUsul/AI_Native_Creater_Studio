import { integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Content Core（P11-01 / §92—93）：每项目一份核心模型（**派生自既有结构；原文档保留**）。
 * project_id 唯一 = 幂等迁移的存储形态；core/consistency 为 JSONB 快照（含 inputsDigest 幂等键）。
 */
export const contentCores = pgTable(
  'content_cores',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    schemaVersion: text('schema_version').notNull(),
    core: jsonb('core').notNull(),
    consistency: jsonb('consistency').notNull(),
    /** 迁移时的原始侧声明计数（迁移记录——前后对照证据） */
    migratedClaimCount: integer('migrated_claim_count').notNull(),
    migratedSourceCount: integer('migrated_source_count').notNull(),
    migratedDocumentCount: integer('migrated_document_count').notNull(),
    migratedAt: timestamp('migrated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('content_cores_project_uq').on(table.projectId)],
);
