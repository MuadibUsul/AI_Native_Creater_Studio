import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/** Closed action vocabulary for the 23 legacy Admin routes. Unknown actions are denied. */
export const OPS_ACTIONS = [
  'ops.overview.read', 'ops.metrics.read', 'ops.job.list', 'ops.job.retry',
  'ops.audit.read', 'ops.user.list', 'ops.workspace.list', 'ops.project.list',
  'ops.provider.status.read', 'ops.storage.summary.read', 'ops.credit.statement.read',
  'ops.audit.log.read', 'ops.abuse.flag.list', 'ops.abuse.flag.create',
  'ops.abuse.flag.resolve', 'ops.abuse.state.set', 'ops.support.grant.list',
  'ops.support.grant.create', 'ops.support.grant.revoke', 'ops.support.view',
  'ops.credit.grant', 'ops.credit.refund_of', 'ops.plan.assign',
] as const;
export const opsActionSchema = z.enum(OPS_ACTIONS);
export type OpsAction = z.infer<typeof opsActionSchema>;

export const OPS_SCOPE_KINDS = ['PLATFORM', 'WORKSPACE', 'OBJECT'] as const;
export const opsScopeKindSchema = z.enum(OPS_SCOPE_KINDS);
export type OpsScopeKind = z.infer<typeof opsScopeKindSchema>;

export const OPS_RESOURCE_KINDS = [
  'USER', 'WORKSPACE', 'PROJECT', 'JOB', 'ABUSE_FLAG', 'SUPPORT_GRANT',
  'LEDGER_ENTRY', 'PLAN',
] as const;
export const opsResourceKindSchema = z.enum(OPS_RESOURCE_KINDS);
export type OpsResourceKind = z.infer<typeof opsResourceKindSchema>;

/** Server-owned object facts: the client must not choose a target workspace or amount. */
export const opsPermissionTargetSchema = z.object({
  workspaceId: opaqueIdSchema.nullable(),
  resourceKind: opsResourceKindSchema.nullable(),
  resourceId: opaqueIdSchema.nullable(),
  amountCredits: z.number().int().nonnegative().nullable(),
  ticketId: z.string().min(1).max(128).nullable(),
});
export type OpsPermissionTarget = z.infer<typeof opsPermissionTargetSchema>;

export const OPS_PERMISSION_DENIALS = [
  'UNKNOWN_ACTION', 'ENVIRONMENT_MISMATCH', 'ROLE_MISSING', 'SCOPE_MISSING',
  'SCOPE_EXPIRED', 'OBJECT_MISMATCH', 'AMOUNT_EXCEEDED', 'TICKET_REQUIRED',
  'APPROVAL_REQUIRED', 'PROJECTION_REQUIRED', 'POLICY_INACTIVE', 'POLICY_MISMATCH',
] as const;
export const opsPermissionDenialSchema = z.enum(OPS_PERMISSION_DENIALS);
export type OpsPermissionDenial = z.infer<typeof opsPermissionDenialSchema>;

export const opsPermissionDecisionSchema = z.object({
  allowed: z.boolean(),
  action: opsActionSchema.nullable(),
  policyVersion: z.string().min(1),
  reason: opsPermissionDenialSchema.nullable(),
});
export type OpsPermissionDecision = z.infer<typeof opsPermissionDecisionSchema>;
