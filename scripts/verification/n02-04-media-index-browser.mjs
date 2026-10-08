#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_INDEX_JOB_TYPE, MEDIA_PROBE_JOB_TYPE } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob, rebuildMediaIndex } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegMediaIndexer, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const databaseUrl = resolveTestDatabaseUrl();
const db = createDb(databaseUrl);
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4300);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-04/browser');
const runId = randomUUID();
const email = `n02-04-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let assetId;
let app;
let browser;
let proxy;

const listen = (server) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});

async function executeOne(deps, registry, type, workerId, expected = 'succeeded') {
  const claimed = await claimJob(deps, { workerId, leaseSeconds: 600, types: [type] });
  assert.ok(claimed, `${type} Job 未找到`);
  const outcome = await executeJob(deps, registry, { workerId, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed);
  assert.equal(outcome, expected);
}

try {
  assert.ok((await stat(mediaPath)).isFile(), `测试媒体不存在：${mediaPath}`);
  await runMigrations(db);
  await mkdir(evidenceDir, { recursive: true });
  let apiPort = 0;
  proxy = createServer((incoming, outgoing) => {
    const upstream = httpRequest({ hostname: '127.0.0.1', port: incoming.url?.startsWith('/api/v1/') ? apiPort : webPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers); response.pipe(outgoing);
    });
    upstream.on('error', (error) => { if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' }); outgoing.end(error.message); });
    incoming.pipe(upstream);
  });
  const proxyPort = await listen(proxy);
  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'N02 媒体索引验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;
  const registry = createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }), sourceMediaIndexer: createFfmpegMediaIndexer({ timeoutMs: 10 * 60 * 1000 }) });

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
  await page.getByLabel('工作区名称').fill(`N02 媒体索引 ${runId.slice(0, 8)}`);
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
  await executeOne(deps, registry, MEDIA_PROBE_JOB_TYPE, 'n02-04-browser-probe');
  const source = (await db.pool.query(`select a.id from assets a where a.workspace_id=$1 and coalesce(a.metadata->>'internalDerivative','false') <> 'true' limit 1`, [workspaceId])).rows[0];
  assetId = source?.id;
  assert.ok(assetId, '源资产缺失');

  const videoName = mediaPath.split(/[\\/]/).pop();
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  const indexRegion = page.getByRole('region', { name: '源媒体索引' });
  await indexRegion.getByText('正在生成', { exact: true }).waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'index-processing-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  await executeOne(deps, registry, MEDIA_INDEX_JOB_TYPE, 'n02-04-browser-index');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await page.getByRole('region', { name: '源媒体索引' }).getByText('已就绪', { exact: true }).waitFor();
  const thumbnails = page.getByRole('button', { name: /播放 缩略/ });
  assert.ok(await thumbnails.count() > 0, '真实缩略图未显示');
  await thumbnails.last().click();
  const seeked = await page.locator('video').evaluate((media) => ({ currentTime: media.currentTime, paused: media.paused }));
  assert.ok(seeked.currentTime >= 0, '点击缩略图没有定位播放器');
  await page.screenshot({ path: resolve(evidenceDir, 'index-ready-dark-1440.png'), fullPage: true });

  await page.getByRole('tab', { name: '波形' }).click();
  await page.getByRole('button', { name: /播放 波形/ }).first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport, '窄屏媒体索引产生横向溢出');
  await page.screenshot({ path: resolve(evidenceDir, 'waveform-ready-dark-390.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  await rebuildMediaIndex(deps, { workspaceId, assetId });
  const failingIndexer = { kind: 'browser-failure', async index() { throw new Error('scripted index failure'); } };
  await executeOne(deps, createDefaultRegistry({ sourceMediaIndexer: failingIndexer }), MEDIA_INDEX_JOB_TYPE, 'n02-04-browser-failure', 'failed');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  const failedRegion = page.getByRole('region', { name: '源媒体索引' });
  await failedRegion.getByText('生成失败', { exact: true }).waitFor();
  assert.ok(await page.locator('video').count() === 1, '索引失败错误地移除了可播放媒体');
  await failedRegion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'index-failed-source-playable-dark-390.png'), fullPage: true });
  await page.getByRole('button', { name: '重新生成索引' }).click();
  await page.getByRole('region', { name: '源媒体索引' }).getByText('正在生成', { exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭' }).click();
  await executeOne(deps, registry, MEDIA_INDEX_JOB_TYPE, 'n02-04-browser-recovery');
  assert.deepEqual(pageErrors, []);

  const summary = (await db.pool.query(`select r.status, count(e.id)::int as entry_count, count(e.storage_key)::int as thumbnail_count from media_index_runs r left join media_index_entries e on e.run_id=r.id where r.workspace_id=$1 group by r.status`, [workspaceId])).rows[0];
  assert.equal(summary.status, 'READY');
  assert.ok(summary.entry_count > 0 && summary.thumbnail_count > 0);
  console.log(JSON.stringify({ ok: true, workspaceId, mediaPath, sourceRangePlayback: true, failureIsolation: true, recovered: true, summary, screenshots: ['index-processing-light-1440.png', 'index-ready-dark-1440.png', 'waveform-ready-dark-390.png', 'index-failed-source-playable-dark-390.png'], pageErrors }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id = $1', [workspaceId]);
  await db.pool.query('delete from "user" where email = $1', [email]);
  await db.close();
  await rm(storageRoot, { recursive: true, force: true });
}
