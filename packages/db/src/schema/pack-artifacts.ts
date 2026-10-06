import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

/**
 * Pack 产物（P12-01 / §92.1）：**只追加**——generate 落一行（payload = 派生 9:16 Graph 载荷），
 * **不写回源项目**（原长视频 Scene Graph/revision 零改动）。
 * lineage_id 锚定 analyze 的 PLAN 血缘行（来源链可回放）。
 */
export const packArtifacts = pgTable(
  'pack_artifacts',
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
    lineageId: text('lineage_id').notNull(),
    payloadKind: text('payload_kind').notNull(),
    title: text('title').notNull(),
    payload: jsonb('payload').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('pack_artifacts_project_idx').on(table.projectId, table.createdAt)],
);

/**
 * 产物校验记录（P12-01）：**只追加**校验历史（重校验不改写旧行——"可恢复可审计"）。
 * ok 与 issues 为 validate 切面的原始产出（问题逐条，不静默）。
 */
export const packArtifactValidations = pgTable(
  'pack_artifact_validations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => packArtifacts.id, { onDelete: 'cascade' }),
    ok: boolean('ok').notNull(),
    issues: jsonb('issues').notNull().default([]),
    validatedAt: timestamp('validated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('pack_artifact_validations_artifact_idx').on(table.artifactId, table.validatedAt)],
);
