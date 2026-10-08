import { createHash } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import {
  OPS_ACTIONS, opsActionSchema, opsPermissionDecisionSchema, opsPermissionTargetSchema,
  type OpsAction, type OpsPermissionDecision, type OpsPermissionTarget,
  type OpsRole, type OpsSession,
} from '@ancs/contracts';
import { adminPermissionPolicyVersions, adminPrincipals, adminRoleGrants, adminRoleScopes } from '@ancs/db';
import type { OpsAuthDeps } from './ops.js';

/** Compiled policy version; a matching ACTIVE database publication is required at runtime. */
export const OPS_PERMISSION_POLICY_VERSION = 'n15-03-preview-3';

type Rule = {
  roles: readonly OpsRole[];
  scope: 'PLATFORM' | 'WORKSPACE';
  projectionReady: boolean;
  approvalRequired?: boolean;
  ticketRequired?: boolean;
};

/** Every legacy Admin action appears once. No wildcard role or implicit owner permission. */
export const OPS_PERMISSION_RULES: Record<OpsAction, Rule> = {
  'ops.overview.read': { roles: ['PRODUCTION_OPERATOR', 'PLATFORM_OWNER'], scope: 'PLATFORM', projectionReady: true },
  'ops.metrics.read': { roles: ['PRODUCTION_OPERATOR', 'AUDITOR'], scope: 'PLATFORM', projectionReady: true },
  'ops.job.list': { roles: ['PRODUCTION_OPERATOR'], scope: 'WORKSPACE', projectionReady: true },
  'ops.job.retry': { roles: ['PRODUCTION_OPERATOR'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.audit.read': { roles: ['AUDITOR', 'SECURITY_ADMIN'], scope: 'PLATFORM', projectionReady: false },
  'ops.user.list': { roles: ['SUPPORT_L1', 'SUPPORT_L2', 'SECURITY_ADMIN'], scope: 'WORKSPACE', projectionReady: false },
  'ops.workspace.list': { roles: ['SUPPORT_L1', 'SUPPORT_L2', 'BILLING_OPERATOR', 'PRODUCTION_OPERATOR'], scope: 'WORKSPACE', projectionReady: false },
  'ops.project.list': { roles: ['SUPPORT_L2', 'PRODUCTION_OPERATOR', 'CONTENT_REVIEWER'], scope: 'WORKSPACE', projectionReady: false },
  'ops.provider.status.read': { roles: ['PROVIDER_MANAGER', 'PRODUCTION_OPERATOR'], scope: 'PLATFORM', projectionReady: true },
  'ops.storage.summary.read': { roles: ['PRODUCTION_OPERATOR', 'PRIVACY_OFFICER'], scope: 'PLATFORM', projectionReady: false },
  'ops.credit.statement.read': { roles: ['BILLING_OPERATOR', 'BILLING_APPROVER', 'AUDITOR'], scope: 'WORKSPACE', projectionReady: false },
  'ops.audit.log.read': { roles: ['AUDITOR', 'SECURITY_ADMIN'], scope: 'WORKSPACE', projectionReady: false },
  'ops.abuse.flag.list': { roles: ['CONTENT_REVIEWER', 'REVIEW_LEAD', 'SECURITY_ADMIN'], scope: 'WORKSPACE', projectionReady: false },
  'ops.abuse.flag.create': { roles: ['CONTENT_REVIEWER'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.abuse.flag.resolve': { roles: ['REVIEW_LEAD'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.abuse.state.set': { roles: ['PRODUCTION_OPERATOR', 'SECURITY_ADMIN', 'REVIEW_LEAD'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.support.grant.list': { roles: ['SUPPORT_L2', 'SECURITY_ADMIN', 'PRIVACY_OFFICER'], scope: 'WORKSPACE', projectionReady: false },
  'ops.support.grant.create': { roles: ['SECURITY_ADMIN', 'PRIVACY_OFFICER'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true, ticketRequired: true },
  'ops.support.grant.revoke': { roles: ['SECURITY_ADMIN', 'PRIVACY_OFFICER'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.support.view': { roles: ['SUPPORT_L2'], scope: 'WORKSPACE', projectionReady: true, ticketRequired: true },
  'ops.credit.grant': { roles: ['BILLING_OPERATOR'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.credit.refund_of': { roles: ['BILLING_OPERATOR'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
  'ops.plan.assign': { roles: ['BILLING_OPERATOR'], scope: 'WORKSPACE', projectionReady: false, approvalRequired: true },
};

/** A deterministic fingerprint of the exact compiled action matrix. Publication cannot silently outlive rule changes. */
export const OPS_PERMISSION_POLICY_HASH = createHash('sha256').update(JSON.stringify(OPS_ACTIONS.map((action) => {
  const rule = OPS_PERMISSION_RULES[action];
  return [action, [...rule.roles].sort(), rule.scope, rule.projectionReady, rule.approvalRequired === true, rule.ticketRequired === true];
}))).digest('hex');

export async function publishedOpsPolicyMatches(deps: OpsAuthDeps): Promise<'ACTIVE' | 'INACTIVE' | 'MISMATCH'> {
  const row = (await deps.db.select({ version: adminPermissionPolicyVersions.version, rulesHash: adminPermissionPolicyVersions.rulesHash })
    .from(adminPermissionPolicyVersions).where(and(
      eq(adminPermissionPolicyVersions.environment, deps.environment), eq(adminPermissionPolicyVersions.status, 'ACTIVE'),
    )).limit(1))[0];
  if (!row) return 'INACTIVE';
  return row.version === OPS_PERMISSION_POLICY_VERSION && row.rulesHash === OPS_PERMISSION_POLICY_HASH ? 'ACTIVE' : 'MISMATCH';
}

const deny = (action: OpsAction | null, reason: NonNullable<OpsPermissionDecision['reason']>): OpsPermissionDecision =>
  opsPermissionDecisionSchema.parse({ allowed: false, action, policyVersion: OPS_PERMISSION_POLICY_VERSION, reason });
const allow = (action: OpsAction): OpsPermissionDecision =>
  opsPermissionDecisionSchema.parse({ allowed: true, action, policyVersion: OPS_PERMISSION_POLICY_VERSION, reason: null });

/** Called only after resolveOpsSession; still rereads current grants/scopes to avoid stale role snapshots. */
export async function decideOpsPermission(
  deps: OpsAuthDeps,
  input: { session: OpsSession; action: unknown; target: OpsPermissionTarget; now?: Date },
): Promise<OpsPermissionDecision> {
  const parsedAction = opsActionSchema.safeParse(input.action);
  if (!parsedAction.success) return deny(null, 'UNKNOWN_ACTION');
  const action = parsedAction.data;
  const target = opsPermissionTargetSchema.parse(input.target);
  if (input.session.environment !== deps.environment) return deny(action, 'ENVIRONMENT_MISMATCH');
  const policy = await publishedOpsPolicyMatches(deps);
  if (policy === 'INACTIVE') return deny(action, 'POLICY_INACTIVE');
  if (policy === 'MISMATCH') return deny(action, 'POLICY_MISMATCH');
  const rule = OPS_PERMISSION_RULES[action];
  const principal = (await deps.db.select({ id: adminPrincipals.id }).from(adminPrincipals).where(and(
    eq(adminPrincipals.id, input.session.principalId), eq(adminPrincipals.environment, deps.environment), eq(adminPrincipals.enabled, true),
  )).limit(1))[0];
  if (!principal) return deny(action, 'ROLE_MISSING');
  const grants = await deps.db.select({
    role: adminRoleGrants.role, scope: adminRoleScopes,
  }).from(adminRoleGrants).leftJoin(adminRoleScopes, eq(adminRoleScopes.roleGrantId, adminRoleGrants.id)).where(and(
    eq(adminRoleGrants.principalId, principal.id), isNull(adminRoleGrants.revokedAt),
  ));
  const roleRows = grants.filter((row) => rule.roles.includes(row.role as OpsRole) && input.session.roles.includes(row.role as OpsRole));
  if (roleRows.length === 0) return deny(action, 'ROLE_MISSING');
  if (rule.ticketRequired && target.ticketId === null) return deny(action, 'TICKET_REQUIRED');
  const now = input.now ?? new Date();
  let expired = false;
  let amountExceeded = false;
  for (const { scope } of roleRows) {
    if (!scope || scope.revokedAt !== null) continue;
    if (scope.startsAt > now || (scope.expiresAt !== null && (!Number.isFinite(scope.expiresAt.getTime()) || scope.expiresAt <= now))) {
      expired = true;
      continue;
    }
    const matches = rule.scope === 'PLATFORM'
      ? scope.scopeKind === 'PLATFORM' && target.workspaceId === null
      : target.workspaceId !== null && scope.workspaceId === target.workspaceId && (
        scope.scopeKind === 'WORKSPACE' || (scope.scopeKind === 'OBJECT' && scope.resourceKind === target.resourceKind && scope.resourceId === target.resourceId)
      );
    if (!matches) continue;
    if (rule.ticketRequired && scope.ticketId === null) continue;
    // Case-bound support access cannot inherit an unbounded role scope.
    if (rule.ticketRequired && scope.expiresAt === null) {
      expired = true;
      continue;
    }
    if (scope.ticketId !== null && scope.ticketId !== target.ticketId) continue;
    if (target.amountCredits !== null && (scope.maxCredits === null || target.amountCredits > scope.maxCredits)) {
      amountExceeded = true;
      continue;
    }
    if (rule.approvalRequired) return deny(action, 'APPROVAL_REQUIRED');
    if (!rule.projectionReady) return deny(action, 'PROJECTION_REQUIRED');
    return allow(action);
  }
  if (amountExceeded) return deny(action, 'AMOUNT_EXCEEDED');
  return deny(action, expired ? 'SCOPE_EXPIRED' : 'SCOPE_MISSING');
}
