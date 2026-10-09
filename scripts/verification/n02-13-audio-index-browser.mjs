#!/usr/bin/env node
/* global document, innerWidth */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { MEDIA_AUDIO_ANALYSIS_JOB_TYPE, MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION, MEDIA_PROBE_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION } from '../../packages/contracts/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { claimJob, getJob } from '../../packages/domain/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';
import { createDefaultRegistry, createFfmpegSourceMediaProbe, executeJob } from '../../apps/worker/dist/index.js';

const db = createDb(resolveTestDatabaseUrl());
const webPort = Number(process.env.ANCS_N02_WEB_PORT ?? 4200);
const mediaPath = resolve(process.env.ANCS_N02_MEDIA_FILE ?? 'E:/Pictures/sd1762005491_2.MP4');
const evidenceDir = resolve('.artifacts/v04/N02-13/browser');
const runId = randomUUID();
const email = `n02-13-${runId}@test.local`;
const password = randomBytes(24).toString('base64url');
const storageRoot = resolve(evidenceDir, `storage-${runId}`);
let workspaceId;
let app;
let browser;
let proxy;

const visualAdapter = {
  kind: 'n02-13-scripted-browser-seam',
  async analyze() {
    const timeBase = { numerator: 1, denominator: 1000 };
    const frame = (pts) => ({ pts, timeBase, frameRef: `browser-frame:${pts}` });
    const keyframe = (pts, state, confidencePermille) => ({ pts, box: [0.12, 0.08, 0.3, 0.7], state, confidencePermille });
    return {
      schemaVersion: '1.0', processorVersion: MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION, adapter: 'scripted-browser-only', modelVersion: 'fixture-vision-v1', sampledFrameCount: 12, durationMs: 3000,
      objectTracks: [{ id: 'phone-1', label: '手机', confidencePermille: 890, lifecycle: 'CONTINUOUS', keyframes: [keyframe('200', 'VISIBLE', 900), keyframe('800', 'VISIBLE', 880)], evidenceFrames: [frame('200')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      personTracks: [{ id: 'person-1', label: 'person', identityState: 'UNKNOWN', confidencePermille: 760, lifecycle: 'OCCLUDED', keyframes: [keyframe('100', 'VISIBLE', 830), keyframe('850', 'UNCERTAIN', 420)], evidenceFrames: [frame('100'), frame('850')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      actionEvents: [{ id: 'raise-phone-1', label: '举起手机', subjectTrackId: 'person-1', confidencePermille: 840, evidenceFrames: [frame('300')], sourceStartPts: '200', sourceEndPts: '800', timeBase }, { id: 'raise-hand-interference', label: '举手（非手机）', subjectTrackId: 'person-1', confidencePermille: 610, evidenceFrames: [frame('1300')], sourceStartPts: '1200', sourceEndPts: '1800', timeBase }],
      visualEvents: [{ id: 'phone-visible', label: '手机进入画面', subjectTrackId: 'phone-1', confidencePermille: 870, evidenceFrames: [frame('200')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
      motionIntensity: [{ id: 'motion-1', valuePermille: 670, method: 'fixture-optical-flow', evidenceFrames: [frame('500')], sourceStartPts: '100', sourceEndPts: '900', timeBase }],
    };
  },
};

const audioAdapter = {
  kind: 'n02-13-scripted-browser-seam',
  async analyze() {
    // The selected real browser fixture exposes audio as stream 0 at 44.1 kHz.
    const timeBase = { numerator: 1, denominator: 44100 };
    const window = (start, end) => ({ sourceStartPts: start, sourceEndPts: end, timeBase, windowRef: `browser-audio:${start}-${end}` });
    return {
      schemaVersion: '1.0', processorVersion: MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION, adapter: 'scripted-browser-only', modelVersion: 'fixture-audio-v1', durationMs: 3000,
      audioEvents: [
        { id: 'applause-1', eventType: 'APPLAUSE', label: '拍手', channel: null, confidencePermille: 880, evidenceWindows: [window('11025', '33075')], sourceStartPts: '11025', sourceEndPts: '33075', timeBase, streamIndex: 0 },
        { id: 'music-1', eventType: 'MUSIC', label: '音乐', channel: null, confidencePermille: 820, evidenceWindows: [window('44100', '132300')], sourceStartPts: '44100', sourceEndPts: '132300', timeBase, streamIndex: 0 },
      ],
      musicBeats: [
        { id: 'beat-1', musicSegmentId: 'music-1', beatOrdinal: 0, downbeat: true, tempoBpm: 120, channel: null, confidencePermille: 800, evidenceWindows: [window('44100', '45100')], sourceStartPts: '44100', sourceEndPts: '45100', timeBase, streamIndex: 0 },
        { id: 'beat-2', musicSegmentId: 'music-1', beatOrdinal: 1, downbeat: false, tempoBpm: 96, channel: null, confidencePermille: 760, evidenceWindows: [window('88200', '89200')], sourceStartPts: '88200', sourceEndPts: '89200', timeBase, streamIndex: 0 },
      ],
    };
  },
};

const listen = (server) => new Promise((resolveListen, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolveListen(server.address().port)); });
async function executeOne(deps, registry, type, workerId) {
  await db.pool.query("update jobs set priority = 1000 where workspace_id = $1 and type = $2 and status = 'QUEUED'", [workspaceId, type]);
  const claimed = await claimJob(deps, { workerId, leaseSeconds: 600, types: [type] });
  assert.ok(claimed, `${type} Job 未找到`);
  assert.equal(claimed.workspaceId, workspaceId, `${type} 认领了其他测试工作区的遗留 Job`);
  const outcome = await executeJob(deps, registry, { workerId, leaseSeconds: 600, heartbeatIntervalMs: 30_000 }, claimed);
  const completed = await getJob(deps, { workspaceId: claimed.workspaceId, jobId: claimed.id });
  assert.equal(outcome, 'succeeded', `${type} 失败：${completed.error?.message ?? '未知错误'}`);
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
  await createInternalUser(auth, { email, password, name: 'N02-13 音频索引验收' });
  const storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  const deps = { db: db.db, storage };
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 }); apiPort = app.server.address().port;

  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await context.newPage();
  const pageErrors = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email); await page.getByLabel('密码').fill(password); await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`); await page.getByLabel('工作区名称').fill(`N02 音频索引 ${runId.slice(0, 8)}`); await page.getByRole('button', { name: '创建工作区' }).click();
  const workspaceLink = await page.getByRole('link', { name: '素材库', exact: true }).getAttribute('href'); workspaceId = workspaceLink?.match(/\/w\/(ws_[^/]+)/)?.[1]; assert.ok(workspaceId);
  await page.goto(`${baseUrl}/w/${workspaceId}/assets`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '上传素材' }).click(); await page.getByLabel('选择文件').setInputFiles(mediaPath); await page.getByRole('button', { name: '开始上传' }).click();
  await page.getByText('上传完成 · 正在分析媒体').waitFor({ timeout: 180_000 }); await page.getByRole('button', { name: '完成' }).click();
  await executeOne(deps, createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 5 * 60 * 1000 }) }), MEDIA_PROBE_JOB_TYPE, 'n02-13-probe');
  await executeOne(deps, createDefaultRegistry({ mediaVisualAnalysisAdapter: visualAdapter }), MEDIA_VISUAL_ANALYSIS_JOB_TYPE, 'n02-13-vision');
  await executeOne(deps, createDefaultRegistry({ mediaAudioAnalysisAdapter: audioAdapter }), MEDIA_AUDIO_ANALYSIS_JOB_TYPE, 'n02-13-audio');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByLabel('搜索素材片段').fill('拍手'); await page.getByRole('button', { name: '搜索片段' }).click();
  await page.getByText('拍手', { exact: true }).waitFor();
  assert.ok((await page.getByText('拍手', { exact: true }).locator('xpath=ancestor::article').textContent()).includes('机器推测'));
  await page.screenshot({ path: resolve(evidenceDir, 'applause-candidate-light-1440.png'), fullPage: true });
  await page.getByRole('button', { name: '播放片段' }).first().click();
  const videoName = mediaPath.split(/[\\/]/).pop(); const video = page.getByLabel(`预览视频 ${videoName}`); await video.waitFor();
  await page.waitForFunction(() => (document.querySelector('video')?.currentTime ?? 0) >= 0.24);
  const analysisSummary = page.getByText('渐进分析 · 可剪辑', { exact: true }); await analysisSummary.waitFor(); await analysisSummary.click();
  const analysis = analysisSummary.locator('xpath=ancestor::details'); assert.ok((await analysis.textContent()).includes('音频事件')); assert.ok((await analysis.textContent()).includes('已就绪'));
  await page.getByLabel('片段标签名称').fill('拍手（人工确认）'); await page.getByLabel('片段开始秒数').fill('0.25'); await page.getByLabel('片段结束秒数').fill('0.75'); await page.getByRole('button', { name: '添加标签' }).click();
  await page.getByText('拍手（人工确认）', { exact: true }).waitFor();
  await analysis.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: resolve(evidenceDir, 'audio-ready-and-correction-light-1440.png') });

  await page.getByRole('button', { name: '关闭' }).click(); await page.getByRole('button', { name: '切换浅深色' }).click(); await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.setViewportSize({ width: 390, height: 844 }); await page.getByLabel('搜索素材片段').fill('拍手（人工确认）'); await page.getByRole('button', { name: '搜索片段' }).click();
  await page.getByText('用户标记', { exact: true }).waitFor();
  const metrics = await page.evaluate(() => ({ viewport: innerWidth, documentWidth: document.documentElement.scrollWidth })); assert.equal(metrics.documentWidth, metrics.viewport);
  await page.screenshot({ path: resolve(evidenceDir, 'corrected-audio-candidate-dark-390.png'), fullPage: true });
  assert.deepEqual(pageErrors, []);
  console.log(JSON.stringify({ ok: true, workspaceId, mediaPath, scriptedDetectorSeam: true, applauseSourceRangePlayed: true, audiovisualCorrelationPersisted: true, varyingTempoPersisted: true, manualCorrectionSearchable: true, screenshots: ['applause-candidate-light-1440.png', 'audio-ready-and-correction-light-1440.png', 'corrected-audio-candidate-dark-390.png'], pageErrors }, null, 2));
} finally {
  await browser?.close(); await app?.close(); if (proxy?.listening) await new Promise((resolveClose) => proxy.close(resolveClose));
  if (workspaceId) await db.pool.query('delete from workspaces where id=$1', [workspaceId]); await db.pool.query('delete from "user" where email=$1', [email]); await db.close(); await rm(storageRoot, { recursive: true, force: true });
}
