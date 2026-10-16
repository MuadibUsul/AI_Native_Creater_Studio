import { and, desc, eq, isNull } from 'drizzle-orm';
import { opsProjectListQuerySchema, opsProjectSummarySchema, type OpsProjectListQuery, type OpsProjectSummary } from '@ancs/contracts';
import { projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/** Filter by the authorized workspace in SQL before LIMIT; never read project content. */
export async function listOpsProjects(deps: DomainDeps, input: OpsProjectListQuery): Promise<OpsProjectSummary[]> {
  const query = opsProjectListQuerySchema.parse(input);
  const conditions = [eq(projects.workspaceId, query.workspaceId), isNull(projects.deletedAt)];
  if (query.status !== undefined) conditions.push(eq(projects.status, query.status));
  const rows = await deps.db
    .select({
      id: projects.id,
      workspaceId: projects.workspaceId,
      status: projects.status,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
    })
    .from(projects)
    .where(and(...conditions))
    .orderBy(desc(projects.createdAt), desc(projects.id))
    .limit(query.limit ?? 50);
  return rows.map((row) => opsProjectSummarySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }));
}
