import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 多语言（P12-04 / §5.1、§94）：
 * - **术语词典**：(projectId, sourceTerm, targetLanguage) 唯一的项目级数据——翻译与 TTS 发音共用；
 * - **翻译作业**：只追加（含派生 Master Narration 引用与数字/实体核对证据）。
 */
export const terminologyEntries = pgTable(
  'terminology_entries',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sourceTerm: text('source_term').notNull(),
    targetLanguage: text('target_language').notNull(),
    targetTerm: text('target_term').notNull(),
    kind: text('kind').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('terminology_entries_term_language_uq').on(table.projectId, table.sourceTerm, table.targetLanguage),
    index('terminology_entries_project_idx').on(table.projectId, table.targetLanguage),
  ],
);

export const narrationTranslations = pgTable(
  'narration_translations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    narrativePlanId: text('narrative_plan_id').notNull(),
    /** 源语言 Master Narration（时间戳对照物——派生版不复用其任何时间戳） */
    sourceNarrationId: text('source_narration_id').notNull(),
    /** 派生（目标语言）Master Narration——全新合成行 */
    derivedNarrationId: text('derived_narration_id').notNull(),
    targetLanguage: text('target_language').notNull(),
    /** 翻译单元（块级：sourceText/translatedText/termMappings） */
    units: jsonb('units').notNull().default([]),
    numbersCheck: jsonb('numbers_check').notNull().default({}),
    entitiesCheck: jsonb('entities_check').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('narration_translations_project_idx').on(table.projectId, table.createdAt)],
);
