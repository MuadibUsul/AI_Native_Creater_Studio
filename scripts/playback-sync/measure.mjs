import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * N03-16 真实浏览器 + 真实媒体测量（baseline 本地实时路径）。
 *
 * 做法：把**真实的** `media-element-backend`（N03-12 适配器）用 esbuild 打成浏览器包，
 * 由 Playwright 驱动真实 Chromium 播放 `packages/testing/fixtures/media-v04/` 里的真实 MP4，
 * 采集冷/热首帧、seek 耗时、播放漂移、掉帧与内存，再用 `summarizePlaybackSyncReport` 判定。
 *
 * 用法：`pnpm test:playback-sync`（需已安装 Playwright Chromium：`pnpm exec playwright install chromium`）
 * 产物：`docs/verification/artifacts/playback-sync-report.json`
 */

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const FIXTURES = join(ROOT, 'packages', 'testing', 'fixtures', 'media-v04');
const REPORT_PATH = join(ROOT, 'docs', 'verification', 'artifacts', 'playback-sync-report.json');
const ADAPTER_ENTRY = join(ROOT, 'apps', 'web', 'src', 'playback', 'media-element-backend.ts');

/** 测量矩阵：真实夹具（含 23.976 / 29.97 分数帧率与 VFR）。 */
const MATRIX = [
  { fixtureId: 'clip-a-24000-1001', file: 'clip-a-24000-1001.mp4', frameRate: { num: 24_000, den: 1_001 } },
  { fixtureId: 'clip-b-30000-1001', file: 'clip-b-30000-1001.mp4', frameRate: { num: 30_000, den: 1_001 } },
  { fixtureId: 'clip-d-synthetic-vfr', file: 'clip-d-synthetic-vfr.mp4', frameRate: { num: 30, den: 1 } },
];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mp4': 'video/mp4' };

async function serve(dir) {
  const server = createServer(async (request, response) => {
    try {
      const path = new URL(request.url, 'http://127.0.0.1').pathname;
      const file = join(dir, path === '/' ? 'harness.html' : decodeURIComponent(path));
      const body = await readFile(file);
      response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'accept-ranges': 'bytes' });
      response.end(body);
    } catch {
      response.writeHead(404).end('not found');
    }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${String(port)}` };
}

/** esbuild 只在 pnpm store 里（未 hoist 到根）；按需定位，避免为脚本改依赖或锁文件。 */
async function loadEsbuild() {
  const store = join(ROOT, 'node_modules', '.pnpm');
  const candidates = (await readdir(store)).filter((name) => name.startsWith('esbuild@')).sort();
  const latest = candidates[candidates.length - 1];
  if (latest === undefined) throw new Error('未找到 esbuild（请先 pnpm install）');
  const entry = join(store, latest, 'node_modules', 'esbuild', 'lib', 'main.js');
  const module = await import(pathToFileURL(entry).href);
  return module.build ?? module.default?.build;
}

async function main() {
  const build = await loadEsbuild();
  const { chromium } = await import('playwright');
  const contracts = await import(pathToFileURL(join(ROOT, 'packages', 'contracts', 'dist', 'index.js')).href);

  const workDir = await mkdtemp(join(tmpdir(), 'ancs-playback-sync-'));
  await build({
    entryPoints: [ADAPTER_ENTRY],
    bundle: true,
    format: 'iife',
    globalName: 'ancsPlayback',
    platform: 'browser',
    outfile: join(workDir, 'adapter.js'),
    logLevel: 'error',
    // 直接指向已构建的 dist，避免依赖 workspace 链接解析
    alias: { '@ancs/contracts': join(ROOT, 'packages', 'contracts', 'dist', 'index.js') },
  });
  await writeFile(join(workDir, 'harness.html'), await readFile(join(HERE, 'harness.html')));
  // 把真实夹具挂到同一站点下（避免 file:// 的媒体限制）
  const { server, baseUrl } = await serve(workDir);
  for (const entry of MATRIX) {
    const source = join(FIXTURES, entry.file);
    if (!existsSync(source)) throw new Error(`缺少真实夹具：${source}`);
    await writeFile(join(workDir, entry.file), await readFile(source));
  }

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  const results = [];

  for (const entry of MATRIX) {
    await page.goto(`${baseUrl}/harness.html`);
    const coldFirstFrameMs = await page.evaluate(
      ([url, num, den]) => globalThis.window.ancsHarness.load(url, num, den),
      [`${baseUrl}/${entry.file}`, entry.frameRate.num, entry.frameRate.den],
    );
    // 热缓存：同一 URL 再加载一次
    const hotFirstFrameMs = await page.evaluate(
      ([url, num, den]) => globalThis.window.ancsHarness.load(url, num, den),
      [`${baseUrl}/${entry.file}`, entry.frameRate.num, entry.frameRate.den],
    );

    const seekSamplesMs = [];
    for (const atMs of [500, 1_200, 300, 900, 1_500, 700]) {
      seekSamplesMs.push(await page.evaluate((ms) => globalThis.window.ancsHarness.seek(ms), atMs));
    }

    await page.evaluate(() => globalThis.window.ancsHarness.play());
    const samples = [];
    for (let index = 0; index < 12; index += 1) {
      await page.waitForTimeout(250);
      samples.push(await page.evaluate(() => globalThis.window.ancsHarness.driftSample()));
    }
    await page.evaluate(() => globalThis.window.ancsHarness.pause());
    const durationMs = await page.evaluate(() => globalThis.window.ancsHarness.durationMs());
    await page.evaluate(() => globalThis.window.ancsHarness.dispose());

    results.push({
      fixtureId: entry.fixtureId,
      path: 'LOCAL_REALTIME',
      backendKind: 'HTML_MEDIA_BASELINE',
      // 浏览器直出受支持 proxy 的前提是"不需要 WebCodecs"；精度如实为关键帧级（未做本地解码到帧）
      precision: 'KEYFRAME_APPROXIMATE',
      frameAccurateRequired: false,
      coldFirstFrameMs, hotFirstFrameMs, seekSamplesMs, samples, durationMs,
    });
  }

  await browser.close();
  server.close();

  const report = contracts.summarizePlaybackSyncReport({ results });
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ overall: report.overall, byPath: report.byPath, fixtures: report.fixtures.map((fixture) => ({ fixtureId: fixture.fixtureId, verdict: fixture.verdict, reasons: fixture.failureReasons })) }, null, 2));
  console.log(`报告已写入：${REPORT_PATH}`);
}

main().catch((error) => {
  console.error(`测量失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
