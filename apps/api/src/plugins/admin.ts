import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiFailure, ERROR_CODES, type OpsSession } from '@ancs/contracts';
import { decideOpsPermission, resolveOpsSession, type AuthContext, type OpsAuthDeps } from '@ancs/auth';
import { legacyAdminRoute, resolveLegacyAdminTarget } from './admin-actions.js';

/** Legacy `userIds` is accepted while old callers migrate, but grants no access. */
export interface AdminDeps {
  ops?: OpsAuthDeps;
  userIds?: readonly string[];
}

export const OPS_COOKIE_NAME = 'ancs_ops_session';

export function createAdminDeps(ops?: OpsAuthDeps): AdminDeps {
  return { ops };
}

export function readOpsCookie(request: FastifyRequest): string | null {
  const values = (request.headers.cookie ?? '').split(';').map((part) => part.trim());
  const matches = values.filter((part) => part.startsWith(`${OPS_COOKIE_NAME}=`));
  if (matches.length !== 1) return null;
  const value = matches[0]!.slice(OPS_COOKIE_NAME.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

const cookieSecurity = (ops: OpsAuthDeps | undefined): string =>
  ops?.environment === 'STAGING' || ops?.environment === 'PRODUCTION' ? '; Secure' : '';

export function opsCookieHeader(token: string, ops: OpsAuthDeps): string {
  return `${OPS_COOKIE_NAME}=${token}; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=${String(ops.policy.absoluteSeconds)}${cookieSecurity(ops)}`;
}

export function clearOpsCookieHeader(ops: OpsAuthDeps | undefined): string {
  return `${OPS_COOKIE_NAME}=; Path=/api/v1; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecurity(ops)}`;
}

declare module 'fastify' {
  interface FastifyInstance {
    requirePlatformAdmin(request: FastifyRequest): Promise<{ context: AuthContext; opsSession: OpsSession }>;
  }
}

/** All old `/admin/*` routes pass through the independent, MFA issued ops audience. */
export function registerAdminGuard(app: FastifyInstance, admin: AdminDeps): void {
  app.decorate('requirePlatformAdmin', async (request: FastifyRequest) => {
    const context = await app.authResolve(request);
    if (context === null) throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', 401);
    if (!admin.ops) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
    const opsSession = await resolveOpsSession(admin.ops, {
      token: readOpsCookie(request),
      context,
      requireRecentReauth: !['GET', 'HEAD', 'OPTIONS'].includes(request.method),
    });
    const legacyRoute = legacyAdminRoute(request);
    if (legacyRoute !== null) {
      // The registered route is canonical; URL spelling or encoding cannot weaken this gate.
      if (admin.ops.environment === 'PRODUCTION') {
        throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Production ops policy is not enabled', 403);
      }
      if (legacyRoute.action === null) {
        throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Ops action is not defined', 403);
      }
      const target = await resolveLegacyAdminTarget(admin.ops, request, legacyRoute.action);
      const decision = await decideOpsPermission(admin.ops, { session: opsSession, action: legacyRoute.action, target });
      if (!decision.allowed) {
        throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Ops action is not permitted', 403, { reason: decision.reason });
      }
    }
    return { context, opsSession };
  });
}
