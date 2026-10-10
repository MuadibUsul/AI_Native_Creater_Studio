import { index, integer, jsonb, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * N06-04：局部试片缓存（proposal trial cache）。
 *
 * - 内容是**确定性试改结果**（真实执行器事务内跑完回滚得到的 ProposalTrial）；
 * - 缓存键 `dependencyKey` 覆盖 `baseProjectRevision + operationsHash + selectionFingerprint +
 *   intentRevisionId + assetVersionSignature`：任一依赖变化 → 键变化 → 自然失效（不返回陈旧试片）；
 * - 缓存**不是第二份工程状态**：只存只读试片结果，工程权威仍是 ProjectDocument；
 * - 行身份 = (workspace, project, dependencyKey)，按工程隔离。
 */
export const proposalTrials = pgTable(
  'proposal_trials',
  {
    dependencyKey: text('dependency_key').notNull(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** 最近一次写入该缓存行的候选（同一依赖可由不同候选产生相同结果） */
    proposalId: text('proposal_id'),
    baseProjectRevision: integer('base_project_revision').notNull(),
    operationsHash: text('operations_hash').notNull(),
    selectionFingerprint: text('selection_fingerprint'),
    intentRevisionId: text('intent_revision_id'),
    assetVersionSignature: text('asset_version_signature').notNull(),
    /** ProposalTrial 的 JSON 表示（只读试片结果） */
    trial: jsonb('trial').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: 'proposal_trials_pkey', columns: [table.workspaceId, table.projectId, table.dependencyKey] }),
    index('proposal_trials_project_idx').on(table.workspaceId, table.projectId, table.updatedAt),
  ],
);
