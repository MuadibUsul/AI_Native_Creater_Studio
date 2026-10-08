/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4000';
const evidenceDir = resolve('docs/verification/evidence/N16-01');
await mkdir(evidenceDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const response = await page.goto(`${baseUrl}/design-system`, { waitUntil: 'load' });
  assert.equal(response?.status(), 200);
  await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--ui-bg-canvas').trim() === '#FFFFFF');

  const inspect = () => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const computed = getComputedStyle(element);
      return { background: computed.backgroundColor, color: computed.color };
    };
    return {
      canvas: getComputedStyle(document.body).getPropertyValue('--ui-bg-canvas').trim(),
      action: style('.btn.blue'),
      statusCard: style('.status-board > div'),
      topbar: style('.topbar'),
    };
  };

  const light = await page.evaluate(inspect);
  assert.equal(light.canvas, '#FFFFFF');
  assert.deepEqual(light.action, { background: 'rgb(23, 23, 23)', color: 'rgb(255, 255, 255)' });
  assert.deepEqual(light.statusCard, { background: 'rgb(245, 245, 245)', color: 'rgb(23, 23, 23)' });
  await page.screenshot({ path: resolve(evidenceDir, 'design-system-light.png'), fullPage: true });

  await page.evaluate(() => document.body.classList.add('theme-dark'));
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.btn.blue')).backgroundColor === 'rgb(245, 245, 245)');
  const dark = await page.evaluate(inspect);
  assert.equal(dark.canvas, '#0A0A0A');
  assert.deepEqual(dark.action, { background: 'rgb(245, 245, 245)', color: 'rgb(23, 23, 23)' });
  assert.deepEqual(dark.statusCard, { background: 'rgb(20, 20, 20)', color: 'rgb(245, 245, 245)' });
  assert.equal(dark.topbar.background, 'rgb(28, 28, 28)');
  await page.screenshot({ path: resolve(evidenceDir, 'design-system-dark.png'), fullPage: true });

  const ordinaryButton = page.locator('.btn.small').first();
  await ordinaryButton.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.btn.small')).backgroundColor === 'rgb(38, 38, 38)');
  const hover = await ordinaryButton.evaluate((element) => {
    const computed = getComputedStyle(element);
    return { background: computed.backgroundColor, color: computed.color };
  });
  assert.deepEqual(hover, { background: 'rgb(38, 38, 38)', color: 'rgb(245, 245, 245)' });

  await page.setViewportSize({ width: 375, height: 812 });
  const mobileSidebar = await page.locator('.sidebar').evaluate((element) => getComputedStyle(element).backgroundColor);
  assert.equal(mobileSidebar, 'rgb(20, 20, 20)');

  const touchContext = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
  const touchPage = await touchContext.newPage();
  const touchResponse = await touchPage.goto(`${baseUrl}/design-system`, { waitUntil: 'load' });
  assert.equal(touchResponse?.status(), 200);
  const touch = await touchPage.evaluate(() => {
    const targets = [...document.querySelectorAll('.btn, .textbtn')]
      .filter((element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility === 'visible')
      .map((element) => ({
        label: element.textContent?.trim() || element.getAttribute('aria-label'),
        height: element.getBoundingClientRect().height,
        width: element.getBoundingClientRect().width,
        iconOnly: element.classList.contains('icononly'),
      }));
    const actionBounds = [...document.querySelectorAll('.qf-design-actions .btn')]
      .map((element) => element.getBoundingClientRect().right);
    return { coarsePointer: window.matchMedia('(pointer: coarse)').matches, targets, maxActionRight: Math.max(...actionBounds), viewportWidth: window.innerWidth };
  });
  assert.equal(touch.coarsePointer, true);
  assert.ok(touch.targets.length > 0);
  assert.ok(touch.targets.every((target) => target.height >= 44), JSON.stringify(touch.targets));
  assert.ok(touch.targets.some((target) => target.iconOnly));
  assert.ok(touch.targets.filter((target) => target.iconOnly).every((target) => target.width >= 44));
  assert.ok(Number.isFinite(touch.maxActionRight));
  assert.ok(touch.maxActionRight <= touch.viewportWidth, JSON.stringify(touch));
  await touchContext.close();

  const hashes = {};
  for (const name of ['design-system-light.png', 'design-system-dark.png']) {
    hashes[name] = createHash('sha256').update(await readFile(resolve(evidenceDir, name))).digest('hex');
  }
  process.stdout.write(`${JSON.stringify({ result: 'PASS', url: `${baseUrl}/design-system`, light, dark, hover, mobileSidebar, touch, hashes }, null, 2)}\n`);
} finally {
  await browser.close();
}
