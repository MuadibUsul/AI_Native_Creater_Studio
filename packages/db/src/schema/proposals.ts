import { index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * N06-01／N06-02／N06-04：私有候选（proposal branch）。
 *
 * - 候选只存**操作集与绑定**（base revision／意图修订／选择指纹／操作哈希），**不改工程**；
 * - 采用后才写 `committed_revision`；采用本身经统一编辑协议原子执行；
 * - 幂等键唯一：同一键重放返回同一候选结果，不产生第二次写入。
 */
export const proposals = pgTable(
  'proposals',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    actorId: text('actor_id'),
    baseProjectRevision: integer('base_project_revision').notNull(),
    selectionAnchorId: text('selection_anchor_id'),
    selectionFingerprint: text('selection_fingerprint'),
    intentRevisionId: text('intent_revision_id'),
    operationsHash: text('operations_hash').notNull(),
    operations: jsonb('operations').notNull(),
    /** N06-03：创建时记录的字段读集／写集（操作注册表声明的并集） */
    readSet: jsonb('read_set'),
    writeSet: jsonb('write_set'),
    /** N06-03：创建时记录的具体写目标（对象级 + 维度） */
    writeTargets: jsonb('write_targets'),
    /** N06-03：候选引用片段的源素材绑定签名（变化 → 必须重新审核） */
    assetVersionSignature: text('asset_version_signature'),
    /** N06-03：rebase 次数、最近一次来源 revision 与历史 */
    rebaseCount: integer('rebase_count').notNull().default(0),
    rebasedFromRevision: integer('rebased_from_revision'),
    rebaseLog: jsonb('rebase_log'),
    /** N06-06：候选代际（工程内单调递增；晚到产物按代际隔离） */
    generation: integer('generation').notNull().default(1),
    /** N06-06：取代本候选的新候选 / 被取代时间 / 取消时间 */
    supersededByProposalId: text('superseded_by_proposal_id'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    status: text('status').notNull(),
    committedRevision: integer('committed_revision'),
    /** 采用时使用的幂等键（同一键重放返回同一结果） */
    adoptionIdempotencyKey: text('adoption_idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    committedAt: timestamp('committed_at', { withTimezone: true }),
    discardedAt: timestamp('discarded_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('proposals_project_idx').on(table.workspaceId, table.projectId, table.createdAt),
    uniqueIndex('proposals_adoption_key_uq').on(table.adoptionIdempotencyKey),
  ],
);
