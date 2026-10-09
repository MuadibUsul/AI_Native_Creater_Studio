#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import {
  MEDIA_INDEX_JOB_TYPE,
  MEDIA_PROBE_JOB_TYPE,
  MEDIA_PROXY_JOB_TYPE,
  MEDIA_TRANSCRIPT_JOB_TYPE,
} from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import {
  createDefaultRegistry,
  createFfmpegMediaIndexer,
  createFfmpegMediaProxyTranscoder,
  createFfmpegSourceMediaProbe,
  executeJob,
} from '../../apps/worker/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const landscapePath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const portraitPath = resolve(process.env.ANCS_N02_SECOND_MEDIA_FILE ?? 'E:/Pictures/v0300fg10000d43ma4vog65qih8737o0.mp4');
const evidenceDir = resolve('.artifacts/v04/N02-09/browser');
const runId = randomUUID();
const ownerEmail = `n02-09-owner-${runId}@test.local`;
const outsiderEmail = `n02-09-outsider-${runId}@test.local`;
const ownerPassword = randomBytes(24).toString('base64url');
const outsiderPassword = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
const corruptPath = resolve(evidenceDir, `invalid-${runId}.mp4`);
let workspaceId;
let app;
let browser;
let proxy;

const listen = (server) => new Promise((resolveListen, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolveListen(server.address().port));
});

const hashFile = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', (chunk) => hash.update(chunk));
  stream.once('error', reject);
  stream.once('end', () => resolveHash(hash.digest('hex')));
});

const transcriptAdapter = {
  kind: 'n02-09-scripted-asr-test-seam',
  async transcribe() {
    return {
      schemaVersion: '1.0', processorVersion: 'source-transcript-v1', provider: 'scripted-test-only', model: 'n02-09-fixture', language: 'zh-CN', terminology: [],
      speakers: [{ id: 'speaker-e2e', displayName: null, identityState: 'UNKNOWN', confidencePermille: 800 }],
      words: [{ ordinal: 0, text: '端到端检索证据', speakerId: 'speaker-e2e', confidencePermille: 900, sourceStartPts: '250', sourceEndPts: '1500', timeBase: { numerator: 1, denominator: 1000 } }],
      segments: [{ id: `mts_${randomUUID()}`, ordinal: 0, text: '端到端检索证据', speakerId: 'speaker-e2e', wordStartOrdinal: 0, wordEndOrdinal: 0, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '250', sourceEndPts: '1500', timeBase: { numerator: 1, denominator: 1000 } }],
    };
  },
};

try {
  assert.ok((await stat(landscapePath)).isFile(), `横屏测试媒体不存在：${landscapePath}`);
  assert.ok((await stat(portraitPath)).isFile(), `竖屏测试媒体不存在：${portraitPath}`);
  await runMigrations(db);
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(corruptPath, Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]));
  const mediaHashes = {
    landscape: await hashFile(landscapePath),
    portrait: await hashFile(portraitPath),
  };

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
  await createInternalUser(auth, { email: ownerEmail, password: ownerPassword, name: 'N02-09 素材验收' });
  await createInternalUser(auth, { email: outsiderEmail, password: outsiderPassword, name: 'N02-09 越权用户' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  const registry = createDefaultRegistry({
    sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }),
    sourceMediaTranscoder: createFfmpegMediaProxyTranscoder({ timeoutMs: 10 * 60 * 1000 }),
    sourceMediaIndexer: createFfmpegMediaIndexer({ timeoutMs: 10 * 60 * 1000 }),
    speechRecognitionAdapter: transcriptAdapter,
  });
  const executeCount = async (type, count) => {
    const outcomes = [];
    for (let index = 0; index < count; index += 1) {
      const workerId = `n02-09-${type.toLowerCase()}-${String(index)}`;
      const claimed = await claimJob(deps, { workerId, leaseSeconds: 900, types: [type] });
      assert.ok(claimed, `${type} Job ${String(index + 1)}/${String(count)} 未找到`);
      outcomes.push(await executeJob(deps, registry, { workerId, leaseSeconds: 900, heartbeatIntervalMs: 30_000 }, claimed));
    }
    assert.deepEqual(outcomes, Array(count).fill('succeeded'), `${type} 未全部完成`);
  };

  browser = await chromium.launch({ headless: true });
  const ownerContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await ownerContext.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  let disconnectedOnce = false;
  await page.route('**/api/v1/storage/upload?token=*', async (route) => {
    if (!disconnectedOnce) {
      disconnectedOnce = true;
      await route.abort('internetdisconnected');
      return;
    }
    await route.continue();
  });

  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(ownerEmail);
  await page.getByLabel('密码').fill(ownerPassword);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByLabel('工作区名称').waitFor({ timeout: 30_000 });
  await page.getByLabel('工作区名称').fill(`N02 全链路 ${runId.slice(0, 8)}`);
  await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1];
  assert.ok(workspaceId, '未能取得 workspaceId');
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });

  const landscapeName = landscapePath.split(/[\\/]/).pop();
  const portraitName = portraitPath.split(/[\\/]/).pop();
  const corruptName = corruptPath.split(/[\\/]/).pop();
  await page.getByRole('button', { name: '上传素材' }).click();
  await page.getByLabel('选择文件').setInputFiles([landscapePath, portraitPath, corruptPath]);
  await page.getByText('已选择 3 个文件').waitFor();
  const landscapeRow = page.getByText(landscapeName, { exact: true }).locator('xpath=ancestor::div[contains(@class,"uploadRow")]');
  const portraitRow = page.getByText(portraitName, { exact: true }).locator('xpath=ancestor::div[contains(@class,"uploadRow")]');
  const corruptRow = page.getByText(corruptName, { exact: true }).locator('xpath=ancestor::div[contains(@class,"uploadRow")]');
  await page.getByRole('button', { name: '开始上传' }).click();
  await landscapeRow.getByText('上传失败').waitFor({ timeout: 120_000 });
  await portraitRow.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
  await corruptRow.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
  await landscapeRow.getByRole('button', { name: '继续' }).click();
  await landscapeRow.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
  await page.screenshot({ path: resolve(evidenceDir, 'batch-network-recovered-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '完成' }).click();
  assert.equal(disconnectedOnce, true, '没有注入断网故障');

  await executeCount(MEDIA_PROBE_JOB_TYPE, 3);
  await executeCount(MEDIA_PROXY_JOB_TYPE, 2);
  await executeCount(MEDIA_INDEX_JOB_TYPE, 2);
  await executeCount(MEDIA_TRANSCRIPT_JOB_TYPE, 2);

  const sourceRows = (await db.pool.query(
    `select a.id, a.status, a.metadata->>'filename' as filename, av.id as version_id, av.storage_key, av.checksum_sha256, av.probe_status
       from assets a join asset_versions av on av.id=a.current_version_id
      where a.workspace_id=$1 and coalesce(a.metadata->>'internalDerivative','false') <> 'true'
      order by a.created_at`,
    [workspaceId],
  )).rows;
  assert.deepEqual(sourceRows.map((row) => row.status), ['READY', 'READY', 'FAILED']);
  assert.deepEqual(sourceRows.slice(0, 2).map((row) => row.probe_status), ['READY', 'READY']);
  assert.equal(sourceRows[0].checksum_sha256, mediaHashes.landscape);
  assert.equal(sourceRows[1].checksum_sha256, mediaHashes.portrait);

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${landscapeName}` }).click();
  await page.getByRole('region', { name: '媒体能力' }).getByText('探测完成').waitFor();
  await page.getByRole('region', { name: '编辑代理' }).getByText('已就绪').waitFor();
  const indexRegion = page.getByRole('region', { name: '源媒体索引' });
  await indexRegion.getByText('已就绪', { exact: true }).waitFor();
  const thumbnail = page.getByRole('button', { name: /播放 缩略/ }).first();
  await thumbnail.waitFor();
  await thumbnail.click();
  const video = page.getByLabel(`预览视频 ${landscapeName}`);
  await video.waitFor();
  await video.evaluate((element) => element.play());
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) > 0.1);
  await video.evaluate((element) => element.pause());
  await page.screenshot({ path: resolve(evidenceDir, 'indexed-playback-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByLabel('搜索素材片段').fill('端到端检索证据');
  await page.getByRole('button', { name: '搜索片段' }).click();
  await page.getByText('端到端检索证据', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: '播放片段' }).first().click();
  await page.getByLabel(/预览视频/).waitFor();
  await page.getByRole('button', { name: '关闭' }).click();

  const original = sourceRows[0];
  await storage.deleteObject(original.storage_key);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: `查看素材 ${landscapeName}` }).click();
  const relinkPanel = page.getByRole('region', { name: '原件在线状态与重新链接' });
  await relinkPanel.getByText('1 个版本缺失').waitFor();
  await page.getByRole('button', { name: '关闭' }).click();

  await page.getByRole('button', { name: '上传素材' }).click();
  await page.getByLabel('选择文件').setInputFiles(landscapePath);
  await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: '完成' }).click();
  await executeCount(MEDIA_PROBE_JOB_TYPE, 1);
  const candidate = (await db.pool.query(
    `select a.id from assets a where a.workspace_id=$1 and a.metadata->>'filename'=$2 order by a.created_at desc limit 1`,
    [workspaceId, landscapeName],
  )).rows[0];
  assert.ok(candidate?.id && candidate.id !== original.id);
  await page.reload({ waitUntil: 'networkidle' });
  const landscapeCards = page.getByRole('button', { name: `查看素材 ${landscapeName}` });
  assert.equal(await landscapeCards.count(), 2);
  await landscapeCards.nth(1).click();
  await page.getByLabel('已上传候选素材').selectOption(candidate.id);
  await page.getByRole('button', { name: '校验候选文件' }).click();
  await page.getByText('内容完全一致').waitFor();
  await page.getByLabel('输入“恢复原件”确认').fill('恢复原件');
  await page.getByRole('button', { name: '恢复原件' }).click();
  await relinkPanel.getByText('原件在线').waitFor();
  assert.equal(await storage.computeObjectSha256(original.storage_key), mediaHashes.landscape);

  await page.getByRole('button', { name: '切换浅深色' }).evaluate((button) => button.click());
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth }));
  assert.equal(metrics.documentWidth, metrics.viewport);
  await relinkPanel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'relinked-dark-390.png'), fullPage: false });
  await page.getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: `查看素材 ${corruptName}` }).click();
  const invalidCapability = page.getByRole('region', { name: '媒体能力' });
  await invalidCapability.getByText('探测失败').waitFor();
  await invalidCapability.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'invalid-file-dark-390.png'), fullPage: false });

  const outsiderContext = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const outsiderPage = await outsiderContext.newPage();
  await outsiderPage.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await outsiderPage.getByLabel('邮箱').fill(outsiderEmail);
  await outsiderPage.getByLabel('密码').fill(outsiderPassword);
  await outsiderPage.getByRole('button', { name: '登录', exact: true }).click();
  await outsiderPage.waitForURL(`${baseUrl}/`);
  const crossTenantStatus = await outsiderPage.evaluate(async (targetWorkspaceId) => {
    const response = await fetch(`/api/v1/workspaces/${targetWorkspaceId}/assets`);
    return response.status;
  }, workspaceId);
  assert.equal(crossTenantStatus, 404, '跨租户素材列表应统一返回 404');
  await outsiderContext.close();

  assert.deepEqual(pageErrors, []);
  const audit = (await db.pool.query(
    `select action, target_version_id, created_version_id, review_required from asset_relinks where workspace_id=$1 order by created_at desc limit 1`,
    [workspaceId],
  )).rows[0];
  assert.deepEqual(audit, { action: 'EXACT_RESTORE', target_version_id: original.version_id, created_version_id: null, review_required: false });
  const uploadResume = (await db.pool.query(
    `select count(*)::int as intent_count, count(*) filter (where status='COMPLETED')::int as completed_count from upload_intents where workspace_id=$1`,
    [workspaceId],
  )).rows[0];
  assert.equal(uploadResume.intent_count, uploadResume.completed_count);

  console.log(JSON.stringify({
    ok: true,
    workspaceId,
    media: [
      { path: landscapePath, sha256: mediaHashes.landscape, orientation: 'landscape' },
      { path: portraitPath, sha256: mediaHashes.portrait, orientation: 'portrait' },
    ],
    batchRealMediaCount: 2,
    networkFailureRecovered: disconnectedOnce,
    probeReadyCount: 2,
    invalidFileFailedClosed: true,
    proxyReadyCount: 2,
    indexReadyCount: 2,
    scriptedAsrSearchPlayed: true,
    thirdPartyAsrVerified: false,
    exactRelinkRestored: true,
    crossTenantStatus,
    uploadResume,
    screenshots: [
      'batch-network-recovered-light-1440.png',
      'indexed-playback-light-1440.png',
      'relinked-dark-390.png',
      'invalid-file-dark-390.png',
    ],
    pageErrors,
  }, null, 2));
} finally {
  await browser?.close();
  await app?.close();
  if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]);
  await db.pool.query('delete from "user" where email in ($1,$2)', [ownerEmail, outsiderEmail]);
  await db.close();
  await rm(storageRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  await rm(corruptPath, { force: true, maxRetries: 5, retryDelay: 200 });
}
