import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ApiFailure, ERROR_CODES, opsRoleSchema, opsSessionSchema, type OpsEnvironment, type OpsSession } from '@ancs/contracts';
import { adminPrincipals, adminRoleGrants, adminSessions, auditLog, session, user } from '@ancs/db';
import type { AuthContext } from './session.js';

export interface OpsSessionPolicy {
  idleSeconds: number;
  absoluteSeconds: number;
  reauthSeconds: number;
}

export const DEFAULT_OPS_SESSION_POLICY: OpsSessionPolicy = {
  idleSeconds: 15 * 60,
  absoluteSeconds: 8 * 60 * 60,
  reauthSeconds: 5 * 60,
};

export interface OpsAuthDeps {
  db: NodePgDatabase;
  environment: OpsEnvironment;
  fingerprintKey: string;
  policy: OpsSessionPolicy;
}

const denied = (): ApiFailure => new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
const tokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
const fingerprint = (key: string, value: string | undefined): string | null =>
  value ? createHmac('sha256', key).update(value).digest('hex') : null;

export async function eligibleOpsPrincipal(deps: OpsAuthDeps, userId: string) {
  const principal = (await deps.db.select().from(adminPrincipals).where(and(
    eq(adminPrincipals.userId, userId),
    eq(adminPrincipals.environment, deps.environment),
    eq(adminPrincipals.enabled, true),
  )).limit(1))[0];
  if (!principal) return null;
  const grants = await deps.db.select().from(adminRoleGrants).where(and(
    eq(adminRoleGrants.principalId, principal.id), isNull(adminRoleGrants.revokedAt),
  ));
  const parsedRoles = grants.map((grant) => opsRoleSchema.safeParse(grant.role));
  if (parsedRoles.some((role) => !role.success)) return null;
  const allRoles = parsedRoles.map((role) => role.data!);
  // 机器人身份不能借另一角色进入交互式人类运营会话。
  if (allRoles.includes('SERVICE_ACCOUNT')) return null;
  const roles = allRoles;
  return roles.length > 0 ? { principal, roles } : null;
}

/** 仅在 Better Auth 已完成 TOTP 验证后由 API 调用；没有公开的跳过 MFA 入口。 */
export async function activateOpsSession(
  deps: OpsAuthDeps,
  input: { userId: string; authSessionToken: string; userAgent?: string; ipAddress?: string },
): Promise<{ token: string; session: OpsSession } | null> {
  const eligible = await eligibleOpsPrincipal(deps, input.userId);
  if (!eligible) return null;
  const [authSession, authUser] = await Promise.all([
    deps.db.select().from(session).where(eq(session.token, input.authSessionToken)).limit(1),
    deps.db.select({ twoFactorEnabled: user.twoFactorEnabled }).from(user).where(eq(user.id, input.userId)).limit(1),
  ]);
  const underlying = authSession[0];
  if (!underlying || underlying.userId !== input.userId || underlying.expiresAt <= new Date() || authUser[0]?.twoFactorEnabled !== true) {
    throw denied();
  }
  const now = new Date();
  const rawToken = randomBytes(32).toString('base64url');
  const userAgentHash = fingerprint(deps.fingerprintKey, input.userAgent);
  const ipHash = fingerprint(deps.fingerprintKey, input.ipAddress);
  const previous = (await deps.db.select({ userAgentHash: adminSessions.userAgentHash })
    .from(adminSessions)
    .where(eq(adminSessions.principalId, eligible.principal.id))
    .orderBy(desc(adminSessions.createdAt)).limit(1))[0];
  const securityNotice = previous?.userAgentHash && userAgentHash && previous.userAgentHash !== userAgentHash ? 'NEW_DEVICE' as const : null;
  const absoluteExpiresAt = new Date(Math.min(now.getTime() + deps.policy.absoluteSeconds * 1000, underlying.expiresAt.getTime()));
  const created = await deps.db.transaction(async (tx) => {
    const [row] = await tx.insert(adminSessions).values({
      id: `opses_${randomUUID()}`,
      principalId: eligible.principal.id,
      authSessionId: underlying.id,
      tokenHash: tokenHash(rawToken),
      environment: deps.environment,
      grantVersion: eligible.principal.grantVersion,
      createdAt: now,
      lastSeenAt: now,
      absoluteExpiresAt,
      reauthenticatedAt: now,
      userAgentHash,
      ipHash,
    }).onConflictDoUpdate({
      target: adminSessions.authSessionId,
      set: {
        tokenHash: tokenHash(rawToken),
        grantVersion: eligible.principal.grantVersion,
        createdAt: now,
        lastSeenAt: now,
        absoluteExpiresAt,
        reauthenticatedAt: now,
        revokedAt: null,
        userAgentHash,
        ipHash,
        reauthFailures: 0,
        reauthLockedUntil: null,
      },
    }).returning();
    if (!row) throw new Error('ops session insert failed');
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID()}`,
      actorKind: 'PLATFORM_ADMIN',
      actorUserId: input.userId,
      action: securityNotice ? 'ops.auth.new_device' : 'ops.auth.session_started',
      targetType: 'admin_session',
      targetId: row.id,
      details: { environment: deps.environment },
    });
    return row;
  });
  return {
    token: rawToken,
    session: opsSessionSchema.parse({
      id: created.id,
      principalId: created.principalId,
      environment: deps.environment,
      roles: eligible.roles,
      createdAt: created.createdAt.toISOString(),
      idleExpiresAt: new Date(created.lastSeenAt.getTime() + deps.policy.idleSeconds * 1000).toISOString(),
      absoluteExpiresAt: created.absoluteExpiresAt.toISOString(),
      reauthenticatedAt: created.reauthenticatedAt.toISOString(),
      securityNotice,
    }),
  };
}

export async function resolveOpsSession(
  deps: OpsAuthDeps,
  input: { token: string | null; context: AuthContext | null; requireRecentReauth?: boolean },
): Promise<OpsSession> {
  if (!input.token || input.context?.kind !== 'web_session' || !input.context.sessionId) throw denied();
  const now = new Date();
  const row = (await deps.db.select().from(adminSessions).where(and(
    eq(adminSessions.tokenHash, tokenHash(input.token)),
    eq(adminSessions.environment, deps.environment),
    eq(adminSessions.authSessionId, input.context.sessionId),
    isNull(adminSessions.revokedAt),
  )).limit(1))[0];
  if (!row || row.absoluteExpiresAt <= now || row.lastSeenAt.getTime() + deps.policy.idleSeconds * 1000 <= now.getTime()) throw denied();
  const eligible = await eligibleOpsPrincipal(deps, input.context.userId);
  if (!eligible || eligible.principal.id !== row.principalId || eligible.principal.grantVersion !== row.grantVersion) throw denied();
  const mfaState = (await deps.db.select({ enabled: user.twoFactorEnabled }).from(user)
    .where(eq(user.id, input.context.userId)).limit(1))[0];
  if (mfaState?.enabled !== true) throw denied();
  if (input.requireRecentReauth && row.reauthenticatedAt.getTime() + deps.policy.reauthSeconds * 1000 <= now.getTime()) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, '运营敏感操作需要重新验证', 403);
  }
  const [updated] = await deps.db.update(adminSessions).set({ lastSeenAt: now }).where(and(
    eq(adminSessions.id, row.id),
    isNull(adminSessions.revokedAt),
    gt(adminSessions.absoluteExpiresAt, now),
    gt(adminSessions.lastSeenAt, new Date(now.getTime() - deps.policy.idleSeconds * 1000)),
    eq(adminSessions.grantVersion, eligible.principal.grantVersion),
  )).returning();
  if (!updated) throw denied();
  const anomaly = (await deps.db.select({ id: auditLog.id }).from(auditLog).where(and(
    eq(auditLog.targetId, row.id), eq(auditLog.action, 'ops.auth.new_device'),
  )).limit(1))[0];
  return opsSessionSchema.parse({
    id: row.id,
    principalId: row.principalId,
    environment: deps.environment,
    roles: eligible.roles,
    createdAt: row.createdAt.toISOString(),
    idleExpiresAt: new Date(now.getTime() + deps.policy.idleSeconds * 1000).toISOString(),
    absoluteExpiresAt: row.absoluteExpiresAt.toISOString(),
    reauthenticatedAt: row.reauthenticatedAt.toISOString(),
    securityNotice: anomaly ? 'NEW_DEVICE' : null,
  });
}

export async function revokeOwnOpsSession(deps: OpsAuthDeps, input: { userId: string; principalId: string; sessionId: string }): Promise<void> {
  const [row] = await deps.db.update(adminSessions).set({ revokedAt: new Date() }).where(and(
    eq(adminSessions.id, input.sessionId),
    eq(adminSessions.principalId, input.principalId),
    isNull(adminSessions.revokedAt),
  )).returning();
  if (!row) throw denied();
  await deps.db.insert(auditLog).values({
    id: `aud_${randomUUID()}`,
    actorKind: 'PLATFORM_ADMIN', actorUserId: input.userId,
    action: 'ops.auth.session_revoked', targetType: 'admin_session', targetId: row.id,
    details: { environment: deps.environment },
  });
}

export async function assertOpsReauthAllowed(deps: OpsAuthDeps, sessionId: string): Promise<void> {
  const row = (await deps.db.select({ lockedUntil: adminSessions.reauthLockedUntil }).from(adminSessions).where(eq(adminSessions.id, sessionId)).limit(1))[0];
  if (!row || (row.lockedUntil && row.lockedUntil > new Date())) throw new ApiFailure(ERROR_CODES.RATE_LIMITED, '验证尝试过多，请稍后重试', 429);
}

export async function recordOpsReauthFailure(deps: OpsAuthDeps, sessionId: string): Promise<void> {
  await deps.db.update(adminSessions).set({
    reauthFailures: sql`${adminSessions.reauthFailures} + 1`,
    reauthLockedUntil: sql`case when ${adminSessions.reauthFailures} + 1 >= 5 then now() + interval '15 minutes' else null end`,
  }).where(eq(adminSessions.id, sessionId));
}

export async function markOpsReauthenticated(deps: OpsAuthDeps, sessionId: string): Promise<void> {
  await deps.db.update(adminSessions).set({
    reauthenticatedAt: new Date(), reauthFailures: 0, reauthLockedUntil: null,
  }).where(and(eq(adminSessions.id, sessionId), isNull(adminSessions.revokedAt)));
}
