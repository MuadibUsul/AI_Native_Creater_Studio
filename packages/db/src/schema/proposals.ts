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
