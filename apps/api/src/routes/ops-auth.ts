import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiFailure, ERROR_CODES, opsMfaEnrollmentRequestSchema, opsMfaEnrollmentSchema,
  opsRevokeSessionRequestSchema, opsSessionSchema, verifyTotpRequestSchema,
} from '@ancs/contracts';
import {
  assertOpsReauthAllowed, eligibleOpsPrincipal, markOpsReauthenticated,
  recordOpsReauthFailure, resolveOpsSession, revokeOwnOpsSession,
} from '@ancs/auth';
import type { AuthDeps } from '../plugins/auth.js';
import { clearOpsCookieHeader, readOpsCookie, type AdminDeps } from '../plugins/admin.js';

const authHeaders = (cookie: string | undefined): Headers => {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  return headers;
};

export function registerOpsAuthRoutes(app: FastifyInstance, auth: AuthDeps, admin: AdminDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.get('/ops/session', {
    schema: { tags: ['ops-auth'], summary: '当前独立运营会话', response: { 200: opsSessionSchema } },
  }, async (request, reply) => {
    const { opsSession } = await app.requirePlatformAdmin(request);
    reply.header('cache-control', 'no-store');
    return opsSession;
  });

  typed.post('/ops/mfa/enroll', {
    schema: { tags: ['ops-auth'], summary: '运营管理员启用 TOTP', body: opsMfaEnrollmentRequestSchema, response: { 200: opsMfaEnrollmentSchema } },
  }, async (request, reply) => {
    const context = await app.authResolve(request);
    if (!admin.ops || context?.kind !== 'web_session' || !await eligibleOpsPrincipal(admin.ops, context.userId)) {
      throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
    }
    const result = await auth.auth.api.enableTwoFactor({
      body: { password: request.body.password },
      headers: authHeaders(request.headers.cookie),
    });
    if (result.method !== 'totp') throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'TOTP unavailable', 409);
    reply.header('cache-control', 'no-store');
    return { totpUri: result.totpURI, backupCodes: result.backupCodes };
  });

  typed.post('/ops/reauth', {
    schema: { tags: ['ops-auth'], summary: 'TOTP 重新验证敏感运营操作', body: verifyTotpRequestSchema, response: { 200: opsSessionSchema } },
  }, async (request, reply) => {
    if (!admin.ops) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
    const context = await app.authResolve(request);
    const current = await resolveOpsSession(admin.ops, { token: readOpsCookie(request), context });
    await assertOpsReauthAllowed(admin.ops, current.id);
    try {
      await auth.auth.api.verifyTOTP({
        body: { code: request.body.code, trustDevice: false },
        headers: authHeaders(request.headers.cookie),
      });
    } catch {
      await recordOpsReauthFailure(admin.ops, current.id);
      throw new ApiFailure(ERROR_CODES.UNAUTHENTICATED, 'Verification failed', 401);
    }
    await markOpsReauthenticated(admin.ops, current.id);
    reply.header('cache-control', 'no-store');
    return resolveOpsSession(admin.ops, { token: readOpsCookie(request), context });
  });

  typed.post('/ops/sessions/revoke', {
    schema: { tags: ['ops-auth'], summary: '撤销本人的运营设备会话', body: opsRevokeSessionRequestSchema },
  }, async (request, reply) => {
    const { context, opsSession } = await app.requirePlatformAdmin(request);
    if (!admin.ops) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'not found', 404);
    await revokeOwnOpsSession(admin.ops, {
      userId: context.userId,
      principalId: opsSession.principalId,
      sessionId: request.body.sessionId,
    });
    if (request.body.sessionId === opsSession.id) reply.header('set-cookie', clearOpsCookieHeader(admin.ops));
    return reply.status(204).send();
  });
}
