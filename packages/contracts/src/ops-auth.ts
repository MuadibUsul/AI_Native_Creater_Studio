import { z } from 'zod';
import { isoDateTimeSchema } from './common/time.js';

export const OPS_ENVIRONMENTS = ['DEVELOPMENT', 'TEST', 'STAGING', 'PRODUCTION'] as const;
export const opsEnvironmentSchema = z.enum(OPS_ENVIRONMENTS);
export type OpsEnvironment = z.infer<typeof opsEnvironmentSchema>;

export const OPS_ROLES = [
  'PLATFORM_OWNER', 'SUPPORT_L1', 'SUPPORT_L2', 'PRODUCTION_OPERATOR',
  'PROVIDER_MANAGER', 'BILLING_OPERATOR', 'BILLING_APPROVER',
  'CONTENT_REVIEWER', 'REVIEW_LEAD', 'AI_QUALITY', 'STRATEGY_CURATOR',
  'GROWTH_ANALYST', 'PRIVACY_OFFICER', 'SECURITY_ADMIN', 'AUDITOR', 'SERVICE_ACCOUNT',
] as const;
export const opsRoleSchema = z.enum(OPS_ROLES);
export type OpsRole = z.infer<typeof opsRoleSchema>;

export const opsSessionSchema = z.object({
  id: z.string().min(1),
  principalId: z.string().min(1),
  environment: opsEnvironmentSchema,
  roles: z.array(opsRoleSchema),
  createdAt: isoDateTimeSchema,
  idleExpiresAt: isoDateTimeSchema,
  absoluteExpiresAt: isoDateTimeSchema,
  reauthenticatedAt: isoDateTimeSchema,
  securityNotice: z.enum(['NEW_DEVICE']).nullable(),
});
export type OpsSession = z.infer<typeof opsSessionSchema>;

export const opsMfaEnrollmentRequestSchema = z.object({ password: z.string().min(8).max(128) });
/** 一次性敏感响应；TOTP URI 和恢复码不得写入日志、持久客户端状态或普通 DTO。 */
export const opsMfaEnrollmentSchema = z.object({
  totpUri: z.string().startsWith('otpauth://totp/'),
  backupCodes: z.array(z.string().min(8)).min(1),
});
export const opsRevokeSessionRequestSchema = z.object({ sessionId: z.string().min(1) });
