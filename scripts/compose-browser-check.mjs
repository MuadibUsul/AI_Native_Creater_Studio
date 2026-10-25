#!/usr/bin/env node
// 生产镜像部署演练（可重复）：在 docker compose 起好的整套服务上（db / migrate / api / worker / realtime / scheduler / web，
// 全部来自 Dockerfile 构建的 ancs:runtime 与 ancs:worker 镜像），用真实浏览器走一遍：建首个账号（user:create 命令，
// 在 api 容器里跑）→ 登录 → 建工作区 → 新建视频 → 上传素材 → 容器里的 Worker（FFmpeg）探测 / 代理 / 索引完成 → 画布显示素材画框；
// 再验证生产不装配任何 Mock（不设 ANCS_ALLOW_MOCK_PROVIDERS 也能启动；旧 V4 流水线 off，旧页面引导到共看片室）、
// 就绪探针、API 优雅退出（排空期间 /ready 503、退出码 0）与重启后恢复。
//
// 前置：docker compose -f infra/docker-compose.prod.yml --env-file infra/production.env up -d（Web 发布在 BASE_URL）
// 用法：node scripts/compose-browser-check.mjs   证据写入 docs/verification/artifacts/deploy/
//       （ANCS_COMPOSE_BASE_URL 缺省 http://localhost:3000；ANCS_BROWSER_EXECUTABLE 可指定 Chromium）
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/deploy');
const baseUrl = (process.env.ANCS_COMPOSE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const compose = ['compose', '-f', 'infra/docker-compose.prod.yml', '--env-file', process.env.ANCS_COMPOSE_ENV_FILE ?? 'infra/production.env'];
const docker = (args, options = {}) => execFileSync('docker', [...compose, ...args], { encoding: 'utf8', ...options });
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const waitUntil = async (check, { timeoutMs = 60_000, intervalMs = 500, label }) => {
  const started = Date.now();
  for (;;) {
    const value = await check().catch(() => false);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, intervalMs));
  }
};

let browser;
let page;
let workDir;

try {
  await mkdir(evidenceDir, { recursive: true });
  workDir = await mkdtemp(join(tmpdir(), 'ancs-compose-'));
  const status = JSON.parse(`[${docker(['ps', '-a', '--format', 'json']).trim().split('\n').join(',')}]`);
  const state = Object.fromEntries(status.map((item) => [item.Service, `${item.State}${item.Health ? `/${item.Health}` : ''}${item.ExitCode !== undefined && item.State === 'exited' ? `:${String(item.ExitCode)}` : ''}`]));
  for (const service of ['db', 'api', 'web', 'worker', 'realtime', 'scheduler']) if (!String(state[service]).startsWith('running')) throw new Error(`${service} is not running: ${String(state[service])}`);
  if (state['migrate'] !== 'exited:0') throw new Error(`migrate did not exit 0: ${String(state['migrate'])}`);
  const ready = await (await fetch(`${baseUrl}/api/v1/ready`)).json();
  if (ready.status !== 'ready' || ready.checks.database !== 'ok') throw new Error(`not ready: ${JSON.stringify(ready)}`);
  pass('整套服务由镜像启动', `migrate 退出 0 后 api / worker / realtime / scheduler / web 启动；经 Web 转发的 /api/v1/ready = ready（database ok）；${JSON.stringify(state)}`);

  // 1. 建首个账号（在 api 容器里跑 user:create；密码只经环境变量）
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`;
  const password = randomBytes(18).toString('base64url');
  const created = docker(['run', '--rm', '--no-deps', '-e', `ANCS_NEW_USER_EMAIL=${email}`, '-e', 'ANCS_NEW_USER_PASSWORD', '-e', 'ANCS_NEW_USER_NAME=Owner', 'api', 'node', 'apps/api/dist/cli/create-user.js'], { env: { ...process.env, ANCS_NEW_USER_PASSWORD: password } });
  if (!created.includes(email) || created.includes(password)) throw new Error(`user:create output unexpected: ${created}`);
  pass('建首个账号', 'user:create 在 api 容器里运行，密码不出现在输出里');

  // 2. 浏览器：登录 → 建工作区 → 新建视频 → 上传素材 → 容器里的 Worker 处理完
  const footage = join(workDir, 'glacier.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', footage]);
  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('还没有工作区').waitFor({ timeout: 30_000 });
  await page.getByLabel('工作区名称').fill('部署演练');
  await page.getByRole('button', { name: '创建工作区' }).click();
  await page.getByRole('heading', { name: '今天想做一条什么视频？' }).waitFor({ timeout: 30_000 });
  await shot('01-home');
  const workspaceId = new URL(page.url()).searchParams.get('workspaceId') ?? await page.evaluate(() => globalThis.document.querySelector('a[href^="/w/"]')?.getAttribute('href')?.split('/')[2] ?? null);
  await page.goto(`${baseUrl}/w/${String(workspaceId)}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('部署演练 · 冰川');
  await page.getByRole('button', { name: '开始', exact: true }).click();
  await page.getByText('放入素材，或说说你想做什么。').waitFor({ timeout: 30_000 });
  const started = Date.now();
  await page.locator('input[type=file]').setInputFiles(footage);
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 180_000 });
  await page.getByRole('region', { name: '素材 1' }).waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('video[aria-hidden="true"]')].some((video) => video.readyState >= 2 && video.videoWidth > 0), null, { timeout: 30_000 });
  const processedSeconds = (Date.now() - started) / 1000;
  await shot('02-footage-processed');
  pass('上传与处理', `浏览器上传 → 共享存储卷 → 容器里的 Worker（FFmpeg）探测 / 代理 / 索引完成，用时 ${processedSeconds.toFixed(1)} s；画布素材画框的预览经签名地址真实加载`);

  // 3. 生产不装配 Mock：api 容器里没有 ANCS_ALLOW_MOCK_PROVIDERS；/capabilities 报告旧流水线 off、没有 MOCK 驱动；旧新建页只给说明
  docker(['exec', '-T', 'api', 'node', '-e', 'process.exit(process.env.ANCS_ALLOW_MOCK_PROVIDERS === undefined ? 0 : 1)'], { stdio: 'pipe' });
  const capabilities = await (await fetch(`${baseUrl}/api/v1/capabilities`)).json();
  const mocks = capabilities.providers.filter((entry) => entry.implementation !== 'REAL');
  if (capabilities.legacyPipeline !== 'off' || mocks.length > 0) throw new Error(`production still wires mocks: ${JSON.stringify({ legacyPipeline: capabilities.legacyPipeline, mocks })}`);
  const studioUrl = page.url();
  await page.goto(`${baseUrl}/w/${String(workspaceId)}/new`, { waitUntil: 'networkidle' });
  await page.getByText('这里不再用旧版脚本 / 分镜流程制作').waitFor({ timeout: 30_000 });
  if (await page.getByRole('link', { name: '去共看片室新建' }).getAttribute('href') !== `/w/${String(workspaceId)}/studio/new`) throw new Error('legacy notice does not lead to the studio');
  await shot('04-legacy-off');
  await page.goto(studioUrl, { waitUntil: 'networkidle' });
  pass('生产不装配 Mock', `api 未设 ANCS_ALLOW_MOCK_PROVIDERS 照常启动；/api/v1/capabilities：legacyPipeline = off、非真实驱动 0 个；旧新建页只显示说明并引导到共看片室`);

  // 4. API 优雅退出：排空期间 /ready 503、存活 200；退出码 0；重启后恢复就绪
  // 异步执行 docker stop（同步执行会阻塞事件循环，看不到排空期间的探针）
  const stop = promisify(execFile)('docker', [...compose, 'stop', '-t', '40', 'api']);
  const draining = await waitUntil(async () => {
    const response = await fetch(`${baseUrl}/api/v1/ready`);
    return response.status === 503 ? response.json() : false;
  }, { timeoutMs: 15_000, intervalMs: 200, label: 'draining' });
  if (draining.draining !== true) throw new Error(`expected draining: ${JSON.stringify(draining)}`);
  await stop;
  const exitCode = docker(['ps', '-a', '--format', '{{.Service}} {{.ExitCode}}']).split('\n').find((line) => line.startsWith('api '))?.split(' ')[1];
  if (exitCode !== '0') throw new Error(`api exit code ${String(exitCode)}`);
  const logs = docker(['logs', '--no-log-prefix', 'api']);
  if (!logs.includes('已优雅退出')) throw new Error('api did not log a graceful exit');
  docker(['start', 'api'], { stdio: 'pipe' });
  await waitUntil(async () => (await (await fetch(`${baseUrl}/api/v1/ready`)).json()).status === 'ready', { timeoutMs: 90_000, label: 'api ready again' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('region', { name: '素材 1' }).waitFor({ timeout: 30_000 });
  await shot('05-after-api-restart');
  pass('优雅退出与恢复', 'docker stop api：排空期间 /api/v1/ready 503（draining: true）、退出码 0、日志"已优雅退出"；重新启动后就绪，作品与素材都在');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nCompose deployment check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
}
