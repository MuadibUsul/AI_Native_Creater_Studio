import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Handoff 记录（P13-05 / §42.3；计划 §8 P13）：
 * 可撤销、限时（expiresAt）、绑定账号（createdBy/claimedBy）与 Artifact（artifactIds）。
 * 状态机：PENDING→CLAIMED→COMPLETED；PENDING/CLAIMED→REVOKED（可撤销）。
 */
export const handoffs = pgTable(
  'handoffs',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    state: text('state').notNull().default('PENDING'),
    artifactIds: jsonb('artifact_ids').notNull().default([]),
    targetPlatform: text('target_platform'),
    createdBy: text('created_by'),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('handoffs_project_idx').on(table.projectId, table.createdAt)],
);
