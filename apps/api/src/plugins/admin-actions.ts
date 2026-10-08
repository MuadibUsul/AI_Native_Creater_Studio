import type { FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { abuseFlags, creditLedger, jobs, supportAccessGrants } from '@ancs/db';
import type { OpsAction, OpsPermissionTarget } from '@ancs/contracts';
import type { OpsAuthDeps } from '@ancs/auth';

/** All 14 GET and 9 POST legacy Admin routes. Unknown routes have no action and are denied. */
export const LEGACY_ADMIN_ACTIONS: Readonly<Record<string, OpsAction>> = {
  'GET /admin/overview': 'ops.overview.read',
  'GET /admin/metrics': 'ops.metrics.read',
  'GET /admin/jobs': 'ops.job.list',
  'POST /admin/jobs/:jobId/retry': 'ops.job.retry',
  'GET /admin/audit': 'ops.audit.read',
  'GET /admin/users': 'ops.user.list',
  'GET /admin/workspaces': 'ops.workspace.list',
  'GET /admin/projects': 'ops.project.list',
  'GET /admin/provider-status': 'ops.provider.status.read',
  'GET /admin/storage': 'ops.storage.summary.read',
  'GET /admin/workspaces/:workspaceId/credits': 'ops.credit.statement.read',
  'GET /admin/audit-log': 'ops.audit.log.read',
  'GET /admin/abuse-flags': 'ops.abuse.flag.list',
  'POST /admin/workspaces/:workspaceId/abuse-flags': 'ops.abuse.flag.create',
  'POST /admin/abuse-flags/:flagId/resolve': 'ops.abuse.flag.resolve',
  'POST /admin/workspaces/:workspaceId/abuse-state': 'ops.abuse.state.set',
  'GET /admin/workspaces/:workspaceId/support-grants': 'ops.support.grant.list',
  'POST /admin/workspaces/:workspaceId/support-grants': 'ops.support.grant.create',
  'POST /admin/support-grants/:grantId/revoke': 'ops.support.grant.revoke',
  'GET /admin/workspaces/:workspaceId/support-view': 'ops.support.view',
  'POST /admin/workspaces/:workspaceId/credits/grant': 'ops.credit.grant',
  'POST /admin/workspaces/:workspaceId/credits/refund': 'ops.credit.refund_of',
  'POST /admin/workspaces/:workspaceId/plan': 'ops.plan.assign',
};

export function legacyAdminRoute(request: FastifyRequest): { path: string; action: OpsAction | null } | null {
  const registered = request.routeOptions.url ?? new URL(request.url, 'http://localhost').pathname;
  const path = registered.startsWith('/api/v1/') ? registered.slice('/api/v1'.length) : registered;
  if (!path.startsWith('/admin/')) return null;
  return { path, action: LEGACY_ADMIN_ACTIONS[`${request.method.toUpperCase()} ${path}`] ?? null };
}

const field = (value: unknown, key: string): string | null => {
  if (typeof value !== 'object' || value === null) return null;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' && item.length > 0 ? item : null;
};

/** Derive object facts on the server; body IDs never establish their own workspace. */
export async function resolveLegacyAdminTarget(
  deps: OpsAuthDeps,
  request: FastifyRequest,
  action: OpsAction,
): Promise<OpsPermissionTarget> {
  const workspaceId = field(request.params, 'workspaceId') ?? field(request.query, 'workspaceId');
  const empty: OpsPermissionTarget = { workspaceId: null, resourceKind: null, resourceId: null, amountCredits: null, ticketId: null };
  if (action === 'ops.overview.read' || action === 'ops.metrics.read' || action === 'ops.audit.read' ||
      action === 'ops.provider.status.read') return empty;
  if (action === 'ops.job.retry') {
    const id = field(request.params, 'jobId');
    const row = id ? (await deps.db.select({ workspaceId: jobs.workspaceId }).from(jobs).where(eq(jobs.id, id)).limit(1))[0] : undefined;
    return { ...empty, workspaceId: row?.workspaceId ?? null, resourceKind: 'JOB', resourceId: row ? id : null };
  }
  if (action === 'ops.abuse.flag.resolve') {
    const id = field(request.params, 'flagId');
    const row = id ? (await deps.db.select({ workspaceId: abuseFlags.workspaceId }).from(abuseFlags).where(eq(abuseFlags.id, id)).limit(1))[0] : undefined;
    return { ...empty, workspaceId: row?.workspaceId ?? null, resourceKind: 'ABUSE_FLAG', resourceId: row ? id : null };
  }
  if (action === 'ops.support.grant.revoke') {
    const id = field(request.params, 'grantId');
    const row = id ? (await deps.db.select({ workspaceId: supportAccessGrants.workspaceId }).from(supportAccessGrants).where(eq(supportAccessGrants.id, id)).limit(1))[0] : undefined;
    return { ...empty, workspaceId: row?.workspaceId ?? null, resourceKind: 'SUPPORT_GRANT', resourceId: row ? id : null };
  }
  if (action === 'ops.credit.refund_of') {
    const id = field(request.body, 'entryId');
    const row = id && workspaceId ? (await deps.db.select({ workspaceId: creditLedger.workspaceId, amount: creditLedger.amount })
      .from(creditLedger).where(and(eq(creditLedger.id, id), eq(creditLedger.workspaceId, workspaceId))).limit(1))[0] : undefined;
    return { ...empty, workspaceId: row?.workspaceId ?? null, resourceKind: 'LEDGER_ENTRY', resourceId: row ? id : null, amountCredits: row?.amount ?? null };
  }
  const amount = action === 'ops.credit.grant' && typeof request.body === 'object' && request.body !== null
    ? (request.body as Record<string, unknown>)['amountCredits'] : null;
  return {
    workspaceId,
    resourceKind: null,
    resourceId: null,
    amountCredits: typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 ? amount : null,
    ticketId: action === 'ops.support.view' || action === 'ops.support.grant.list' ? field(request.query, 'ticketId') :
      action === 'ops.support.grant.create' ? field(request.body, 'ticketId') : null,
  };
}
