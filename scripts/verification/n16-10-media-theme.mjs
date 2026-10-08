/* global document, getComputedStyle, HTMLImageElement, crypto, atob, Blob */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const baseUrl = process.env.ANCS_WEB_URL ?? 'http://127.0.0.1:4000';
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.route('**/api/v1/auth/session', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: { id: 'usr_media_fixture', email: 'media-fixture@example.test', name: '媒体测试', emailVerified: true }, sessionId: 'ses_media_fixture', method: 'web_session', expiresAt: '2026-12-31T00:00:00.000Z' }) }));
  assert.equal((await page.goto(`${baseUrl}/welcome`, { waitUntil: 'networkidle' }))?.status(), 200);
  await page.evaluate(async () => {
    const viewer = document.querySelector('.viewer.graph');
    if (!viewer) throw new Error('Missing content viewer');
    const image = document.createElement('img');
    image.id = 'n16-10-media-fixture';
    image.alt = '四色媒体像素校准样本';
    image.style.cssText = 'position:absolute;left:8px;bottom:8px;width:64px;height:64px;z-index:2';
    image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><path fill="#f00" d="M0 0h32v32H0z"/><path fill="#0f0" d="M32 0h32v32H32z"/><path fill="#00f" d="M0 32h32v32H0z"/><path fill="#888" d="M32 32h32v32H32z"/></svg>');
    viewer.append(image);
    await image.decode();
  });
  const inspect = () => page.evaluate(() => {
    const image = document.querySelector('#n16-10-media-fixture');
    if (!(image instanceof HTMLImageElement)) throw new Error('Missing media fixture');
    const chain = [];
    for (let node = image; node; node = node.parentElement) {
      const filter = getComputedStyle(node).filter;
      chain.push({ element: node.tagName.toLowerCase(), filter });
    }
    return {
      canvas: getComputedStyle(document.body).getPropertyValue('--ui-bg-canvas').trim(),
      viewerBackground: getComputedStyle(document.querySelector('.viewer.graph')).backgroundImage,
      viewerColor: getComputedStyle(document.querySelector('.viewer.graph')).color,
      contentStrokes: [...document.querySelectorAll('.viewer.graph svg path')].map((path) => getComputedStyle(path).stroke),
      mediaPixels: (() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Missing canvas context');
        context.drawImage(image, 0, 0, 64, 64);
        return [[16, 16], [48, 16], [16, 48], [48, 48]].map(([x, y]) => [...context.getImageData(x, y, 1, 1).data]);
      })(),
      chain,
    };
  });
  const light = await inspect();
  await mkdir(resolve('.artifacts/v04/N16-10'), { recursive: true });
  await page.locator('.viewer.graph').screenshot({ path: resolve('.artifacts/v04/N16-10/viewer-light.png') });
  await page.evaluate(() => document.body.classList.add('theme-dark'));
  const dark = await inspect();
  await page.locator('.viewer.graph').screenshot({ path: resolve('.artifacts/v04/N16-10/viewer-dark.png') });
  assert.equal(light.canvas, '#FFFFFF');
  assert.equal(dark.canvas, '#0A0A0A');
  assert.equal(light.viewerBackground, dark.viewerBackground);
  assert.equal(light.viewerColor, dark.viewerColor);
  assert.deepEqual(light.contentStrokes, dark.contentStrokes);
  assert.deepEqual(light.mediaPixels, [[255, 0, 0, 255], [0, 255, 0, 255], [0, 0, 255, 255], [136, 136, 136, 255]]);
  assert.deepEqual(light.mediaPixels, dark.mediaPixels);
  assert(light.chain.every((node) => node.filter === 'none'));
  assert(dark.chain.every((node) => node.filter === 'none'));
  let realVideo = 'not supplied';
  if (process.env.ANCS_N16_MEDIA_FILE) {
    const bytes = await readFile(process.env.ANCS_N16_MEDIA_FILE);
    await page.evaluate((base64) => {
      document.body.classList.remove('theme-dark');
      const viewer = document.querySelector('.viewer.graph');
      if (!viewer) throw new Error('Missing content viewer');
      const video = document.createElement('video');
      video.id = 'n16-10-real-video';
      video.muted = true;
      video.preload = 'auto';
      video.style.cssText = 'position:absolute;right:8px;top:8px;width:160px;height:90px;z-index:2';
      const binary = atob(base64);
      const data = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      video.src = URL.createObjectURL(new Blob([data], { type: 'video/mp4' }));
      viewer.append(video);
    }, bytes.toString('base64'));
    await page.waitForFunction(() => document.querySelector('#n16-10-real-video')?.readyState >= 2, undefined, { timeout: 8000 }).catch(async () => {
      throw new Error(`Video did not decode: ${JSON.stringify(await page.evaluate(() => {
        const video = document.querySelector('#n16-10-real-video');
        return { readyState: video?.readyState, networkState: video?.networkState, mediaError: video?.error?.message, currentSrc: video?.currentSrc };
      }))}`);
    });
    await page.evaluate(() => { document.querySelector('#n16-10-real-video').currentTime = 1; });
    await page.waitForFunction(() => {
      const video = document.querySelector('#n16-10-real-video');
      return video?.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - 1) < 0.1;
    });
    const inspectFrame = () => page.evaluate(async () => {
      const video = document.querySelector('#n16-10-real-video');
      if (!video) throw new Error('Missing video');
      const canvas = document.createElement('canvas');
      canvas.width = 160; canvas.height = 90;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Missing canvas context');
      context.drawImage(video, 0, 0, 160, 90);
      const data = context.getImageData(0, 0, 160, 90).data;
      const digest = await crypto.subtle.digest('SHA-256', data);
      const filters = [];
      for (let node = video; node; node = node.parentElement) filters.push(getComputedStyle(node).filter);
      return { frameHash: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''), currentTime: video.currentTime, dimensions: [video.videoWidth, video.videoHeight], filters };
    });
    const before = await inspectFrame();
    await page.evaluate(() => document.body.classList.add('theme-dark'));
    const after = await inspectFrame();
    assert.equal(before.frameHash, after.frameHash);
    assert(before.filters.every((filter) => filter === 'none'));
    assert(after.filters.every((filter) => filter === 'none'));
    realVideo = { sourceSha256: createHash('sha256').update(bytes).digest('hex'), frameSha256: before.frameHash, dimensions: before.dimensions, currentTime: [before.currentTime, after.currentTime], ancestorCount: before.filters.length };
  }
  process.stdout.write(`${JSON.stringify({ result: 'PASS', route: `${baseUrl}/welcome`, uiCanvas: [light.canvas, dark.canvas], mediaPixels: light.mediaPixels, unchangedContentStrokes: light.contentStrokes.length, checkedAncestorCount: light.chain.length, realVideo, screenshots: ['.artifacts/v04/N16-10/viewer-light.png', '.artifacts/v04/N16-10/viewer-dark.png'], boundary: 'real Next page and CSS; fixture plus optional locally supplied decoded video frame; no project or provider writes' }, null, 2)}\n`);
} finally {
  await browser.close();
}
