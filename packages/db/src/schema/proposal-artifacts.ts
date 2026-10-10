import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * N06-06：外部晚到产物隔离台账。
 *
 * 关键纪律：这**不是**第二份作品状态。晚到产物（外部渲染/分析/工具输出）先落这里，
 * 只有「候选仍 OPEN 且为当前代际」时 `bound=true`；其余一律 `bound=false` 隔离，
 * **不得**自动绑定到候选或工程。孤儿行按保留策略清理。
 */
export const proposalArtifacts = pgTable(
  'proposal_artifacts',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    proposalId: text('proposal_id'),
    /** 产物声称所属的候选代际 */
    generation: integer('generation').notNull(),
    /** 判定时的候选当前代际（对照用） */
    currentGeneration: integer('current_generation'),
    kind: text('kind').notNull(),
    reference: text('reference').notNull(),
    bound: boolean('bound').notNull(),
    bindingReason: text('binding_reason').notNull(),
    payload: jsonb('payload'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('proposal_artifacts_project_idx').on(table.workspaceId, table.projectId, table.createdAt),
    index('proposal_artifacts_proposal_idx').on(table.proposalId),
    uniqueIndex('proposal_artifacts_reference_uq').on(table.workspaceId, table.projectId, table.kind, table.reference),
  ],
);
