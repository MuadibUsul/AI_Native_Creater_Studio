import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, createSignupInvitation, DEFAULT_NATIVE_TOKEN_CONFIG, type AccountEmailOptions, type AuthInstance } from '@ancs/auth';
import type { EmailMessage, EmailSender } from '@ancs/contracts';
import { createDb, resolveTestDatabaseUrl, runMigrations, signupInvitations, user, workspaceInvitations, workspaces, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * D-04 账号自助（真实 DB + HTTP + SDK）：invite 模式开站时的完整用户路径——
 * /capabilities 公布注册方式 → 无邀请注册 403 → 凭邀请注册 202（只说"请查收邮件"）→ 未验证登录 403 EMAIL_NOT_VERIFIED →
 * 点验证链接即登录 → 找回密码 → 新密码登录；工作区邀请寄出邀请邮件、被邀请人凭它注册并在首页接受。
 * 另起一个 closed 实例确认缺省不开放注册、也不能找回密码。
 */

const DOMAIN = `api-accounts-${randomUUID().slice(0, 8)}.test.local`;
const PASSWORD = 'password-1234';

class Inbox implements EmailSender {
  readonly kind = 'inbox';
  readonly messages: EmailMessage[] = [];
  async send(message: EmailMessage): Promise<void> {
    this.messages.push(message);
  }
}

let handle: DbHandle;
let auth: AuthInstance;
let inbox: Inbox;
let app: Awaited<ReturnType<typeof buildServer>>;
let closedApp: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let closedUrl: string;

const address = (name: string): string => `${name}-${randomUUID().slice(0, 6)}@${DOMAIN}`;
const client = (url = baseUrl): AncsClient => createClient({ baseUrl: url, clientType: 'web', clientVersion: '0.1.0' });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function mailFor(to: string, count = 1): Promise<EmailMessage[]> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = inbox.messages.filter((message) => message.to === to);
    if (found.length >= count) return found;
    await sleep(20);
  }
  throw new Error(`${to} 没有收到第 ${String(count)} 封邮件`);
}
const tokenIn = (message: EmailMessage): string => /token=([A-Za-z0-9._~-]+)/.exec(message.text)![1]!;

async function failureOf(promise: Promise<unknown>): Promise<AncsApiError> {
  const error = await promise.then(() => null, (failure: unknown) => failure);
  expect(error).toBeInstanceOf(AncsApiError);
  return error as AncsApiError;
}

async function listen(instance: Awaited<ReturnType<typeof buildServer>>): Promise<string> {
  await instance.listen({ port: 0, host: '127.0.0.1' });
  return `http://127.0.0.1:${String((instance.server.address() as AddressInfo).port)}`;
}

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  inbox = new Inbox();
  const email: AccountEmailOptions = { sender: inbox, webBaseUrl: 'https://studio.example.com', productName: 'ANCS' };
  auth = createAuth({ db: handle.db, secret: 'api-accounts-secret-0123456789', baseUrl: 'http://localhost:3001', email }); // secrets:check-ignore：测试专用假密钥
  const authDeps = { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } };
  app = await buildServer({ auth: authDeps, accounts: { signupMode: 'invite', email } });
  baseUrl = await listen(app);
  closedApp = await buildServer({ auth: { ...authDeps, auth: createAuth({ db: handle.db, secret: 'api-accounts-secret-0123456789', baseUrl: 'http://localhost:3001' }) } }); // secrets:check-ignore：测试专用假密钥
  closedUrl = await listen(closedApp);
});

afterAll(async () => {
  await app.close();
  await closedApp.close();
  await handle.db.delete(workspaceInvitations).where(like(workspaceInvitations.email, `%@${DOMAIN}`));
  await handle.db.delete(signupInvitations).where(like(signupInvitations.email, `%@${DOMAIN}`));
  await handle.db.delete(user).where(like(user.email, `%@${DOMAIN}`));
  await handle.close();
});

describe('invite 模式开站', () => {
  it('能力清单公布注册方式；无邀请 403 SIGNUP_INVITE_REQUIRED；凭平台邀请注册 → 验证前登录 403 → 点链接即登录 → 找回密码 → 新密码登录', async () => {
    expect((await client().capabilities()).accounts).toEqual({ signup: 'invite', passwordReset: true });

    const to = address('beta');
    const denied = await failureOf(client().auth.signUp({ name: 'Beta', email: to, password: PASSWORD }));
    expect(denied.status).toBe(403);
    expect(denied.details).toMatchObject({ reason: 'SIGNUP_INVITE_REQUIRED' });

    await createSignupInvitation(handle.db, { email: to });
    const browser = client();
    expect(await browser.auth.signUp({ name: 'Beta', email: to, password: PASSWORD, locale: 'en' })).toEqual({ status: 'EMAIL_SENT' });
    const [verifyMail] = await mailFor(to);
    expect(verifyMail!.subject).toBe('Verify your ANCS email');

    const unverified = await failureOf(browser.auth.signIn({ email: to, password: PASSWORD, locale: 'zh-CN' }));
    expect(unverified.status).toBe(403);
    expect(unverified.details).toMatchObject({ reason: 'EMAIL_NOT_VERIFIED' });
    expect((await mailFor(to, 2))[1]!.subject).toBe('验证你的 ANCS 邮箱');

    const verified = await browser.auth.verifyEmail({ token: tokenIn(verifyMail!) });
    expect(verified).toMatchObject({ status: 'VERIFIED', user: { email: to, name: 'Beta', emailVerified: true } });
    expect((await browser.auth.session()).user.email).toBe(to);
    // 同一链接再点：已验证，不再发会话
    expect(await client().auth.verifyEmail({ token: tokenIn(verifyMail!) })).toEqual({ status: 'VERIFIED', user: null });
    const bad = await failureOf(client().auth.verifyEmail({ token: 'not-a-real-token-0123456789' })); // secrets:check-ignore：测试专用假口令 / 令牌
    expect(bad.status).toBe(400);
    expect(bad.details).toMatchObject({ reason: 'INVALID_TOKEN' });

    expect(await client().auth.requestPasswordReset({ email: to, locale: 'en' })).toEqual({ status: 'EMAIL_SENT' });
    const resetMail = (await mailFor(to, 3))[2]!;
    expect(resetMail.subject).toBe('Reset your ANCS password');
    expect(await client().auth.resetPassword({ token: tokenIn(resetMail), newPassword: 'brand-new-pass-1' })).toEqual({ status: 'PASSWORD_RESET' }); // secrets:check-ignore：测试专用假口令 / 令牌
    await expect(browser.auth.session()).rejects.toBeInstanceOf(AncsApiError);
    expect((await failureOf(client().auth.signIn({ email: to, password: PASSWORD }))).status).toBe(401);
    expect(await client().auth.signIn({ email: to, password: 'brand-new-pass-1' })).toMatchObject({ user: { email: to } }); // secrets:check-ignore：测试专用假口令 / 令牌

    // 不存在的邮箱：同样答复
    expect(await client().auth.requestPasswordReset({ email: address('nobody') })).toEqual({ status: 'EMAIL_SENT' });
    expect(await client().auth.resendVerification({ email: address('nobody') })).toEqual({ status: 'EMAIL_SENT' });
  });

  it('工作区邀请：按邀请人语言寄出邀请邮件（没有账号 → 注册链接），被邀请人凭它注册、验证后看到并接受邀请', async () => {
    const ownerEmail = address('owner');
    await createInternalUser(auth, { email: ownerEmail, password: PASSWORD, name: 'Owner' });
    const owner = client();
    await owner.auth.signIn({ email: ownerEmail, password: PASSWORD });
    const workspace = await owner.workspaces.create({ name: '内测小队' });
    const to = address('mate');
    await owner.workspaces.invitations.create(workspace.id, { email: to, role: 'EDITOR', locale: 'zh-CN' });
    const [invite] = await mailFor(to);
    expect(invite!.subject).toBe('邀请你加入「内测小队」');
    expect(invite!.text).toContain(`https://studio.example.com/sign-up?email=${encodeURIComponent(to)}`);

    const mate = client();
    await mate.auth.signUp({ name: 'Mate', email: to, password: PASSWORD });
    await mate.auth.verifyEmail({ token: tokenIn((await mailFor(to, 2))[1]!) });
    const [pending] = await mate.invitations.mine();
    expect(pending).toMatchObject({ workspaceName: '内测小队', status: 'PENDING' });
    await mate.invitations.accept(pending!.id);
    expect((await mate.workspaces.list()).map((item) => item.id)).toContain(workspace.id);
    await handle.db.delete(workspaces).where(eq(workspaces.id, workspace.id));
  });
});

describe('缺省（closed、未配置发信）', () => {
  it('能力清单为 closed 且不能找回密码；注册 403 SIGNUP_CLOSED；找回密码 501 EMAIL_NOT_CONFIGURED', async () => {
    expect((await client(closedUrl).capabilities()).accounts).toEqual({ signup: 'closed', passwordReset: false });
    const closed = await failureOf(client(closedUrl).auth.signUp({ name: 'X', email: address('x'), password: PASSWORD }));
    expect(closed.status).toBe(403);
    expect(closed.details).toMatchObject({ reason: 'SIGNUP_CLOSED' });
    const reset = await failureOf(client(closedUrl).auth.requestPasswordReset({ email: address('y') }));
    expect(reset.status).toBe(501);
    expect(reset.details).toMatchObject({ reason: 'EMAIL_NOT_CONFIGURED' });
  });
});
