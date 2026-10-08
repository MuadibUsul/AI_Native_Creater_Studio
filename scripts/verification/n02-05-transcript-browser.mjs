#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_PROBE_JOB_TYPE, MEDIA_TRANSCRIPT_JOB_TYPE } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob, failMediaTranscript } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-05/browser');
const runId = randomUUID();
const email = `n02-05-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let app;
let browser;
let proxy;

const adapter = {
  kind: 'browser-scripted-asr',
  async transcribe() {
    return {
      schemaVersion: '1.0', processorVersion: 'source-transcript-v1', provider: 'scripted-browser-only', model: 'fixture-v1', language: 'zh-CN', terminology: [],
      speakers: [{ id: 'speaker-1', displayName: null, identityState: 'UNKNOWN', confidencePermille: 740 }],
      words: [
        { ordinal: 0, text: '本期预算是120万元', speakerId: 'speaker-1', confidencePermille: 860, sourceStartPts: '0', sourceEndPts: '2000', timeBase: { numerator: 1, denominator: 1000 } },
        { ordinal: 1, text: '下周开始交付', speakerId: null, confidencePermille: 810, sourceStartPts: '2000', sourceEndPts: '4000', timeBase: { numerator: 1, denominator: 1000 } },
      ],
      segments: [
        { id: 'mts_budget', ordinal: 0, text: '本期预算是120万元', speakerId: 'speaker-1', wordStartOrdinal: 0, wordEndOrdinal: 0, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '0', sourceEndPts: '2000', timeBase: { numerator: 1, denominator: 1000 } },
        { id: 'mts_delivery', ordinal: 1, text: '下周开始交付', speakerId: null, wordStartOrdinal: 1, wordEndOrdinal: 1, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '2000', sourceEndPts: '4000', timeBase: { numerator: 1, denominator: 1000 } },
      ],
    };
  },
};

const listen = (server) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)); });
async function executeOne(deps, registry, type, workerId, expected = 'succeeded') {
  const claimed = await claimJob(deps, { workerId, leaseSeconds: 600, types: [type] });
  assert.ok(claimed, `${type} Job 未找到`);
  const outcome = await executeJob(deps, registry, { workerId, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed);
  assert.equal(outcome, expected);
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
  await createInternalUser(auth, { email, password, name: 'N02 转写验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;
  const probeRegistry = createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }) });
  const transcriptRegistry = createDefaultRegistry({ speechRecognitionAdapter: adapter });

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email); await page.getByLabel('密码').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`);
  await page.getByLabel('工作区名称').fill(`N02 转写 ${runId.slice(0, 8)}`); await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库' }).getAttribute('href');
  workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1]; assert.ok(workspaceId);
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click(); await page.getByLabel('选择文件').setInputFiles(mediaPath); await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 }); await page.getByRole('button', { name: '完成' }).click();
  await executeOne(deps, probeRegistry, MEDIA_PROBE_JOB_TYPE, 'n02-05-browser-probe');
  const videoName = mediaPath.split(/[\\/]/).pop();
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  const transcriptRegion = page.getByRole('region', { name: '源媒体转写' });
  await transcriptRegion.getByText('等待识别', { exact: true }).waitFor();
  await transcriptRegion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'transcript-queued-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '关闭' }).click();

  const transcriptJob = await executeOne(deps, transcriptRegistry, MEDIA_TRANSCRIPT_JOB_TYPE, 'n02-05-browser-asr');
  await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '切换浅深色' }).click(); await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.getByRole('button', { name: `查看素材 ${videoName}` }).click(); await transcriptRegion.getByText('机器识别 · 待核对', { exact: true }).waitFor();
  assert.ok((await transcriptRegion.textContent()).includes('说话人未知'));
  await transcriptRegion.getByRole('button', { name: '本期预算是120万元' }).click(); await transcriptRegion.getByLabel('校正转写文本').fill('本期预算是128万元'); await transcriptRegion.getByRole('button', { name: '保存校正' }).click();
  await transcriptRegion.getByText('版本 2', { exact: true }).waitFor(); await transcriptRegion.getByRole('button', { name: '本期预算是128万元' }).waitFor();
  await transcriptRegion.scrollIntoViewIfNeeded();
  await page.screenshot({ path: resolve(evidenceDir, 'transcript-corrected-dark-1440.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth })); assert.equal(metrics.documentWidth, metrics.viewport);
  await transcriptRegion.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidenceDir, 'transcript-corrected-dark-390.png'), fullPage: true });

  await failMediaTranscript(deps, { workspaceId, jobInput: transcriptJob.input, message: 'ASR 服务暂时不可用，等待管理员处理。' });
  await page.getByRole('button', { name: '关闭' }).click(); await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: `查看素材 ${videoName}` }).click();
  await transcriptRegion.getByText('等待处理', { exact: true }).waitFor(); assert.ok((await transcriptRegion.textContent()).includes('本期预算是128万元'));
  assert.equal(await page.locator('video').count(), 1);
  await transcriptRegion.scrollIntoViewIfNeeded(); await page.screenshot({ path: resolve(evidenceDir, 'transcript-failed-retained-dark-390.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  const summary = (await db.pool.query(`select r.status,r.current_version,count(v.id)::int version_count from media_transcript_runs r left join media_transcript_versions v on v.run_id=r.id where r.workspace_id=$1 group by r.status,r.current_version`, [workspaceId])).rows[0];
  assert.deepEqual(summary, { status: 'FAILED', current_version: 2, version_count: 2 });
  console.log(JSON.stringify({ ok: true, workspaceId, mediaPath, anonymousSpeaker: true, correctedOnlySelectedSegment: true, sourcePlaybackRetainedOnFailure: true, summary, screenshots: ['transcript-queued-light-1440.png', 'transcript-corrected-dark-1440.png', 'transcript-corrected-dark-390.png', 'transcript-failed-retained-dark-390.png'], pageErrors }, null, 2));
} finally {
  await browser?.close(); await app?.close(); if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]); await db.pool.query('delete from "user" where email=$1', [email]); await db.close(); await rm(storageRoot, { recursive: true, force: true });
}
