/* global document, getComputedStyle, location */
import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const options = parseOptions(process.argv.slice(2));
const output = join(root, '.artifacts/quiet-frame/responsive-audit', options.runId);
const fixturePath = join(root, 'scripts/fixtures/quiet-frame-visual.json');
const rawFixture = await readFile(fixturePath);
const fixture = JSON.parse(rawFixture.toString('utf8'));
if (fixture.label !== 'SYNTHETIC_VISUAL_ONLY') throw new Error('Responsive audit requires the synthetic visual fixture.');
const apiOrigins = new Set(fixture.apiOrigins.map((value) => new URL(value).origin));
const workspace = '/w/ws_visual_fixture';
const project = `${workspace}/p/prj_visual_01`;
const scenarios = [
  { id: 'workspace', path: '/?workspaceId=ws_visual_fixture', ready: 'main h1' },
  { id: 'director', path: `${project}/storyboard`, ready: '.qf-director-viewer' },
  { id: 'render', path: `${project}/render`, ready: '[data-testid="quiet-render"]' },
  { id: 'settings', path: `${workspace}/settings`, ready: 'main h1' },
  { id: 'finance', path: `${project}/assets`, ready: '[data-testid="quiet-assets"]', action: '#finance-pack summary', after: '[data-testid="finance-pack"]' },
].filter((item) => !options.scenario || item.id === options.scenario);
const viewports = [
  { width: 320, height: 700 }, { width: 390, height: 844 }, { width: 768, height: 1024 },
  { width: 1280, height: 800 }, { width: 1920, height: 1080 },
].filter((item) => !options.width || item.width === options.width);
if (!scenarios.length || !viewports.length) throw new Error('Unknown scenario or viewport width.');

// The second mkdir is intentionally non-recursive: an existing run must never be overwritten.
await mkdir(dirname(output), { recursive: true });
await mkdir(output);
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const scenario of scenarios) {
    for (const viewport of viewports) {
      const label = `${scenario.id}-${viewport.width}`;
      const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', reducedMotion: 'reduce' });
      const unmatchedApi = [];
      const externalRequests = [];
      const pageErrors = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const isApi = (['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname.startsWith('/api/')) || apiOrigins.has(url.origin);
        if (!isApi) {
          if (url.origin === options.appOrigin) return route.continue();
          externalRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
          return route.abort();
        }
        const key = `${request.method()} ${url.pathname}`;
        const headers = {
          'access-control-allow-origin': options.appOrigin,
          'access-control-allow-credentials': 'true',
          'access-control-allow-methods': 'GET, POST, OPTIONS',
          'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type, x-ancs-client-type, x-ancs-client-version',
        };
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (request.method() === 'GET' && Object.hasOwn(fixture.responses, key)) {
          return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(fixture.responses[key]) });
        }
        unmatchedApi.push(key);
        return route.fulfill({ status: 501, contentType: 'application/json', headers, body: JSON.stringify({ code: 'VISUAL_FIXTURE_UNMATCHED', message: key }) });
      });
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push(error.name));
      const item = { scenario: scenario.id, viewport, url: `${options.appOrigin}${scenario.path}`, screenshot: `${label}.png`, unmatchedApi, externalRequests, pageErrors };
      try {
        await page.clock.install({ time: new Date('2026-10-07T12:00:00+08:00') });
        await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.locator(scenario.ready).first().waitFor({ state: 'visible', timeout: 30000 });
        if (scenario.action) await page.locator(scenario.action).first().click();
        if (scenario.after) await page.locator(scenario.after).first().waitFor({ state: 'visible', timeout: 30000 });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: join(output, item.screenshot), fullPage: true, animations: 'disabled' });
        item.metrics = await page.evaluate(() => {
          const html = document.documentElement;
          const width = html.clientWidth;
          const visible = (element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
          };
          const actions = [...document.querySelectorAll('main .btn.primary, main .btn.blue, main button[type="submit"]')]
            .filter(visible).map((element) => {
              const rect = element.getBoundingClientRect();
              return { text: element.textContent.trim(), left: rect.left, right: rect.right, width: rect.width };
            });
          const clippedActions = actions.filter((action) => action.left < -1 || action.right > width + 1);
          const forms = document.querySelector('[data-testid="finance-pack"] form')?.parentElement;
          const timeline = document.querySelector('.timeline-strip');
          const timelineScroll = timeline ? (() => {
            const before = timeline.scrollLeft;
            timeline.scrollLeft = timeline.scrollWidth;
            const after = timeline.scrollLeft;
            timeline.scrollLeft = before;
            return { clientWidth: timeline.clientWidth, scrollWidth: timeline.scrollWidth, overflowX: getComputedStyle(timeline).overflowX, scrollable: after > before };
          })() : null;
          return {
            clientWidth: width,
            scrollWidth: html.scrollWidth,
            horizontalOverflowPx: Math.max(0, html.scrollWidth - width),
            actions,
            clippedActions,
            timeline: timelineScroll,
            financeColumns: forms ? getComputedStyle(forms).gridTemplateColumns : null,
            heading: document.querySelector('main h1')?.textContent ?? null,
            path: location.pathname,
          };
        });
      } catch (error) {
        item.error = error instanceof Error ? error.name : 'UnknownError';
      }
      results.push(item);
      await context.close();
    }
  }
} finally {
  await browser.close();
}

const failures = results.filter((item) => item.error || item.pageErrors.length || item.unmatchedApi.length || item.externalRequests.length || item.metrics?.horizontalOverflowPx > 0 || item.metrics?.clippedActions.length);
const report = {
  label: 'SYNTHETIC_VISUAL_ONLY',
  runId: options.runId,
  fixture: fixturePath,
  fixtureSha256: createHash('sha256').update(rawFixture).digest('hex'),
  browser: `Playwright Chromium ${browser.version()}`,
  appOrigin: options.appOrigin,
  results,
};
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ output, captures: results.length, failures: failures.map((item) => `${item.scenario}-${item.viewport.width}`) }, null, 2));
if (failures.length) process.exitCode = 1;

function parseOptions(args) {
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!['--run-id', '--app-url', '--scenario', '--width'].includes(name) || !value) {
      throw new Error('Usage: pnpm visual:qf:responsive --run-id RUN_ID [--app-url http://127.0.0.1:4000] [--scenario workspace|director|render|settings|finance] [--width 320|390|768|1280|1920]');
    }
    if (Object.hasOwn(values, name)) throw new Error(`Duplicate option: ${name}`);
    values[name] = value;
  }
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(values['--run-id'] ?? '')) throw new Error('A lowercase --run-id of 3–64 characters is required.');
  const appUrl = new URL(values['--app-url'] ?? 'http://127.0.0.1:4000');
  if (appUrl.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(appUrl.hostname) || appUrl.username || appUrl.password || appUrl.pathname !== '/' || appUrl.search || appUrl.hash) {
    throw new Error('--app-url must be a loopback HTTP origin without credentials, path, query, or fragment.');
  }
  return { runId: values['--run-id'], appOrigin: appUrl.origin, scenario: values['--scenario'], width: values['--width'] ? Number(values['--width']) : null };
}
