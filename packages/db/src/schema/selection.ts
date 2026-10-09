import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';
import { projectSequences } from './composition.js';

/**
 * N04-09：SelectionAnchor 的持久化（AttentionSnapshot 的规范选择子结构）。
 * - 只存**规范锚点**（几何 × 时间 × 轨道 × 属性 × 区域模式 + 目标引用与版本），不存第二套选择语义；
 * - 同一锚点每次保存产生新 revision（选择变化不改工程）；
 * - `fingerprint` = sha256(fingerprintInput)，供采用绑定与幂等比较；**预览帧号/帧哈希不是身份或授权**。
 */
export const selectionAnchors = pgTable(
  'selection_anchors',
  {
    /** 锚点 id（同一锚点多次保存 = 多条修订记录，因此 id 不是行主键） */
    id: text('id').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => projectSequences.id, { onDelete: 'cascade' }),
    /** 锚点自身修订号（按项目单调递增；与工程 revision 无关） */
    revision: integer('revision').notNull(),
    fingerprint: text('fingerprint').notNull(),
    createdBy: text('created_by'),
    /** 规范锚点载荷（SelectionAnchor schema 的 JSON 表示，校验后落库） */
    anchor: jsonb('anchor').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // 追加式修订日志：行身份 = (workspace, project, anchorId, revision)
    primaryKey({ name: 'selection_anchors_pkey', columns: [table.workspaceId, table.projectId, table.id, table.revision] }),
    index('selection_anchors_project_idx').on(table.workspaceId, table.projectId, table.createdAt),
  ],
);
