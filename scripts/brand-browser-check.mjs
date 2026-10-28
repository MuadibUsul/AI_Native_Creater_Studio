#!/usr/bin/env node
// 品牌（D-02 提议：Kinora）真实浏览器验收（可重复）：登录页与侧栏的新标志与产品名、页面标题、收藏夹图标、主屏幕清单；中英、深浅。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker）+ Next 生产服务（127.0.0.1:3000）。
// 用法：node scripts/brand-browser-check.mjs   证据写入 docs/verification/artifacts/brand/
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/brand');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `brand-${randomUUID().slice(0, 8)}@test.local`;
const BRAND = 'Kinora';
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-brand-' });
  const { client, password } = await env.signedInClient(email);
  await client.workspaces.create({ name: 'Northbound Films' });
  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });

  for (const [locale, colorScheme] of [['en-US', 'dark'], ['zh-CN', 'light']]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale, colorScheme });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const zh = locale === 'zh-CN';
    await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: zh ? `登录 ${BRAND}` : `Sign in to ${BRAND}` }).waitFor();
    if (await page.title() !== BRAND) throw new Error(`page title is "${await page.title()}"`);
    await page.screenshot({ path: resolve(evidenceDir, `01-sign-in-${zh ? 'zh-light' : 'en-dark'}.png`) });
    await page.getByLabel(zh ? '邮箱' : 'Email').fill(email);
    await page.getByLabel(zh ? '密码' : 'Password').fill(password);
    await page.getByRole('button', { name: zh ? '登录' : 'Sign in', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    const home = page.getByRole('link', { name: zh ? `${BRAND} 创作台` : `${BRAND} home` });
    await home.waitFor({ timeout: 20_000 });
    if ((await home.textContent())?.trim() !== BRAND) throw new Error(`sidebar wordmark is "${String(await home.textContent())}"`);
    await page.waitForTimeout(400);
    await page.screenshot({ path: resolve(evidenceDir, `02-home-${zh ? 'zh-light' : 'en-dark'}.png`) });
    if (errors.length > 0) throw new Error(`page errors: ${errors.join(' | ')}`);
    pass(`登录页与侧栏（${zh ? '中文 · 浅色' : '英文 · 深色'}）`, `标题 "${BRAND}"；登录标题与侧栏产品名、渐变方块标志`);
    await context.close();
  }

  // 收藏夹图标与主屏幕清单
  const page = await browser.newPage();
  const icon = await page.request.get(`${env.baseUrl}/icons/icon.svg`);
  const svg = await icon.text();
  if (!icon.ok() || !svg.includes('<svg') || !svg.includes('#7C5CFF')) throw new Error('icon.svg is not the Kinora tile');
  const manifest = await (await page.request.get(`${env.baseUrl}/manifest.webmanifest`)).json();
  if (manifest.name !== BRAND || manifest.short_name !== BRAND) throw new Error(`manifest name ${String(manifest.name)} / ${String(manifest.short_name)}`);
  for (const entry of manifest.icons) {
    const response = await page.request.get(`${env.baseUrl}${entry.src}`);
    if (!response.ok() || response.headers()['content-type'] !== 'image/png') throw new Error(`manifest icon ${String(entry.src)} not served`);
  }
  pass('收藏夹图标与主屏幕清单', `icon.svg（渐变方块）；manifest ${manifest.name}，${String(manifest.icons.length)} 个 PNG 图标`);
  console.log(`\nBrand browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
