/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4000';
const evidenceDir = resolve('.artifacts/n16-03-layout');
const routes = ['/welcome', '/design-system', '/sign-in'];
const widths = [1440, 960, 720, 390, 320];
const browser = await chromium.launch({ headless: true });
const results = [];

try {
  await mkdir(evidenceDir, { recursive: true });
  for (const routeName of routes) {
    for (const width of widths) {
      // DPR 2 at 720 CSS px models 1440 physical px at 200% effective reflow.
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width === 720 ? 2 : 1 });
      const page = await context.newPage();
      let interceptedApiRequests = 0;
      await page.route('**/api/v1/**', async (request) => {
        interceptedApiRequests += 1;
        await request.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAUTHENTICATED', message: 'Isolated UI audit' } }) });
      });
      const response = await page.goto(`${baseUrl}${routeName}`, { waitUntil: 'networkidle' });
      assert.equal(response?.status(), 200, `${routeName} ${width}`);
      const layout = await page.evaluate(() => {
        const visible = (element) => {
          const css = getComputedStyle(element);
          return element.getClientRects().length > 0 && css.visibility === 'visible' && css.display !== 'none';
        };
        const controls = [...document.querySelectorAll('button, input, a[href]')]
          .filter((element) => visible(element) && !element.classList.contains('skiplink'))
          .map((element) => {
            const box = element.getBoundingClientRect();
            return { label: element.getAttribute('aria-label') || element.textContent?.trim().slice(0, 40) || element.getAttribute('id'), left: box.left, right: box.right, width: box.width };
          });
        const outsideControls = controls.filter((item) => item.left < -1 || item.right > window.innerWidth + 1);
        const panel = document.querySelector('.type-spec .panel');
        const longFile = document.querySelector('.qf-long-text');
        const loginPanel = document.querySelector('#sign-in-email')?.closest('.panel');
        const mockPreview = document.querySelector('.landing-product .mini-content');
        return {
          width: window.innerWidth,
          dpr: window.devicePixelRatio,
          documentWidth: document.documentElement.scrollWidth,
          outsideControls,
          controlCount: controls.length,
          panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
          longFileClipped: longFile ? getComputedStyle(longFile).overflowX === 'hidden' && longFile.scrollWidth > longFile.clientWidth : null,
          loginInputs: [...document.querySelectorAll('#sign-in-email, #sign-in-password')].filter(visible).length,
          loginPanelOverflow: loginPanel ? loginPanel.scrollWidth - loginPanel.clientWidth : null,
          mockPreviewWidth: mockPreview?.clientWidth ?? null,
        };
      });
      if (width === 720 || width === 320) await page.screenshot({ path: resolve(evidenceDir, `${routeName.slice(1)}-${width}.png`), fullPage: true });
      results.push({ route: routeName, cssWidth: width, interceptedApiRequests, ...layout });
      await context.close();
    }
  }
  await writeFile(resolve(evidenceDir, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const failures = results.filter((item) => item.documentWidth > item.width + 1 || item.outsideControls.length > 0 || (item.panelOverflow ?? 0) > 1 || item.longFileClipped === true || (item.loginPanelOverflow ?? 0) > 1 || (item.route === '/sign-in' && item.loginInputs !== 2) || (item.route === '/welcome' && item.width <= 390 && (item.mockPreviewWidth ?? 0) < 200));
  process.stdout.write(`${JSON.stringify({ result: failures.length ? 'FAIL' : 'PASS', cases: results.length, failures, results }, null, 2)}\n`);
  assert.equal(failures.length, 0);
} finally {
  await browser.close();
}
