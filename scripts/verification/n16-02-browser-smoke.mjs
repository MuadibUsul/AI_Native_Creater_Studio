/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4000';
const browser = await chromium.launch({ headless: true });
try {
  const firstPaint = [];
  for (const colorScheme of ['light', 'dark']) {
    const context = await browser.newContext({ colorScheme });
    await context.addCookies([{ name: 'ancs-qf-appearance', value: 'usr_unrelated.dark', url: baseUrl }]);
    const page = await context.newPage();
    await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, (route) => route.abort());
    const response = await page.goto(`${baseUrl}/design-system`, { waitUntil: 'domcontentloaded' });
    assert.equal(response?.status(), 200);
    const result = await page.evaluate(() => ({
      mode: document.body.dataset['appearanceMode'],
      dark: document.body.classList.contains('theme-dark'),
      canvas: getComputedStyle(document.body).getPropertyValue('--ui-bg-canvas').trim(),
    }));
    assert.deepEqual(result, {
      mode: 'system', dark: colorScheme === 'dark', canvas: colorScheme === 'dark' ? '#0A0A0A' : '#FFFFFF',
    });
    firstPaint.push({ colorScheme, ...result });
    await context.close();
  }

  const fixedPaint = [];
  if (process.env.ANCS_APPEARANCE_AUTH_STUB === '1') {
    for (const [cookieUser, expectedMode] of [['usr_test', 'dark'], ['usr_other', 'system']]) {
      const context = await browser.newContext({ colorScheme: 'light' });
      await context.addCookies([
        { name: 'appearance-test-session', value: 'usr_test', url: baseUrl },
        { name: 'ancs-qf-appearance', value: `${cookieUser}.dark`, url: baseUrl },
      ]);
      const page = await context.newPage();
      await page.route(/\/_next\/static\/.*\.js(?:\?.*)?$/, (route) => route.abort());
      assert.equal((await page.goto(`${baseUrl}/design-system`, { waitUntil: 'domcontentloaded' }))?.status(), 200);
      const result = await page.evaluate(() => ({
        mode: document.body.dataset['appearanceMode'],
        dark: document.body.classList.contains('theme-dark'),
      }));
      assert.deepEqual(result, { mode: expectedMode, dark: expectedMode === 'dark' });
      fixedPaint.push({ cookieUser, ...result });
      await context.close();
    }
  }

  const context = await browser.newContext({ colorScheme: 'dark' });
  const page = await context.newPage();
  const hydrationErrors = [];
  page.on('console', (message) => {
    if (/hydration|did not match/i.test(message.text())) hydrationErrors.push(message.text());
  });
  page.on('pageerror', (error) => {
    if (/hydration|did not match/i.test(error.message)) hydrationErrors.push(error.message);
  });
  assert.equal((await page.goto(`${baseUrl}/design-system`, { waitUntil: 'load' }))?.status(), 200);
  await page.waitForFunction(() => document.body.classList.contains('theme-dark'));
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForFunction(() => !document.body.classList.contains('theme-dark'));
  assert.deepEqual(hydrationErrors, []);
  await context.close();
  process.stdout.write(`${JSON.stringify({ result: 'PASS', url: `${baseUrl}/design-system`, firstPaint, fixedPaint, systemChange: 'dark→light', hydrationErrors }, null, 2)}\n`);
} finally {
  await browser.close();
}
