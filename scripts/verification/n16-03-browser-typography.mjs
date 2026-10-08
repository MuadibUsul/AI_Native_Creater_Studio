/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4200';
const source = await readFile('apps/web/src/ui/QuietIcon.tsx', 'utf8');
const reference = await readFile('docs/design-reference/quiet-frame/a04a074c62f0/ANCS_Quiet_Frame/index.html', 'utf8');
const iconMap = (text) => text.match(/const ICONS[^=]*=\s*(\{[^\n]*\});/)?.[1];
assert.ok(iconMap(source));
assert.equal(iconMap(source), iconMap(reference));
const iconCount = (iconMap(source).match(/(?:^|,)\w+:/g) ?? []).length;
assert.equal(iconCount, 41);
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const fontRequests = [];
  page.on('request', (request) => { if (request.resourceType() === 'font') fontRequests.push(request.url()); });
  const response = await page.goto(`${baseUrl}/design-system`, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200);

  const desktop = await page.evaluate(() => {
    const style = (selector) => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing ${selector}`);
      const css = getComputedStyle(element);
      return { fontSize: css.fontSize, lineHeight: css.lineHeight, letterSpacing: css.letterSpacing, fontFamily: css.fontFamily, fontVariantNumeric: css.fontVariantNumeric };
    };
    return {
      body: style('body'),
      title: style('.qf-type-title'),
      heading: style('.qf-type-heading'),
      prose: style('.qf-type-body'),
      metadata: style('.qf-type-metadata'),
      control: style('.btn.small'),
      numeric: style('.qf-type-numeric'),
      technicalId: style('.qf-technical-id'),
      icon: (() => {
        const css = getComputedStyle(document.querySelector('.btn.small .icon'));
        return { width: css.width, height: css.height, strokeWidth: css.strokeWidth };
      })(),
      fileName: document.querySelector('.qf-long-text')?.textContent ?? '',
    };
  });
  assert.match(desktop.body.fontFamily, /Segoe UI/);
  assert.match(desktop.body.fontFamily, /PingFang SC/);
  assert.match(desktop.body.fontFamily, /Microsoft YaHei/);
  assert.deepEqual([desktop.title.fontSize, desktop.title.lineHeight, desktop.title.letterSpacing], ['28px', '36px', 'normal']);
  assert.deepEqual([desktop.heading.fontSize, desktop.heading.lineHeight], ['18px', '26px']);
  assert.deepEqual([desktop.prose.fontSize, desktop.prose.lineHeight], ['16px', '24px']);
  assert.deepEqual([desktop.metadata.fontSize, desktop.metadata.lineHeight], ['12px', '18px']);
  assert.equal(desktop.control.fontSize, '14px');
  assert.equal(desktop.numeric.fontVariantNumeric, 'tabular-nums');
  assert.match(desktop.technicalId.fontFamily, /Consolas/);
  assert.deepEqual(desktop.icon, { width: '20px', height: '20px', strokeWidth: '1.6px' });
  assert.match(desktop.fileName, /final-cut_1080p\.mp4/);
  assert.deepEqual(fontRequests, []);

  // 1440 physical pixels at 200% gives a 720 CSS-pixel reflow width.
  await page.setViewportSize({ width: 720, height: 900 });
  const zoomEquivalent = await page.evaluate(() => {
    const panel = document.querySelector('.type-spec .panel');
    const fileName = document.querySelector('.qf-long-text');
    if (!panel || !fileName) throw new Error('Missing typography sample');
    const panelRect = panel.getBoundingClientRect();
    const fileRect = fileName.getBoundingClientRect();
    return {
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      panelWidth: panel.clientWidth,
      panelScrollWidth: panel.scrollWidth,
      fileRight: fileRect.right,
      panelRight: panelRect.right,
      titleSize: getComputedStyle(document.querySelector('.qf-type-title')).fontSize,
      fileText: fileName.textContent,
    };
  });
  assert.equal(zoomEquivalent.viewportWidth, 720);
  assert.ok(zoomEquivalent.documentWidth <= zoomEquivalent.viewportWidth + 1, JSON.stringify(zoomEquivalent));
  assert.ok(zoomEquivalent.panelScrollWidth <= zoomEquivalent.panelWidth + 1, JSON.stringify(zoomEquivalent));
  assert.ok(zoomEquivalent.fileRight <= zoomEquivalent.panelRight + 1, JSON.stringify(zoomEquivalent));
  assert.equal(zoomEquivalent.titleSize, '24px');
  assert.match(zoomEquivalent.fileText, /final-cut_1080p\.mp4/);

  const previewResponse = await page.goto(`${baseUrl}/welcome`, { waitUntil: 'networkidle' });
  assert.equal(previewResponse?.status(), 200);
  const mediaPreview = await page.evaluate(() => {
    const title = document.querySelector('.landing-product .viewer h2');
    const canvas = document.querySelector('.landing-product .viewer');
    if (!title || !canvas) throw new Error('Missing media preview');
    const titleStyle = getComputedStyle(title);
    return {
      titleLetterSpacing: titleStyle.letterSpacing,
      titleNumeric: titleStyle.fontVariantNumeric,
      canvasFilter: getComputedStyle(canvas).filter,
    };
  });
  assert.match(mediaPreview.titleLetterSpacing, /^-/);
  assert.equal(mediaPreview.titleNumeric, 'normal');
  assert.equal(mediaPreview.canvasFilter, 'none');

  process.stdout.write(`${JSON.stringify({ result: 'PASS', url: `${baseUrl}/design-system`, iconCount, desktop, zoomEquivalent, mediaPreview, fontRequests }, null, 2)}\n`);
} finally {
  await browser.close();
}
