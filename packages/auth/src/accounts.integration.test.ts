import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import type { EmailMessage, EmailSender, SignupMode } from '@ancs/contracts';
import { createDb, resolveTestDatabaseUrl, runMigrations, signupInvitations, user, workspaceInvitations, workspaces, type DbHandle } from '@ancs/db';
import {
  ApiFailure,
  authApiErrorCode,
  createAuth,
  createInternalUser,
  createSignupInvitation,
  createWorkspace,
  listSignupInvitations,
  renderAccountEmail,
  requestPasswordReset,
  resendVerificationEmail,
  resetPasswordWithToken,
  revokeSignupInvitation,
  signUpWithEmail,
  verifyEmailToken,
  withAccountEmailContext,
  type AccountDeps,
  type AccountEmailOptions,
  type AuthInstance,
} from './index.js';

/**
 * D-04 账号自助：注册（三种方式）、验证邮箱、找回密码、平台内测邀请——真实数据库 + 真实 Better Auth，
 * 发信用进程内收件箱（记录每封邮件；真实 SMTP 投递见 providers/email-smtp 的集成测试）。
 */

const DOMAIN = `accounts-${randomUUID().slice(0, 8)}.test.local`;
const PASSWORD = 'password-1234';
const NEW_PASSWORD = 'new-password-5678'; // secrets:check-ignore：测试专用假口令 / 令牌

class Inbox implements EmailSender {
  readonly kind = 'inbox';
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
  for(address: string): EmailMessage[] {
    return this.messages.filter((message) => message.to === address.toLowerCase());
  }
}

let handle: DbHandle;
let inbox: Inbox;
let blocked: Set<string>;
let email: AccountEmailOptions;
let auth: AuthInstance;

const address = (name: string): string => `${name}-${randomUUID().slice(0, 6)}@${DOMAIN}`;
const deps = (signupMode: SignupMode, emailEnabled = true): AccountDeps => ({ auth, db: handle.db, signupMode, emailEnabled });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 邮件是异步投递的：等到这个收件人收到第 n 封 */
async function mailFor(to: string, count = 1): Promise<EmailMessage[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = inbox.for(to);
    if (found.length >= count) return found;
    await sleep(20);
  }
  throw new Error(`${to} 没有收到第 ${String(count)} 封邮件（只有 ${String(inbox.for(to).length)} 封）`);
}

const tokenIn = (message: EmailMessage): string => {
  const match = /token=([A-Za-z0-9._~-]+)/.exec(message.text);
  if (match?.[1] === undefined) throw new Error(`邮件里没有令牌：${message.subject}`);
  return match[1];
};

async function signIn(addressValue: string, password: string): Promise<{ ok: true; cookie: string } | { ok: false; code: string | null }> {
  try {
    const result = await auth.api.signInEmail({ body: { email: addressValue, password }, headers: new Headers(), returnHeaders: true });
    return { ok: true, cookie: result.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ') };
  } catch (error) {
    return { ok: false, code: authApiErrorCode(error) };
  }
}

async function expectFailure(promise: Promise<unknown>, status: number, reason: string): Promise<void> {
  const failure = await promise.then(() => null, (error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiFailure);
  expect((failure as ApiFailure).httpStatus).toBe(status);
  expect((failure as ApiFailure).details).toMatchObject({ reason });
}

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  inbox = new Inbox();
  blocked = new Set();
  email = {
    sender: inbox,
    webBaseUrl: 'https://studio.example.com',
    productName: 'ANCS',
    allowRecipient: async (to) => !blocked.has(to),
  };
  auth = createAuth({ db: handle.db, secret: 'accounts-test-secret-0123456789abcdef', baseUrl: 'https://studio.example.com', email }); // secrets:check-ignore：测试专用假密钥
});

afterAll(async () => {
  await handle.db.delete(workspaceInvitations).where(like(workspaceInvitations.email, `%@${DOMAIN}`));
  await handle.db.delete(signupInvitations).where(like(signupInvitations.email, `%@${DOMAIN}`));
  await handle.db.delete(user).where(like(user.email, `%@${DOMAIN}`));
  await handle.close();
});

describe('注册方式', () => {
  it('closed：拒绝注册（403 SIGNUP_CLOSED），不建账号、不发信', async () => {
    const to = address('closed');
    await expectFailure(signUpWithEmail(deps('closed'), { name: 'A', email: to, password: PASSWORD }), 403, 'SIGNUP_CLOSED');
    expect(await handle.db.select().from(user).where(eq(user.email, to))).toHaveLength(0);
    expect(inbox.for(to)).toHaveLength(0);
  });

  it('未配置发信：即使 open 也不能注册、不能找回密码（501 EMAIL_NOT_CONFIGURED）', async () => {
    const to = address('nomail');
    await expectFailure(signUpWithEmail(deps('open', false), { name: 'A', email: to, password: PASSWORD }), 501, 'EMAIL_NOT_CONFIGURED');
    await expectFailure(requestPasswordReset(deps('open', false), { email: to }), 501, 'EMAIL_NOT_CONFIGURED');
  });

  it('invite：没有邀请 → 403 SIGNUP_INVITE_REQUIRED；平台邀请发出邀请邮件，凭邀请注册，验证后邀请记为已使用；撤销后不能再凭它注册', async () => {
    const to = address('invitee');
    await expectFailure(signUpWithEmail(deps('invite'), { name: 'Invitee', email: to, password: PASSWORD }), 403, 'SIGNUP_INVITE_REQUIRED');

    const first = await createSignupInvitation(handle.db, { email: to.toUpperCase(), invitedBy: 'owner', note: 'beta wave 1' }, email);
    expect(first.created).toBe(true);
    expect(first.invitation).toMatchObject({ email: to, status: 'PENDING', invitedBy: 'owner' });
    const [invitationMail] = await mailFor(to);
    expect(invitationMail!.subject).toBe("You're invited to try ANCS");
    expect(invitationMail!.text).toContain(`https://studio.example.com/sign-up?email=${encodeURIComponent(to)}`);
    // 再邀请一次：只顺延有效期，不重复建行
    const again = await createSignupInvitation(handle.db, { email: to });
    expect(again.created).toBe(false);
    expect(again.invitation.id).toBe(first.invitation.id);

    expect(await signUpWithEmail(deps('invite'), { name: 'Invitee', email: to, password: PASSWORD })).toEqual({ status: 'EMAIL_SENT' });
    const verifyMail = (await mailFor(to, 2))[1]!;
    await verifyEmailToken({ auth }, tokenIn(verifyMail));
    const [row] = await handle.db.select().from(signupInvitations).where(eq(signupInvitations.id, first.invitation.id));
    expect(row).toMatchObject({ status: 'ACCEPTED' });
    expect(row!.acceptedUserId).not.toBeNull();

    const other = address('revoked');
    await createSignupInvitation(handle.db, { email: other });
    expect(await revokeSignupInvitation(handle.db, other)).toBe(true);
    expect(await revokeSignupInvitation(handle.db, other)).toBe(false);
    await expectFailure(signUpWithEmail(deps('invite'), { name: 'X', email: other, password: PASSWORD }), 403, 'SIGNUP_INVITE_REQUIRED');
    expect((await listSignupInvitations(handle.db)).find((item) => item.email === other)?.status).toBe('REVOKED');
  });

  it('invite：有效的工作区邀请也能注册', async () => {
    const owner = await createInternalUser(auth, { email: address('ws-owner'), password: PASSWORD, name: 'Owner' });
    const workspace = await createWorkspace({ db: handle.db }, { userId: owner.id, name: 'Beta team' });
    const to = address('teammate');
    await handle.db.insert(workspaceInvitations).values({ id: `inv_${randomUUID()}`, workspaceId: workspace.id, email: to, role: 'EDITOR', expiresAt: new Date(Date.now() + 86_400_000), invitedByUserId: owner.id });
    expect(await signUpWithEmail(deps('invite'), { name: 'Mate', email: to, password: PASSWORD })).toEqual({ status: 'EMAIL_SENT' });
    await mailFor(to);
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  });
});

describe('注册 → 验证邮箱 → 登录', () => {
  it('open：注册发验证邮件（按界面语言）；验证前不能登录（并重发验证）；点链接即验证并登录；链接再点一次不报错也不再发会话', async () => {
    const to = address('signup');
    expect(await signUpWithEmail(deps('open'), { name: '  小林 ', email: to.toUpperCase(), password: PASSWORD, locale: 'zh-CN' })).toEqual({ status: 'EMAIL_SENT' });
    const [stored] = await handle.db.select().from(user).where(eq(user.email, to));
    expect(stored).toMatchObject({ name: '小林', emailVerified: false });
    const [mail] = await mailFor(to);
    expect(mail!.subject).toBe('验证你的 ANCS 邮箱');
    expect(mail!.text).toContain('小林，你好');
    expect(mail!.text).toContain('https://studio.example.com/verify-email?token=');
    expect(mail!.html).toContain('href="https://studio.example.com/verify-email?token=');

    const early = await withAccountEmailContext({ locale: 'en' }, () => signIn(to, PASSWORD));
    expect(early).toEqual({ ok: false, code: 'EMAIL_NOT_VERIFIED' });
    const resent = (await mailFor(to, 2))[1]!;
    expect(resent.subject).toBe('Verify your ANCS email');

    const verified = await verifyEmailToken({ auth }, tokenIn(mail!));
    expect(verified.setCookies.join('\n')).toContain('session_token');
    const session = await auth.api.getSession({ headers: new Headers({ cookie: verified.setCookies.map((value) => value.split(';')[0]).join('; ') }) });
    expect(session?.user.email).toBe(to);
    expect(session?.user.emailVerified).toBe(true);
    expect((await signIn(to, PASSWORD)).ok).toBe(true);

    expect((await verifyEmailToken({ auth }, tokenIn(resent))).setCookies).toEqual([]);
  });

  it('已注册的邮箱再注册：答复相同，原账号与密码不变，只给邮箱主人发"你已经有账号了"', async () => {
    const to = address('existing');
    await createInternalUser(auth, { email: to, password: PASSWORD, name: 'Existing' });
    expect(await signUpWithEmail(deps('open'), { name: 'Attacker', email: to, password: 'attacker-password-1' })).toEqual({ status: 'EMAIL_SENT' }); // secrets:check-ignore：测试专用假口令 / 令牌
    const [mail] = await mailFor(to);
    expect(mail!.subject).toBe('You already have a ANCS account');
    expect(mail!.text).toContain('https://studio.example.com/sign-in');
    expect(mail!.text).toContain('https://studio.example.com/forgot-password?email=');
    expect((await signIn(to, PASSWORD)).ok).toBe(true);
    expect((await signIn(to, 'attacker-password-1')).ok).toBe(false);
    const [stored] = await handle.db.select().from(user).where(eq(user.email, to));
    expect(stored!.name).toBe('Existing');
  });

  it('运营建号：直接视为已验证、不发验证邮件；邮箱已存在时失败且不改原账号', async () => {
    const to = address('ops');
    const created = await createInternalUser(auth, { email: to, password: PASSWORD, name: 'Ops' });
    const [stored] = await handle.db.select().from(user).where(eq(user.id, created.id));
    expect(stored!.emailVerified).toBe(true);
    await sleep(100);
    expect(inbox.for(to)).toHaveLength(0);
    await expect(createInternalUser(auth, { email: to, password: 'another-pass-99', name: 'Dup' })).rejects.toThrow('已有账号');
    expect((await signIn(to, PASSWORD)).ok).toBe(true);
  });

  it('重发验证：不存在或已验证的邮箱同样答复、不发信；无效令牌 400 INVALID_TOKEN', async () => {
    const unknown = address('nobody');
    expect(await resendVerificationEmail(deps('open'), { email: unknown })).toEqual({ status: 'EMAIL_SENT' });
    const verifiedUser = address('verified');
    await createInternalUser(auth, { email: verifiedUser, password: PASSWORD, name: 'V' });
    expect(await resendVerificationEmail(deps('open'), { email: verifiedUser })).toEqual({ status: 'EMAIL_SENT' });
    await sleep(100);
    expect(inbox.for(unknown)).toHaveLength(0);
    expect(inbox.for(verifiedUser)).toHaveLength(0);
    await expectFailure(verifyEmailToken({ auth }, 'not-a-real-token-0123456789'), 400, 'INVALID_TOKEN');
  });
});

describe('找回密码', () => {
  it('不存在的邮箱：同样答复、不发信；存在：发 1 小时链接 → 重设后旧密码失效、其他会话下线、未验证邮箱视为已验证；同一链接不能再用', async () => {
    const unknown = address('ghost');
    expect(await requestPasswordReset(deps('closed'), { email: unknown })).toEqual({ status: 'EMAIL_SENT' });
    await sleep(100);
    expect(inbox.for(unknown)).toHaveLength(0);

    const to = address('forgetful');
    await signUpWithEmail(deps('open'), { name: 'Forgetful', email: to, password: PASSWORD });
    await mailFor(to);
    await handle.db.update(user).set({ emailVerified: true }).where(eq(user.email, to));
    const session = await signIn(to, PASSWORD);
    expect(session.ok).toBe(true);
    await handle.db.update(user).set({ emailVerified: false }).where(eq(user.email, to));

    expect(await requestPasswordReset(deps('closed'), { email: to, locale: 'en' })).toEqual({ status: 'EMAIL_SENT' });
    const resetMail = (await mailFor(to, 2))[1]!;
    expect(resetMail.subject).toBe('Reset your ANCS password');
    expect(resetMail.text).toContain('https://studio.example.com/reset-password?token=');
    const token = tokenIn(resetMail);

    expect(await resetPasswordWithToken(deps('closed'), { token, newPassword: NEW_PASSWORD })).toEqual({ status: 'PASSWORD_RESET' });
    expect((await signIn(to, PASSWORD)).ok).toBe(false);
    expect((await signIn(to, NEW_PASSWORD)).ok).toBe(true);
    const [stored] = await handle.db.select().from(user).where(eq(user.email, to));
    expect(stored!.emailVerified).toBe(true);
    if (session.ok) expect(await auth.api.getSession({ headers: new Headers({ cookie: session.cookie }) })).toBeNull();
    await expectFailure(resetPasswordWithToken(deps('closed'), { token, newPassword: 'third-password-0' }), 400, 'INVALID_TOKEN'); // secrets:check-ignore：测试专用假口令 / 令牌
  });

  it('同一收件人被限频时不发信，答复不变', async () => {
    const to = address('flooded');
    await createInternalUser(auth, { email: to, password: PASSWORD, name: 'F' });
    blocked.add(to);
    expect(await requestPasswordReset(deps('open'), { email: to })).toEqual({ status: 'EMAIL_SENT' });
    await sleep(100);
    expect(inbox.for(to)).toHaveLength(0);
    blocked.delete(to);
  });
});

describe('邮件模板', () => {
  it('中英两种语言；插入值经过 HTML 转义；纯文本里带完整链接', () => {
    const zh = renderAccountEmail('WORKSPACE_INVITATION', 'zh-CN', 'a@example.com', { productName: 'ANCS', url: 'https://studio.example.com/sign-in?email=a%40example.com', workspaceName: '<b>团队</b>' });
    expect(zh.subject).toBe('邀请你加入「<b>团队</b>」');
    expect(zh.html).toContain('&lt;b&gt;团队&lt;/b&gt;');
    expect(zh.html).not.toContain('<b>团队</b>');
    expect(zh.text).toContain('查看邀请: https://studio.example.com/sign-in?email=a%40example.com');
    const en = renderAccountEmail('RESET_PASSWORD', 'en', 'b@example.com', { productName: 'Studio', name: 'Bo', url: 'https://x.example/reset-password?token=t' });
    expect(en.subject).toBe('Reset your Studio password');
    expect(en.text.startsWith('Hi Bo,')).toBe(true);
    expect(en.to).toBe('b@example.com');
  });
});
