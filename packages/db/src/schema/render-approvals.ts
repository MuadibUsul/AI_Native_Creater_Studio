import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workspaces } from './workspaces.js';
import { projects } from './projects.js';
import { renders } from './renders.js';

/**
 * 渲染审批（P07-06 / 规范 §87、§54；REQ-54-02）。
 *
 * - **append-only**：每次批准/驳回一行（最新一行为当前决定）；批准绑定
 *   renderId + manifestHash + projectVersionId + projectRevision（"新编辑需重新审批"）；
 * - 导出守卫在服务端复核：批准存在且 manifestHash 与 Render 一致（否则 APPROVAL_STALE → 409）。
 */

export const renderApprovals = pgTable(
  'render_approvals',
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
    /** APPROVED | REJECTED */
    decision: text('decision').notNull(),
    manifestHashAtApproval: text('manifest_hash_at_approval').notNull(),
    projectVersionIdAtApproval: text('project_version_id_at_approval').notNull(),
    projectRevisionAtApproval: integer('project_revision_at_approval').notNull(),
    note: text('note'),
    decidedBy: text('decided_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('render_approvals_render_idx').on(table.renderId, table.createdAt)],
);
