import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { agentTurns } from './agent.js';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 导演蓝图与场景契约（裁决 0020，AP-04；含 0.2 剪辑意图）：带版本的规划记录，**不是**第二套时间线真相。
 * 每次导演写计划就新增一版（同一工程内版本号递增、唯一），记录制定时的工程版本号；时间线仍只经操作日志与投影器改变。
 */
export const productionPlans = pgTable(
  'production_plans',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    baseRevision: integer('base_revision').notNull(),
    turnId: text('turn_id').references(() => agentTurns.id, { onDelete: 'set null' }),
    blueprint: jsonb('blueprint').notNull(),
    scenes: jsonb('scenes').notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('production_plans_project_version_uq').on(table.projectId, table.version),
    index('production_plans_workspace_idx').on(table.workspaceId, table.createdAt),
    check('production_plans_version_ck', sql`${table.version} > 0`),
    check('production_plans_base_revision_ck', sql`${table.baseRevision} >= 0`),
  ],
);
