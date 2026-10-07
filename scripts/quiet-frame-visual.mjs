#!/usr/bin/env node
/** Capture Quiet Frame and the real app in one Chromium environment. Evidence stays in .artifacts. */
import { chromium } from 'playwright';
import { parseArgs } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = join(repo, '.artifacts', 'quiet-frame');
const referenceRoot = join(repo, 'docs', 'design-reference', 'quiet-frame', 'a04a074c62f0', 'ANCS_Quiet_Frame');
const names = [
  ['01-workspace', 'home'], ['02-new-project', 'new'], ['03-script', 'script'],
  ['04-director', 'editor'], ['05-assets', 'assets'], ['06-identity', 'identity'],
  ['07-review', 'render'], ['08-publishing', 'publish'], ['09-analytics', 'analytics'],
  ['10-extensions', 'extensions'], ['11-settings', 'settings'], ['12-landing', 'welcome'],
  ['13-design-system', 'system'], ['14-ai-diff', 'editor'], ['15-mobile-workspace', 'home'],
  ['16-mobile-director', 'editor'], ['17-mobile-review', 'render'], ['18-dark-workspace', 'home'],
];
const cases = Object.fromEntries(names.map(([id, route]) => [id, {
  id, route, viewport: id.startsWith('15-') || id.startsWith('16-') || id.startsWith('17-')
    ? { width: 390, height: 844, dpr: 2 } : { width: 1600, height: 1000, dpr: 1.5 },
  theme: id === '18-dark-workspace' ? 'dark' : 'light',
  referenceAsset: join(referenceRoot, 'screens', `${id}.png`),
  referenceAction: id === '14-ai-diff' ? '[data-action="aiedit"]' : null,
}]));

function localUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Screenshot URLs must be local HTTP(S) addresses.');
  }
  if (url.username || url.password || url.search) throw new Error('Screenshot URLs cannot contain credentials or query parameters.');
  return url;
}
function insideArtifacts(value) {
  const full = resolve(value);
  const rel = relative(artifacts, full);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error('Storage state must be inside .artifacts/quiet-frame/.');
  }
  return full;
}
function safeUrl(value) {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`; // omit query, fragment, and any credentials
}
async function fontInfo(page) {
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: 'h1, h2' });
    const result = nodeId ? await cdp.send('CSS.getPlatformFontsForNode', { nodeId }) : { fonts: [] };
    await cdp.detach();
    return result.fonts.map(({ familyName, isCustomFont, glyphCount }) => ({ familyName, isCustomFont, glyphCount }));
  } catch { return []; }
}
async function capture(browser, target, name, options, output) {
  const context = await browser.newContext({
    viewport: { width: options.viewport.width, height: options.viewport.height },
    deviceScaleFactor: options.viewport.dpr, locale: 'zh-CN', timezoneId: 'Asia/Shanghai',
    colorScheme: options.theme, reducedMotion: 'reduce',
    ...(name === 'actual' && options.storageState ? { storageState: options.storageState } : {}),
  });
  if (name === 'reference' && options.theme === 'dark') {
    await context.addInitScript(() => {
      if (globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:') {
        globalThis.localStorage.setItem('ancs-quiet-frame', JSON.stringify({ theme: 'dark' }));
      }
    });
  }
  if (name === 'actual' && options.theme === 'dark') {
    await context.addInitScript(() => {
      if (globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:') {
        globalThis.localStorage.setItem('ancs-qf-theme', 'dark');
      }
    });
  }
  const fixtureTraffic = name === 'actual' && options.fixture ? { served: [], scriptedMutations: [], blocked: [], unmatchedApi: [] } : null;
  if (fixtureTraffic) {
    const appOrigin = new URL(target).origin;
    const apiOrigins = new Set(options.fixture.apiOrigins.map((entry) => localUrl(entry).origin));
    await context.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const isApp = url.origin === appOrigin;
      const isApi = (isApp && url.pathname.startsWith('/api/')) || apiOrigins.has(url.origin);
      const key = `${request.method()} ${url.pathname}`;
      const headers = {
        'access-control-allow-origin': appOrigin,
        'access-control-allow-credentials': 'true',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': request.headers()['access-control-request-headers'] ?? 'content-type, x-ancs-client-type, x-ancs-client-version',
      };
      if (isApi && request.method() === 'OPTIONS') {
        await route.fulfill({ status: 204, headers });
      } else if (isApi && request.method() === 'GET' && Object.hasOwn(options.fixture.responses, key)) {
        fixtureTraffic.served.push(key);
        await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(options.fixture.responses[key]) });
      } else if (isApi && request.method() === 'POST' && Object.hasOwn(options.fixture.scriptedResponses ?? {}, key)) {
        const scripted = options.fixture.scriptedResponses[key];
        let body;
        try { body = request.postDataJSON(); } catch { body = null; }
        if (JSON.stringify(body) !== JSON.stringify(scripted.expectedBody)) {
          fixtureTraffic.unmatchedApi.push(`${key} (unexpected body)`);
          await route.fulfill({ status: 501, contentType: 'application/json', headers, body: JSON.stringify({ code: 'VISUAL_FIXTURE_UNMATCHED', message: 'Scripted visual request body mismatch.' }) });
        } else {
          fixtureTraffic.scriptedMutations.push(key);
          await route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(scripted.response) });
        }
      } else if (isApi) {
        fixtureTraffic.unmatchedApi.push(key);
        await route.fulfill({ status: 501, contentType: 'application/json', headers, body: JSON.stringify({ code: 'VISUAL_FIXTURE_UNMATCHED', message: 'No isolated visual fixture exists for this request.' }) });
      } else if (isApp && request.method() === 'GET') {
        await route.continue();
      } else {
        fixtureTraffic.blocked.push(key);
        await route.abort('blockedbyclient');
      }
    });
  }
  const page = await context.newPage();
  const errors = { pageErrors: [], consoleErrors: [], httpErrors: [], requestFailures: [] };
  page.on('pageerror', (error) => errors.pageErrors.push(error.name));
  page.on('console', (message) => { if (message.type() === 'error') errors.consoleErrors.push(message.location().url ? safeUrl(message.location().url) : 'unknown'); });
  page.on('response', (response) => { if (response.status() >= 400) errors.httpErrors.push({ status: response.status(), url: safeUrl(response.url()) }); });
  page.on('requestfailed', (request) => errors.requestFailures.push({ url: safeUrl(request.url()), reason: request.failure()?.errorText ?? 'unknown' }));
  await page.clock.install({ time: new Date('2026-10-07T12:00:00+08:00') });
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  if (name === 'reference' && options.referenceAction) await page.locator(options.referenceAction).first().click();
  if (name === 'actual' && options.readySelector) await page.locator(options.readySelector).first().waitFor({ state: 'visible', timeout: 30_000 });
  if (name === 'actual') for (const selector of options.actualActions) await page.locator(selector).first().click();
  if (name === 'actual' && options.afterActionSelector) await page.locator(options.afterActionSelector).first().waitFor({ state: 'visible', timeout: 30_000 });
  await page.evaluate(async () => {
    await globalThis.document.fonts.ready;
    await Promise.all([...globalThis.document.images].map((item) => item.decode().catch(() => undefined)));
    for (const video of globalThis.document.querySelectorAll('video')) {
      video.pause();
      if (video.readyState >= 1 && Number.isFinite(video.duration)) video.currentTime = 0;
    }
    globalThis.window.scrollTo(0, 0);
  });
  const selectors = ['h1', 'main', 'nav', 'aside', '.sidebar', '.editor-workspace', '.scene-rail', '.inspector', '[role="dialog"]', '[data-testid="approval-panel"]'];
  const bounds = {};
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const box = await locator.count() ? await locator.boundingBox({ timeout: 1000 }).catch(() => null) : null;
    if (box) bounds[selector] = box;
  }
  await page.screenshot({ path: join(output, `${name}.png`), fullPage: true, scale: 'device', animations: 'disabled', caret: 'hide' });
  await page.screenshot({ path: join(output, `${name}-fold.png`), fullPage: false, scale: 'device', animations: 'disabled', caret: 'hide' });
  const png = await readFile(join(output, `${name}.png`));
  const record = {
    url: safeUrl(page.url()), title: await page.title(), pngSha256: createHash('sha256').update(png).digest('hex'),
    computedFontStack: await page.locator('body').evaluate((body) => globalThis.getComputedStyle(body).fontFamily),
    platformFontsForHeading: await fontInfo(page), scroll: await page.evaluate(() => ({ x: globalThis.scrollX, y: globalThis.scrollY })),
    documentMetrics: await page.evaluate(() => ({
      clientWidth: globalThis.document.documentElement.clientWidth,
      scrollWidth: globalThis.document.documentElement.scrollWidth,
      scrollHeight: globalThis.document.documentElement.scrollHeight,
      horizontalOverflowPx: Math.max(0, globalThis.document.documentElement.scrollWidth - globalThis.document.documentElement.clientWidth),
    })),
    observedTheme: await page.evaluate(() => ({ html: globalThis.document.documentElement.getAttribute('data-theme'), bodyClass: globalThis.document.body.className })),
    bounds, errors, ...(fixtureTraffic ? { fixtureTraffic } : {}),
  };
  await context.close();
  return record;
}

const { values } = parseArgs({ options: {
  case: { type: 'string' }, mode: { type: 'string', default: 'reference' },
  'reference-base': { type: 'string', default: 'http://127.0.0.1:4100/index.html' },
  'actual-url': { type: 'string' }, 'storage-state': { type: 'string' },
  'ready-selector': { type: 'string' }, 'actual-action': { type: 'string', multiple: true }, 'after-action-selector': { type: 'string' },
  'data-label': { type: 'string' }, 'fixture-id': { type: 'string' },
  'fixture-file': { type: 'string' },
  'browser-executable': { type: 'string' }, viewport: { type: 'string' }, dpr: { type: 'string' },
  'run-id': { type: 'string' }, list: { type: 'boolean' }, help: { type: 'boolean' },
}, strict: true });

if (values.list || values.help) {
  console.log('Usage: node scripts/quiet-frame-visual.mjs --case 01-workspace --mode reference|actual|compare [--actual-url LOCAL_URL --data-label public|isolated-fixture --fixture-id ID --fixture-file JSON]');
  console.log('Cases:', Object.keys(cases).join(', '));
  process.exit(0);
}
const item = cases[values.case];
if (!item) throw new Error('Unknown --case. Use --list.');
if (!['reference', 'actual', 'compare'].includes(values.mode)) throw new Error('Invalid --mode.');
const needActual = values.mode !== 'reference';
if (needActual && (!values['actual-url'] || !['public', 'isolated-fixture', 'harness-selftest'].includes(values['data-label']))) {
  throw new Error('Actual capture requires --actual-url and --data-label public|isolated-fixture|harness-selftest.');
}
const referenceBase = localUrl(values['reference-base']);
const actualUrl = needActual ? localUrl(values['actual-url']) : null;
if (needActual && values['data-label'] === 'public' && !['12-landing', '13-design-system'].includes(item.id)) throw new Error('Public capture is limited to public design cases.');
if (needActual && values['data-label'] === 'isolated-fixture' && (!values['fixture-id'] || !values['fixture-file'])) throw new Error('Isolated fixture capture requires --fixture-id and --fixture-file.');
if (needActual && values['data-label'] === 'isolated-fixture' && !values['ready-selector']) throw new Error('Isolated fixture capture requires --ready-selector for stable data readiness.');
if (needActual && values['data-label'] === 'isolated-fixture' && values['actual-action']?.length && !values['after-action-selector']) throw new Error('Isolated fixture actions require --after-action-selector.');
if (values['fixture-file'] && values['data-label'] !== 'isolated-fixture') throw new Error('Fixture files are only valid for isolated fixture captures.');
if (needActual && values['data-label'] === 'harness-selftest' && actualUrl.origin !== referenceBase.origin) throw new Error('Self-test actual URL must use the reference server.');
if (values['fixture-id'] && !/^[A-Za-z0-9._-]+$/.test(values['fixture-id'])) throw new Error('Fixture ID must be a short slug.');
const viewport = values.viewport ? (() => {
  const match = /^(\d{2,4})x(\d{2,4})$/.exec(values.viewport);
  if (!match) throw new Error('Viewport must be WIDTHxHEIGHT.');
  return { width: Number(match[1]), height: Number(match[2]), dpr: values.dpr ? Number(values.dpr) : item.viewport.dpr };
})() : { ...item.viewport, dpr: values.dpr ? Number(values.dpr) : item.viewport.dpr };
if (viewport.width < 320 || viewport.height < 500 || !Number.isFinite(viewport.dpr) || viewport.dpr <= 0 || viewport.dpr > 3) throw new Error('Invalid viewport/DPR.');
const storageState = values['storage-state'] ? insideArtifacts(values['storage-state']) : null;
if (storageState && !existsSync(storageState)) throw new Error('Storage state file does not exist.');
if (storageState && values['data-label'] !== 'isolated-fixture') throw new Error('Storage state may only be used for isolated fixtures.');
const fixturePath = values['fixture-file'] ? resolve(values['fixture-file']) : null;
const fixture = fixturePath ? JSON.parse(await readFile(fixturePath, 'utf8')) : null;
if (fixture && (fixture.schemaVersion !== 1 || fixture.label !== 'SYNTHETIC_VISUAL_ONLY' || !Array.isArray(fixture.apiOrigins) || !fixture.responses || typeof fixture.responses !== 'object')) {
  throw new Error('Invalid isolated visual fixture file.');
}
if (fixture) for (const key of Object.keys(fixture.responses)) {
  if (!/^GET \/api\/v1\/[^?#]+$/.test(key)) throw new Error(`Fixture response key must be an exact GET API path: ${key}`);
}
if (fixture) for (const [key, scripted] of Object.entries(fixture.scriptedResponses ?? {})) {
  if (!/^POST \/api\/v1\/workspaces\/[^/]+\/projects\/[^/]+\/ai-edit\/plan$/.test(key) || !scripted || typeof scripted !== 'object' || !scripted.expectedBody || !scripted.response) {
    throw new Error(`Only an exact scripted AI plan POST is allowed in a visual fixture: ${key}`);
  }
}
if (fixture && storageState) throw new Error('Isolated fixture captures must not load a browser authentication storage state.');
const runId = values['run-id'] ?? `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
if (!/^[a-zA-Z0-9._-]+$/.test(runId)) throw new Error('Invalid run ID.');
const output = join(artifacts, item.id, runId);
if (existsSync(output)) throw new Error('Run ID already exists; evidence is immutable.');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, ...(values['browser-executable'] ? { executablePath: resolve(values['browser-executable']) } : {}) });
try {
  const options = { viewport, theme: item.theme, referenceAction: item.referenceAction, readySelector: values['ready-selector'], afterActionSelector: values['after-action-selector'], storageState, fixture };
  const evidence = {
    caseId: item.id, prototypeRoute: item.route, referenceAction: item.referenceAction, actualActions: values['actual-action'] ?? [],
    mode: values.mode, dataLabel: values['data-label'] ?? 'reference-only', fixtureId: values['fixture-id'] ?? null,
    fixtureSource: fixturePath ? { path: relative(repo, fixturePath), sha256: createHash('sha256').update(await readFile(fixturePath)).digest('hex'), label: fixture.label } : null,
    comparable: values.mode === 'compare' && values['data-label'] === 'isolated-fixture' ? 'requires manual data/state check' : 'no',
    browser: { name: 'Chromium', version: browser.version(), executable: values['browser-executable'] ? resolve(values['browser-executable']) : chromium.executablePath() },
    environment: { os: process.platform, node: process.version, viewport, zoom: 1, theme: item.theme,
      locale: 'zh-CN', timezone: 'Asia/Shanghai', fixedTime: '2026-10-07T12:00:00+08:00', reducedMotion: 'reduce' },
    sourceReference: { path: relative(repo, item.referenceAsset), sha256: createHash('sha256').update(await readFile(item.referenceAsset)).digest('hex') },
  };
  if (values.mode !== 'actual') evidence.reference = await capture(browser, `${referenceBase.href.split('#')[0]}#${item.route}`, 'reference', options, output);
  if (needActual) evidence.actual = await capture(browser, actualUrl.href, 'actual', { ...options, actualActions: values['actual-action'] ?? [] }, output);
  if (values.mode === 'compare') {
    const diff = spawnSync('python', [join(repo, 'scripts', 'quiet-frame-diff.py'), join(output, 'reference.png'), join(output, 'actual.png'), output], { encoding: 'utf8' });
    if (diff.status !== 0) throw new Error(`Diff failed: ${diff.stderr || diff.stdout}`);
    evidence.comparison = JSON.parse(diff.stdout);
  }
  await writeFile(join(output, 'metadata.json'), JSON.stringify(evidence, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, mode: values.mode, caseId: item.id, comparison: evidence.comparison ?? null }, null, 2));
  if (evidence.actual?.fixtureTraffic?.unmatchedApi.length || evidence.actual?.fixtureTraffic?.blocked.length) {
    throw new Error('Isolated visual capture observed unmatched API requests or blocked non-app traffic. See metadata.json.');
  }
} finally { await browser.close(); }
