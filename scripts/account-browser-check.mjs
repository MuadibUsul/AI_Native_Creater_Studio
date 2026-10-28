#!/usr/bin/env node
/**
 * D-04 账号自助的真实浏览器验收（invite 模式开站——所有者决定首轮内测用 invite）：
 *
 * 邮件走**真实 SMTP 驱动**（nodemailer）投递到本机收信服务（smtp-server，要求登录），脚本从收到的原文里取出链接，
 * 在浏览器里打开——和用户点邮件里的按钮一样。真实服务商（SES / Postmark 等）的投递待所有者提供账号后实测。
 *
 * 1. 登录页按能力显示"创建账号""忘记密码？"；
 * 2. 没被邀请的邮箱注册被拒（说明要用受邀邮箱）；
 * 3. 运营发平台邀请 → 邀请邮件 → 点邀请链接（邮箱预填）注册 → "请查收邮件"；
 * 4. 验证前登录 → "邮箱还没确认"（并收到新的验证邮件）；
 * 5. 点验证链接 → "邮箱已确认" → 自动进入创作台（新用户先建工作区）；
 * 6. 找回密码 → 重设链接 → 设新密码 → 旧密码不能登录、新密码能；
 * 7. 工作区邀请（中文）→ 邀请邮件 → 被邀请人注册、验证 → 首页"你有新的邀请" → 接受；
 * 8. 手机宽度与深色。
 *
 * 用法：先 `pnpm --filter @ancs/web build` 并在 3000 端口启动网站，然后 `node scripts/account-browser-check.mjs`。
 */
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createSignupInvitation } from '../packages/auth/dist/index.js';
import { SmtpEmailSender } from '../packages/providers/email-smtp/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const { SMTPServer } = createRequire(resolve('packages/providers/email-smtp/package.json'))('smtp-server');

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/accounts');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const tag = randomUUID().slice(0, 8);
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

/** 本机收信服务：要求 SMTP 登录；把每封信解码成主题 + 纯文本 */
const mailbox = [];
const SMTP_USER = 'mailer';
const SMTP_PASSWORD = `pw-${randomUUID()}`;
function decodeQuotedPrintable(value) {
  const bytes = [];
  const text = value.replace(/=\r?\n/g, '');
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '=' && /^[0-9A-F]{2}$/i.test(text.slice(index + 1, index + 3))) { bytes.push(Number.parseInt(text.slice(index + 1, index + 3), 16)); index += 2; } else bytes.push(...Buffer.from(text[index]));
  }
  return Buffer.from(bytes).toString('utf8');
}
function decodeSubject(raw) {
  const header = /^Subject: (.+(?:\r?\n[ \t].+)*)/m.exec(raw)?.[1] ?? '';
  return header.replace(/\r?\n[ \t]/g, ' ').replace(/=\?UTF-8\?([BQ])\?([^?]*)\?=\s*/gi, (_m, kind, data) => (kind.toUpperCase() === 'B' ? Buffer.from(data, 'base64').toString('utf8') : decodeQuotedPrintable(data.replace(/_/g, ' '))));
}
function plainText(raw) {
  const part = /Content-Type: text\/plain[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*?\r?\n([\s\S]*?)\r?\n--/i.exec(raw);
  if (part === null) return raw;
  const headers = raw.slice(Math.max(0, part.index), part.index + part[0].indexOf(part[1]));
  if (/Content-Transfer-Encoding: base64/i.test(headers)) return Buffer.from(part[1].replace(/\s+/g, ''), 'base64').toString('utf8');
  return /Content-Transfer-Encoding: quoted-printable/i.test(headers) ? decodeQuotedPrintable(part[1]) : part[1];
}
const smtp = new SMTPServer({
  secure: false, authOptional: false, allowInsecureAuth: true, disabledCommands: ['STARTTLS'], logger: false,
  onAuth(auth, _session, callback) { callback(auth.username === SMTP_USER && auth.password === SMTP_PASSWORD ? null : new Error('bad credentials'), { user: auth.username }); },
  onData(stream, session, callback) {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      mailbox.push({ to: session.envelope.rcptTo.map((address) => address.address), subject: decodeSubject(raw), text: plainText(raw) });
      callback();
    });
  },
});

async function nextMail(to, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = mailbox.filter((mail) => mail.to.includes(to));
    if (found.length >= count) return found[count - 1];
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`${to} did not receive mail #${String(count)}`);
}
const linkIn = (mail, path) => {
  const match = new RegExp(`https?://[^\\s]+/${path}[^\\s]*`).exec(mail.text);
  if (match === null) throw new Error(`no ${path} link in "${mail.subject}":\n${mail.text}`);
  return match[0];
};

let env;
let browser;
let page;
try {
  await mkdir(evidenceDir, { recursive: true });
  await new Promise((done) => smtp.listen(0, '127.0.0.1', done));
  const smtpPort = smtp.server.address().port;
  const sender = new SmtpEmailSender({ url: `smtp://${SMTP_USER}:${SMTP_PASSWORD}@127.0.0.1:${String(smtpPort)}`, from: 'ANCS <no-reply@studio.test>' });
  await sender.verify();
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-accounts-', accounts: { signupMode: 'invite', sender } });

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const newPage = async (locale) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale, colorScheme: 'light' });
    const created = await context.newPage();
    created.on('pageerror', (error) => pageErrors.push(`${created.url()}: ${error.message}`));
    return created;
  };
  const pageErrors = [];
  page = await newPage('en-US');
  const shot = async (target, name) => { await target.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };

  // 1. 登录页入口
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: 'Create one' }).waitFor();
  await page.getByRole('link', { name: 'Forgot password?' }).waitFor();
  await shot(page, '01-sign-in-links');
  pass('登录页入口', '"Create one" 与 "Forgot password?" 按 /capabilities（invite、可找回）显示');

  // 2. 未受邀
  const stranger = `stranger-${tag}@studio.test`;
  await page.getByRole('link', { name: 'Create one' }).click();
  await page.getByText('Invite only for now').waitFor();
  await page.getByLabel('Your name').fill('Stranger');
  await page.getByLabel('Email').fill(stranger);
  await page.getByLabel(/^Password/).fill('password-1234');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByText("This email address hasn't been invited yet.", { exact: false }).waitFor();
  await shot(page, '02-sign-up-not-invited');
  if (mailbox.some((mail) => mail.to.includes(stranger))) throw new Error('uninvited sign-up must not send mail');
  pass('未受邀注册被拒', '说明要用受邀邮箱；没有发出任何邮件');

  // 3. 平台邀请 → 邀请邮件 → 注册
  const beta = `beta-${tag}@studio.test`;
  await createSignupInvitation(env.db.db, { email: beta, invitedBy: 'owner', note: 'beta wave 1', locale: 'en' }, env.accountEmail);
  const invitation = await nextMail(beta, 1);
  if (invitation.subject !== "You're invited to try ANCS") throw new Error(`invitation subject: ${invitation.subject}`);
  await page.goto(linkIn(invitation, 'sign-up'), { waitUntil: 'networkidle' });
  if (await page.getByLabel('Email').inputValue() !== beta) throw new Error('invitation link should prefill the email');
  await page.getByLabel('Your name').fill('Bea Tester');
  await page.getByLabel(/^Password/).fill('first-password-1');
  await shot(page, '03-sign-up-from-invitation');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  await shot(page, '04-check-inbox');
  const verifyMail = await nextMail(beta, 2);
  pass('凭邀请注册', `邀请邮件「${invitation.subject}」→ 链接预填邮箱 → 注册 → 「${verifyMail.subject}」`);

  // 4. 验证前登录
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(beta);
  await page.getByLabel('Password').fill('first-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: "Your email isn't confirmed yet" }).waitFor();
  await shot(page, '05-sign-in-unverified');
  await nextMail(beta, 3);
  pass('验证前不能登录', '提示去收件箱，并重发了验证邮件');

  // 5. 点验证链接 → 进入创作台
  await page.goto(linkIn(verifyMail, 'verify-email'));
  await page.getByRole('heading', { name: 'Email confirmed' }).waitFor();
  await shot(page, '06-email-confirmed');
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  await page.getByRole('button', { name: /Create workspace/i }).waitFor({ timeout: 15_000 });
  await shot(page, '07-dashboard-after-verify');
  pass('点验证链接即登录', '确认后自动进入创作台（新用户先建工作区）');

  // 6. 找回密码
  await page.context().clearCookies();
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(beta);
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await page.waitForURL((url) => url.pathname === '/forgot-password');
  if (await page.getByLabel('Email').inputValue() !== beta) throw new Error('forgot-password should carry the email');
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await page.getByText(`If ${beta} has an account`, { exact: false }).waitFor();
  await shot(page, '08-reset-link-sent');
  const resetMail = await nextMail(beta, 4);
  await page.goto(linkIn(resetMail, 'reset-password'), { waitUntil: 'networkidle' });
  await page.getByLabel('New password').fill('second-password-2');
  await page.getByLabel('Repeat it').fill('second-password-2');
  await shot(page, '09-choose-new-password');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await page.getByRole('heading', { name: 'Password updated' }).waitFor();
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(beta);
  await page.getByLabel('Password').fill('first-password-1');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Sign-in failed' }).waitFor();
  await page.getByLabel('Password').fill('second-password-2');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  pass('找回密码', `「${resetMail.subject}」→ 设新密码 → 旧密码登录失败、新密码登录成功`);

  // 7. 工作区邀请（中文）
  const { client: owner } = await env.signedInClient(`owner-${tag}@studio.test`);
  const workspace = await owner.workspaces.create({ name: '内测小队' });
  const mate = `mate-${tag}@studio.test`;
  await owner.workspaces.invitations.create(workspace.id, { email: mate, role: 'EDITOR', locale: 'zh-CN' });
  const workspaceInvite = await nextMail(mate, 1);
  if (workspaceInvite.subject !== '邀请你加入「内测小队」') throw new Error(`workspace invitation subject: ${workspaceInvite.subject}`);
  const zh = await newPage('zh-CN');
  await zh.goto(linkIn(workspaceInvite, 'sign-up'), { waitUntil: 'networkidle' });
  await zh.getByLabel('怎么称呼你').fill('小林');
  await zh.getByLabel(/^密码/).fill('mate-password-1');
  await shot(zh, '10-sign-up-zh');
  await zh.getByRole('button', { name: '创建账号' }).click();
  await zh.getByRole('heading', { name: '请查收邮件' }).waitFor();
  const mateVerify = await nextMail(mate, 2);
  if (mateVerify.subject !== '验证你的 ANCS 邮箱') throw new Error(`zh verify subject: ${mateVerify.subject}`);
  await zh.goto(linkIn(mateVerify, 'verify-email'));
  await zh.waitForURL((url) => url.pathname === '/', { timeout: 15_000 });
  await zh.getByText('加入「内测小队」').waitFor({ timeout: 15_000 });
  await shot(zh, '11-pending-invitation');
  await zh.getByRole('button', { name: '接受' }).click();
  await zh.locator('[data-pending-invitations]').waitFor({ state: 'detached', timeout: 15_000 });
  const joined = await env.db.pool.query('select count(*)::int as n from workspace_members m join "user" u on u.id = m.user_id where m.workspace_id = $1 and u.email = $2', [workspace.id, mate]);
  if (joined.rows[0].n !== 1) throw new Error('mate should be a member after accepting');
  await shot(zh, '12-invitation-accepted');
  pass('工作区邀请', `「${workspaceInvite.subject}」→ 注册（中文）→ 「${mateVerify.subject}」→ 首页接受邀请 → 成为成员`);

  // 8. 手机宽度与深色
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-US', colorScheme: 'dark' });
  const phone = await mobile.newPage();
  await phone.goto(`${env.baseUrl}/sign-up?email=${encodeURIComponent(`phone-${tag}@studio.test`)}`, { waitUntil: 'networkidle' });
  await phone.getByText('Invite only for now').waitFor();
  const overflow = await phone.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
  await shot(phone, '13-sign-up-mobile-dark');
  if (overflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(overflow)} px`);
  pass('手机宽度与深色', '注册页 390 px 无横向溢出');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nD-04 account browser check passed (${String(results.length)} checks, ${String(mailbox.length)} emails over SMTP). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
  sender.close();
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
  await new Promise((done) => smtp.close(done));
}
