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
  /** 界面语言：邮箱未验证时会重发验证邮件，用这个语言（D-04） */
  locale: z.enum(['zh-CN', 'en']).optional(),
});

export const signInResponseSchema = z.union([
  z.object({ user: authUserSchema }),
  z.object({ twoFactorRequired: z.literal(true), methods: z.array(z.literal('totp')).min(1) }),
]);

export const verifyTotpRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/, '需要 6 位验证码') });

export type SignInResponse = z.infer<typeof signInResponseSchema>;

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

/**
 * 账号自助（D-04）：邮箱注册、邮箱验证、找回密码。
 *
 * - 注册方式由部署配置 `ANCS_SIGNUP_MODE` 决定：closed = 只能由运营创建账号；invite = 只有收到邀请的邮箱能注册；open = 任何人；
 * - 防枚举：注册与找回密码对"邮箱已注册 / 不存在"给出同一个答复（真实结果只出现在发往该邮箱的邮件里）；
 * - 邮件语言取请求里的界面语言。
 */
export const SIGNUP_MODES = ['closed', 'invite', 'open'] as const;
export const signupModeSchema = z.enum(SIGNUP_MODES);
export type SignupMode = z.infer<typeof signupModeSchema>;

/** 邮件语言（与 Web 界面语言一致） */
export const accountEmailLocaleSchema = z.enum(['zh-CN', 'en']);
export type AccountEmailLocale = z.infer<typeof accountEmailLocaleSchema>;

export const ACCOUNT_ERROR_REASONS = {
  /** 本部署不开放注册 */
  SIGNUP_CLOSED: 'SIGNUP_CLOSED',
  /** 仅限受邀邮箱注册，这个邮箱没有有效邀请 */
  SIGNUP_INVITE_REQUIRED: 'SIGNUP_INVITE_REQUIRED',
  /** 未配置发信：无法发送验证 / 重置邮件 */
  EMAIL_NOT_CONFIGURED: 'EMAIL_NOT_CONFIGURED',
  /** 邮箱尚未验证：登录前需点开验证邮件 */
  EMAIL_NOT_VERIFIED: 'EMAIL_NOT_VERIFIED',
  /** 链接无效或已过期 */
  INVALID_TOKEN: 'INVALID_TOKEN',
} as const;

/** 密码长度与登录一致：8—128 */
const passwordSchema = z.string().min(8).max(128);

export const signUpRequestSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: passwordSchema,
  locale: accountEmailLocaleSchema.optional(),
}).strict();
export type SignUpRequest = z.infer<typeof signUpRequestSchema>;

/** 注册 / 重发验证 / 找回密码的统一答复：只说"请查收邮件"，不透露邮箱是否已注册 */
export const accountEmailSentResponseSchema = z.object({ status: z.literal('EMAIL_SENT') });
export type AccountEmailSentResponse = z.infer<typeof accountEmailSentResponseSchema>;

export const emailOnlyRequestSchema = z.object({
  email: z.email().max(254),
  locale: accountEmailLocaleSchema.optional(),
}).strict();
export type EmailOnlyRequest = z.infer<typeof emailOnlyRequestSchema>;

/** 邮件链接里的一次性令牌（验证邮箱 / 重置密码） */
const emailTokenSchema = z.string().min(16).max(4096).regex(/^[A-Za-z0-9._~-]+$/, '令牌格式不正确');

export const verifyEmailRequestSchema = z.object({ token: emailTokenSchema }).strict();
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;
/** 验证成功即登录（返回 Web 会话 Cookie 与用户）；链接之前已用过（邮箱早已验证）时 user 为 null，请直接登录 */
export const verifyEmailResponseSchema = z.object({ status: z.literal('VERIFIED'), user: authUserSchema.nullable() });

export const resetPasswordRequestSchema = z.object({ token: emailTokenSchema, newPassword: passwordSchema }).strict();
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;
export const resetPasswordResponseSchema = z.object({ status: z.literal('PASSWORD_RESET') });

/** 账号自助能力（经 /capabilities 公开，登录页据此显示"注册""忘记密码"入口） */
export const accountCapabilitiesSchema = z.object({
  signup: signupModeSchema,
  passwordReset: z.boolean(),
});
export type AccountCapabilities = z.infer<typeof accountCapabilitiesSchema>;
