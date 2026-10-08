import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ApiFailure,
  ERROR_CODES,
  errorEnvelope,
  errorEnvelopeSchema,
  nativeAuthorizeQuerySchema,
  revokeTokenRequestSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signInResponseSchema,
  verifyTotpRequestSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  type AuthUser,
} from '@ancs/contracts';
import {
  assertRegisteredClient,
  activateOpsSession,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  findUserById,
  refreshTokenPair,
  revokeRefreshToken,
} from '@ancs/auth';
import type { AuthDeps } from '../plugins/auth.js';
import { opsCookieHeader, clearOpsCookieHeader, type AdminDeps } from '../plugins/admin.js';

/** 请求头 → Headers（供 Better Auth 读取 Cookie）。 */
const toHeaders = (request: FastifyRequest): Headers => {
  const headers = new Headers();
  if (request.headers.cookie !== undefined) headers.set('cookie', request.headers.cookie);
  if (request.headers.authorization !== undefined) headers.set('authorization', request.headers.authorization);
  return headers;
};

const copySetCookies = (reply: FastifyReply, headers: Headers): void => {
  const cookies = headers.getSetCookie();
  if (cookies.length > 0) reply.header('set-cookie', cookies);
};

const mapUser = (source: { id: string; name: string; email: string; emailVerified: boolean }): AuthUser => ({
  id: source.id,
  name: source.name,
  email: source.email,
  emailVerified: source.emailVerified,
});

/**
 * 认证路由（P01-02）：
 * - Web：sign-in / sign-out / session（Better Auth 会话 Cookie）；
 * - 原生：authorize（授权码 + PKCE）→ token（兑换/轮换）→ revoke（退出）。
 * 认证失败统一使用契约错误信封（REQ-33-02）；authorize 的"错误回调"按授权流程惯例
 * 把错误重定向回 redirect_uri（error + state）。
 */
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps, admin: AdminDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    '/auth/sign-in',
    { schema: { tags: ['auth'], summary: '登录（Web 会话 Cookie）', body: signInRequestSchema, response: { 200: signInResponseSchema } } },
    async (request, reply) => {
      const result = await deps.auth.api.signInEmail({
        body: request.body,
        headers: toHeaders(request),
        returnHeaders: true,
      });
      copySetCookies(reply, result.headers);
      reply.header('cache-control', 'no-store');
      const challenge = result.response as { twoFactorRedirect?: boolean; twoFactorMethods?: unknown };
      if (challenge.twoFactorRedirect === true) {
        if (!Array.isArray(challenge.twoFactorMethods) || !challenge.twoFactorMethods.includes('totp')) {
          throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'Second factor unavailable', 409);
        }
        return { twoFactorRequired: true as const, methods: ['totp' as const] };
      }
      return { user: mapUser(result.response.user) };
    },
  );

  typed.post(
    '/auth/verify-totp',
    { schema: { tags: ['auth'], summary: '完成 TOTP 登录或启用确认', body: verifyTotpRequestSchema, response: { 200: signInResponseSchema } } },
    async (request, reply) => {
      // 已登录会话在这里仅确认 enrollment；它不能借本端点升级为 ops 会话。
      // 独立 ops cookie 只签发给未登录的 Better Auth 二次挑战成功结果。
      const existingContext = await app.authResolve(request);
      const result = await deps.auth.api.verifyTOTP({
        body: { code: request.body.code, trustDevice: false },
        headers: toHeaders(request),
        returnHeaders: true,
      });
      const cookies = result.headers.getSetCookie();
      if (admin.ops && existingContext === null) {
        const issued = await activateOpsSession(admin.ops, {
          userId: result.response.user.id,
          authSessionToken: result.response.token,
          userAgent: request.headers['user-agent'],
          ipAddress: request.ip,
        });
        if (issued) cookies.push(opsCookieHeader(issued.token, admin.ops));
      }
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      reply.header('cache-control', 'no-store');
      return { user: mapUser(result.response.user) };
    },
  );

  typed.post(
    '/auth/sign-out',
    { schema: { tags: ['auth'], summary: '退出（失效服务端会话）' } },
    async (request, reply) => {
      const result = await deps.auth.api.signOut({ headers: toHeaders(request), returnHeaders: true });
      reply.header('set-cookie', [...result.headers.getSetCookie(), clearOpsCookieHeader(admin.ops)]);
      return reply.status(204).send();
    },
  );

  typed.get(
    '/auth/session',
    {
      schema: {
        tags: ['auth'],
        summary: '当前会话信息',
        response: { 200: sessionInfoSchema, 401: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const context = await app.authResolve(request);
      if (context === null) {
        return reply
          .status(401)
          .send(errorEnvelope(ERROR_CODES.UNAUTHENTICATED, 'Not authenticated', String(request.id)));
      }
      const authUser = await findUserById(deps.db, context.userId);
      if (authUser === null) {
        return reply
          .status(401)
          .send(errorEnvelope(ERROR_CODES.UNAUTHENTICATED, 'Session user no longer exists', String(request.id)));
      }
      return {
        user: authUser,
        sessionId: context.sessionId,
        method: context.kind,
        expiresAt: context.expiresAt.toISOString(),
      };
    },
  );

  typed.get(
    '/auth/authorize',
    {
      schema: {
        tags: ['auth'],
        summary: '原生客户端授权（授权码 + PKCE；需已登录的 Web 会话）',
        querystring: nativeAuthorizeQuerySchema,
        response: { 400: errorEnvelopeSchema },
      },
    },
    async (request, reply) => {
      const query = request.query;

      // ApiFailure 由全局错误处理器统一转换（apps/api/src/error-handler.ts）
      assertRegisteredClient(deps.tokens.config, query.clientId, query.redirectUri);

      const redirect = new URL(query.redirectUri);
      redirect.searchParams.set('state', query.state);

      const context = await app.authResolve(request);
      if (context === null || context.kind !== 'web_session') {
        redirect.searchParams.set('error', 'login_required');
        return reply.redirect(redirect.toString());
      }

      const code = await createAuthorizationCode(deps.tokens, {
        userId: context.userId,
        clientId: query.clientId,
        redirectUri: query.redirectUri,
        codeChallenge: query.codeChallenge,
      });
      redirect.searchParams.set('code', code);
      return reply.redirect(redirect.toString());
    },
  );

  typed.post(
    '/auth/token',
    {
      schema: {
        tags: ['auth'],
        summary: '令牌端点：授权码兑换 / Refresh 轮换',
        body: tokenRequestSchema,
        response: { 200: tokenResponseSchema, 400: errorEnvelopeSchema },
      },
    },
    async (request) => {
      const body = request.body;
      // ApiFailure 由全局错误处理器统一转换（apps/api/src/error-handler.ts）
      if (body.grantType === 'authorization_code') {
        return exchangeAuthorizationCode(deps.tokens, {
          code: body.code,
          codeVerifier: body.codeVerifier,
          clientId: body.clientId,
          redirectUri: body.redirectUri,
        });
      }
      return refreshTokenPair(deps.tokens, {
        refreshToken: body.refreshToken,
        clientId: body.clientId,
      });
    },
  );

  typed.post(
    '/auth/revoke',
    { schema: { tags: ['auth'], summary: '撤销（退出原生会话）', body: revokeTokenRequestSchema } },
    async (request, reply) => {
      await revokeRefreshToken(deps.tokens, {
        refreshToken: request.body.refreshToken,
        clientId: request.body.clientId,
      });
      return reply.status(204).send();
    },
  );
}
