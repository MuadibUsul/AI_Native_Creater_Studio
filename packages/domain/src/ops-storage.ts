import { and, eq, isNull, sql } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, opsWorkspaceStorageSummarySchema, type OpsWorkspaceStorageSummary } from '@ancs/contracts';
import { assetVersions, workspaces } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/** Tenant predicate is applied in SQL before aggregation; response has no storage identifier. */
export async function getOpsWorkspaceStorageSummary(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<OpsWorkspaceStorageSummary> {
  const workspace = (await deps.db.select({ id: workspaces.id }).from(workspaces)
    .where(eq(workspaces.id, input.workspaceId)).limit(1))[0];
  if (!workspace) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'Workspace not found', 404);
  const row = (await deps.db.select({
    bytesUsed: sql<number>`coalesce(sum(${assetVersions.sizeBytes}), 0)::bigint`,
    assetCount: sql<number>`count(distinct ${assetVersions.assetId})::int`,
  }).from(assetVersions).where(and(
    eq(assetVersions.workspaceId, input.workspaceId), isNull(assetVersions.deletedAt),
  )))[0];
  return opsWorkspaceStorageSummarySchema.parse({
    workspaceId: input.workspaceId,
    bytesUsed: Number(row?.bytesUsed ?? 0),
    assetCount: Number(row?.assetCount ?? 0),
  });
}
