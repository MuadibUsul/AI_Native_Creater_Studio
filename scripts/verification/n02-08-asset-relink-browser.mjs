#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_PROBE_JOB_TYPE } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-08/browser');
const runId = randomUUID();
const email = `n02-08-${runId}@test.local`;
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
  await createInternalUser(auth, { email, password, name: 'N02 重新链接验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;
  const registry = createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }) });
  const executeProbe = async (label) => {
    const claimed = await claimJob(deps, { workerId: label, leaseSeconds: 600, types: [MEDIA_PROBE_JOB_TYPE] });
    assert.ok(claimed, 'MEDIA_PROBE Job 未找到');
    assert.equal(await executeJob(deps, registry, { workerId: label, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed), 'succeeded');
  };

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email); await page.getByLabel('密码').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('工作区名称').waitFor({ timeout: 30_000 });
  await page.getByLabel('工作区名称').fill(`N02 重新链接 ${runId.slice(0, 8)}`); await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1]; assert.ok(workspaceId);
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  const filename = mediaPath.split(/[\\/]/).pop();
  const upload = async () => {
    await page.getByRole('button', { name: '上传素材' }).click();
    await page.getByLabel('选择文件').setInputFiles(mediaPath);
    await page.getByRole('button', { name: '开始上传' }).click();
    await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
    await page.getByRole('button', { name: '完成' }).click();
  };
  await upload();
  await executeProbe('n02-08-original');
  await page.reload({ waitUntil: 'networkidle' });
  const original = (await db.pool.query(`select a.id, av.id as version_id, av.storage_key, av.checksum_sha256 from assets a join asset_versions av on av.id=a.current_version_id where a.workspace_id=$1 order by a.created_at asc limit 1`, [workspaceId])).rows[0];
  assert.ok(original?.id && original?.version_id && original?.storage_key && original?.checksum_sha256);
  await storage.deleteObject(original.storage_key);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${filename}` }).click();
  const relinkPanel = page.getByRole('region', { name: '原件在线状态与重新链接' });
  await relinkPanel.getByText('1 个版本缺失').waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'missing-original-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  await upload();
  await executeProbe('n02-08-candidate');
  await page.reload({ waitUntil: 'networkidle' });
  const rows = (await db.pool.query(`select a.id, a.created_at from assets a where a.workspace_id=$1 and a.metadata->>'filename'=$2 order by a.created_at desc`, [workspaceId, filename])).rows;
  assert.equal(rows.length, 2);
  const candidateAssetId = rows[0].id;
  const originalCards = page.getByRole('button', { name: `查看素材 ${filename}` });
  assert.equal(await originalCards.count(), 2);
  await originalCards.nth(1).click();
  await page.getByLabel('已上传候选素材').selectOption(candidateAssetId);
  await page.getByRole('button', { name: '校验候选文件' }).click();
  await page.getByText('内容完全一致').waitFor();
  assert.ok((await relinkPanel.textContent()).includes('版本 ID、裁剪范围和代理关系保持不变'));
  await page.screenshot({ path: resolve(evidenceDir, 'exact-preflight-light-1440.png'), fullPage: true });
  await page.getByLabel('输入“恢复原件”确认').fill('恢复原件');
  await page.getByRole('button', { name: '恢复原件' }).click();
  await relinkPanel.getByText('原件在线').waitFor();
  const audit = (await db.pool.query(`select action, target_version_id, created_version_id, review_required from asset_relinks where workspace_id=$1 order by created_at desc limit 1`, [workspaceId])).rows[0];
  assert.deepEqual(audit, { action: 'EXACT_RESTORE', target_version_id: original.version_id, created_version_id: null, review_required: false });
  assert.equal(await storage.computeObjectSha256(original.storage_key), original.checksum_sha256);
  await page.getByRole('button', { name: '切换浅深色' }).evaluate((button) => button.click());
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport);
  await relinkPanel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'restored-dark-390.png'), fullPage: false });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, workspaceId, originalAssetId: original.id, candidateAssetId, mediaPath, checksumRestored: true, audit, responsiveNoOverflow: true, screenshots: ['missing-original-light-1440.png', 'exact-preflight-light-1440.png', 'restored-dark-390.png'], pageErrors }, null, 2));
} finally {
  await browser?.close(); await app?.close(); if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]); await db.pool.query('delete from "user" where email=$1', [email]); await db.close(); await rm(storageRoot, { recursive: true, force: true });
}
