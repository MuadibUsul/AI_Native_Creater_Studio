/* global document, getComputedStyle */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const appOrigin = new URL(process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4200').origin;
const runId = process.env.ANCS_RUN_ID ?? '20261008-final-01';
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('ANCS_RUN_ID must be a short slug.');
const output = join(root, '.artifacts', 'n00-05-workspace-features', runId);
const fixturePath = join(root, 'scripts', 'fixtures', 'quiet-frame-visual.json');
const fixtureBytes = await readFile(fixturePath);
const fixture = JSON.parse(fixtureBytes.toString('utf8'));
if (fixture.label !== 'SYNTHETIC_VISUAL_ONLY') throw new Error('Expected synthetic visual fixture.');
await mkdir(output, { recursive: true });

const definition = (key, label, description, gate, platforms = ['WEB'], level = 'INTERNAL_VALIDATED') => ({
  key, label, description, platforms, minimumCapabilityLevel: level, releaseGate: gate, releaseReady: false,
  requestedEnabled: false, effectiveState: 'OFF', reason: 'WORKSPACE_DISABLED', updatedAt: null,
});
const originalFeatures = [
  definition('V04_MEDIA_EDITING', '素材剪辑', '纯素材导入、预览与非破坏性剪辑。', 'G0'),
  definition('V04_AI_COWATCH', 'AI 共看片室', '围绕画面、选区和时间范围进行对话与试改。', 'G1'),
  definition('V04_THREE_MODES', '三种制作模式', '纯素材、纯生成与混合制作的策略入口。', 'G2'),
  definition('V04_PRO_TOOLS', '专业工具', '多轨、关键帧、蒙版、调色、专业音频与多机位。', 'G3', ['WEB'], 'PRODUCTION_SUPPORTED'),
  definition('V04_EXTERNAL_DELIVERY', '外部交付', '对外发布、多端和商业交付能力。', 'G4', ['WEB', 'DESKTOP', 'MOBILE'], 'PRODUCTION_SUPPORTED'),
];
const cases = [
  { id: 'desktop-light', viewport: { width: 1440, height: 900 }, colorScheme: 'light' },
  { id: 'small-dark', viewport: { width: 1280, height: 800 }, colorScheme: 'dark' },
  { id: 'narrow-light', viewport: { width: 390, height: 844 }, colorScheme: 'light' },
];

const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const testCase of cases) {
    let features = JSON.parse(JSON.stringify(originalFeatures));
    const traffic = [];
    const errors = [];
    const context = await browser.newContext({ viewport: testCase.viewport, colorScheme: testCase.colorScheme, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === appOrigin && !url.pathname.startsWith('/api/')) return route.continue();
      if (!url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
      const key = `${request.method()} ${url.pathname}`;
      traffic.push(key);
      const headers = { 'access-control-allow-origin': appOrigin, 'access-control-allow-credentials': 'true', 'access-control-allow-methods': 'GET, PUT, OPTIONS', 'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type' };
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (key === 'GET /api/v1/workspaces/ws_visual_fixture/features') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ items: features }) });
      if (key === 'GET /api/v1/users/me/appearance') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ userId: 'usr_visual_fixture', mode: 'system', updatedAt: null }) });
      if (key === 'GET /api/v1/ops/session') return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify({ id: 'opses_visual_fixture', principalId: 'opspr_visual_fixture', environment: 'TEST', roles: [], createdAt: '2026-10-08T11:00:00.000Z', idleExpiresAt: '2026-10-08T13:00:00.000Z', absoluteExpiresAt: '2026-10-08T20:00:00.000Z', reauthenticatedAt: '2026-10-08T11:00:00.000Z', securityNotice: null }) });
      if (key === 'PUT /api/v1/workspaces/ws_visual_fixture/features/V04_MEDIA_EDITING') {
        const body = request.postDataJSON();
        if (body?.enabled !== true) return route.fulfill({ status: 422, headers, contentType: 'application/json', body: JSON.stringify({ error: { code: 'VALIDATION_FAILED', message: 'unexpected body', requestId: 'req_visual', details: {} } }) });
        features = features.map((item) => item.key === 'V04_MEDIA_EDITING' ? { ...item, requestedEnabled: true, effectiveState: 'READ_ONLY', reason: 'RELEASE_GATE_BLOCKED', updatedAt: '2026-10-08T12:00:00.000Z' } : item);
        return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(features[0]) });
      }
      if (request.method() === 'GET' && Object.hasOwn(fixture.responses, key)) return route.fulfill({ status: 200, headers, contentType: 'application/json', body: JSON.stringify(fixture.responses[key]) });
      return route.fulfill({ status: 501, headers, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_UNMATCHED', message: key, requestId: 'req_visual', details: {} } }) });
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(`page:${error.name}`));
    page.on('console', (message) => { if (message.type() === 'error') errors.push(`console:${message.text().slice(0, 240)}`); });
    await page.goto(`${appOrigin}/w/ws_visual_fixture/settings`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '新能力' }).click();
    await page.getByRole('heading', { name: 'v0.4 新能力' }).waitFor();
    await page.getByText('素材剪辑', { exact: true }).waitFor({ timeout: 10_000 }).catch(async (error) => {
      throw new Error(`Feature rows did not load. traffic=${traffic.join(',')} main=${await page.locator('main').last().innerText()}`, { cause: error });
    });
    await page.getByRole('button', { name: '选择此能力' }).first().click();
    await page.getByText('等待发布门', { exact: true }).waitFor();
    const metrics = await page.evaluate(() => {
      const html = document.documentElement;
      const button = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === '取消选择');
      const rect = button?.getBoundingClientRect();
      return {
        clientWidth: html.clientWidth,
        scrollWidth: html.scrollWidth,
        horizontalOverflowPx: Math.max(0, html.scrollWidth - html.clientWidth),
        button: rect ? { width: rect.width, height: rect.height } : null,
        bodyFont: getComputedStyle(document.body).fontFamily,
        readOnlyCount: [...document.querySelectorAll('.badge')].filter((item) => item.textContent?.trim() === '等待发布门').length,
      };
    });
    const screenshot = join(output, `${testCase.id}.png`);
    await page.screenshot({ path: screenshot, fullPage: true, animations: 'disabled' });
    const bytes = await readFile(screenshot);
    results.push({ ...testCase, screenshot, sha256: createHash('sha256').update(bytes).digest('hex'), traffic, errors, metrics });
    await context.close();
  }
} finally {
  await browser.close();
}
const failures = results.filter((item) => item.errors.length || item.metrics.horizontalOverflowPx > 0 || item.metrics.readOnlyCount !== 1 || item.metrics.button === null || item.metrics.button.height < (item.viewport.width <= 640 ? 44 : 40));
const report = { browser: `Chromium ${browser.version()}`, appOrigin, fixture: { path: fixturePath, sha256: createHash('sha256').update(fixtureBytes).digest('hex'), label: fixture.label }, results, failures: failures.map((item) => item.id) };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, captures: results.length, failures: report.failures }, null, 2));
if (failures.length) process.exitCode = 1;
