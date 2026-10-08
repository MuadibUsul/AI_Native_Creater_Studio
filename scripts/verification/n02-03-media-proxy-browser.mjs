#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_PROBE_JOB_TYPE, MEDIA_PROXY_JOB_TYPE } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegMediaProxyTranscoder, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const databaseUrl = resolveTestDatabaseUrl();
const db = createDb(databaseUrl);
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4300);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-03/browser');
const runId = randomUUID();
const email = `n02-03-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let app;
let browser;
let proxy;

const listen = (server) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});

async function executeOne(deps, registry, type, workerId) {
  const claimed = await claimJob(deps, { workerId, leaseSeconds: 600, types: [type] });
  assert.ok(claimed, `${type} Job 未找到`);
  const outcome = await executeJob(deps, registry, { workerId, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed);
  assert.equal(outcome, 'succeeded');
}

async function seekVideo(page, ratio) {
  const video = page.locator('video');
  await video.waitFor();
  await video.evaluate((element, requestedRatio) => new Promise((resolveSeek, reject) => {
    const media = element;
    const seek = () => {
      const duration = media.duration;
      if (!Number.isFinite(duration) || duration <= 0) { reject(new Error('代理视频没有有效 duration')); return; }
      media.addEventListener('seeked', () => resolveSeek({ duration, currentTime: media.currentTime }), { once: true });
      media.currentTime = Math.min(Math.max(0, duration * requestedRatio), Math.max(0, duration - 0.05));
    };
    if (media.readyState >= 1) seek();
    else media.addEventListener('loadedmetadata', seek, { once: true });
  }), ratio);
}

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
  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'N02 代理转码验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`);
  await page.getByLabel('工作区名称').fill(`N02 代理转码 ${runId.slice(0, 8)}`);
  await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1];
  assert.ok(workspaceId, '未能取得 workspaceId');
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click();
  await page.getByLabel('选择文件').setInputFiles(mediaPath);
  await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: '完成' }).click();

  const registry = createDefaultRegistry({
    sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }),
    sourceMediaTranscoder: createFfmpegMediaProxyTranscoder({ timeoutMs: 10 * 60 * 1000 }),
  });
  await executeOne(deps, registry, MEDIA_PROBE_JOB_TYPE, 'n02-03-browser-probe');
  const videoName = mediaPath.split(/[\\/]/).pop();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await page.getByRole('region', { name: '编辑代理' }).getByText('正在生成', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'proxy-processing-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  const sourceBefore = (await db.pool.query(
    `select av.id, av.storage_key, av.checksum_sha256 from assets a join asset_versions av on av.id=a.current_version_id where a.workspace_id=$1 and coalesce(a.metadata->>'internalDerivative','false') <> 'true' limit 1`,
    [workspaceId],
  )).rows[0];
  await executeOne(deps, registry, MEDIA_PROXY_JOB_TYPE, 'n02-03-browser-proxy');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  const proxyRegion = page.getByRole('region', { name: '编辑代理' });
  await proxyRegion.getByText('已就绪').waitFor();
  await proxyRegion.getByText(/PTS 映射/).first().waitFor();
  await seekVideo(page, 0.02);
  await seekVideo(page, 0.5);
  await seekVideo(page, 0.98);
  await page.screenshot({ path: resolve(evidenceDir, 'proxy-ready-dark-1440.png'), fullPage: true });

  const output = (await db.pool.query(
    `select av.storage_key from media_derivatives md join asset_versions av on av.id=md.derivative_asset_version_id where md.workspace_id=$1 and md.source_asset_version_id=$2 and md.kind='PROXY'`,
    [workspaceId, sourceBefore.id],
  )).rows[0];
  assert.ok(output?.storage_key, '代理 storage key 缺失');
  await storage.deleteObject(output.storage_key);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await page.getByRole('region', { name: '编辑代理' }).getByText('文件缺失').waitFor();
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport, '窄屏代理状态产生横向溢出');
  await page.screenshot({ path: resolve(evidenceDir, 'proxy-missing-dark-390.png'), fullPage: true });
  await page.getByRole('button', { name: '重新生成代理' }).click();
  await page.getByRole('region', { name: '编辑代理' }).getByText('正在生成', { exact: true }).waitFor();
  await executeOne(deps, registry, MEDIA_PROXY_JOB_TYPE, 'n02-03-browser-rebuild');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await page.getByRole('region', { name: '编辑代理' }).getByText('已就绪').waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'proxy-rebuilt-dark-390.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);

  const sourceAfter = (await db.pool.query('select storage_key, checksum_sha256 from asset_versions where id=$1', [sourceBefore.id])).rows[0];
  assert.deepEqual(sourceAfter, { storage_key: sourceBefore.storage_key, checksum_sha256: sourceBefore.checksum_sha256 });
  const derivative = (await db.pool.query(
    `select status, profile_key, source_checksum_sha256, metadata->'timeMappings' as time_mappings from media_derivatives where workspace_id=$1 and source_asset_version_id=$2`,
    [workspaceId, sourceBefore.id],
  )).rows[0];
  assert.equal(derivative.status, 'READY');
  assert.equal(derivative.source_checksum_sha256, sourceBefore.checksum_sha256);
  assert.ok(Array.isArray(derivative.time_mappings) && derivative.time_mappings.length > 0);
  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    mediaPath,
    derivative: { status: derivative.status, profileKey: derivative.profile_key, timeMappingCount: derivative.time_mappings.length },
    sourceUnchanged: true,
    seeks: ['start', 'middle', 'end'],
    screenshots: ['proxy-processing-light-1440.png', 'proxy-ready-dark-1440.png', 'proxy-missing-dark-390.png', 'proxy-rebuilt-dark-390.png'],
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
}
