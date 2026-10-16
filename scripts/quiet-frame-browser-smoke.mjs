#!/usr/bin/env node
// Authenticated Web smoke against an isolated PostgreSQL test database.
// Requires a built Web server on 127.0.0.1:3000. All browser API traffic is
// proxied to an in-process Fastify instance backed by ANCS_TEST_DATABASE_URL.
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../packages/auth/dist/index.js';
import { buildServer } from '../apps/api/dist/server.js';
import { createStorageDeps } from '../apps/api/dist/plugins/storage.js';
import { MockLlmAdapter } from '../packages/providers/mock-llm/dist/index.js';
import { LocalObjectStorage } from '../packages/providers/storage-local/dist/index.js';

const testDatabaseUrl = resolveTestDatabaseUrl();
const db = createDb(testDatabaseUrl);
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
let apiPort = 0;
const proxy = createServer((incoming, outgoing) => {
  const routeToApi = incoming.url?.startsWith('/api/v1/') ?? false;
  const upstream = httpRequest({
    hostname: '127.0.0.1',
    port: routeToApi ? apiPort : webPort,
    method: incoming.method,
    path: incoming.url,
    headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', (error) => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
    outgoing.end(`Local test upstream failed: ${error.message}`);
  });
  incoming.pipe(upstream);
});
const listenProxy = () => new Promise((resolve, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', () => resolve(proxy.address().port));
});
const closeProxy = () => new Promise((resolve) => proxy.close(resolve));
const prefix = `qf-smoke-${randomUUID()}`;
const email = `${prefix}@test.local`;
const password = randomBytes(24).toString('base64url');
const projectTitle = `Quiet Frame smoke ${prefix.slice(-8)}`;
let app;
let browser;
let page;
const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? '.artifacts/quiet-frame-rebuild/browser-smoke');

try {
  await runMigrations(db);
  const proxyPort = await listenProxy();
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'Quiet Frame 测试' });
  const storage = new LocalObjectStorage({ rootDir: resolve(evidenceDir, `${prefix}-storage`), publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  app = await buildServer({
    auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { llm: new MockLlmAdapter() },
    storage: createStorageDeps(storage),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  page = await context.newPage();
  const pageErrors = [];
  const hydrationErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => {
    if (/hydration|hydrate|did not match|server.rendered html/i.test(message.text())) hydrationErrors.push(`${page.url()}: ${message.text()}`);
  });
  const response = await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  if (response?.status() !== 200) throw new Error(`Web sign-in HTTP ${response?.status() ?? 'none'}`);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`, { timeout: 15_000 });
  await page.getByText('还没有工作区').waitFor({ timeout: 15_000 });
  await page.getByLabel('工作区名称').fill('Quiet Frame 隔离测试');
  await page.getByRole('button', { name: '创建工作区' }).click();
  await page.getByRole('link', { name: '新建作品' }).waitFor({ timeout: 15_000 });
  await page.getByRole('link', { name: '新建作品' }).click();
  await page.getByRole('tab', { name: '粘贴正文' }).click();
  await page.getByLabel('作品名称').fill(projectTitle);
  await page.getByLabel('原始内容').fill('本次隔离测试检查真实浏览器、会话、工作区、项目和内容保存。来源事实需要人工核对。'.repeat(8));
  await page.getByRole('button', { name: '读取正文' }).click();
  await page.getByText('已解析的内容').waitFor({ timeout: 20_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('已解析的内容').waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: '生成脚本草稿' }).click();
  await page.waitForURL(/\/script$/, { timeout: 30_000 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('.projectbar .title').filter({ hasText: projectTitle }).waitFor({ timeout: 15_000 });
  const stored = await db.pool.query('select id, workspace_id from projects where title = $1', [projectTitle]);
  if (stored.rowCount !== 1) throw new Error(`Expected one persisted project, got ${stored.rowCount}`);
  const contents = await db.pool.query('select id from content_documents where project_id = $1', [stored.rows[0].id]);
  if (contents.rowCount !== 1) throw new Error(`Expected one persisted content document, got ${contents.rowCount}`);
  const workspacePath = `/w/${stored.rows[0].workspace_id}`;
  const projectPath = `${workspacePath}/p/${stored.rows[0].id}`;
  const routeChecks = [
    ['workspace-assets', `${workspacePath}/assets`, '好素材，值得留下。', '还没有资产'],
    ['project-assets', `${projectPath}/assets`, '好素材，值得留下。', '还没有资产'],
    ['identity', `${workspacePath}/identity`, '让每部作品，都有你的辨识度。', '先创建身份，再配置声音、表达和品牌。'],
    ['extensions', `${workspacePath}/extensions`, '需要时，再多一步。'],
    ['settings', `${workspacePath}/settings`, '保持掌控，也保持简单。'],
    ['team', `${workspacePath}/team`, '团队与隐私', '暂无邀请。'],
    ['billing', `${workspacePath}/billing`, '额度与账单', '暂无 Credits 流水（充值/赠送/使用后在此展示）。'],
    ['analytics', `${projectPath}/analytics`, '看见作品，如何被理解。', '暂无可绘制的采样值；缺失值保持未知。'],
    ['history', `${projectPath}/history`, '版本历史'],
    ['render', `${projectPath}/render`, '最后一遍，由你把关。', '还没有渲染。建议先运行预检。'],
    ['publish', `${projectPath}/publish`, '作品准备好了。选择下一站。', '尚无发布记录。'],
  ];
  const routeEvidenceDir = resolve(evidenceDir, `${prefix}-routes`);
  await mkdir(routeEvidenceDir, { recursive: true });
  for (const [name, path, heading, emptyState] of routeChecks) {
    const routeResponse = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
    if (routeResponse?.status() !== 200) throw new Error(`${name} HTTP ${routeResponse?.status() ?? 'none'}`);
    await page.getByRole('heading', { level: 1, name: heading, exact: true }).waitFor({ timeout: 15_000 });
    if (emptyState) await page.getByText(emptyState, { exact: true }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: resolve(routeEvidenceDir, `${name}.png`), fullPage: true });
    console.log(`PASS route ${name}: ${path}`);
  }

  // 英文界面（界面精修第四阶段）：顶栏切到英文后逐页检查——界面文字与无障碍属性里不应再有中文；
  // 本脚本写入的中文数据（工作区名、用户名、粘贴的正文）与页面从 /api/v1/ 读到的服务端数据
  // （由中文正文生成的脚本内容、服务端错误信息等）不算界面文字。
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).waitFor({ timeout: 10_000 });
  // "中文"是英文界面里切回中文的按钮（用目标语言写自己的名字），不算残留
  const userData = ['中文', 'Quiet Frame 隔离测试', 'Quiet Frame 测试', '本次隔离测试检查真实浏览器、会话、工作区、项目和内容保存。来源事实需要人工核对。'.repeat(8)];
  const englishRoutes = [['home', '/'], ['new', `${workspacePath}/new`], ['script', `${projectPath}/script`], ['storyboard', `${projectPath}/storyboard`], ...routeChecks.map(([name, path]) => [name, path])];
  let apiTexts = [];
  page.on('response', (apiResponse) => {
    if (!apiResponse.url().includes('/api/v1/') || !(apiResponse.headers()['content-type'] ?? '').includes('json')) return;
    void apiResponse.text().then((text) => { apiTexts.push(text); }, () => undefined);
  });
  for (const [name, path] of englishRoutes) {
    apiTexts = [];
    const routeResponse = await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle' });
    if (routeResponse?.status() !== 200) throw new Error(`en ${name} HTTP ${routeResponse?.status() ?? 'none'}`);
    await page.locator('#main').first().waitFor({ timeout: 15_000 });
    const lang = await page.evaluate(() => globalThis.document.documentElement.lang);
    if (lang !== 'en') throw new Error(`en ${name}: <html lang> is ${lang}`);
    const texts = await page.evaluate(() => {
      const parts = [globalThis.document.body.innerText];
      for (const element of globalThis.document.querySelectorAll('[aria-label],[title],[placeholder],[alt]')) {
        for (const attribute of ['aria-label', 'title', 'placeholder', 'alt']) { const value = element.getAttribute(attribute); if (value) parts.push(value); }
      }
      return parts;
    });
    const leftovers = [...new Set(texts.join('\n').match(/[\u4e00-\u9fff][^\n]{0,40}/g) ?? [])]
      .filter((run) => { const head = run.match(/^[\u4e00-\u9fff，。、：；！？“”「」（）·\s]+/)?.[0]?.trim() ?? run; return !userData.some((data) => data.includes(head)) && !apiTexts.some((text) => text.includes(head)); });
    await page.screenshot({ path: resolve(routeEvidenceDir, `en-${name}.png`), fullPage: true });
    if (leftovers.length) throw new Error(`en ${name}: Chinese interface text left: ${leftovers.slice(0, 8).join(' | ')}`);
    console.log(`PASS en route ${name}: ${path}`);
  }
  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join(' | ')}`);
  if (hydrationErrors.length) throw new Error(`Browser hydration errors: ${hydrationErrors.join(' | ')}`);
  await mkdir(evidenceDir, { recursive: true });
  const screenshotPath = resolve(evidenceDir, `${prefix}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  console.log('PASS Quiet Frame browser smoke: login → workspace → project → pasted content → reload → mock narrative → script deep link → persisted rows → 11 secondary routes → English interface on 15 routes');
  console.log('Environment: isolated test DB, in-process API, production Next, Chromium; no paid Provider or live publication');
  console.log(`Evidence: ${screenshotPath}`);
  console.log(`Route screenshots: ${routeEvidenceDir}`);
} catch (error) {
  if (page) {
    await mkdir(evidenceDir, { recursive: true });
    const screenshotPath = resolve(evidenceDir, `${prefix}-failure.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
    console.error(`Browser smoke failure screenshot: ${screenshotPath}`);
  }
  throw error;
} finally {
  await browser?.close();
  await app?.close();
  if (proxy.listening) await closeProxy();
  await db.close();
}
