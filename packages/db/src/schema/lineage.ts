import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * 派生血缘（P11-04 / §93）：只追加——analyze 每次运行记一条 PLAN 行（派生时核心 digest 快照）。
 * 过期 = 对照当前 digest 的**读取时提示**（stale），不改写行状态；已 APPROVED 行永不覆盖。
 * project_version_id：approve 可选绑定的产出项目版本（不做 FK——同项目校验在 domain 层，
 * 版本行随项目级联删除，血缘行独立保留）。
 */
export const derivationLineage = pgTable(
  'derivation_lineage',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    packId: text('pack_id').notNull(),
    packVersion: text('pack_version').notNull(),
    channelKey: text('channel_key'),
    status: text('status').notNull().default('PLAN'),
    coreInputsDigest: text('core_inputs_digest'),
    inputsSnapshot: jsonb('inputs_snapshot').notNull().default({}),
    summary: text('summary').notNull(),
    projectVersionId: text('project_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
  },
  (table) => [index('derivation_lineage_project_idx').on(table.projectId, table.createdAt)],
);
