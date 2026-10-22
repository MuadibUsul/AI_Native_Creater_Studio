import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { twoFactor as twoFactorPlugin } from 'better-auth/plugins';
import { and, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { account, session, signupInvitations, user, verification, twoFactor } from '@ancs/db';
import { accountLink, dispatchAccountEmail, type AccountEmailOptions } from './account-email.js';

/**
 * Better Auth 集成（计划 §3.1 / 规范 §30）。
 *
 * 职责边界：
 * - Better Auth 负责：用户记录、密码凭据、Web 会话（HttpOnly Cookie、滑动续期）；
 * - 原生客户端的 Access/Refresh Token 由本包 native-tokens 层实现（服务端权威、哈希存储）。
 *
 * 配置了发信（`email`）时（D-04）：
 * - 登录前必须验证邮箱（运营建的账号建号时即标记已验证）；未验证的人登录会再收到一封验证邮件；
 * - 验证链接 24 小时有效，点开即登录；重设密码链接 1 小时有效、只能用一次，重设后其他会话全部失效，
 *   并视为邮箱已验证（能收到重设邮件即证明邮箱归属）；
 * - 用已注册的邮箱再注册：接口答复与新注册相同，只给邮箱主人发一封"你已经有账号了"。
 * 未配置发信时保持原样：不要求验证、不能找回密码（注册入口也关闭，见 accounts.ts）。
 */

export interface AuthCoreOptions {
  db: NodePgDatabase;
  /** 会话与 Cookie 签名密钥（生产经 KMS/Secrets 注入，禁止入库） */
  secret: string;
  baseUrl: string;
  /** Web 会话有效期（秒），默认 30 天 */
  sessionTtlSeconds?: number;
  /** 会话滑动续期间隔（秒），默认 1 天 */
  sessionUpdateAgeSeconds?: number;
  /** 账号邮件（注册验证、找回密码）；不配则不要求邮箱验证、不能找回密码 */
  email?: AccountEmailOptions;
}

/** 验证链接有效期（秒） */
export const EMAIL_VERIFICATION_TTL_SECONDS = 24 * 60 * 60;
/** 重设密码链接有效期（秒） */
export const RESET_PASSWORD_TTL_SECONDS = 60 * 60;

export function createAuth(options: AuthCoreOptions) {
  const email = options.email;
  return betterAuth({
    database: drizzleAdapter(options.db, {
      provider: 'pg',
      schema: { user, session, account, verification, twoFactor },
    }),
    secret: options.secret,
    baseURL: options.baseUrl,
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 8,
      ...(email === undefined ? {} : {
        requireEmailVerification: true,
        resetPasswordTokenExpiresIn: RESET_PASSWORD_TTL_SECONDS,
        revokeSessionsOnPasswordReset: true,
        sendResetPassword: async ({ user: target, token }) => {
          void dispatchAccountEmail(email, 'RESET_PASSWORD', target.email, { name: target.name, url: accountLink(email, 'reset-password', { token }) });
        },
        onExistingUserSignUp: async ({ user: existing }) => {
          void dispatchAccountEmail(email, 'ACCOUNT_EXISTS', existing.email, {
            name: existing.name,
            url: accountLink(email, 'sign-in'),
            secondaryUrl: accountLink(email, 'forgot-password', { email: existing.email }),
          });
        },
        onPasswordReset: async ({ user: target }) => {
          await options.db.update(user).set({ emailVerified: true, updatedAt: new Date() }).where(eq(user.id, target.id));
        },
      }),
    },
    ...(email === undefined ? {} : {
      emailVerification: {
        sendOnSignUp: true,
        sendOnSignIn: true,
        autoSignInAfterVerification: true,
        expiresIn: EMAIL_VERIFICATION_TTL_SECONDS,
        sendVerificationEmail: async ({ user: target, token }) => {
          void dispatchAccountEmail(email, 'VERIFY_EMAIL', target.email, { name: target.name, url: accountLink(email, 'verify-email', { token }) });
        },
        // 邀请注册的邮箱一经验证，平台邀请即视为已使用
        afterEmailVerification: async (verified) => {
          await options.db.update(signupInvitations)
            .set({ status: 'ACCEPTED', acceptedAt: new Date(), acceptedUserId: verified.id })
            .where(and(eq(signupInvitations.email, verified.email.toLowerCase()), eq(signupInvitations.status, 'PENDING')));
        },
      },
    }),
    session: {
      expiresIn: options.sessionTtlSeconds ?? 60 * 60 * 24 * 30,
      updateAge: options.sessionUpdateAgeSeconds ?? 60 * 60 * 24,
    },
    plugins: [twoFactorPlugin({
      issuer: 'ANCS Platform Ops',
      trustDeviceMaxAge: 0,
      backupCodeOptions: { storeBackupCodes: 'encrypted' },
    })],
  });
}

export type AuthInstance = ReturnType<typeof createAuth>;
