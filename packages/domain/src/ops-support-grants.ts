import { and, desc, eq } from 'drizzle-orm';
import { opaqueIdSchema, opsSupportGrantListQuerySchema, opsSupportGrantSummarySchema, type OpsSupportGrantSummary } from '@ancs/contracts';
import { supportAccessGrants } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/** The caller must supply the current, authenticated ops principal and authorize this ticket. */
export async function listOpsSupportGrantsForTicket(
  deps: DomainDeps,
  input: { workspaceId: string; principalId: string; ticketId: string },
): Promise<OpsSupportGrantSummary[]> {
  const workspaceId = opaqueIdSchema.parse(input.workspaceId);
  const principalId = opaqueIdSchema.parse(input.principalId);
  const { ticketId } = opsSupportGrantListQuerySchema.parse({ ticketId: input.ticketId });
  const rows = await deps.db.select({
    id: supportAccessGrants.id,
    workspaceId: supportAccessGrants.workspaceId,
    scope: supportAccessGrants.scope,
    status: supportAccessGrants.status,
    createdAt: supportAccessGrants.createdAt,
    expiresAt: supportAccessGrants.expiresAt,
  }).from(supportAccessGrants).where(and(
    eq(supportAccessGrants.workspaceId, workspaceId),
    eq(supportAccessGrants.beneficiaryPrincipalId, principalId),
    eq(supportAccessGrants.ticketId, ticketId),
    eq(supportAccessGrants.scope, 'SUMMARY_READ'),
  )).orderBy(desc(supportAccessGrants.createdAt), desc(supportAccessGrants.id)).limit(100);

  const now = Date.now();
  return rows.map((row) => opsSupportGrantSummarySchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    scope: row.scope,
    status: row.status === 'ACTIVE' && row.expiresAt.getTime() <= now ? 'EXPIRED' : row.status,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  }));
}
