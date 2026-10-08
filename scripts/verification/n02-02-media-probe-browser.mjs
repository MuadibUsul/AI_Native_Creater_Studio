#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
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

const databaseUrl = resolveTestDatabaseUrl();
const db = createDb(databaseUrl);
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4300);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-02/browser');
const runId = randomUUID();
const email = `n02-02-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
const corruptPath = resolve(evidenceDir, `corrupt-${runId}.mp4`);
let workspaceId;
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
  await writeFile(corruptPath, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
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
  await createInternalUser(auth, { email, password, name: 'N02 媒体探测验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({
    auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
  });
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
  await page.getByLabel('工作区名称').fill(`N02 媒体探测 ${runId.slice(0, 8)}`);
  await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1];
  assert.ok(workspaceId, '未能取得 workspaceId');
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click();
  await page.getByLabel('选择文件').setInputFiles([mediaPath, corruptPath]);
  await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').first().waitFor({ timeout: 180_000 });
  await page.getByText('上传完成 · 正在分析媒体').nth(1).waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: '完成' }).click();
  await page.getByText('正在分析').first().waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'media-processing-light-1440.png'), fullPage: true });

  const registry = createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }) });
  for (let index = 0; index < 2; index += 1) {
    const claimed = await claimJob(deps, { workerId: `n02-02-browser-${String(index)}`, leaseSeconds: 360, types: [MEDIA_PROBE_JOB_TYPE] });
    assert.ok(claimed, `第 ${String(index + 1)} 个 MEDIA_PROBE Job 未找到`);
    const outcome = await executeJob(
      deps,
      registry,
      { workerId: `n02-02-browser-${String(index)}`, leaseSeconds: 360, heartbeatIntervalMs: 30_000 },
      claimed,
    );
    assert.equal(outcome, 'succeeded');
  }

  await page.reload({ waitUntil: 'networkidle' });
  const videoName = mediaPath.split(/[\\/]/).pop();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await page.getByRole('region', { name: '媒体能力' }).waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'media-ready-dark-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  const corruptName = corruptPath.split(/[\\/]/).pop();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForFunction(() => !document.body.classList.contains('theme-dark'));
  await page.getByRole('button', { name: `查看素材 ${corruptName}` }).click();
  const failedRegion = page.getByRole('region', { name: '媒体能力' });
  await failedRegion.getByText('探测失败').waitFor();
  await failedRegion.getByText(/检查文件是否完整|重新上传/).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport, '窄屏媒体能力弹窗产生横向溢出');
  await page.screenshot({ path: resolve(evidenceDir, 'media-failed-light-390.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);

  const rows = await db.pool.query(
    `select a.status, av.probe_status, av.media_probe->'capabilities'->>'preview' as preview
       from assets a join asset_versions av on av.id = a.current_version_id
      where a.workspace_id = $1 order by a.created_at`,
    [workspaceId],
  );
  assert.deepEqual(rows.rows.map((row) => row.status), ['READY', 'FAILED']);
  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    mediaPath,
    rows: rows.rows,
    screenshots: ['media-processing-light-1440.png', 'media-ready-dark-1440.png', 'media-failed-light-390.png'],
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
  await rm(corruptPath, { force: true });
}
