import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';
import { renders } from './renders.js';

/**
 * 发布前 QA 报告（P07-05 / 规范 §86）。
 *
 * - **仅 Final QA 落库**（绑定 Render；预检是只读查询，不产生报告行）；
 * - append-only：同 Render 重新 QA（例如修复后重渲）→ 新报告行（最新一条为当前结论）；
 * - 报告本体（检查项/严重度/详情）以 JSONB 整体保存（UI 逐项展示；tests 按 id 断言）。
 */

export const renderQaReports = pgTable(
  'render_qa_reports',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    renderId: text('render_id')
      .notNull()
      .references(() => renders.id, { onDelete: 'cascade' }),
    verdict: text('verdict').notNull(),
    blockersFailed: integer('blockers_failed').notNull().default(0),
    warningsFailed: integer('warnings_failed').notNull().default(0),
    skipped: integer('skipped').notNull().default(0),
    /** 完整报告（qaReportSchema） */
    report: jsonb('report').notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('render_qa_reports_render_idx').on(table.renderId, table.createdAt)],
);
