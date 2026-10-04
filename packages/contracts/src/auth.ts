import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 认证契约（规范 §30 / 计划 P01-02）。
 *
 * 设计说明：
 * - Web 会话：Better Auth 会话 Cookie（HttpOnly），滑动续期（§30）。
 * - 原生客户端：Authorization Code + PKCE 模式（计划 §3.1），换取
 *   短生命周期 Access Token + 轮换式 Refresh Token（§30）。
 * - 字段命名遵循计划 §4.1 的 camelCase 约定（本流程由本平台客户端使用，
 *   非对第三方开放的通用 OAuth 端点；流程形态为授权码 + PKCE）。
 */

export const authUserSchema = z.object({
  id: opaqueIdSchema,
  email: z.email(),
  name: z.string().min(1),
  emailVerified: z.boolean(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

export const AUTH_METHODS = ['web_session', 'native_access'] as const;

/** GET /api/v1/auth/session 的响应（同时被错误码 UNAUTHENTICATED 的 401 路径覆盖） */
export const sessionInfoSchema = z.object({
  user: authUserSchema,
  /** web_session 时为会话 ID；native_access 时为空 */
  sessionId: z.string().nullable(),
  method: z.enum(AUTH_METHODS),
  expiresAt: isoDateTimeSchema,
});

export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const signInRequestSchema = z.object({
  email: z.email(),
  password: z.string().min(8).max(128),
});

export const signInResponseSchema = z.object({
  user: authUserSchema,
});

/** GET /api/v1/auth/authorize（原生 PKCE 第一步；由已登录的 Web 会话发起） */
export const nativeAuthorizeQuerySchema = z.object({
  responseType: z.literal('code'),
  clientId: z.string().min(1).max(100),
  redirectUri: z.string().min(1).max(500),
  /** PKCE：S256 挑战（base64url，无填充） */
  codeChallenge: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43,128}$/, 'codeChallenge 必须为 base64url（43—128 字符）'),
  codeChallengeMethod: z.literal('S256').default('S256'),
  state: z.string().min(1).max(200),
});

/** POST /api/v1/auth/token（授权码兑换 / 刷新轮换） */
export const authorizationCodeGrantSchema = z.object({
  grantType: z.literal('authorization_code'),
  clientId: z.string().min(1),
  code: z.string().min(8),
  codeVerifier: z.string().min(43).max(128),
  redirectUri: z.string().min(1).optional(),
});

export const refreshTokenGrantSchema = z.object({
  grantType: z.literal('refresh_token'),
  clientId: z.string().min(1),
  refreshToken: z.string().min(8),
});

export const tokenRequestSchema = z.discriminatedUnion('grantType', [
  authorizationCodeGrantSchema,
  refreshTokenGrantSchema,
]);

export const tokenResponseSchema = z.object({
  tokenType: z.literal('Bearer'),
  accessToken: z.string().min(8),
  /** 秒 */
  expiresIn: z.number().int().positive(),
  refreshToken: z.string().min(8),
  /** 秒 */
  refreshExpiresIn: z.number().int().positive(),
});

export type TokenRequest = z.infer<typeof tokenRequestSchema>;
export type TokenResponse = z.infer<typeof tokenResponseSchema>;

/** POST /api/v1/auth/revoke（退出原生会话：撤销整个 refresh 家族） */
export const revokeTokenRequestSchema = z.object({
  clientId: z.string().min(1),
  refreshToken: z.string().min(8),
});

export type RevokeTokenRequest = z.infer<typeof revokeTokenRequestSchema>;
