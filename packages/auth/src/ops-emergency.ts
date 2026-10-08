import { and, eq, isNull } from 'drizzle-orm';
import {
  opaqueIdSchema, opsEmergencyActionSchema, opsEmergencyEligibilitySchema, opsEmergencyTargetKindSchema,
  type OpsEmergencyEligibility, type OpsSession,
} from '@ancs/contracts';
import { adminEmergencyGrants, adminPrincipals, adminRoleGrants } from '@ancs/db';
import type { OpsAuthDeps } from './ops.js';
import { publishedOpsPolicyMatches } from './ops-permissions.js';

const denied = (reason: NonNullable<OpsEmergencyEligibility['reason']>): OpsEmergencyEligibility =>
  opsEmergencyEligibilitySchema.parse({ eligible: false, grantId: null, reason });

/**
 * Policy eligibility only. The action is never executed here; N15-04/33 must preflight,
 * audit, alert, and execute a typed stop-loss command through the AdminAction workflow.
 */
export async function assessEmergencyGrant(
  deps: OpsAuthDeps,
  input: { session: OpsSession; action: unknown; targetKind: unknown; targetId: unknown; incidentId: unknown; now?: Date },
): Promise<OpsEmergencyEligibility> {
  const action = opsEmergencyActionSchema.safeParse(input.action);
  const targetKind = opsEmergencyTargetKindSchema.safeParse(input.targetKind);
  const targetId = opaqueIdSchema.safeParse(input.targetId);
  if (!action.success || !targetKind.success || !targetId.success ||
      typeof input.incidentId !== 'string' || input.incidentId.length === 0 || input.incidentId.length > 128) {
    return denied('UNKNOWN_ACTION');
  }
  if ((action.data === 'PAUSE_NEW_GENERATION' && targetKind.data !== 'WORKSPACE') ||
      (action.data === 'REVOKE_COMPROMISED_OPS_SESSION' && targetKind.data !== 'OPS_SESSION')) {
    return denied('UNKNOWN_ACTION');
  }
  if (input.session.environment !== deps.environment) return denied('ENVIRONMENT_MISMATCH');
  const policy = await publishedOpsPolicyMatches(deps);
  if (policy === 'INACTIVE') return denied('POLICY_INACTIVE');
  if (policy === 'MISMATCH') return denied('POLICY_MISMATCH');

  const principal = (await deps.db.select({ id: adminPrincipals.id }).from(adminPrincipals).where(and(
    eq(adminPrincipals.id, input.session.principalId), eq(adminPrincipals.environment, deps.environment), eq(adminPrincipals.enabled, true),
  )).limit(1))[0];
  if (!principal) return denied('ROLE_MISSING');
  const requiredRole = action.data === 'PAUSE_NEW_GENERATION' ? 'PRODUCTION_OPERATOR' : 'SECURITY_ADMIN';
  const role = (await deps.db.select({ id: adminRoleGrants.id }).from(adminRoleGrants).where(and(
    eq(adminRoleGrants.principalId, principal.id), eq(adminRoleGrants.role, requiredRole), isNull(adminRoleGrants.revokedAt),
  )).limit(1))[0];
  if (!role || !input.session.roles.includes(requiredRole)) return denied('ROLE_MISSING');

  const candidates = await deps.db.select().from(adminEmergencyGrants).where(and(
    eq(adminEmergencyGrants.principalId, principal.id), eq(adminEmergencyGrants.environment, deps.environment),
    eq(adminEmergencyGrants.action, action.data), eq(adminEmergencyGrants.targetKind, targetKind.data),
    eq(adminEmergencyGrants.targetId, targetId.data),
  ));
  if (candidates.length === 0) return denied('GRANT_MISSING');
  const now = input.now ?? new Date();
  let reason: NonNullable<OpsEmergencyEligibility['reason']> = 'INCIDENT_MISMATCH';
  for (const grant of candidates) {
    if (grant.incidentId !== input.incidentId) continue;
    if (grant.revokedAt !== null) { reason = 'GRANT_REVOKED'; continue; }
    if (grant.startsAt > now || grant.expiresAt <= now) { reason = 'GRANT_EXPIRED'; continue; }
    if (grant.alertedAt === null || grant.alertedAt > now) { reason = 'ALERT_REQUIRED'; continue; }
    return opsEmergencyEligibilitySchema.parse({ eligible: true, grantId: grant.id, reason: null });
  }
  return denied(reason);
}
