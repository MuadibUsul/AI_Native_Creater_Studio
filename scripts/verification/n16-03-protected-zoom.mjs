/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';
import { DEFAULT_CHANNEL_STYLE } from '../../packages/contracts/dist/index.js';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4200';
const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? '.artifacts/n16-03-layout');
await mkdir(evidenceDir, { recursive: true });
const profile = await mkdtemp(resolve(evidenceDir, 'chrome-protected-'));
assert.ok(profile.startsWith(`${evidenceDir}${sep}`));
await mkdir(resolve(profile, 'Default'), { recursive: true });
await writeFile(resolve(profile, 'Default/Preferences'), JSON.stringify({
  partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } },
}));

const graph = JSON.parse(await readFile(resolve('packages/contracts/fixtures/scene-graph.sample.json'), 'utf8'));
const workspaceId = 'ws_zoom_fixture';
const projectId = graph.projectId;
const userId = 'usr_zoom_fixture';
const now = '2026-10-08T00:00:00.000Z';
const workspace = { id: workspaceId, name: '长期研究与跨市场创作工作区', privacyTier: 'STANDARD', createdAt: now, updatedAt: now, role: 'OWNER' };
const project = {
  id: projectId, workspaceId, channelId: 'chn_zoom_fixture',
  title: '2026 年跨市场观察：为什么国债利差变化会影响企业融资与家庭储蓄？Policy Brief Final Cut',
  sourceType: 'MANUAL_SCRIPT', status: 'STORYBOARDING', revision: graph.projectRevision,
  aspectRatio: '16:9', resolution: '1920x1080', fps: 30, targetDurationMs: graph.timeline.durationMs,
  createdAt: now, updatedAt: now,
};
const projectDetail = { ...project, channelSnapshot: { channelId: project.channelId, channelStyleVersionId: 'chsv_zoom_fixture', styleVersion: 1, defaults: DEFAULT_CHANNEL_STYLE } };
const routes = new Map([
  ['/api/v1/auth/session', { user: { id: userId, email: 'zoom-fixture@example.test', name: '缩放测试用户', emailVerified: true }, sessionId: 'ses_zoom_fixture', method: 'web_session', expiresAt: '2026-12-31T00:00:00.000Z' }],
  ['/api/v1/users/me/appearance', { userId, mode: 'system', updatedAt: null }],
  ['/api/v1/workspaces', { items: [workspace], nextCursor: null }],
  [`/api/v1/workspaces/${workspaceId}`, workspace],
  [`/api/v1/workspaces/${workspaceId}/projects`, { items: [project], nextCursor: null }],
  [`/api/v1/projects/${projectId}`, projectDetail],
  [`/api/v1/projects/${projectId}/graph`, graph],
  [`/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative`, null],
]);
const scenarios = [
  { name: 'workspace', path: '/', ready: '.project-card' },
  { name: 'studio', path: `/w/${workspaceId}/p/${projectId}/storyboard`, ready: '.scene-rail .scene-card' },
  { name: 'ops-denied', path: '/admin', ready: 'text=需要独立运营会话' },
];

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: true, viewport: null, args: ['--window-size=1440,900'],
  });
  const results = [];
  for (const scenario of scenarios) {
    const page = await context.newPage();
    const requests = [];
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.route('**/api/v1/**', async (request) => {
      const httpRequest = request.request();
      const url = new URL(httpRequest.url());
      requests.push(`${httpRequest.method()} ${url.pathname}`);
      assert.equal(httpRequest.method(), 'GET', 'Layout audit must not write through the API');
      if (scenario.name === 'ops-denied' && url.pathname.startsWith('/api/v1/admin/')) {
        await request.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No operator access' } }) });
        return;
      }
      if (url.pathname === '/api/v1/ops/session') {
        await request.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: { code: 'NOT_FOUND', message: 'No operator session' } }) });
        return;
      }
      const fixture = routes.get(url.pathname);
      assert.ok(routes.has(url.pathname), `Missing isolated API fixture for ${url.pathname}`);
      await request.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    });
    const response = await page.goto(`${baseUrl}${scenario.path}`, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, scenario.name);
    try {
      await page.locator(scenario.ready).first().waitFor({ state: 'visible', timeout: 10000 });
    } catch (error) {
      const body = (await page.locator('body').innerText()).slice(0, 1500);
      throw new Error(`${scenario.name} did not render ${scenario.ready}: ${JSON.stringify({ requests, pageErrors, body })}`, { cause: error });
    }
    const cdp = await context.newCDPSession(page);
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const layout = await page.evaluate(() => {
      const visible = (element) => {
        const css = getComputedStyle(element);
        if (element.closest('.sidebar:not(.mobile-open)') && window.innerWidth <= 760) return false;
        return element.getClientRects().length > 0 && css.visibility === 'visible' && css.display !== 'none';
      };
      const controls = [...document.querySelectorAll('button, input, select, textarea, a[href]')]
        .filter((element) => visible(element) && !element.classList.contains('skiplink'))
        .map((element) => { const box = element.getBoundingClientRect(); return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.tagName, left: box.left, right: box.right, inSceneRail: element.closest('.scene-rail') !== null }; });
      const sceneRail = document.querySelector('.scene-rail');
      const projectCardTitle = document.querySelector('.project-card h3');
      const projectIdentity = document.querySelector('.qf-project-identity');
      const projectTitle = projectIdentity?.querySelector('.title');
      const identityBox = projectIdentity?.getBoundingClientRect();
      const titleBox = projectTitle?.getBoundingClientRect();
      return {
        cssWidth: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        mainWidth: document.querySelector('main')?.clientWidth ?? null,
        mainOverflow: document.querySelector('main') ? document.querySelector('main').scrollWidth - document.querySelector('main').clientWidth : null,
        visibleControlCount: controls.length,
        outsideControls: controls.filter((item) => !item.inSceneRail && (item.left < -1 || item.right > window.innerWidth + 1)),
        sceneRail: sceneRail ? { scrollWidth: sceneRail.scrollWidth, clientWidth: sceneRail.clientWidth, overflowX: getComputedStyle(sceneRail).overflowX } : null,
        projectCardTitleOverflow: projectCardTitle ? projectCardTitle.scrollWidth - projectCardTitle.clientWidth : null,
        projectIdentity: projectIdentity && projectTitle && identityBox && titleBox ? {
          right: identityBox.right,
          titleRight: titleBox.right,
          titleOverflow: projectTitle.scrollWidth - projectTitle.clientWidth,
          textOverflow: getComputedStyle(projectTitle).textOverflow,
        } : null,
        projectCardCount: document.querySelectorAll('.project-card').length,
        sceneCardCount: document.querySelectorAll('.scene-rail .scene-card').length,
        opsDeniedVisible: document.body.textContent?.includes('需要独立运营会话') ?? false,
      };
    });
    let lastSceneReachable = null;
    if (scenario.name === 'studio') {
      const last = page.locator('.scene-rail .scene-card').last();
      await last.scrollIntoViewIfNeeded();
      lastSceneReachable = await last.evaluate((element) => {
        const rail = element.closest('.scene-rail');
        const cardBox = element.getBoundingClientRect();
        const railBox = rail?.getBoundingClientRect();
        return !!railBox && cardBox.left >= railBox.left - 1 && cardBox.right <= railBox.right + 1;
      });
    }
    const menu = page.getByRole('button', { name: '打开导航' });
    await menu.click();
    await page.locator('.sidebar.mobile-open').waitFor({ state: 'visible' });
    const openMobileNavFits = await page.locator('.sidebar.mobile-open').evaluate((element) => {
      const sidebar = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('a[href], button')].map((node) => node.getBoundingClientRect());
      return sidebar.left >= -1 && sidebar.right <= window.innerWidth + 1 && controls.every((box) => box.left >= -1 && box.right <= window.innerWidth + 1);
    });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: resolve(evidenceDir, `${scenario.name}-native-200.png`), fullPage: true });
    const result = { scenario: scenario.name, chromeZoom: metrics.cssVisualViewport.zoom, apiRequests: requests, lastSceneReachable, openMobileNavFits, ...layout };
    results.push(result);
    await page.close();
  }
  const failures = results.filter((item) => item.chromeZoom !== 2 || item.cssWidth < 700 || item.cssWidth > 740 || item.documentWidth > item.cssWidth + 1 || (item.mainOverflow ?? 0) > 1 || item.outsideControls.length > 0 || !item.openMobileNavFits || (item.scenario === 'workspace' && (item.projectCardCount !== 1 || (item.projectCardTitleOverflow ?? 0) > 1)) || (item.scenario === 'studio' && (item.sceneCardCount < 1 || item.sceneRail?.overflowX !== 'auto' || item.lastSceneReachable !== true || item.projectIdentity === null || item.projectIdentity.right > item.cssWidth + 1 || item.projectIdentity.titleRight > item.projectIdentity.right + 1 || item.projectIdentity.titleOverflow <= 0 || item.projectIdentity.textOverflow !== 'ellipsis')) || (item.scenario === 'ops-denied' && !item.opsDeniedVisible));
  await writeFile(resolve(evidenceDir, 'protected-native-200-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', physicalWindowWidth: 1440, cases: results.length, failures, results }, null, 2)}\n`);
  assert.equal(failures.length, 0);
} finally {
  if (context) await context.close();
  assert.ok(profile.startsWith(`${evidenceDir}${sep}`));
  await rm(profile, { recursive: true, force: true });
}
