/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4200';
const evidenceDir = resolve('.artifacts/n16-03-layout');
await mkdir(evidenceDir, { recursive: true });
const profile = await mkdtemp(resolve(evidenceDir, 'chrome-profile-'));
assert.ok(profile.startsWith(`${evidenceDir}${sep}`));
await mkdir(resolve(profile, 'Default'), { recursive: true });
// Chromium stores default page zoom as a level keyed by the default partition ("x").
await writeFile(resolve(profile, 'Default/Preferences'), JSON.stringify({
  partition: { default_zoom_level: { x: Math.log(2) / Math.log(1.2) } },
}));

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chrome', headless: true, viewport: null, args: ['--window-size=1440,900'],
  });
  const results = [];
  for (const routeName of ['/welcome', '/design-system', '/sign-in']) {
    const page = await context.newPage();
    let interceptedApiRequests = 0;
    await page.route('**/api/v1/**', async (request) => {
      interceptedApiRequests += 1;
      await request.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Isolated UI audit' } }) });
    });
    const response = await page.goto(`${baseUrl}${routeName}`, { waitUntil: 'networkidle' });
    assert.equal(response?.status(), 200, routeName);
    const cdp = await context.newCDPSession(page);
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const layout = await page.evaluate(() => {
      const visible = (element) => {
        const css = getComputedStyle(element);
        return element.getClientRects().length > 0 && css.visibility === 'visible' && css.display !== 'none';
      };
      const outsideControls = [...document.querySelectorAll('button, input, a[href]')]
        .filter((element) => visible(element) && !element.classList.contains('skiplink'))
        .map((element) => ({ element, box: element.getBoundingClientRect() }))
        .filter(({ box }) => box.left < -1 || box.right > window.innerWidth + 1)
        .map(({ element, box }) => ({ label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40), left: box.left, right: box.right }));
      const typePanel = document.querySelector('.type-spec .panel');
      const loginPanel = document.querySelector('#sign-in-email')?.closest('.panel');
      const loginHeading = loginPanel?.querySelector('h1');
      const longFile = document.querySelector('.qf-long-text');
      return {
        cssWidth: window.innerWidth,
        dpr: window.devicePixelRatio,
        documentWidth: document.documentElement.scrollWidth,
        outsideControls,
        typePanelOverflow: typePanel ? typePanel.scrollWidth - typePanel.clientWidth : null,
        loginPanelOverflow: loginPanel ? loginPanel.scrollWidth - loginPanel.clientWidth : null,
        loginHeadingOverflow: loginHeading ? loginHeading.scrollWidth - loginHeading.clientWidth : null,
        loginInputs: [...document.querySelectorAll('#sign-in-email, #sign-in-password')].filter(visible).length,
        longFileClipped: longFile ? getComputedStyle(longFile).overflowX === 'hidden' && longFile.scrollWidth > longFile.clientWidth : null,
        mockPreviewWidth: document.querySelector('.landing-product .mini-content')?.clientWidth ?? null,
      };
    });
    const result = { route: routeName, chromeZoom: metrics.cssVisualViewport.zoom, interceptedApiRequests, ...layout };
    results.push(result);
    await page.close();
  }
  const failures = results.filter((item) => item.chromeZoom !== 2 || item.cssWidth < 700 || item.cssWidth > 740 || item.documentWidth > item.cssWidth + 1 || item.outsideControls.length > 0 || (item.typePanelOverflow ?? 0) > 1 || (item.loginPanelOverflow ?? 0) > 1 || (item.loginHeadingOverflow ?? 0) > 1 || item.longFileClipped === true || (item.route === '/sign-in' && item.loginInputs !== 2) || (item.route === '/welcome' && (item.mockPreviewWidth ?? 0) < 200));
  await writeFile(resolve(evidenceDir, 'native-200-results.json'), `${JSON.stringify(results, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', physicalWindowWidth: 1440, cases: results.length, failures, results }, null, 2)}\n`);
  assert.equal(failures.length, 0);
} finally {
  if (context) await context.close();
  assert.ok(profile.startsWith(`${evidenceDir}${sep}`));
  await rm(profile, { recursive: true, force: true });
}
