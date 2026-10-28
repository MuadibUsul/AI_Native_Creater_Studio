#!/usr/bin/env node
// I-13 运营后台授权真实浏览器验收（可重复）：没授权时 /admin 只说"需要独立运营会话" → 运行真实的 ops:grant 命令（子进程）
// → 同一账号在 /admin 绑定验证器（TOTP）→ 重新登录走二次验证 → 进入运营后台，显示环境与授予的角色；再跑一次命令不重复授权。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker）+ Next 生产服务（127.0.0.1:3000）+ 已构建的 apps/api/dist。
// 运营环境用 TEST（经 http 验收不能用带 Secure cookie 的 STAGING / PRODUCTION；TEST 的权限策略已由测试发布，不会新增不可删的策略行）。
// 用法：node scripts/ops-grant-browser-check.mjs   证据写入 docs/verification/artifacts/ops-grant/
import { createHmac, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { resolveTestDatabaseUrl } from '../packages/db/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/ops-grant');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const run = promisify(execFile);

/** RFC 6238 TOTP（SHA-1、30 秒、6 位），与验证器 App 相同 */
function totp(uri, now = Date.now()) {
  const secret = new URL(uri).searchParams.get('secret') ?? '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let accumulator = 0;
  const bytes = [];
  for (const letter of secret.toUpperCase().replace(/=+$/, '')) {
    accumulator = (accumulator << 5) | alphabet.indexOf(letter);
    bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((accumulator >> bits) & 0xff); }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000)));
  const digest = createHmac('sha1', Buffer.from(bytes)).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
/** 等到下一个 30 秒窗口（同一个码不能用两次） */
const nextWindow = () => new Promise((done) => setTimeout(done, 30_000 - (Date.now() % 30_000) + 500));

const grant = (email) => run(process.execPath, ['apps/api/dist/cli/ops-grant.js'], {
  env: { PATH: process.env.PATH, DATABASE_URL: resolveTestDatabaseUrl(), ANCS_OPS_ENVIRONMENT: 'TEST', ANCS_OPS_GRANT_EMAIL: email, ANCS_OPS_GRANT_ROLES: 'PRODUCTION_OPERATOR,AUDITOR' },
});

let env;
let browser;
try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-ops-grant-', ops: { environment: 'TEST' } });
  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });

  for (const [locale, colorScheme] of [['en-US', 'dark'], ['zh-CN', 'light']]) {
    const zh = locale === 'zh-CN';
    const tag = zh ? 'zh-light' : 'en-dark';
    const email = `ops-grant-${randomUUID().slice(0, 8)}@test.local`;
    const password = await env.createUser(email);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const signIn = async () => {
      await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
      await page.getByLabel(zh ? '邮箱' : 'Email').fill(email);
      await page.getByLabel(zh ? '密码' : 'Password').fill(password);
      await page.getByRole('button', { name: zh ? '登录' : 'Sign in', exact: true }).click();
    };

    // 1. 普通账号：/admin 不放行
    await signIn();
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    await page.goto(`${env.baseUrl}/admin`, { waitUntil: 'networkidle' });
    await page.getByText(zh ? '需要独立运营会话' : 'A separate operations session is required').waitFor({ timeout: 20_000 });
    await page.screenshot({ path: resolve(evidenceDir, `01-before-grant-${tag}.png`) });
    pass(`未授权（${tag}）`, '/admin 只显示"需要独立运营会话"');

    // 2. 真实命令授权；再跑一次不重复写
    const first = await grant(email);
    if (!first.stdout.includes('新建运营身份') || !first.stdout.includes('PRODUCTION_OPERATOR, AUDITOR')) throw new Error(`ops:grant output: ${first.stdout}`);
    const second = await grant(email);
    if (!second.stdout.includes('已有运营身份') || !second.stdout.includes('新增角色：无')) throw new Error(`ops:grant rerun output: ${second.stdout}`);
    pass(`ops:grant 命令（${tag}）`, first.stdout.trim().split('\n').slice(0, 2).join(' / '));

    // 3. 首次绑定验证器
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByText(zh ? '已获运营授权，首次配置验证器' : 'Granted operations access? Set up your authenticator').click();
    await page.locator('#ops-enroll-password').fill(password);
    await page.getByRole('button', { name: zh ? '配置验证器' : 'Set up authenticator' }).click();
    const uri = (await page.locator('code', { hasText: 'otpauth://totp/' }).first().textContent({ timeout: 20_000 }))?.trim() ?? '';
    await page.locator('#ops-enroll-code').fill(totp(uri));
    await page.getByRole('button', { name: zh ? /确认/ : /Confirm|Turn on|Enable/ }).click();
    await page.getByRole('status').filter({ hasText: zh ? 'TOTP 已启用' : 'TOTP is on' }).waitFor({ timeout: 20_000 });
    // 截图里不留验证器密钥和恢复码（即使是一次性测试账号）
    await page.locator('code', { hasText: 'otpauth://' }).evaluate((element) => { element.style.filter = 'blur(7px)'; });
    await page.locator('ul code').evaluateAll((elements) => { for (const element of elements) element.style.filter = 'blur(7px)'; });
    await page.screenshot({ path: resolve(evidenceDir, `02-totp-enabled-${tag}.png`) });
    pass(`绑定验证器（${tag}）`, '输入密码 → 导入 otpauth URI 与恢复码 → 验证码确认');

    // 4. 重新登录：二次验证 → 运营后台
    await page.getByRole('button', { name: zh ? '保存后重新登录' : 'Sign in again after saving' }).click();
    await page.waitForURL((url) => url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    await nextWindow();
    await signIn();
    await page.locator('#sign-in-totp').fill(totp(uri));
    await page.locator('#sign-in-totp').press('Enter');
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    await page.goto(`${env.baseUrl}/admin`, { waitUntil: 'networkidle' });
    await page.getByText(zh ? /运营环境.*TEST/ : 'Operations environment: TEST').waitFor({ timeout: 20_000 });
    const roles = await page.getByText(/PRODUCTION_OPERATOR[,、] ?AUDITOR|AUDITOR[,、] ?PRODUCTION_OPERATOR/).first().textContent();
    await page.waitForTimeout(800);
    await page.screenshot({ path: resolve(evidenceDir, `03-ops-console-${tag}.png`), fullPage: false });
    if (errors.length > 0) throw new Error(`page errors: ${errors.join(' | ')}`);
    pass(`进入运营后台（${tag}）`, `二次验证后显示运营环境 TEST；${String(roles).trim()}`);
    await context.close();
  }
  console.log(`\nOps grant browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
