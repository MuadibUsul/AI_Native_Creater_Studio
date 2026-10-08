/* global AbortSignal, document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../../packages/auth/dist/index.js';
import {
  adminRoleScopes, assets, assetVersions,
  channels, channelStyleVersions, createDb, projects,
  resolveTestDatabaseUrl, runMigrations, supportAccessGrants, workspaces,
} from '../../packages/db/dist/index.js';
import { createClient } from '../../packages/sdk/dist/index.js';
import { buildServer } from '../../apps/api/dist/server.js';
import { enrollTestOpsTotp, provisionTestOpsPrincipal, testOpsDeps, testTotpCode } from '../../apps/api/dist/test-helpers/ops-auth.js';

// Exact guard for this local script; CI integration tests use resolveTestDatabaseUrl alone.
const databaseUrl = resolveTestDatabaseUrl();
assert.equal(decodeURIComponent(new URL(databaseUrl).pathname), '/ancs_quiet_frame_test_261007');
assert.equal(process.env.DATABASE_URL, undefined);
const handle = createDb(databaseUrl);
const runId = randomUUID();
const evidenceDir = resolve('.artifacts/n15-03-ops-ui');
const apiPort = 4607;
const webPort = 4707;
const apiBase = `http://127.0.0.1:${apiPort}`;
const webBase = `http://127.0.0.1:${webPort}`;
const password = 'n15-ops-browser-test-password'; // secrets:check-ignore: test-only dummy
const workspaceA = `ws_${randomUUID()}`;
const workspaceB = `ws_${randomUUID()}`;
const ticketA = `ticket-${randomUUID()}`;
const ticketB = `ticket-${randomUUID()}`;
const titleCanary = 'private-project-title-browser-canary'; // secrets:check-ignore: test-only leak sentinel
const keyCanary = 'private-storage-key-browser-canary'; // secrets:check-ignore: test-only leak sentinel
const users = [];
const webLogs = [];
let api;
let web;
let browser;
let zoomContext;
let zoomProfile;

async function waitForWeb() {
  for (let attempt = 0; attempt < 90; attempt += 1) {
    if (web?.exitCode !== null) throw new Error(`Web exited: ${webLogs.slice(-8).join('')}`);
    try {
      const response = await fetch(`${webBase}/admin`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch { /* Next is starting. */ }
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`Web did not start: ${webLogs.slice(-8).join('')}`);
}

async function createOperator(auth, tag, role, scopes) {
  const email = `n15-ops-${tag}-${runId}@test.local`;
  const created = await createInternalUser(auth, { email, password, name: `N15 browser ${tag}` });
  users.push({ id: created.id, email });
  await provisionTestOpsPrincipal(handle.db, created.id);
  const principalResult = await handle.pool.query('select id from admin_principals where user_id = $1 limit 1', [created.id]);
  const principal = principalResult.rows[0];
  assert.ok(principal);
  const grantResult = await handle.pool.query('select id from admin_role_grants where principal_id = $1 limit 1', [principal.id]);
  const grant = grantResult.rows[0];
  assert.ok(grant);
  await handle.pool.query('update admin_role_grants set role = $1 where id = $2', [role, grant.id]);
  await handle.pool.query('delete from admin_role_scopes where role_grant_id = $1', [grant.id]);
  await handle.db.insert(adminRoleScopes).values(scopes.map((scope) => ({ id: `opsc_${randomUUID()}`, roleGrantId: grant.id, ...scope })));
  return { id: created.id, email, principalId: principal.id };
}

async function browserLogin(context, operator) {
  const challenge = await context.request.post(`${apiBase}/api/v1/auth/sign-in`, { data: { email: operator.email, password } });
  assert.equal(challenge.status(), 200, await challenge.text());
  assert.equal((await challenge.json()).twoFactorRequired, true);
  const verified = await context.request.post(`${apiBase}/api/v1/auth/verify-totp`, { data: { code: testTotpCode(operator.totpUri) } });
  assert.equal(verified.status(), 200, await verified.text());
  const page = await context.newPage();
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({ url: `${apiBase}${url.pathname}${url.search}` });
    await route.fulfill({ response });
  });
  await page.goto(`${webBase}/admin`);
  try {
    await page.getByText('运营环境：TEST').waitFor({ timeout: 10_000 });
  } catch (error) {
    throw new Error(`Ops session did not render: ${JSON.stringify({ cookies: (await context.cookies()).map(({ name, domain, path }) => ({ name, domain, path })), body: (await page.locator('body').innerText()).slice(0, 1500) })}`, { cause: error });
  }
  return page;
}

async function layout(page) {
  return page.evaluate(() => ({
    cssWidth: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    mainOverflow: document.querySelector('main') ? document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth : null,
    dark: document.body.classList.contains('theme-dark'),
    focusVisible: document.activeElement?.matches(':focus-visible') ?? false,
  }));
}

try {
  await mkdir(evidenceDir, { recursive: true });
  await handle.pool.query('select 1');
  await runMigrations(handle);
  const auth = createAuth({ db: handle.db, secret: 'n15-ops-browser-auth-secret-0123456789', baseUrl: apiBase }); // secrets:check-ignore: test-only dummy
  await handle.db.insert(workspaces).values([
    { id: workspaceA, name: `N15 browser A ${runId}` },
    { id: workspaceB, name: `N15 browser B ${runId}` },
  ]);
  const channelA = `chn_${randomUUID()}`;
  const channelB = `chn_${randomUUID()}`;
  const styleA = `chs_${randomUUID()}`;
  const styleB = `chs_${randomUUID()}`;
  await handle.db.insert(channels).values([
    { id: channelA, workspaceId: workspaceA, name: 'A', language: 'zh-CN' },
    { id: channelB, workspaceId: workspaceB, name: 'B', language: 'zh-CN' },
  ]);
  await handle.db.insert(channelStyleVersions).values([
    { id: styleA, workspaceId: workspaceA, channelId: channelA, version: 1, defaults: {} },
    { id: styleB, workspaceId: workspaceB, channelId: channelB, version: 1, defaults: {} },
  ]);
  const projectA = `prj_${randomUUID()}`;
  const projectB = `prj_${randomUUID()}`;
  await handle.db.insert(projects).values([
    { id: projectA, workspaceId: workspaceA, channelId: channelA, channelStyleVersionId: styleA, title: titleCanary, status: 'DRAFT', aspectRatio: '16:9', resolution: '1920x1080' },
    { id: projectB, workspaceId: workspaceB, channelId: channelB, channelStyleVersionId: styleB, title: titleCanary, status: 'DRAFT', aspectRatio: '16:9', resolution: '1920x1080' },
  ]);
  const license = { type: 'USER_OWNED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: null, confirmedBy: null, confirmedAt: null };
  const assetA = `ast_${randomUUID()}`;
  const assetB = `ast_${randomUUID()}`;
  const versionA = `av_${randomUUID()}`;
  const versionB = `av_${randomUUID()}`;
  await handle.db.insert(assets).values([
    { id: assetA, workspaceId: workspaceA, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license, metadata: { filename: keyCanary }, currentVersionId: versionA },
    { id: assetB, workspaceId: workspaceB, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license, metadata: { filename: keyCanary }, currentVersionId: versionB },
  ]);
  await handle.db.insert(assetVersions).values([
    { id: versionA, assetId: assetA, workspaceId: workspaceA, versionNumber: 1, storageKey: `workspaces/${workspaceA}/${keyCanary}`, mimeType: 'video/mp4', sizeBytes: 1048576, checksumSha256: 'a'.repeat(64), status: 'READY', metadata: { filename: keyCanary } },
    { id: versionB, assetId: assetB, workspaceId: workspaceB, versionNumber: 1, storageKey: `workspaces/${workspaceB}/${keyCanary}`, mimeType: 'video/mp4', sizeBytes: 2097152, checksumSha256: 'b'.repeat(64), status: 'READY', metadata: { filename: keyCanary } },
  ]);

  const now = Date.now();
  const operator = await createOperator(auth, 'operator', 'PRODUCTION_OPERATOR', [{ scopeKind: 'WORKSPACE', workspaceId: workspaceA }]);
  const support = await createOperator(auth, 'support', 'SUPPORT_L2', [{ scopeKind: 'WORKSPACE', workspaceId: workspaceA, ticketId: ticketA, startsAt: new Date(now - 60_000), expiresAt: new Date(now + 3_600_000) }]);
  const grantId = `sag_${randomUUID()}`;
  await handle.db.insert(supportAccessGrants).values({
    id: grantId, workspaceId: workspaceA, beneficiaryPrincipalId: support.principalId,
    ticketId: ticketA, scope: 'SUMMARY_READ', requestedByUserId: operator.id,
    purpose: 'N15 browser scoped support check', status: 'ACTIVE', expiresAt: new Date(now + 3_600_000),
  });

  api = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, admin: testOpsDeps(handle.db) });
  await api.listen({ port: apiPort, host: '127.0.0.1' });
  const enrollmentClient = () => createClient({ baseUrl: apiBase, clientType: 'web', clientVersion: '0.1.0' });
  operator.totpUri = await enrollTestOpsTotp(enrollmentClient(), operator.email, password);
  support.totpUri = await enrollTestOpsTotp(enrollmentClient(), support.email, password);

  web = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', String(webPort)], {
    cwd: resolve('apps/web'), env: { ...process.env, NODE_ENV: 'production', ANCS_API_INTERNAL_URL: apiBase }, windowsHide: true,
  });
  web.stdout.on('data', (chunk) => webLogs.push(String(chunk)));
  web.stderr.on('data', (chunk) => webLogs.push(String(chunk)));
  await waitForWeb();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  const operatorContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const operatorPage = await browserLogin(operatorContext, operator);
  await operatorPage.getByLabel('工作区 ID').fill(workspaceA);
  await operatorPage.getByRole('button', { name: '查询工作区' }).click();
  await operatorPage.getByText(projectA).waitFor();
  assert.ok((await operatorPage.getByTestId('admin-storage').innerText()).includes('1.0 MiB'));
  assert.ok(!(await operatorPage.locator('body').innerText()).includes(titleCanary));
  assert.ok(!(await operatorPage.locator('body').innerText()).includes(keyCanary));
  assert.ok(!(await operatorPage.locator('body').innerText()).includes(projectB));
  const operatorLight = await layout(operatorPage);
  assert.equal(operatorLight.dark, false);
  assert.ok(operatorLight.documentWidth <= operatorLight.cssWidth + 1);
  await operatorPage.screenshot({ path: resolve(evidenceDir, 'operator-light-1440.png'), fullPage: true });

  await operatorPage.getByLabel('工作区 ID').fill(workspaceB);
  await operatorPage.getByRole('button', { name: '查询工作区' }).click();
  await operatorPage.getByText('当前范围无权查看').first().waitFor();
  assert.ok(!(await operatorPage.locator('body').innerText()).includes(projectA));
  assert.ok(!(await operatorPage.locator('body').innerText()).includes(projectB));
  await operatorPage.screenshot({ path: resolve(evidenceDir, 'operator-denied-b.png'), fullPage: true });
  await operatorPage.getByLabel('工作区 ID').fill(workspaceA);
  await operatorPage.getByRole('button', { name: '查询工作区' }).click();
  await operatorPage.getByText(projectA).waitFor();
  await operatorPage.getByRole('button', { name: '切换浅深色' }).click();
  await operatorPage.setViewportSize({ width: 1280, height: 800 });
  const operatorDark = await layout(operatorPage);
  assert.equal(operatorDark.dark, true);
  assert.ok(operatorDark.documentWidth <= operatorDark.cssWidth + 1);
  await operatorPage.screenshot({ path: resolve(evidenceDir, 'operator-dark-1280.png'), fullPage: true });
  await operatorPage.setViewportSize({ width: 390, height: 844 });
  const narrow = await layout(operatorPage);
  assert.ok(narrow.documentWidth <= narrow.cssWidth + 1);
  await operatorPage.screenshot({ path: resolve(evidenceDir, 'operator-narrow-390.png'), fullPage: true });

  const supportContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const supportPage = await browserLogin(supportContext, support);
  assert.equal(await supportPage.getByRole('heading', { name: '工作区诊断' }).count(), 0);
  await supportPage.getByLabel('工作区 ID').fill(workspaceA);
  await supportPage.getByLabel('工单 ID').fill(ticketA);
  await supportPage.getByRole('button', { name: '查询授权' }).click();
  await supportPage.getByText(grantId).waitFor();
  assert.equal(await supportPage.getByTestId('support-view').count(), 0);
  await supportPage.screenshot({ path: resolve(evidenceDir, 'support-grants-1440.png'), fullPage: true });
  await supportPage.getByRole('button', { name: '确认并打开支持摘要' }).click();
  await supportPage.getByTestId('support-view').waitFor();
  assert.ok((await supportPage.getByTestId('support-view').innerText()).includes('本次访问已留痕'));
  await supportPage.screenshot({ path: resolve(evidenceDir, 'support-summary-1440.png'), fullPage: true });
  const auditRows = await handle.pool.query(`select id from audit_log where workspace_id = $1 and action = 'support.view' and details->>'grantId' = $2`, [workspaceA, grantId]);
  const outboxRows = await handle.pool.query(`select id from outbox_events where workspace_id = $1 and type = 'support.viewed' and payload->>'grantId' = $2`, [workspaceA, grantId]);
  assert.equal(auditRows.rowCount, 1);
  assert.equal(outboxRows.rowCount, 1);
  await supportPage.getByLabel('工单 ID').fill(ticketB);
  await supportPage.getByRole('button', { name: '查询授权' }).click();
  await supportPage.getByText('当前范围无权查看').waitFor();
  assert.equal(await supportPage.getByTestId('support-view').count(), 0);
  await supportPage.screenshot({ path: resolve(evidenceDir, 'support-denied-ticket.png'), fullPage: true });

  zoomProfile = await mkdtemp(resolve(evidenceDir, 'chrome-zoom-'));
  assert.ok(zoomProfile.startsWith(`${evidenceDir}${sep}`));
  await mkdir(resolve(zoomProfile, 'Default'), { recursive: true });
  await writeFile(resolve(zoomProfile, 'Default/Preferences'), JSON.stringify({ partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } } }));
  zoomContext = await chromium.launchPersistentContext(zoomProfile, { channel: 'chrome', headless: true, viewport: null, args: ['--window-size=1440,900'], reducedMotion: 'reduce' });
  const zoomPage = await browserLogin(zoomContext, operator);
  await zoomPage.getByLabel('工作区 ID').fill(workspaceA);
  await zoomPage.getByRole('button', { name: '查询工作区' }).click();
  await zoomPage.getByText(projectA).waitFor();
  const zoom = await layout(zoomPage);
  assert.ok(zoom.cssWidth >= 690 && zoom.cssWidth <= 750, `Unexpected native 200% width: ${zoom.cssWidth}`);
  assert.ok(zoom.documentWidth <= zoom.cssWidth + 1);
  await zoomPage.screenshot({ path: resolve(evidenceDir, 'operator-native-200.png'), fullPage: true });

  const result = { operatorLight, operatorDark, narrow, zoom, supportAuditRows: auditRows.rowCount, supportOutboxRows: outboxRows.rowCount, screenshots: ['operator-light-1440.png', 'operator-denied-b.png', 'operator-dark-1280.png', 'operator-narrow-390.png', 'support-grants-1440.png', 'support-summary-1440.png', 'support-denied-ticket.png', 'operator-native-200.png'] };
  await writeFile(resolve(evidenceDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await zoomContext?.close();
  await browser?.close();
  web?.kill();
  await api?.close();
  await handle.pool.query('delete from workspaces where id = any($1::text[])', [[workspaceA, workspaceB]]);
  if (users.length > 0) await handle.pool.query('delete from "user" where id = any($1::text[])', [users.map((entry) => entry.id)]);
  await handle.close();
  if (zoomProfile) await rm(zoomProfile, { recursive: true, force: true });
}
