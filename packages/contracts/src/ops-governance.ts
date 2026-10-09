import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { opsEnvironmentSchema } from './ops-auth.js';

/** A published policy must match the rule set compiled into the running service. */
export const OPS_PERMISSION_POLICY_STATUSES = ['DRAFT', 'ACTIVE', 'RETIRED'] as const;
export const opsPermissionPolicyStatusSchema = z.enum(OPS_PERMISSION_POLICY_STATUSES);
export const opsPermissionPolicyVersionSchema = z.object({
  id: opaqueIdSchema,
  environment: opsEnvironmentSchema,
  version: z.string().min(1).max(80),
  rulesHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: opsPermissionPolicyStatusSchema,
  publishedAt: isoDateTimeSchema.nullable(),
  retiredAt: isoDateTimeSchema.nullable(),
});
export type OpsPermissionPolicyVersion = z.infer<typeof opsPermissionPolicyVersionSchema>;

/** Emergency grants describe eligibility only; execution remains an AdminAction workflow. */
export const OPS_EMERGENCY_ACTIONS = ['PAUSE_NEW_GENERATION', 'REVOKE_COMPROMISED_OPS_SESSION'] as const;
export const opsEmergencyActionSchema = z.enum(OPS_EMERGENCY_ACTIONS);
export type OpsEmergencyAction = z.infer<typeof opsEmergencyActionSchema>;
export const opsEmergencyTargetKindSchema = z.enum(['WORKSPACE', 'OPS_SESSION']);
export const opsEmergencyGrantSchema = z.object({
  id: opaqueIdSchema,
  environment: opsEnvironmentSchema,
  principalId: opaqueIdSchema,
  action: opsEmergencyActionSchema,
  targetKind: opsEmergencyTargetKindSchema,
  targetId: opaqueIdSchema,
  incidentId: z.string().min(1).max(128),
  reason: z.string().min(10).max(500),
  startsAt: isoDateTimeSchema,
  expiresAt: isoDateTimeSchema,
  alertedAt: isoDateTimeSchema.nullable(),
  reviewDueAt: isoDateTimeSchema,
  revokedAt: isoDateTimeSchema.nullable(),
  reviewedAt: isoDateTimeSchema.nullable(),
  reviewedByPrincipalId: opaqueIdSchema.nullable(),
});
export type OpsEmergencyGrant = z.infer<typeof opsEmergencyGrantSchema>;

export const OPS_EMERGENCY_DENIALS = [
  'UNKNOWN_ACTION', 'POLICY_INACTIVE', 'POLICY_MISMATCH', 'ENVIRONMENT_MISMATCH',
  'ROLE_MISSING', 'GRANT_MISSING', 'INCIDENT_MISMATCH', 'ALERT_REQUIRED', 'GRANT_EXPIRED', 'GRANT_REVOKED',
] as const;
export const opsEmergencyEligibilitySchema = z.object({
  eligible: z.boolean(),
  grantId: opaqueIdSchema.nullable(),
  reason: z.enum(OPS_EMERGENCY_DENIALS).nullable(),
});
export type OpsEmergencyEligibility = z.infer<typeof opsEmergencyEligibilitySchema>;
