import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ERROR_CODES,
  errorEnvelope,
  errorEnvelopeSchema,
  nativeAuthorizeQuerySchema,
  revokeTokenRequestSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signInResponseSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  type AuthUser,
} from '@ancs/contracts';
import {
  AuthFailure,
  assertRegisteredClient,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  findUserById,
  refreshTokenPair,
  revokeRefreshToken,
} from '@ancs/auth';
import type { AuthDeps } from '../plugins/auth.js';

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
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): void {
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
      return { user: mapUser(result.response.user) };
    },
  );

  typed.post(
    '/auth/sign-out',
    { schema: { tags: ['auth'], summary: '退出（失效服务端会话）' } },
    async (request, reply) => {
      const result = await deps.auth.api.signOut({ headers: toHeaders(request), returnHeaders: true });
      copySetCookies(reply, result.headers);
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

      try {
        assertRegisteredClient(deps.tokens.config, query.clientId, query.redirectUri);
      } catch (error) {
        if (error instanceof AuthFailure) {
          return reply
            .status(error.httpStatus)
            .send(errorEnvelope(error.code, error.message, String(request.id)));
        }
        throw error;
      }

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
    async (request, reply) => {
      const body = request.body;
      try {
        if (body.grantType === 'authorization_code') {
          return await exchangeAuthorizationCode(deps.tokens, {
            code: body.code,
            codeVerifier: body.codeVerifier,
            clientId: body.clientId,
            redirectUri: body.redirectUri,
          });
        }
        return await refreshTokenPair(deps.tokens, {
          refreshToken: body.refreshToken,
          clientId: body.clientId,
        });
      } catch (error) {
        if (error instanceof AuthFailure) {
          return reply
            .status(error.httpStatus)
            .send(errorEnvelope(error.code, error.message, String(request.id)));
        }
        throw error;
      }
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
