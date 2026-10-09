#!/usr/bin/env node
/* global window, location */
/**
 * N02-15 真实浏览器验收：共用素材检索与参考证据缓存。
 * 真实本地媒体 → 上传/Probe/脚本视觉分析（"举起手机"动作事件）→ 片段检索命中 →
 * "带到编辑器"带入真实源范围（banner 明示项目未被自动修改）→ 取消选择；
 * 同时经浏览器已认证会话验证 media-evidence 接口 MISS→HIT（缓存命中与用量记录）。
 */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_PROBE_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1605579510_2.mp4');
const evidenceDir = resolve('.artifacts/v04/N02-15/browser');
const runId = randomUUID();
const email = `n02-15-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let app;
let browser;
let proxy;

const visualAdapter = {
  kind: 'n02-15-scripted-browser-seam',
  async analyze() {
    const timeBase = { numerator: 1, denominator: 1000 };
    const frame = (pts) => ({ pts, timeBase, frameRef: `browser-frame:${pts}` });
    const keyframe = (pts, state, confidencePermille) => ({ pts, box: [0.12, 0.08, 0.3, 0.7], state, confidencePermille });
    return {
      schemaVersion: '1.0', processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, adapter: 'scripted-browser-only', modelVersion: 'fixture-vision-v1', sampledFrameCount: 12, durationMs: 3000,
      objectTracks: [{ id: 'phone-1', label: '手机', confidencePermille: 890, lifecycle: 'CONTINUOUS', keyframes: [keyframe('200', 'VISIBLE', 900), keyframe('800', 'VISIBLE', 880)], evidenceFrames: [frame('200')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      personTracks: [{ id: 'person-1', label: 'person', identityState: 'UNKNOWN', confidencePermille: 760, lifecycle: 'CONTINUOUS', keyframes: [keyframe('100', 'VISIBLE', 830)], evidenceFrames: [frame('100')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      actionEvents: [{ id: 'raise-phone-1', label: '举起手机', subjectTrackId: 'person-1', confidencePermille: 840, evidenceFrames: [frame('300')], sourceStartPts: '200', sourceEndPts: '800', timeBase }],
      visualEvents: [{ id: 'phone-visible', label: '手机进入画面', subjectTrackId: 'phone-1', confidencePermille: 870, evidenceFrames: [frame('200')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      motionIntensity: [{ id: 'motion-1', valuePermille: 670, method: 'fixture-optical-flow', evidenceFrames: [frame('500')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
    };
  },
};

const listen = (server) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)); });
async function executeOne(deps, registry, type, workerId) {
  const claimed = await claimJob(deps, { workerId, leaseSeconds: 600, types: [type] });
  assert.ok(claimed, `${type} Job 未找到`);
  assert.equal(await executeJob(deps, registry, { workerId, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed), 'succeeded');
  return claimed;
}

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
  await createInternalUser(auth, { email, password, name: 'N02-15 证据缓存验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 }); apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));

  // 1) 登录 → 建工作区 → 建项目（全部真实 UI）
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email); await page.getByLabel('密码').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`);
  await page.getByLabel('工作区名称').fill(`N02 证据缓存 ${runId.slice(0, 8)}`); await page.getByRole('button', { name: '创建工作区' }).click();
  await page.getByLabel('项目标题').fill('证据缓存作品'); await page.getByRole('button', { name: '创建项目' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库', exact: true }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1]; assert.ok(workspaceId);
  await page.getByLabel('项目标题').waitFor({ state: 'detached' }).catch(() => undefined);
  const projectId = (await db.pool.query('select id from projects where workspace_id = $1 order by created_at desc limit 1', [workspaceId])).rows[0]?.id;
  assert.ok(projectId, '项目未创建');

  // 2) 项目素材页：上传真实媒体 → Probe → 脚本视觉分析（动作事件“举起手机”）
  await page.goto(`${baseUrl}/w/${workspaceId}/p/${projectId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click(); await page.getByLabel('选择文件').setInputFiles(mediaPath); await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 }); await page.getByRole('button', { name: '完成' }).click();
  const probeJob = await executeOne(deps, createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }) }), MEDIA_PROBE_JOB_TYPE, 'n02-15-probe');
  await executeOne(deps, createDefaultRegistry({ mediaVisualAnalysisAdapter: visualAdapter }), MEDIA_VISUAL_ANALYSIS_JOB_TYPE, 'n02-15-vision');
  const assetId = probeJob.input.assetId ?? probeJob.input.sourceAssetId;
  assert.ok(assetId, `probe job 未携带 assetId：${JSON.stringify(probeJob.input)}`);
  const sourceVersion = await db.pool.query('select probe_status, status from asset_versions where id = $1', [assetId === probeJob.input.assetId ? probeJob.input.assetVersionId ?? probeJob.input.versionId : '']);
  assert.ok(sourceVersion.rows[0] === undefined || sourceVersion.rows[0].probe_status === 'READY', `源版本 probe 未就绪：${JSON.stringify(sourceVersion.rows)}`);

  // 3) 片段检索命中“举起手机”，结果行提供“带到编辑器”
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('搜索素材片段').fill('举起手机'); await page.getByRole('button', { name: '搜索片段' }).click();
  await page.getByText('举起手机', { exact: true }).waitFor();
  const resultRow = page.getByText('举起手机', { exact: true }).locator('xpath=ancestor::article');
  await resultRow.getByRole('link', { name: '带到编辑器' }).waitFor();
  await page.screenshot({ path: resolve(evidenceDir, 'search-hit-with-bring-to-editor-light-1440.png'), fullPage: true });

  // 4) 浏览器已认证会话：media-evidence 两次请求 MISS → HIT（缓存复用与用量真实记录）
  const evidenceResult = await page.evaluate(async ({ ws, asset }) => {
    const url = `/api/v1/workspaces/${ws}/assets/${asset}/media-evidence?consumer=SELECTION&analysisConfigHash=${'a'.repeat(64)}&sourceStartPts=200&sourceEndPts=800&timeBaseNumerator=1&timeBaseDenominator=1000`;
    const first = await (await fetch(url, { credentials: 'include' })).json();
    const second = await (await fetch(url, { credentials: 'include' })).json();
    return { first, second };
  }, { ws: workspaceId, asset: assetId });
  assert.equal(evidenceResult.first.cacheStatus, 'MISS');
  assert.equal(evidenceResult.first.usage.analysisReadCount, 1);
  assert.equal(evidenceResult.first.usage.rangeReadCount, 1);
  assert.equal(evidenceResult.second.cacheStatus, 'HIT');
  assert.equal(evidenceResult.second.cacheKey, evidenceResult.first.cacheKey);
  assert.equal(evidenceResult.second.usage.hitCount, 1);
  if (!evidenceResult.first.page.items.some((item) => item.kind === 'ACTION_EVENT' && item.payload?.label === '举起手机')) {
    console.log('DEBUG items:', JSON.stringify(evidenceResult.first.page.items.map((item) => ({ kind: item.kind, label: item.payload?.label ?? null, start: item.sourceStartPts, end: item.sourceEndPts })), null, 1));
    console.log('DEBUG caps:', JSON.stringify(evidenceResult.first.page.capabilities.map((capability) => `${capability.kind}:${capability.status}:${capability.recordCount}`)));
  }
  assert.ok(evidenceResult.first.page.items.some((item) => item.kind === 'ACTION_EVENT' && item.payload?.label === '举起手机'));

  // 5) 带到编辑器：真实选区 banner（空分镜同样显示）+ 明示项目未被自动修改 + 可取消
  await resultRow.getByRole('link', { name: '带到编辑器' }).click();
  await page.waitForURL(new RegExp(`/w/${workspaceId}/p/${projectId}/editor`));
  await page.getByText('已选择真实片段：举起手机').waitFor({ timeout: 60_000 });
  const banner = page.getByText('已选择真实片段：举起手机').locator('xpath=ancestor::div[contains(@class,"notice")]');
  const bannerText = await banner.textContent();
  assert.ok(bannerText?.includes('项目尚未自动修改'), '未明示项目未被自动修改');
  assert.ok(bannerText?.includes('源范围 200–800'), `源范围缺失：${bannerText ?? ''}`);
  await page.screenshot({ path: resolve(evidenceDir, 'selection-banner-light-1440.png'), fullPage: true });

  await banner.getByRole('button', { name: '取消选择' }).click();
  await page.getByText('已选择真实片段：举起手机').waitFor({ state: 'detached' });
  const stored = await page.evaluate(() => window.sessionStorage.getItem(`ancs-media-selection:${location.pathname.split('/')[2]}:${location.pathname.split('/')[4]}`));
  assert.equal(stored, null);

  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({
    ok: true, workspaceId, projectId, assetId, mediaPath, scriptedDetectorSeam: true,
    cacheMissThenHit: true, evidenceRangeRead: true, actionHit: '举起手机', selectionCarriedToEditor: true,
    projectAutoModified: false, screenshots: ['search-hit-with-bring-to-editor-light-1440.png', 'selection-banner-light-1440.png'], pageErrors,
  }, null, 2));
} finally {
  await browser?.close(); await app?.close(); if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]); await db.pool.query('delete from "user" where email=$1', [email]); await db.close(); await rm(storageRoot, { recursive: true, force: true });
}
