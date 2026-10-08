#!/usr/bin/env node
// N00-06 partial check: real Chromium playback of fixed, synthetic/local fixtures.
// No product API, account, storage service, database, or paid Provider is used.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const fixtureDir = resolve('packages/testing/fixtures/media-v04');
const evidenceDir = resolve('.artifacts/n00-06-browser-media');
const recording = JSON.parse(await readFile(resolve(fixtureDir, 'screen-recording-manifest.json'), 'utf8'));
const synthetic = JSON.parse(await readFile(resolve(fixtureDir, 'manifest.json'), 'utf8'));
const audio = synthetic.assets.find((asset) => asset.id === 'synthetic-independent-audio');
assert.ok(audio, 'N00-04 independent audio fixture is missing from its manifest');

const override = process.argv.find((arg) => arg.startsWith('--video-path='));
const videoPath = override ? resolve(override.slice('--video-path='.length)) : resolve(fixtureDir, recording.file);
const audioPath = resolve(fixtureDir, audio.file);

async function verifiedFile(path, expectedHash, expectedBytes, label) {
  const file = await stat(path).catch(() => { throw new Error(`${label} fixture path unavailable`); });
  assert.ok(file.isFile(), `${label} fixture is not a file`);
  assert.equal(file.size, expectedBytes, `${label} fixture size mismatch`);
  const hash = createHash('sha256');
  try { for await (const chunk of createReadStream(path)) hash.update(chunk); }
  catch { throw new Error(`${label} fixture unreadable`); }
  assert.equal(hash.digest('hex'), expectedHash, `${label} fixture SHA-256 mismatch`);
  return file.size;
}

function command(name, args) {
  const result = spawnSync(name, args, { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw new Error(`${name} unavailable`);
  assert.equal(result.status, 0, `${name} failed with exit ${result.status}`);
  return result.stdout;
}

function probe(path, type) {
  const output = command('ffprobe', [
    '-v', 'error', '-show_entries',
    'format=duration:stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels,time_base',
    '-of', 'json', path,
  ]);
  const result = JSON.parse(output);
  assert.ok(result.streams?.some((stream) => stream.codec_type === type), `${type} stream missing`);
  command('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-xerror', '-i', path, '-map', `0:${type[0]}:0`, '-f', 'null', '-']);
  return result;
}

await verifiedFile(videoPath, recording.sha256, recording.sizeBytes, 'video');
await verifiedFile(audioPath, audio.sha256, audio.sizeBytes, 'audio');
const videoProbe = probe(videoPath, 'video');
const audioProbe = probe(audioPath, 'audio');

const files = new Map([
  ['/video.webm', { path: videoPath, size: recording.sizeBytes, type: 'video/webm' }],
  ['/audio.wav', { path: audioPath, size: audio.sizeBytes, type: 'audio/wav' }],
]);
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>N00-06 fixture playback</title>
  <body><h1>N00-06 synthetic media browser check</h1>
  <video id="video" width="960" height="540" controls muted preload="auto" src="/video.webm"></video>
  <audio id="audio" controls preload="auto" src="/audio.wav"></audio>
  <button id="play">Play fixtures</button><output id="status"></output>
  <script>document.querySelector('#play').addEventListener('click', async () => {
    try {
      await Promise.all([document.querySelector('#video').play(), document.querySelector('#audio').play()]);
      document.querySelector('#status').textContent = 'playing';
    } catch (error) { document.querySelector('#status').textContent = error.message; }
  });</script></body></html>`;
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }
  const file = files.get(request.url);
  if (!file) { response.writeHead(404).end(); return; }
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
  const start = range ? Number(range[1]) : 0;
  const end = range && range[2] ? Number(range[2]) : file.size - 1;
  if (start > end || end >= file.size) {
    response.writeHead(416, { 'content-range': `bytes */${file.size}` }).end();
    return;
  }
  response.writeHead(range ? 206 : 200, {
    'content-type': file.type,
    'content-length': end - start + 1,
    'accept-ranges': 'bytes',
    ...(range ? { 'content-range': `bytes ${start}-${end}/${file.size}` } : {}),
  });
  createReadStream(file.path, { start, end }).pipe(response);
});

let browser;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const response = await page.goto(url, { waitUntil: 'networkidle' });
  assert.equal(response?.status(), 200);
  await page.getByRole('button', { name: 'Play fixtures' }).click();
  await page.waitForFunction(() => {
    const video = globalThis.document.querySelector('#video');
    const audio = globalThis.document.querySelector('#audio');
    return video.currentTime > 0.3 && audio.currentTime > 0.3;
  }, null, { timeout: 10_000 });
  const playback = await page.evaluate(() => {
    const video = globalThis.document.querySelector('#video');
    const audio = globalThis.document.querySelector('#audio');
    return {
      video: { width: video.videoWidth, height: video.videoHeight, duration: video.duration, currentTime: video.currentTime, error: video.error?.message ?? null },
      audio: { duration: audio.duration, currentTime: audio.currentTime, error: audio.error?.message ?? null },
    };
  });
  assert.equal(playback.video.width, 960);
  assert.equal(playback.video.height, 540);
  assert.equal(playback.video.error, null);
  assert.equal(playback.audio.error, null);
  assert.deepEqual(pageErrors, []);
  await mkdir(evidenceDir, { recursive: true });
  const screenshot = resolve(evidenceDir, 'chromium-playback.png');
  await page.screenshot({ path: screenshot, fullPage: true });
  const report = {
    scope: 'fixed N00-04 fixtures served from isolated local HTTP; no ANCS project playback',
    browser: 'Playwright Chromium',
    fixtures: { video: recording.sha256, audio: audio.sha256 },
    fullDecode: true,
    videoProbe,
    audioProbe,
    playback,
    screenshot,
  };
  await writeFile(resolve(evidenceDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`PASS N00-06 isolated browser/media check; report: ${resolve(evidenceDir, 'report.json')}`);
} finally {
  await browser?.close();
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}
