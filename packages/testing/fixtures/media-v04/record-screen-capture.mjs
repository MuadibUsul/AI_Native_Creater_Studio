#!/usr/bin/env node
// Browser-recorded synthetic UI fixture. No session, user project, or database writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const scratch = resolve('.artifacts/v04/n00-04-screen-recording');
const output = process.argv[2] ? resolve(process.argv[2]) : join(scratch, 'screen-recording-design-system.webm');
await mkdir(scratch, { recursive: true });
await mkdir(dirname(output), { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: { width: 960, height: 540 },
    recordVideo: { dir: scratch, size: { width: 960, height: 540 } },
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'zh-CN',
  });
  const page = await context.newPage();
  const video = page.video();
  const response = await page.goto('http://127.0.0.1:4000/design-system', { waitUntil: 'load' });
  assert.equal(response?.status(), 200);
  await page.getByRole('heading', { name: 'Quiet Frame · 静框' }).waitFor();

  await page.waitForTimeout(600);
  await page.mouse.wheel(0, 360);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '切换深浅色' }).click();
  await page.waitForTimeout(700);
  await page.mouse.wheel(0, 430);
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: '查看解决方式' }).click();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: '知道了' }).click();
  await page.waitForTimeout(500);

  await context.close();
  await video.saveAs(output);
  const data = await readFile(output);
  process.stdout.write(`${JSON.stringify({ output, bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })}\n`);
} finally {
  await browser.close();
}
