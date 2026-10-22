import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  ACCOUNT_ERROR_REASONS,
  accountEmailSentResponseSchema,
  ApiFailure,
  emailOnlyRequestSchema,
  ERROR_CODES,
  errorEnvelope,
  errorEnvelopeSchema,
  nativeAuthorizeQuerySchema,
  resetPasswordRequestSchema,
  resetPasswordResponseSchema,
  revokeTokenRequestSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signInResponseSchema,
  signUpRequestSchema,
  verifyEmailRequestSchema,
  verifyEmailResponseSchema,
  verifyTotpRequestSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  type AuthUser,
} from '@ancs/contracts';
import {
  assertRegisteredClient,
  activateOpsSession,
  authApiErrorCode,
  createAuthorizationCode,
  exchangeAuthorizationCode,
  findUserById,
  refreshTokenPair,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  revokeRefreshToken,
  signUpWithEmail,
  verifyEmailToken,
  withAccountEmailContext,
  type AccountDeps,
} from '@ancs/auth';
import type { AuthDeps } from '../plugins/auth.js';
import { opsCookieHeader, clearOpsCookieHeader, type AdminDeps } from '../plugins/admin.js';
import type { AccountsDeps } from '../plugins/email.js';

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
export function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps, admin: AdminDeps, accounts: AccountsDeps = { signupMode: 'closed' }): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const accountDeps: AccountDeps = { auth: deps.auth, db: deps.db, signupMode: accounts.signupMode, emailEnabled: accounts.email !== undefined };

  typed.post(
    '/auth/sign-in',
    { schema: { tags: ['auth'], summary: '登录（Web 会话 Cookie）', body: signInRequestSchema, response: { 200: signInResponseSchema } } },
    async (request, reply) => {
      const { locale, ...credentials } = request.body;
      let result;
      try {
        result = await withAccountEmailContext({ locale }, () => deps.auth.api.signInEmail({
          body: credentials,
          headers: toHeaders(request),
          returnHeaders: true,
        }));
      } catch (error) {
        // 密码正确但邮箱未验证：已重发验证邮件，界面提示去收件箱（D-04）
        if (authApiErrorCode(error) === 'EMAIL_NOT_VERIFIED') {
          throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Please verify your email before signing in', 403, { reason: ACCOUNT_ERROR_REASONS.EMAIL_NOT_VERIFIED });
        }
        throw error;
      }
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

  /**
   * 账号自助（D-04）。答复不透露邮箱是否已注册；注册方式与发信配置不满足时明确失败（403 / 501）。
   * 这些端点属于 auth 限流类别（按 IP），邮件另有同一收件人限频。
   */
  typed.post(
    '/auth/sign-up',
    { schema: { tags: ['auth'], summary: '邮箱注册（发验证邮件；invite 模式需持有邀请）', body: signUpRequestSchema, response: { 202: accountEmailSentResponseSchema } } },
    async (request, reply) => {
      const result = await signUpWithEmail(accountDeps, request.body);
      reply.header('cache-control', 'no-store');
      return reply.status(202).send(result);
    },
  );

  typed.post(
    '/auth/verify-email',
    { schema: { tags: ['auth'], summary: '确认邮箱（点开邮件链接；成功即登录）', body: verifyEmailRequestSchema, response: { 200: verifyEmailResponseSchema } } },
    async (request, reply) => {
      const verified = await verifyEmailToken(accountDeps, request.body.token);
      if (verified.setCookies.length > 0) reply.header('set-cookie', verified.setCookies);
      reply.header('cache-control', 'no-store');
      // 新会话的 Cookie 换出用户；链接之前已用过（已验证）时没有新会话 → user 为 null，界面请用户直接登录
      const cookie = verified.setCookies.map((value) => value.split(';')[0]).join('; ');
      const session = cookie === '' ? null : await deps.auth.api.getSession({ headers: new Headers({ cookie }) });
      const user = session === null ? null : await findUserById(deps.db, session.user.id);
      return { status: 'VERIFIED' as const, user };
    },
  );

  typed.post(
    '/auth/resend-verification',
    { schema: { tags: ['auth'], summary: '重发验证邮件', body: emailOnlyRequestSchema, response: { 202: accountEmailSentResponseSchema } } },
    async (request, reply) => reply.status(202).send(await resendVerificationEmail(accountDeps, request.body)),
  );

  typed.post(
    '/auth/request-password-reset',
    { schema: { tags: ['auth'], summary: '找回密码（发重设链接）', body: emailOnlyRequestSchema, response: { 202: accountEmailSentResponseSchema } } },
    async (request, reply) => reply.status(202).send(await requestPasswordReset(accountDeps, request.body)),
  );

  typed.post(
    '/auth/reset-password',
    { schema: { tags: ['auth'], summary: '用邮件里的链接设置新密码（其他会话全部失效）', body: resetPasswordRequestSchema, response: { 200: resetPasswordResponseSchema } } },
    async (request, reply) => {
      reply.header('cache-control', 'no-store');
      return resetPasswordWithToken(accountDeps, request.body);
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
