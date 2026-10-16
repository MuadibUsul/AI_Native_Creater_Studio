/* global document, window */
/**
 * V5-M4 Edge 安全层的真实浏览器验证：
 *   1) 真实 API（buildServer + Edge：CORS/Origin 白名单、限流、安全头）+ 生产构建的 Web（next start）；
 *   2) 在 Chromium 中经 UI 登录，访问工作台主要页面，捕获 CSP 违规与页面错误——必须为 0；
 *   3) 核对 Web 与 API 的安全头、跨源预检拒绝、带 Cookie 的跨源写请求拒绝。
 *
 * 前置：`pnpm build`，且构建 Web 时设置 `ANCS_CSP_EXTRA_ORIGINS`（Next 在构建期固化 headers）：
 *   ANCS_CSP_EXTRA_ORIGINS=http://localhost:3001,http://127.0.0.1:3001 pnpm --filter @ancs/web build
 * 运行：ANCS_TEST_DATABASE_URL=… [PLAYWRIGHT_CHROMIUM_EXECUTABLE=…] node scripts/verification/v5-m4-web-security.mjs
 * 证据：.artifacts/v5-m4-web-security/results.json
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createAuth, createInternalUser, createWorkspace, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { DEFAULT_RATE_LIMITS } from '../../apps/api/dist/plugins/edge.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';

const apiPort = 3001; // Web 构建期的 rewrite 目标（ANCS_API_INTERNAL_URL 缺省值）
const webPort = 3000;
const apiBase = `http://127.0.0.1:${String(apiPort)}`;
const webBase = `http://127.0.0.1:${String(webPort)}`;
const evilOrigin = 'https://evil.example.net';
const runId = randomUUID();
const password = `edge-browser-${runId}`; // secrets:check-ignore: test-only dummy
const evidenceDir = resolve('.artifacts/v5-m4-web-security');
const handle = createDb(resolveTestDatabaseUrl());
let app;
let web;
let browser;
const webLogs = [];

async function waitForWeb() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${webBase}/sign-in`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // not ready yet
    }
    await new Promise((done) => { setTimeout(done, 500); });
  }
  throw new Error(`web did not start\n${webLogs.join('')}`);
}

try {
  await mkdir(evidenceDir, { recursive: true });
  await runMigrations(handle);
  const auth = createAuth({ db: handle.db, secret: `edge-browser-session-secret-${runId}`, baseUrl: webBase }); // secrets:check-ignore: test-only dummy
  const storage = new LocalObjectStorage({ rootDir: resolve(evidenceDir, `storage-${runId}`), publicBaseUrl: apiBase, signingSecret: `edge-browser-storage-${runId}` }); // secrets:check-ignore: test-only dummy
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
    edge: { allowedOrigins: [webBase, `http://localhost:${String(webPort)}`], rateLimits: DEFAULT_RATE_LIMITS, hsts: false },
  });
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  const email = `edge-browser-${runId}@test.local`;
  const user = await createInternalUser(auth, { email, name: 'Edge Browser', password });
  const workspace = await createWorkspace({ db: handle.db }, { userId: user.id, name: `Edge browser ${runId}` });

  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(webPort), '-H', '127.0.0.1'], {
    cwd: resolve('apps/web'),
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NODE_ENV: 'production', ANCS_API_INTERNAL_URL: apiBase },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', (chunk) => webLogs.push(String(chunk)));
  web.stderr.on('data', (chunk) => webLogs.push(String(chunk)));
  await waitForWeb();

  // 1) 响应头
  const webHeaders = (await fetch(`${webBase}/sign-in`)).headers;
  const csp = webHeaders.get('content-security-policy') ?? '';
  assert.match(csp, /frame-ancestors 'none'/, 'web CSP forbids framing');
  assert.match(csp, /object-src 'none'/, 'web CSP forbids plugins');
  assert.doesNotMatch(csp, /unsafe-eval/, 'production web CSP has no unsafe-eval');
  assert.equal(webHeaders.get('x-frame-options'), 'DENY');
  const apiHealth = await fetch(`${apiBase}/api/v1/health`);
  assert.equal(apiHealth.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(apiHealth.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'");

  // 2) 跨源防护（Node 侧模拟恶意站点）
  const evilPreflight = await fetch(`${apiBase}/api/v1/workspaces`, { method: 'OPTIONS', headers: { origin: evilOrigin, 'access-control-request-method': 'POST' } });
  assert.equal(evilPreflight.status, 403, 'preflight from unlisted origin is rejected');
  assert.equal(evilPreflight.headers.get('access-control-allow-origin'), null);
  const evilWrite = await fetch(`${apiBase}/api/v1/workspaces`, { method: 'POST', headers: { origin: evilOrigin, cookie: 'better-auth.session_token=forged', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(evilWrite.status, 403, 'credentialed write from unlisted origin is rejected');

  // 3) 浏览器：登录并访问主要页面，CSP 违规与页面错误必须为 0
  // 可用 PLAYWRIGHT_CHROMIUM_EXECUTABLE 指定已安装的 Chromium（本地浏览器版本与 Playwright 期望不同时）
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  browser = await chromium.launch({ headless: true, ...(executablePath === undefined ? {} : { executablePath }) });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      window.__cspViolations.push({ directive: event.violatedDirective, blocked: event.blockedURI, sample: event.sample, source: event.sourceFile, line: event.lineNumber, column: event.columnNumber });
    });
  });
  const page = await context.newPage();
  const pageErrors = [];
  const consoleCsp = [];
  page.on('pageerror', (error) => pageErrors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error' && /Content Security Policy/i.test(message.text())) consoleCsp.push(message.text()); });

  assert.equal((await page.goto(`${webBase}/sign-in`, { waitUntil: 'networkidle' }))?.status(), 200);
  await page.fill('#sign-in-email', email);
  await page.fill('#sign-in-password', password);
  await Promise.all([page.waitForURL((url) => url.pathname !== '/sign-in', { timeout: 30_000 }), page.click('button[type="submit"]')]);

  const routes = ['/', `/w/${workspace.id}/assets`, `/w/${workspace.id}/settings`, `/w/${workspace.id}/new`, `/w/${workspace.id}/team`, `/w/${workspace.id}/billing`];
  const visited = [];
  for (const path of routes) {
    const response = await page.goto(`${webBase}${path}`, { waitUntil: 'networkidle' });
    const violations = await page.evaluate(() => window.__cspViolations);
    visited.push({ path, status: response?.status() ?? null, violations });
  }
  const result = {
    runId,
    webCsp: csp,
    apiHeaders: { nosniff: apiHealth.headers.get('x-content-type-options'), csp: apiHealth.headers.get('content-security-policy') },
    crossOrigin: { evilPreflight: evilPreflight.status, evilCredentialedWrite: evilWrite.status },
    visited,
    pageErrors,
    consoleCsp,
  };
  await writeFile(resolve(evidenceDir, 'results.json'), `${JSON.stringify(result, null, 2)}\n`);
  assert.deepEqual(visited.flatMap((entry) => entry.violations), [], 'no CSP violations while using the app');
  assert.deepEqual(consoleCsp, [], 'no CSP errors in console');
  assert.deepEqual(pageErrors, [], 'no page errors');
  assert.ok(visited.every((entry) => entry.status === 200), `all pages load: ${JSON.stringify(visited.map((entry) => [entry.path, entry.status]))}`);
  console.log(JSON.stringify({ ok: true, pages: visited.length, evidence: '.artifacts/v5-m4-web-security/results.json' }));
} finally {
  await browser?.close().catch(() => undefined);
  web?.kill('SIGTERM');
  await app?.close().catch(() => undefined);
  await handle.close().catch(() => undefined);
}
