#!/usr/bin/env node
// 真实模型的共看片室浏览器验收：导演与视觉理解都接 Google Gemini（真实 Provider，不是脚本导演）。
//
// 环境：隔离测试库（ANCS_TEST_DATABASE_URL）+ 进程内 API + 进程内 Worker（真实 FFmpeg）+ Next 生产服务（127.0.0.1:3000）+ Chromium。
// 需要环境变量 GEMINI_API_KEY（只从环境读取，不写日志）；可选 ANCS_AGENT_MODEL（缺省 gemini-flash-latest）、ANCS_VISION_MODEL
// （缺省 gemini-flash-lite-latest）。代理环境下 Node 需要 NODE_USE_ENV_PROXY=1。会产生少量模型费用。
// 真实模型的输出每次不同：这里只断言闭环（理解完成 → AI 用工具剪出试改 → 指着一段说一句 → 新试改 → 采用），
// 剪辑质量由初剪评测（scripts/eval-first-cut.mjs --model gemini）与人工评分衡量。
//
// 用法：node scripts/gemini-browser-check.mjs   证据写入 docs/verification/artifacts/gemini/
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { GeminiAgentModel } from '../packages/providers/gemini/dist/index.js';
import { createModelVisualAnalysisAdapter } from '../apps/worker/dist/model-visual-analysis.js';
import { startStudioEnv } from './lib/studio-env.mjs';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) throw new Error('GEMINI_API_KEY is required in the environment (never pass keys on the command line)');
const agentModel = process.env.ANCS_AGENT_MODEL ?? 'gemini-flash-latest';
const visionModel = process.env.ANCS_VISION_MODEL ?? 'gemini-flash-lite-latest';
const evidenceDir = resolve('docs/verification/artifacts/gemini');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `gemini-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({
    director: new GeminiAgentModel({ apiKey, model: agentModel }),
    mediaVisualAnalysisAdapter: createModelVisualAnalysisAdapter({ model: new GeminiAgentModel({ apiKey, model: visionModel }) }),
    webPort,
    workDirPrefix: 'ancs-gemini-',
  });
  const { baseUrl, workDir } = env;
  const password = await env.createUser(email);

  const footageDir = join(workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };

  // 1. 登录 → 工作区 → 新建作品
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('还没有工作区').waitFor({ timeout: 20_000 });
  await page.getByLabel('工作区名称').fill('Gemini 验收');
  await page.getByRole('button', { name: '创建工作区' }).click();
  await page.waitForURL((url) => url.searchParams.has('workspaceId') || url.pathname.startsWith('/w/'), { timeout: 20_000 });
  const landed = new URL(page.url());
  const workspaceId = landed.searchParams.get('workspaceId') ?? landed.pathname.split('/')[2];
  await page.goto(`${baseUrl}/w/${workspaceId}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('冰岛环岛自驾 · 第一天');
  await page.getByRole('radio', { name: '横屏 16:9' }).click();
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const projectId = page.url().split('/studio/')[1];

  // 2. 上传 → 素材理解：镜头索引（FFmpeg）+ 画面理解（Gemini 视觉）完成；语音转写未配置
  const uploadStarted = Date.now();
  await page.locator('input[type=file]').first().setInputFiles(sources.map(([name]) => join(footageDir, name)));
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: /^素材 3$/ }).click();
  await page.waitForFunction(() => {
    const labels = [...globalThis.document.querySelectorAll('aside b')].map((node) => node.textContent);
    return labels.filter((text) => text === '已理解').length === 6 && labels.filter((text) => text === '未配置').length === 3;
  }, null, { timeout: 300_000 });
  await shot('01-footage-understood');
  await page.getByRole('button', { name: '关闭素材面板' }).click();
  pass('Gemini 画面理解完成', `3 段素材的镜头与画面都显示“已理解”（${String(Math.round((Date.now() - uploadStarted) / 1000))} s，视觉模型 ${visionModel}）`);

  const latestTurn = () => page.evaluate(async ({ workspaceId, projectId }) => {
    const state = await (await fetch(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/studio`)).json();
    const turns = await (await fetch(`/api/v1/workspaces/${workspaceId}/agent-sessions/${state.session.id}/turns`)).json();
    return turns.items[0] ?? null;
  }, { workspaceId, projectId });
  const awaitTurn = async (previousId) => {
    const deadline = Date.now() + 420_000;
    for (;;) {
      const turn = await latestTurn();
      if (turn !== null && turn.id !== previousId && !['QUEUED', 'RUNNING'].includes(turn.status)) return turn;
      if (Date.now() > deadline) throw new Error('the AI turn did not finish in 7 minutes');
      await page.waitForTimeout(2_000);
    }
  };
  const describeTurn = (turn) => `${turn.status}；工具 ${(turn.toolCalls ?? []).map((call) => call.name).join(' → ') || '（无）'}；回应「${String(turn.reply ?? '').slice(0, 120)}」`;

  // 3. 让 AI 剪第一版 → 试改预览可播放
  let started = Date.now();
  await page.getByRole('button', { name: '让 AI 剪第一版' }).click();
  const first = await awaitTurn(null);
  if (first.status !== 'COMPLETED') throw new Error(`first cut turn ${first.status}: ${JSON.stringify(first.error ?? null)}`);
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 180_000 });
  const video = page.locator('video[aria-label]');
  await video.evaluate((element) => element.play());
  await page.waitForTimeout(1500);
  const playedTo = await video.evaluate((element) => element.currentTime);
  await video.evaluate((element) => element.pause());
  if (!(playedTo > 0.8)) throw new Error(`trial preview did not play (currentTime ${String(playedTo)})`);
  await shot('02-first-cut-trial');
  pass('真实 Gemini 导演剪出第一版试改', `${String(Math.round((Date.now() - started) / 1000))} s；${describeTurn(first)}`);

  // 4. 在时间带上拖选一段 → 说一句 → 新试改
  const lanes = page.getByLabel('片段区：拖动选择一段时间，点击选中片段');
  const box = await lanes.boundingBox();
  await page.mouse.move(box.x + box.width * 0.10, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.35, box.y + 12, { steps: 8 });
  await page.mouse.up();
  const chip = await page.getByText(/^00:\d\d\.\d–00:\d\d\.\d$/).textContent();
  await page.getByLabel('告诉 AI 怎么改').fill('这一段剪短一点，节奏快一些');
  await shot('03-pointer-selected');
  started = Date.now();
  await page.getByRole('button', { name: '发送' }).click();
  const second = await awaitTurn(first.id);
  if (second.status !== 'COMPLETED') throw new Error(`pointer turn ${second.status}: ${JSON.stringify(second.error ?? null)}`);
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 180_000 });
  await page.waitForTimeout(1_000);
  await shot('04-pointer-trial');
  pass('指着一段说一句 → 新试改', `选区 ${chip}；${String(Math.round((Date.now() - started) / 1000))} s；${describeTurn(second)}`);

  // 5. 就这样 → 写入工程
  const revisionOf = async () => Number(await page.locator('header [data-revision]').getAttribute('data-revision'));
  const before = await revisionOf();
  await page.getByRole('button', { name: '就这样' }).click();
  await page.getByRole('button', { name: '撤销这次修改' }).waitFor({ timeout: 30_000 });
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 180_000 });
  const after = await revisionOf();
  if (!(after > before)) throw new Error('adopting did not advance the project revision');
  await shot('05-adopted');
  pass('采用试改写入工程', `版本 ${String(before)} → ${String(after)}`);

  if (pageErrors.length > 0) throw new Error(`browser errors: ${pageErrors.join(' | ')}`);
  const summary = { when: new Date().toISOString(), director: `REAL gemini:${agentModel}`, vision: `REAL gemini:${visionModel}`, workspaceId, projectId, results };
  await writeFile(resolve(evidenceDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nGemini studio browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/gemini/`);
} catch (error) {
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close();
}
