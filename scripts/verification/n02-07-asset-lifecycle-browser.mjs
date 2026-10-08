#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-07/browser');
const runId = randomUUID();
const email = `n02-07-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let app;
let browser;
let proxy;

const listen = (server) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)); });

try {
  assert.ok((await stat(mediaPath)).isFile(), `测试媒体不存在：${mediaPath}`);
  await runMigrations(db);
  await mkdir(evidenceDir, { recursive: true });
  let apiPort = 0;
  proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: incoming.url?.startsWith('/api/v1/') ? apiPort : webPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => { outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing); });
    upstream.on('error', (error) => { if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' }); outgoing.end(error.message); });
    incoming.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'N02 生命周期验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email); await page.getByLabel('密码').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('工作区名称').waitFor({ timeout: 30_000 });
  await page.getByLabel('工作区名称').fill(`N02 生命周期 ${runId.slice(0, 8)}`); await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1]; assert.ok(workspaceId);
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click(); await page.getByLabel('选择文件').setInputFiles(mediaPath); await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 }); await page.getByRole('button', { name: '完成' }).click();
  const filename = mediaPath.split(/[\\/]/).pop();
  await page.getByRole('button', { name: `查看素材 ${filename}` }).click();
  const panel = page.getByRole('region', { name: '来源、许可与媒体生命周期' });
  await panel.waitFor();
  assert.ok((await panel.textContent()).includes('许可有效'));
  await page.getByRole('button', { name: '编辑来源与许可' }).click();
  await page.getByLabel('敏感级别').selectOption('SENSITIVE');
  await page.getByLabel('许可到期时间').fill('2027-12-31T23:59');
  await page.getByRole('button', { name: '保存许可' }).click();
  await page.getByText('敏感', { exact: true }).waitFor();
  const assetId = (await db.pool.query('select id from assets where workspace_id=$1 and metadata->>\'filename\'=$2 order by created_at desc limit 1', [workspaceId, filename])).rows[0]?.id;
  assert.ok(assetId);
  const stored = (await db.pool.query('select sensitivity_class, license from assets where id=$1', [assetId])).rows[0];
  assert.equal(stored.sensitivity_class, 'SENSITIVE');
  assert.ok(stored.license.permittedUses.includes('PUBLISH'));
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'rights-summary-light-1440.png'), fullPage: true });
  await page.getByText('删除与隐私').click();
  await page.getByRole('button', { name: '请求隐私删除' }).click();
  await page.getByLabel('删除原因').fill('浏览器验收：只验证确认闸门，不提交');
  assert.equal(await page.getByRole('button', { name: '确认隐私删除' }).isDisabled(), true);
  await page.screenshot({ path: resolve(evidenceDir, 'privacy-confirmation-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '切换浅深色' }).evaluate((button) => button.click()); await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport);
  await page.getByLabel('输入素材 ID 以确认').scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'rights-privacy-dark-390.png'), fullPage: false });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, workspaceId, assetId, mediaPath, rightsPersisted: true, privacyConfirmationRequired: true, responsiveNoOverflow: true, screenshots: ['rights-summary-light-1440.png', 'privacy-confirmation-light-1440.png', 'rights-privacy-dark-390.png'], pageErrors }, null, 2));
} finally {
  await browser?.close(); await app?.close(); if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]); await db.pool.query('delete from "user" where email=$1', [email]); await db.close(); await rm(storageRoot, { recursive: true, force: true });
}
