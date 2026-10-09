#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';

const databaseUrl = resolveTestDatabaseUrl();
const db = createDb(databaseUrl);
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4300);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-01/browser');
const runId = randomUUID();
const email = `n02-01-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let cancelPath;
let app;
let browser;
let proxy;

const listen = (server) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});

try {
  assert.ok((await stat(mediaPath)).isFile(), `测试媒体不存在：${mediaPath}`);
  await runMigrations(db);
  await mkdir(evidenceDir, { recursive: true });
  let apiPort = 0;
  proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest({
      hostname: '127.0.0.1',
      port: incoming.url?.startsWith('/api/v1/') ? apiPort : webPort,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    });
    upstream.on('error', (error) => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end(error.message);
    });
    incoming.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'N02 上传验收' });
  const storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: baseUrl,
    signingSecret: randomBytes(32).toString('hex'),
  });
  app = await buildServer({
    auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  let delayOnePart = true;
  await page.route('**/api/v1/storage/upload?token=*', async (route) => {
    if (delayOnePart) {
      delayOnePart = false;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`);
  await page.getByLabel('工作区名称').fill(`N02 分片上传 ${runId.slice(0, 8)}`);
  await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1];
  assert.ok(workspaceId, '未能从素材库入口取得 workspaceId');
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click();
  const png = Buffer.alloc(600_000);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 0x40, 0, 0, 0, 0x40, 8, 2]).copy(png);
  cancelPath = resolve(evidenceDir, `cancel-${runId.slice(0, 4)}.png`);
  await writeFile(cancelPath, png);
  await page.getByLabel('选择文件').setInputFiles([mediaPath, cancelPath]);
  await page.getByText('已选择 2 个文件').waitFor();
  const videoName = mediaPath.split(/[\\/]/).pop();
  const videoRow = page.getByText(videoName, { exact: true }).locator('xpath=ancestor::div[contains(@class,"uploadRow")]');
  const cancelledRow = page.getByText(`cancel-${runId.slice(0, 4)}.png`, { exact: true }).locator('xpath=ancestor::div[contains(@class,"uploadRow")]');
  await page.getByRole('button', { name: '开始上传' }).click();
  await videoRow.getByText(/上传中/).waitFor();
  await cancelledRow.getByRole('button', { name: '取消' }).click();
  await videoRow.getByRole('button', { name: '暂停' }).click();
  await videoRow.getByText(/已暂停/).waitFor({ timeout: 10_000 });
  await page.screenshot({ path: resolve(evidenceDir, 'upload-paused-light-1440.png'), fullPage: true });
  await videoRow.getByRole('button', { name: '继续' }).click();
  await videoRow.getByText('已完成').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: resolve(evidenceDir, 'asset-ready-dark-1280.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '上传素材' }).click();
  await page.getByLabel('选择文件').setInputFiles({ name: '窄屏长文件名-用于检查换行与操作区域-0123456789.png', mimeType: 'image/png', buffer: png.subarray(0, 300_000) });
  await page.waitForTimeout(350);
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport, '窄屏上传弹窗产生横向溢出');
  await page.screenshot({ path: resolve(evidenceDir, 'upload-queue-dark-390.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);

  const rows = await db.pool.query('select status from assets where workspace_id = $1 order by created_at', [workspaceId]);
  assert.deepEqual(rows.rows.map((row) => row.status), ['READY']);
  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    mediaPath,
    uploadedAssets: rows.rowCount,
    screenshots: ['upload-paused-light-1440.png', 'asset-ready-dark-1280.png', 'upload-queue-dark-390.png'],
    pageErrors,
  }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id = $1', [workspaceId]);
  await db.pool.query('delete from "user" where email = $1', [email]);
  await db.close();
  await rm(storageRoot, { recursive: true, force: true });
  if (cancelPath) await rm(cancelPath, { force: true });
}
