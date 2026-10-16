import { and, asc, eq, gt, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PROJECT_API_SCHEMA_VERSION,
  objectLockSchema,
  projectEditEventPageSchema,
  projectStateSchema,
  type ProjectEditEventPage,
  type ProjectState,
} from '@ancs/contracts';
import { editEvents, projectObjectLocks, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assembleProjectDocument } from './project-document.js';
import { listProjectMediaViews } from './media-sources.js';

export function assertProjectApiSchemaVersion(schemaVersion?: string): void {
  if (schemaVersion !== undefined && schemaVersion !== PROJECT_API_SCHEMA_VERSION) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'project API schema version is not supported', 409, {
      reason: 'PROJECT_SCHEMA_UNSUPPORTED',
      requestedSchemaVersion: schemaVersion,
      supportedSchemaVersions: [PROJECT_API_SCHEMA_VERSION],
    });
  }
}

async function assertProjectScope(deps: DomainDeps, workspaceId: string, projectId: string): Promise<void> {
  const rows = await deps.db.select({ id: projects.id }).from(projects).where(and(
    eq(projects.id, projectId), eq(projects.workspaceId, workspaceId),
  )).limit(1);
  if (!rows[0]) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
}

export async function getProjectState(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; schemaVersion?: string },
): Promise<ProjectState> {
  assertProjectApiSchemaVersion(input.schemaVersion);
  const [document, rows, seqRows, media] = await Promise.all([
    assembleProjectDocument(deps, input),
    deps.db.select().from(projectObjectLocks).where(and(
      eq(projectObjectLocks.workspaceId, input.workspaceId), eq(projectObjectLocks.projectId, input.projectId),
    )),
    deps.db.select({ max: sql<number>`coalesce(max(${editEvents.seq}), 0)` }).from(editEvents).where(and(
      eq(editEvents.workspaceId, input.workspaceId), eq(editEvents.projectId, input.projectId),
    )),
    listProjectMediaViews(deps, input),
  ]);
  return projectStateSchema.parse({
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    document,
    locks: rows.map((row) => objectLockSchema.parse({ ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() })),
    mediaSources: media.mediaSources,
    clipInstances: media.clipInstances,
    eventSeq: Number(seqRows[0]?.max ?? 0),
  });
}

export async function listProjectEditEvents(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; schemaVersion?: string; afterSeq?: number; limit?: number },
): Promise<ProjectEditEventPage> {
  assertProjectApiSchemaVersion(input.schemaVersion);
  await assertProjectScope(deps, input.workspaceId, input.projectId);
  const afterSeq = input.afterSeq ?? 0;
  const limit = input.limit ?? 100;
  const rows = await deps.db.select().from(editEvents).where(and(
    eq(editEvents.workspaceId, input.workspaceId), eq(editEvents.projectId, input.projectId), gt(editEvents.seq, afterSeq),
  )).orderBy(asc(editEvents.seq)).limit(limit + 1);
  const page = rows.slice(0, limit);
  return projectEditEventPageSchema.parse({
    schemaVersion: PROJECT_API_SCHEMA_VERSION,
    items: page.map((row) => ({
      id: row.id, seq: row.seq, workspaceId: row.workspaceId, projectId: row.projectId,
      sceneId: row.sceneId, objectKind: row.objectKind, objectId: row.objectId,
      actorType: row.actorType, actorId: row.actorId, action: row.action, intentText: row.intentText,
      patch: row.patch, baseRevision: row.baseRevision, resultRevision: row.resultRevision,
      compensatesEventId: row.compensatesEventId, createdAt: row.createdAt.toISOString(),
    })),
    nextAfterSeq: rows.length > limit ? (page.at(-1)?.seq ?? null) : null,
  });
}
