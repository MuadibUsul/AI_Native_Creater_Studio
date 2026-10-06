import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Podcast（P12-05 / §4.2、§59）：只追加——每次生成记一集（payload 含脚本/章节/混音计划/元数据/署名）。
 * 音频本体 = master_narrations 中 variant='PODCAST' 的行（**不进视频主链**——getCurrent 只认 MASTER）。
 */
export const podcastEpisodes = pgTable(
  'podcast_episodes',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    planId: text('plan_id').notNull(),
    sourceNarrationId: text('source_narration_id').notNull(),
    masterNarrationId: text('master_narration_id').notNull(),
    language: text('language').notNull(),
    title: text('title').notNull(),
    units: jsonb('units').notNull().default([]),
    skippedBlockIds: jsonb('skipped_block_ids').notNull().default([]),
    coverage: jsonb('coverage').notNull().default({}),
    chapters: jsonb('chapters').notNull().default([]),
    mixPlan: jsonb('mix_plan').notNull().default({}),
    mixNote: text('mix_note').notNull(),
    metadata: jsonb('metadata').notNull().default({}),
    attribution: jsonb('attribution').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('podcast_episodes_project_idx').on(table.projectId, table.createdAt)],
);
