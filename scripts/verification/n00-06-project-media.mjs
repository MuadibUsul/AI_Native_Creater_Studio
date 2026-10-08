#!/usr/bin/env node
// N00-06: real signed upload and playback inside a project, with scoped tenant cleanup.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { createStorageDeps } from '../../apps/api/dist/plugins/storage.js';
import { MockLlmAdapter } from '../../packages/providers/mock-llm/dist/index.js';
import { LocalObjectStorage } from '../../packages/providers/storage-local/dist/index.js';

const databaseUrl = resolveTestDatabaseUrl();
assert.equal(decodeURIComponent(new URL(databaseUrl).pathname), '/ancs_quiet_frame_test_261007', 'Use only the named isolated test database');
assert.equal(process.env.DATABASE_URL, undefined, 'DATABASE_URL must be unset for this browser test');

const manifest = JSON.parse(await readFile('packages/testing/fixtures/media-v04/manifest.json', 'utf8'));
const fixture = manifest.assets.find((entry) => entry.id === 'synthetic-cfr-24000-1001');
assert.ok(fixture);
const fixturePath = process.argv.find((arg) => arg.startsWith('--video-path='))?.slice('--video-path='.length) ??
  `packages/testing/fixtures/media-v04/${fixture.file}`;
let videoBytes;
try { videoBytes = await readFile(fixturePath); } catch { throw new Error('video fixture path unavailable'); }
assert.equal(videoBytes.length, fixture.sizeBytes, 'video fixture size mismatch');
assert.equal(createHash('sha256').update(videoBytes).digest('hex'), fixture.sha256, 'video fixture hash mismatch');

const db = createDb(databaseUrl);
const runId = `n0006-${randomUUID()}`;
const emailA = `${runId}-a@test.local`;
const emailB = `${runId}-b@test.local`;
const passwordA = randomBytes(24).toString('base64url');
const passwordB = randomBytes(24).toString('base64url');
const workspaceNameA = `${runId} workspace A`;
const workspaceNameB = `${runId} workspace B`;
const projectTitle = `${runId} media project`;
const evidenceDir = resolve('.artifacts/n00-06-project-media');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
let apiPort = 0;
const proxy = createServer((incoming, outgoing) => {
  const upstream = httpRequest({
    hostname: '127.0.0.1', port: incoming.url?.startsWith('/api/v1/') ? apiPort : webPort,
    method: incoming.method, path: incoming.url, headers: incoming.headers,
  }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
    outgoing.end('Local test upstream unavailable');
  });
  incoming.pipe(upstream);
});
const listenProxy = () => new Promise((resolvePort, reject) => {
  proxy.once('error', reject);
  proxy.listen(0, '127.0.0.1', () => resolvePort(proxy.address().port));
});
const closeProxy = () => new Promise((done) => proxy.close(done));

let app;
let browser;
let pageA;
let failure = null;
const cleanupErrors = [];
const removeOwnedWorkspace = async (name) => {
  const rows = await db.pool.query('select id from workspaces where name = $1', [name]);
  assert.ok(rows.rowCount <= 1, 'test workspace name must be unique');
  if (rows.rowCount === 0) return 0;
  const deleted = await db.pool.query('delete from workspaces where id = $1 and name = $2', [rows.rows[0].id, name]);
  assert.equal(deleted.rowCount, 1);
  return 1;
};
const signInAndCreateWorkspace = async (baseUrl, email, password, workspaceName) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200);
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL(`${baseUrl}/`, { timeout: 20_000 });
  await page.getByLabel('工作区名称').fill(workspaceName);
  await page.getByRole('button', { name: '创建工作区' }).click();
  await page.getByRole('link', { name: '新建作品' }).waitFor({ timeout: 20_000 });
  assert.deepEqual(errors, []);
  const rows = await db.pool.query('select id from workspaces where name = $1', [workspaceName]);
  assert.equal(rows.rowCount, 1);
  return { context, page, workspaceId: rows.rows[0].id, errors };
};

try {
  await mkdir(evidenceDir, { recursive: true });
  await runMigrations(db);
  const port = await listenProxy();
  const baseUrl = `http://127.0.0.1:${port}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email: emailA, password: passwordA, name: 'N00-06 Tenant A' });
  await createInternalUser(auth, { email: emailB, password: passwordB, name: 'N00-06 Tenant B' });
  const storage = new LocalObjectStorage({
    rootDir: resolve(evidenceDir, `${runId}-storage`), publicBaseUrl: baseUrl,
    signingSecret: randomBytes(32).toString('hex'),
  });
  app = await buildServer({
    auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { llm: new MockLlmAdapter() }, storage: createStorageDeps(storage),
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  const tenantA = await signInAndCreateWorkspace(baseUrl, emailA, passwordA, workspaceNameA);
  pageA = tenantA.page;
  await pageA.getByRole('link', { name: '新建作品' }).click();
  await pageA.getByRole('tab', { name: '粘贴正文' }).click();
  await pageA.getByLabel('作品名称').fill(projectTitle);
  await pageA.getByLabel('原始内容').fill('N00-06 隔离项目媒体播放测试。此文字仅用于创建项目，视频为仓库合成 fixture。'.repeat(8));
  await pageA.getByRole('button', { name: '读取正文' }).click();
  await pageA.getByText('已解析的内容').waitFor({ timeout: 20_000 });
  await pageA.getByRole('button', { name: '生成脚本草稿' }).click();
  await pageA.waitForURL(/\/script$/, { timeout: 30_000 });
  const projects = await db.pool.query('select id from projects where workspace_id = $1 and title = $2', [tenantA.workspaceId, projectTitle]);
  assert.equal(projects.rowCount, 1);
  const projectId = projects.rows[0].id;
  await pageA.goto(`${baseUrl}/w/${tenantA.workspaceId}/p/${projectId}/assets`, { waitUntil: 'networkidle' });
  await pageA.getByRole('button', { name: '上传素材' }).click();
  await pageA.getByLabel('选择文件').setInputFiles({ name: fixture.file, mimeType: 'video/mp4', buffer: videoBytes });
  await pageA.getByRole('button', { name: '开始上传' }).click();
  const assetCard = pageA.getByRole('button', { name: `查看素材 ${fixture.file}` });
  await assetCard.waitFor({ timeout: 30_000 });
  const assets = await db.pool.query('select id, status from assets where workspace_id = $1 and project_id = $2', [tenantA.workspaceId, projectId]);
  assert.equal(assets.rowCount, 1);
  assert.equal(assets.rows[0].status, 'READY');
  await assetCard.click();
  const player = pageA.getByLabel(`预览视频 ${fixture.file}`);
  await player.waitFor({ timeout: 15_000 });
  await player.evaluate((video) => video.play());
  await pageA.waitForFunction(() => {
    const video = globalThis.document.querySelector('video[aria-label^="预览视频"]');
    return video && video.currentTime > 0.5 && video.videoWidth === 320 && video.error === null;
  }, undefined, { timeout: 15_000 });
  const playback = await player.evaluate((video) => ({ currentTime: video.currentTime, duration: video.duration, width: video.videoWidth, height: video.videoHeight }));
  assert.ok(playback.currentTime > 0.5 && playback.width === 320 && playback.height === 180);
  await pageA.screenshot({ path: resolve(evidenceDir, `${runId}-project-playback.png`), fullPage: true });

  const tenantB = await signInAndCreateWorkspace(baseUrl, emailB, passwordB, workspaceNameB);
  const forbiddenAsset = await tenantB.context.request.get(`${baseUrl}/api/v1/workspaces/${tenantA.workspaceId}/assets/${assets.rows[0].id}/download-url`);
  assert.equal(forbiddenAsset.status(), 404, 'other tenant must not mint a signed URL');
  const forbiddenProject = await tenantB.context.request.get(`${baseUrl}/api/v1/projects/${projectId}`);
  assert.equal(forbiddenProject.status(), 404, 'other tenant must not read the project');
  const deletedA = await removeOwnedWorkspace(workspaceNameA);
  assert.equal(deletedA, 1);
  const remainingB = await db.pool.query('select count(*)::integer as count from workspaces where id = $1 and name = $2', [tenantB.workspaceId, workspaceNameB]);
  assert.equal(remainingB.rows[0].count, 1, 'scoped cleanup must preserve the other tenant');
  assert.deepEqual(tenantA.errors, []);
  assert.deepEqual(tenantB.errors, []);
  console.log(JSON.stringify({ result: 'PASS', fixtureSha256: fixture.sha256, playback, otherTenantDownloadStatus: forbiddenAsset.status(), otherTenantProjectStatus: forbiddenProject.status(), deletedOwnedWorkspaceCount: deletedA, otherTenantPreserved: true }));
} catch (error) {
  failure = error;
  if (pageA) {
    await mkdir(evidenceDir, { recursive: true });
    await pageA.screenshot({ path: resolve(evidenceDir, `${runId}-failure.png`), fullPage: true }).catch(() => undefined);
  }
} finally {
  await browser?.close().catch((error) => cleanupErrors.push(error));
  await app?.close().catch((error) => cleanupErrors.push(error));
  if (proxy.listening) await closeProxy().catch((error) => cleanupErrors.push(error));
  for (const name of [workspaceNameA, workspaceNameB]) {
    await removeOwnedWorkspace(name).catch((error) => cleanupErrors.push(error));
  }
  for (const email of [emailA, emailB]) {
    await db.pool.query('delete from "user" where email = $1', [email]).catch((error) => cleanupErrors.push(error));
  }
  await db.close().catch((error) => cleanupErrors.push(error));
}
if (failure) throw failure;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Scoped test cleanup failed');
