import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects, projectVersions } from './projects.js';
import { workspaces } from './workspaces.js';

export const projectCompositionMigrations = pgTable(
  'project_composition_migrations',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    enabled: boolean('enabled').notNull().default(false),
    status: text('status').notNull().default('PENDING'),
    completedStep: text('completed_step').notNull().default('NONE'),
    authorityMode: text('authority_mode').notNull().default('LEGACY'),
    attemptCount: integer('attempt_count').notNull().default(0),
    sourceDigestSha256: text('source_digest_sha256'),
    targetDigestSha256: text('target_digest_sha256'),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_composition_migrations_project_uq').on(table.projectId),
    index('project_composition_migrations_workspace_idx').on(table.workspaceId),
    index('project_composition_migrations_status_idx').on(table.status),
  ],
);

export const projectVersionCompositionProjections = pgTable(
  'project_version_composition_projections',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    projectVersionId: text('project_version_id').notNull().references(() => projectVersions.id, { onDelete: 'cascade' }),
    sourceSnapshotSha256: text('source_snapshot_sha256').notNull(),
    projectionSha256: text('projection_sha256').notNull(),
    projection: jsonb('projection').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_version_composition_projections_version_uq').on(table.projectVersionId),
    index('project_version_composition_projections_scope_idx').on(table.workspaceId, table.projectId),
  ],
);
