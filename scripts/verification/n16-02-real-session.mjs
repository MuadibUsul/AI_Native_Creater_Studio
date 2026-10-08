/* global AbortSignal, document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createAuth, createInternalUser, createWorkspace, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../../packages/db/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';

// This script is intentionally gated by resolveTestDatabaseUrl: it may never write to ancs_dev.
const testDatabaseUrl = resolveTestDatabaseUrl();
const apiPort = 4501;
const webPort = 4300;
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const password = 'appearance-browser-test-pass-123'; // secrets:check-ignore: test-only dummy
const handle = createDb(testDatabaseUrl);
const runId = randomUUID();
const emailA = `appearance-browser-a-${runId}@test.local`;
const emailB = `appearance-browser-b-${runId}@test.local`;
const workspaceNameA = `Appearance browser test A ${runId}`;
const workspaceNameB = `Appearance browser test B ${runId}`;
let app;
let web;
let browser;
let userA;
let userB;
let workspaceA;
let workspaceB;
let failure = null;
let result = null;
const cleanupErrors = [];
const webLogs = [];

// This is a digest of current API snapshots, not the future ProjectDocument authority hash.
function observedProjectSnapshotHash(project, graph) {
  const ordered = (value) => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, entry]) => [key, ordered(entry)])) : value;
  return createHash('sha256').update(JSON.stringify(ordered({ project, graph })), 'utf8').digest('hex');
}

function generationInputs(project, graph) {
  return {
    format: { aspectRatio: project.aspectRatio, resolution: project.resolution, fps: project.fps, channelDefaults: project.channelSnapshot.defaults },
    scenes: graph.scenes.map((scene) => ({
      sceneId: scene.id,
      sceneRevision: scene.revision,
      durationMs: scene.durationMs,
      prompt: scene.visualIntent || String(scene.props?.prompt ?? ''),
      providerRequirement: scene.providerRequirement,
      props: scene.props,
    })),
  };
}

async function deleteCreatedWorkspace(record, expectedName) {
  const rows = await handle.pool.query('select id from workspaces where name = $1', [expectedName]);
  assert.ok(rows.rowCount <= 1, `Test workspace name ${expectedName} must be unique`);
  if (rows.rowCount === 0) return 0;
  if (record) assert.equal(rows.rows[0].id, record.id, 'Scoped workspace identity must match its creation result');
  const deleted = await handle.pool.query('delete from workspaces where id = $1 and name = $2', [rows.rows[0].id, expectedName]);
  assert.equal(deleted.rowCount, 1, `Created workspace ${expectedName} must be deleted exactly once`);
  return 1;
}

async function deleteCreatedUser(record, expectedEmail) {
  const rows = await handle.pool.query('select id from "user" where email = $1', [expectedEmail]);
  assert.ok(rows.rowCount <= 1, `Test user email ${expectedEmail} must be unique`);
  if (rows.rowCount === 0) return 0;
  if (record) assert.equal(rows.rows[0].id, record.id, 'Scoped user identity must match its creation result');
  const deleted = await handle.pool.query('delete from "user" where id = $1 and email = $2', [rows.rows[0].id, expectedEmail]);
  assert.equal(deleted.rowCount, 1, `Created user ${expectedEmail} must be deleted exactly once`);
  return 1;
}

async function waitForWeb() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (web?.exitCode !== null) throw new Error(`Web exited early: ${webLogs.slice(-15).join('')}`);
    try {
      const response = await fetch(`${webBase}/design-system`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Next is starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Web did not start: ${webLogs.slice(-15).join('')}`);
}

async function signIn(context, email) {
  const response = await context.request.post(`${apiBase}/api/v1/auth/sign-in`, { data: { email, password } });
  assert.equal(response.status(), 200, await response.text());
  assert.equal((await response.json()).user.email, email);
}

async function apiJson(context, method, path, data) {
  const response = await context.request.fetch(`${apiBase}/api/v1${path}`, { method, ...(data === undefined ? {} : { data }) });
  assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`);
  return response.json();
}

async function firstPaint(context, expectedMode, expectedDark, path = '/design-system') {
  const page = await context.newPage();
  await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, (route) => route.abort());
  const response = await page.goto(`${webBase}${path}`, { waitUntil: 'domcontentloaded' });
  assert.equal(response?.status(), 200);
  const actual = await page.evaluate(() => ({ mode: document.body.dataset.appearanceMode, dark: document.body.classList.contains('theme-dark') }));
  assert.deepEqual(actual, { mode: expectedMode, dark: expectedDark });
  await page.close();
  return actual;
}

async function playerElapsedSeconds(player) {
  // Remotion 4.0.532 renders this label from Timeline.useTimelinePosition().
  const label = await player.locator('div').filter({ hasText: /^\d+:\d{2} \/ \d+:\d{2}$/ }).last().textContent();
  const match = /^(\d+):(\d{2}) \/ /.exec(label?.trim() ?? '');
  assert.ok(match, `Remotion time label unavailable: ${label}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

async function waitForPlayerTime(player, minimum, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const elapsed = await playerElapsedSeconds(player);
    if (elapsed >= minimum) return elapsed;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Player did not reach ${minimum}s`);
}

try {
  await runMigrations(handle);
  const auth = createAuth({ db: handle.db, secret: 'appearance-browser-test-secret-0123456789abcdef', baseUrl: apiBase }); // secrets:check-ignore: test-only dummy
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: apiPort, host: '127.0.0.1' });
  userA = await createInternalUser(auth, { email: emailA, name: 'Appearance A', password });
  userB = await createInternalUser(auth, { email: emailB, name: 'Appearance B', password });
  workspaceA = await createWorkspace({ db: handle.db }, { userId: userA.id, name: workspaceNameA });
  workspaceB = await createWorkspace({ db: handle.db }, { userId: userB.id, name: workspaceNameB });
  const workspace = workspaceA;

  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(webPort)], {
    cwd: resolve('apps/web'), env: { ...process.env, NODE_ENV: 'production', ANCS_API_INTERNAL_URL: apiBase }, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stdout.on('data', (chunk) => webLogs.push(String(chunk)));
  web.stderr.on('data', (chunk) => webLogs.push(String(chunk)));
  await waitForWeb();
  browser = await chromium.launch({ headless: true });
  const first = await browser.newContext({ colorScheme: 'light' });
  const second = await browser.newContext({ colorScheme: 'dark' });
  const anotherUser = await browser.newContext({ colorScheme: 'light' });
  // The checked-in production build points its browser rewrite at the normal API.
  // Route browser API traffic to the in-process isolated API; SSR uses the runtime env above.
  for (const context of [first, second, anotherUser]) {
    await context.route('**/api/v1/**', async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `${apiBase}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
  }
  await signIn(first, userA.email);
  await signIn(second, userA.email);
  await signIn(anotherUser, userB.email);
  const channel = await apiJson(first, 'POST', `/workspaces/${workspace.id}/channels`, { name: 'Appearance test channel' });
  const project = await apiJson(first, 'POST', `/workspaces/${workspace.id}/projects`, { title: 'Appearance invariant project', channelId: channel.id });
  for (const [index, title] of ['Scene One', 'Scene Two'].entries()) {
    await apiJson(first, 'POST', `/projects/${project.id}/scenes`, {
      sceneType: 'CHAPTER_TITLE', semanticType: title, durationMs: 12000,
      visualIntent: index === 0 ? '单色数据视觉，保留素材原色' : '',
      props: { title, prompt: index === 1 ? '生成清晰的章节背景' : '' },
      providerRequirement: { modality: 'image', capabilities: ['still-image'], constraints: { style: 'editorial', seed: index + 17 } },
    });
  }
  const beforeProject = await apiJson(first, 'GET', `/projects/${project.id}`);
  const beforeGraph = await apiJson(first, 'GET', `/projects/${project.id}/graph`);
  const beforeLedger = await apiJson(first, 'GET', `/workspaces/${workspace.id}/billing/ledger`);
  const beforeHash = observedProjectSnapshotHash(beforeProject, beforeGraph);
  const beforeGenerationInputs = generationInputs(beforeProject, beforeGraph);
  assert.equal(beforeGenerationInputs.scenes.length, 2);
  assert(beforeGenerationInputs.scenes.every((scene) => scene.prompt.length > 0 && scene.providerRequirement?.constraints?.style === 'editorial'));

  const initial = [await firstPaint(first, 'system', false), await firstPaint(second, 'system', true)];
  const settings = await first.newPage();
  const hydrationErrors = [];
  settings.on('pageerror', (error) => { if (/hydration|did not match/i.test(error.message)) hydrationErrors.push(error.message); });
  assert.equal((await settings.goto(`${webBase}/w/${workspace.id}/settings`, { waitUntil: 'load' }))?.status(), 200);
  await settings.getByRole('button', { name: '外观与偏好' }).click();
  const accountSelect = settings.getByLabel('账号外观');
  await accountSelect.waitFor({ state: 'visible' });
  const save = settings.waitForResponse((response) => response.url().endsWith('/api/v1/users/me/appearance') && response.request().method() === 'PUT');
  await accountSelect.selectOption('dark');
  assert.equal((await save).status(), 200);
  await settings.waitForFunction(() => document.body.classList.contains('theme-dark'));
  const synchronized = [await firstPaint(first, 'dark', true), await firstPaint(second, 'dark', true)];
  const signInPage = await second.newPage();
  assert.equal((await signInPage.goto(`${webBase}/sign-in`, { waitUntil: 'load' }))?.status(), 200);
  await signInPage.waitForTimeout(200);
  assert.deepEqual(await signInPage.evaluate(() => ({ mode: document.body.dataset.appearanceMode, dark: document.body.classList.contains('theme-dark') })), { mode: 'dark', dark: true });
  await signInPage.close();

  await settings.getByLabel('设备外观').selectOption('light');
  await settings.waitForFunction(() => document.body.dataset.appearanceMode === 'light');
  const localOverride = [await firstPaint(first, 'light', false), await firstPaint(second, 'dark', true)];

  const director = await first.newPage();
  assert.equal((await director.goto(`${webBase}/w/${workspace.id}/p/${project.id}/storyboard`, { waitUntil: 'load' }))?.status(), 200);
  const sceneButtons = director.locator('.scene-rail .scene-card');
  await sceneButtons.nth(1).waitFor({ state: 'visible' });
  await sceneButtons.nth(1).click();
  assert.equal(await sceneButtons.nth(1).getAttribute('aria-pressed'), 'true');
  await director.getByRole('button', { name: '播放完整预览' }).click();
  const player = director.getByTestId('preview-player');
  await player.waitFor({ state: 'visible' });
  await player.evaluate((node) => { window.__appearancePlayerNode = node; });
  await player.hover();
  await player.locator('button[aria-label="Play video"]').click();
  const beforeSeconds = await waitForPlayerTime(player, 2);
  await director.getByRole('button', { name: '切换浅深色' }).click();
  assert.equal(await sceneButtons.nth(1).getAttribute('aria-pressed'), 'true');
  assert.equal(await player.evaluate((node) => node === window.__appearancePlayerNode), true);
  assert.equal(await director.getByRole('button', { name: '返回当前分镜' }).isVisible(), true);
  const afterSeconds = await playerElapsedSeconds(player);
  assert.ok(afterSeconds >= beforeSeconds, `Playback position reset across theme change: ${beforeSeconds}s → ${afterSeconds}s`);
  assert.equal(await player.locator('button[aria-label="Pause video"]').count(), 1);
  const continuedSeconds = await waitForPlayerTime(player, afterSeconds + 1, 4000);
  const afterProject = await apiJson(first, 'GET', `/projects/${project.id}`);
  const afterGraph = await apiJson(first, 'GET', `/projects/${project.id}/graph`);
  const afterLedger = await apiJson(first, 'GET', `/workspaces/${workspace.id}/billing/ledger`);
  assert.deepEqual(afterProject, beforeProject);
  assert.deepEqual(afterGraph, beforeGraph);
  assert.deepEqual(afterLedger, beforeLedger);
  assert.equal(observedProjectSnapshotHash(afterProject, afterGraph), beforeHash);
  assert.deepEqual(generationInputs(afterProject, afterGraph), beforeGenerationInputs);

  await anotherUser.addCookies([{ name: 'ancs-qf-appearance', value: `${userA.id}.dark`, url: webBase }]);
  const isolated = await firstPaint(anotherUser, 'system', false);
  const anonymous = await browser.newContext({ colorScheme: 'light' });
  await anonymous.addCookies([{ name: 'ancs-qf-appearance', value: `${userA.id}.dark`, url: webBase }]);
  const signedOut = await firstPaint(anonymous, 'system', false);
  await firstPaint(anonymous, 'system', false, '/sign-in');
  assert.deepEqual(hydrationErrors, []);
  result = { realAuthSessions: 3, realApi: apiBase, web: webBase, initial, synchronized, signInHydrationPreserved: true, localOverride, projectAndLedgerUnchanged: true, observedProjectSnapshotSha256: beforeHash, nonEmptyGenerationPromptCount: beforeGenerationInputs.scenes.length, generationInputsUnchanged: true, selectionAndPlayerPreserved: true, observablePlaybackSeconds: { before: beforeSeconds, after: afterSeconds, continued: continuedSeconds }, isolated, signedOut, hydrationErrors };
} catch (error) {
  failure = error;
} finally {
  await browser?.close().catch((error) => cleanupErrors.push(error));
  if (web && web.exitCode === null) web.kill();
  await app?.close().catch((error) => cleanupErrors.push(error));
  let deletedWorkspaceA = 0;
  let deletedWorkspaceB = 0;
  let otherTenantPreserved = false;
  let workspaceACleanupSafe = true;
  let workspaceBCleanupSafe = true;
  try {
    deletedWorkspaceA = await deleteCreatedWorkspace(workspaceA, workspaceNameA);
    const other = await handle.pool.query('select id from workspaces where name = $1', [workspaceNameB]);
    assert.ok(other.rowCount <= 1, 'Other test tenant name must be unique');
    if (workspaceB) {
      assert.equal(other.rowCount, 1, 'Deleting test tenant A must preserve test tenant B');
      assert.equal(other.rows[0].id, workspaceB.id, 'Other test tenant identity must be unchanged');
      otherTenantPreserved = true;
    }
  } catch (error) { workspaceACleanupSafe = false; cleanupErrors.push(error); }
  try { deletedWorkspaceB = await deleteCreatedWorkspace(workspaceB, workspaceNameB); } catch (error) { workspaceBCleanupSafe = false; cleanupErrors.push(error); }
  if (workspaceACleanupSafe) {
    try { await deleteCreatedUser(userA, emailA); } catch (error) { cleanupErrors.push(error); }
  }
  if (workspaceBCleanupSafe) {
    try { await deleteCreatedUser(userB, emailB); } catch (error) { cleanupErrors.push(error); }
  }
  if (result) result.cleanup = { deletedWorkspaceA, deletedWorkspaceB, otherTenantPreserved };
  await handle.close().catch((error) => cleanupErrors.push(error));
}
if (failure && cleanupErrors.length) throw new AggregateError([failure, ...cleanupErrors], 'Appearance browser run and scoped cleanup failed');
if (failure) throw failure;
if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Appearance browser scoped cleanup failed');
process.stdout.write(`${JSON.stringify({ result: 'PASS', ...result }, null, 2)}\n`);
