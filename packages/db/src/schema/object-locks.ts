import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { workspaces } from './workspaces.js';

export const projectObjectLocks = pgTable(
  'project_object_locks',
  {
    id: text('id').primaryKey(),
    workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
    projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
    objectKind: text('object_kind').notNull(),
    objectId: text('object_id').notNull(),
    dimensions: jsonb('dimensions').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('project_object_locks_object_uq').on(table.projectId, table.objectKind, table.objectId),
    index('project_object_locks_scope_idx').on(table.workspaceId, table.projectId),
    check('project_object_locks_kind_ck', sql`${table.objectKind} in ('PROJECT','SCENE','SEQUENCE','TRACK','CLIP','VISUAL_OBJECT','CAPTION','AUDIO_REGION')`),
    check('project_object_locks_dimensions_ck', sql`jsonb_typeof(${table.dimensions}) = 'array' and jsonb_array_length(${table.dimensions}) > 0 and ${table.dimensions} <@ '["CONTENT","POSITION","DURATION","ASSET","STYLE","TRACK"]'::jsonb`),
  ],
);
