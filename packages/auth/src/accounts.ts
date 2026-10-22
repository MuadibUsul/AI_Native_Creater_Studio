import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  ACCOUNT_ERROR_REASONS,
  ApiFailure,
  ERROR_CODES,
  type AccountEmailLocale,
  type AccountEmailSentResponse,
  type SignUpRequest,
  type SignupMode,
} from '@ancs/contracts';
import { isUniqueViolation, signupInvitations, workspaceInvitations } from '@ancs/db';
import { accountLink, dispatchAccountEmail, withAccountEmailContext, type AccountEmailOptions } from './account-email.js';
import type { AuthInstance } from './auth-core.js';

/**
 * 账号自助服务（D-04）：注册、验证邮箱、重发验证、找回密码，以及平台内测邀请。
 *
 * 规则：
 * - 注册方式：closed → 403 SIGNUP_CLOSED；invite → 只有持有效平台邀请或工作区邀请的邮箱能注册，否则 403 SIGNUP_INVITE_REQUIRED；
 *   open → 任何人。未配置发信时只能 closed（入口校验），找回密码 501；
 * - 防枚举：注册、重发验证、找回密码对"邮箱已注册 / 不存在 / 已验证"的答复一律是 EMAIL_SENT；
 * - 验证成功即登录（返回会话 Cookie 头，由 API 转发）；重设密码成功后其他会话全部失效。
 */
export interface AccountDeps {
  auth: AuthInstance;
  db: NodePgDatabase;
  signupMode: SignupMode;
  /** 已配置发信（不配时不能注册、不能找回密码） */
  emailEnabled: boolean;
}

const EMAIL_SENT: AccountEmailSentResponse = { status: 'EMAIL_SENT' };

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

function emailNotConfigured(): ApiFailure {
  return new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'Email is not configured on this server', 501, { reason: ACCOUNT_ERROR_REASONS.EMAIL_NOT_CONFIGURED });
}

function invalidToken(): ApiFailure {
  return new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'This link is invalid or has expired', 400, { reason: ACCOUNT_ERROR_REASONS.INVALID_TOKEN });
}

/** 这个邮箱现在能否凭邀请注册：有效的平台邀请，或任何工作区的有效邀请。 */
export async function hasSignupInvitation(db: NodePgDatabase, email: string): Promise<boolean> {
  const normalized = normalizeEmail(email);
  const now = new Date();
  const platform = await db.select({ id: signupInvitations.id }).from(signupInvitations)
    .where(and(eq(signupInvitations.email, normalized), eq(signupInvitations.status, 'PENDING'), gt(signupInvitations.expiresAt, now))).limit(1);
  if (platform.length > 0) return true;
  const workspace = await db.select({ id: workspaceInvitations.id }).from(workspaceInvitations)
    .where(and(eq(workspaceInvitations.email, normalized), eq(workspaceInvitations.status, 'PENDING'), gt(workspaceInvitations.expiresAt, now))).limit(1);
  return workspace.length > 0;
}

export async function signUpWithEmail(deps: AccountDeps, input: SignUpRequest): Promise<AccountEmailSentResponse> {
  if (deps.signupMode === 'closed') {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Sign-up is not open on this server', 403, { reason: ACCOUNT_ERROR_REASONS.SIGNUP_CLOSED });
  }
  if (!deps.emailEnabled) throw emailNotConfigured();
  const email = normalizeEmail(input.email);
  if (deps.signupMode === 'invite' && !(await hasSignupInvitation(deps.db, email))) {
    throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'Sign-up is by invitation only', 403, { reason: ACCOUNT_ERROR_REASONS.SIGNUP_INVITE_REQUIRED });
  }
  // 已注册的邮箱：Better Auth 返回与新注册相同的结果（并同样计算密码哈希），只给邮箱主人发"你已经有账号了"
  await withAccountEmailContext({ locale: input.locale }, () => deps.auth.api.signUpEmail({ body: { name: input.name.trim(), email, password: input.password } }));
  return EMAIL_SENT;
}

/** 点开验证链接：标记已验证并登录；返回需要转发给浏览器的 Set-Cookie。 */
export async function verifyEmailToken(deps: Pick<AccountDeps, 'auth'>, token: string): Promise<{ setCookies: string[] }> {
  try {
    const result = await deps.auth.api.verifyEmail({ query: { token }, returnHeaders: true });
    return { setCookies: result.headers.getSetCookie() };
  } catch (error) {
    if (isAuthApiError(error)) throw invalidToken();
    throw error;
  }
}

export async function resendVerificationEmail(deps: AccountDeps, input: { email: string; locale?: AccountEmailLocale | undefined }): Promise<AccountEmailSentResponse> {
  if (!deps.emailEnabled) throw emailNotConfigured();
  // 不存在或已验证的邮箱同样答复（Better Auth 内部做等时处理）
  await withAccountEmailContext({ locale: input.locale }, () => deps.auth.api.sendVerificationEmail({ body: { email: normalizeEmail(input.email) } }));
  return EMAIL_SENT;
}

export async function requestPasswordReset(deps: AccountDeps, input: { email: string; locale?: AccountEmailLocale | undefined }): Promise<AccountEmailSentResponse> {
  if (!deps.emailEnabled) throw emailNotConfigured();
  await withAccountEmailContext({ locale: input.locale }, () => deps.auth.api.requestPasswordReset({ body: { email: normalizeEmail(input.email) } }));
  return EMAIL_SENT;
}

export async function resetPasswordWithToken(deps: AccountDeps, input: { token: string; newPassword: string }): Promise<{ status: 'PASSWORD_RESET' }> {
  if (!deps.emailEnabled) throw emailNotConfigured();
  try {
    await deps.auth.api.resetPassword({ body: { token: input.token, newPassword: input.newPassword } });
  } catch (error) {
    if (isAuthApiError(error)) throw invalidToken();
    throw error;
  }
  return { status: 'PASSWORD_RESET' };
}

/** Better Auth 的接口错误（APIError：带 status 与 body.code） */
export function isAuthApiError(error: unknown): error is { status: string; statusCode: number; body?: { code?: string; message?: string } } {
  return typeof error === 'object' && error !== null && 'statusCode' in error && 'status' in error && (error as { name?: string }).name === 'APIError';
}

/** Better Auth 错误码（如 EMAIL_NOT_VERIFIED） */
export function authApiErrorCode(error: unknown): string | null {
  return isAuthApiError(error) ? error.body?.code ?? null : null;
}

// ---------------------------------------------------------------------------
// 平台内测邀请（运营经 CLI 管理；invite 模式下拿到邀请的邮箱才能注册）
// ---------------------------------------------------------------------------

/** 平台邀请有效期（天） */
export const SIGNUP_INVITATION_TTL_DAYS = 30;

export interface SignupInvitationRow {
  id: string;
  email: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED' | 'EXPIRED';
  invitedBy: string | null;
  note: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
}

const toInvitation = (row: typeof signupInvitations.$inferSelect): SignupInvitationRow => ({
  id: row.id,
  email: row.email,
  status: row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now() ? 'EXPIRED' : (row.status as SignupInvitationRow['status']),
  invitedBy: row.invitedBy,
  note: row.note,
  expiresAt: row.expiresAt,
  acceptedAt: row.acceptedAt,
  createdAt: row.createdAt,
});

/**
 * 发一份平台邀请：同一邮箱已有有效邀请时只顺延有效期（不重复建行）；已过期的旧邀请先作废再新建。
 * 配了发信就同时寄出邀请邮件（`email`）。
 */
export async function createSignupInvitation(
  db: NodePgDatabase,
  input: { email: string; invitedBy?: string | undefined; note?: string | undefined; ttlDays?: number; locale?: AccountEmailLocale },
  email?: AccountEmailOptions,
): Promise<{ invitation: SignupInvitationRow; created: boolean }> {
  const address = normalizeEmail(input.email);
  const expiresAt = new Date(Date.now() + (input.ttlDays ?? SIGNUP_INVITATION_TTL_DAYS) * 24 * 60 * 60 * 1000);
  const pending = await db.select().from(signupInvitations).where(and(eq(signupInvitations.email, address), eq(signupInvitations.status, 'PENDING'))).limit(1);
  let row: typeof signupInvitations.$inferSelect;
  let created = false;
  if (pending[0] !== undefined) {
    [row] = await db.update(signupInvitations).set({ expiresAt, invitedBy: input.invitedBy ?? pending[0].invitedBy, note: input.note ?? pending[0].note })
      .where(eq(signupInvitations.id, pending[0].id)).returning() as [typeof signupInvitations.$inferSelect];
  } else {
    try {
      [row] = await db.insert(signupInvitations).values({ id: `sinv_${randomUUID()}`, email: address, invitedBy: input.invitedBy ?? null, note: input.note ?? null, expiresAt })
        .returning() as [typeof signupInvitations.$inferSelect];
      created = true;
    } catch (error) {
      // 并发：另一个请求刚建了同一邮箱的有效邀请
      if (!isUniqueViolation(error)) throw error;
      [row] = await db.select().from(signupInvitations).where(and(eq(signupInvitations.email, address), eq(signupInvitations.status, 'PENDING'))).limit(1) as [typeof signupInvitations.$inferSelect];
    }
  }
  if (email !== undefined) {
    await dispatchAccountEmail(email, 'SIGNUP_INVITATION', address, { url: accountLink(email, 'sign-up', { email: address }) }, input.locale);
  }
  return { invitation: toInvitation(row), created };
}

export async function listSignupInvitations(db: NodePgDatabase, limit = 200): Promise<SignupInvitationRow[]> {
  const rows = await db.select().from(signupInvitations).orderBy(desc(signupInvitations.createdAt)).limit(limit);
  return rows.map(toInvitation);
}

/** 撤销这个邮箱的有效邀请（立即生效：之后不能再凭它注册；已注册的账号不受影响）。 */
export async function revokeSignupInvitation(db: NodePgDatabase, email: string): Promise<boolean> {
  const rows = await db.update(signupInvitations).set({ status: 'REVOKED', revokedAt: new Date() })
    .where(and(eq(signupInvitations.email, normalizeEmail(email)), eq(signupInvitations.status, 'PENDING'))).returning({ id: signupInvitations.id });
  return rows.length > 0;
}
