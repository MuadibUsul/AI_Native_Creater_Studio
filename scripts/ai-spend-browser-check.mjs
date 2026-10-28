#!/usr/bin/env node
// 工作区 AI 月度费用上限 真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker）+ Next 生产服务（127.0.0.1:3000）。
// 部署缺省上限设为 $1.00（与生产的 ANCS_AI_MONTHLY_CAP_USD 同一条注入路径：configureDeploymentPolicy）。
// AI 导演：**脚本导演**（SCRIPTED，不调用真实 Provider），每次调用报告 20 万输入 token、按价格表里输入 $4/MTok 的模型单价计 $0.80——
// 用来验证"每次模型调用前检查上限、达到即停下并说明、之后不能再开始、界面说明额度与恢复日期"，不证明剪辑质量。
//
// 用法：node scripts/ai-spend-browser-check.mjs   证据写入 docs/verification/artifacts/ai-spend/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { AGENT_MODEL_PRICES, mergeModelPrices } from '../packages/contracts/dist/index.js';
import { configureDeploymentPolicy } from '../packages/domain/dist/index.js';
import { createModelVisualAnalysisAdapter } from '../apps/worker/dist/model-visual-analysis.js';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/ai-spend');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `ai-spend-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

/** 每次调用 $0.80：前两次看素材，第三次回答（上限 $1 时第三次不会发生） */
class PricedScriptedDirector {
  providerId = 'scripted';
  implementation = 'SCRIPTED';
  model = Object.keys(AGENT_MODEL_PRICES).find((model) => AGENT_MODEL_PRICES[model].inputMicrosPerMTok === 4_000_000);
  calls = 0;
  async respond(request) {
    this.calls += 1;
    const usage = { inputTokens: 200_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const done = request.messages.filter((message) => message.role === 'assistant').length;
    if (done < 2) return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'list_footage', input: {} }], stopReason: 'tool_use', usage };
    return { model: this.model, content: [{ type: 'text', text: '看完了。' }], stopReason: 'end_turn', usage };
  }
}

/** 画面理解用的脚本视觉模型：每次调用 10 万输入 token（$0.40），按帧数回逐帧说明 */
class PricedScriptedVision {
  providerId = 'scripted';
  implementation = 'SCRIPTED';
  model = Object.keys(AGENT_MODEL_PRICES).find((model) => AGENT_MODEL_PRICES[model].inputMicrosPerMTok === 4_000_000);
  calls = 0;
  async respond(request) {
    this.calls += 1;
    const frames = request.messages[0].content.filter((block) => block.type === 'image').length;
    return {
      model: this.model, stopReason: 'end_turn', usage: { inputTokens: 100_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      content: [{ type: 'text', text: JSON.stringify(Array.from({ length: frames }, (_, frame) => ({ frame, description: 'test pattern on screen' }))) }],
    };
  }
}

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  const director = new PricedScriptedDirector();
  const vision = new PricedScriptedVision();
  // 4 秒素材、每秒一帧、每批一帧 → 一次完整的画面理解 = 4 次调用 $1.60
  const mediaVisualAnalysisAdapter = createModelVisualAnalysisAdapter({ model: vision, minIntervalMs: 1000, batchSize: 1 });
  env = await startStudioEnv({ director, mediaVisualAnalysisAdapter, webPort, workDirPrefix: 'ancs-ai-spend-' });
  configureDeploymentPolicy({ aiMonthlyCapMicros: 1_000_000 });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: 'AI 额度验收' });

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);

  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('额度测试');
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const projectId = page.url().split('/studio/')[1];
  const input = page.getByLabel('告诉 AI 怎么改');
  const sendButton = page.getByRole('button', { name: '发送' });
  await input.waitFor({ timeout: 30_000 });
  if (await page.locator('[data-ai-limit]').count() !== 0) throw new Error('limit notice shown before any spend');
  pass('额度未用完', '上限 $1.00、本月 $0：没有额度提示，可以发送');

  // 1. 说一句 → 第 1 次调用 $0.80（未达上限）→ 第 2 次 $1.60（达到）→ 第 3 次调用之前停下，说明原因
  await input.fill('看看有什么素材');
  await sendButton.click();
  const stopped = page.getByText('这个工作区本月的 AI 额度（$1.00）已用完，我先停在这里');
  await stopped.waitFor({ timeout: 60_000 });
  if (director.calls !== 2) throw new Error(`expected 2 model calls, saw ${String(director.calls)}`);
  const notice = page.locator('[data-ai-limit]');
  await notice.waitFor({ timeout: 30_000 });
  const noticeText = (await notice.textContent()) ?? '';
  if (!/^这个工作区本月的 AI 额度（\$1\.00）已用完，\d+月1日恢复。$/.test(noticeText)) throw new Error(`unexpected notice: ${noticeText}`);
  await input.fill('再剪一版');
  if (!(await sendButton.isDisabled())) throw new Error('send stays enabled after the allowance is used up');
  const costMeta = page.getByText('AI 用量 $1.60');
  const hint = await costMeta.getAttribute('title');
  if (!hint?.includes('本工作区本月 AI 费用 $1.60 / 额度 $1.00')) throw new Error(`cost hint lacks the month summary: ${String(hint)}`);
  await shot('01-cap-reached-zh');
  pass('达到上限即停', `第 2 次调用后本月 $1.60 ≥ $1.00：第 3 次调用没有发生；对话里说明"额度已用完、修改已保留"；输入框上方："${noticeText}"；发送不可用；顶栏费用提示含本月花费与额度`);

  // 2. 服务端同样拒绝（不因按钮不可用而放松）
  const sessionId = (await client.studio.state(workspace.id, projectId)).session.id;
  const denied = await client.agent.startTurn(workspace.id, sessionId, { message: '绕过界面再来一次' }).then(() => null, (error) => error);
  if (denied?.status !== 402 || denied.details?.reason !== 'AI_MONTHLY_CAP_REACHED') throw new Error(`API did not refuse the turn: ${JSON.stringify(denied?.details ?? denied)}`);
  if (director.calls !== 2) throw new Error('a refused turn reached the model');
  pass('服务端拒绝新的一轮', `SDK 直接发起 → 402 AI_MONTHLY_CAP_REACHED（capMicros ${String(denied.details.capMicros)}、spentMicros ${String(denied.details.spentMicros)}、resetsAt ${String(denied.details.resetsAt)}）；模型没有被调用`);

  // 3. 英文界面、深色、手机宽度
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  const english = page.locator('[data-ai-limit]');
  await page.waitForFunction(() => /^This workspace has used its AI allowance for this month \(\$1\.00\)\. It resets on [A-Z][a-z]+ 1\.$/.test(globalThis.document.querySelector('[data-ai-limit]')?.textContent ?? ''), undefined, { timeout: 10_000 });
  const englishText = (await english.textContent()) ?? '';
  await shot('02-cap-reached-en');
  await page.getByRole('button', { name: 'Toggle light/dark' }).click();
  await page.waitForTimeout(300);
  await shot('03-cap-reached-dark');
  await page.getByRole('button', { name: 'Toggle light/dark' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload({ waitUntil: 'networkidle' });
  await english.waitFor({ timeout: 30_000 });
  const mobileOverflow = await overflow();
  await shot('04-cap-reached-mobile');
  if (mobileOverflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(mobileOverflow)} px`);
  pass('英文、深色、手机宽度', `"${englishText}"；390 px 无横向溢出`);

  // 4. 画面理解计入同一额度：新工作区、上限 $0.70 → 上传 4 秒素材 → 第 2 次调用后停下 → 素材面板"AI 额度已用完"
  configureDeploymentPolicy({ aiMonthlyCapMicros: 700_000 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  const second = await client.workspaces.create({ name: '画面理解额度' });
  const media = join(env.workDir, 'media');
  await mkdir(media, { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(media, 'harbor.mp4')]);
  await page.goto(`${env.baseUrl}/w/${second.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('港口');
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const secondProject = page.url().split('/studio/')[1];
  await page.locator('input[type=file]').first().setInputFiles(join(media, 'harbor.mp4'));
  const visualOf = async () => (await client.studio.state(second.id, secondProject)).footage[0]?.understanding.visual ?? 'NONE';
  for (let attempt = 0; attempt < 120 && await visualOf() !== 'LIMIT_REACHED'; attempt += 1) await page.waitForTimeout(1_000);
  if (await visualOf() !== 'LIMIT_REACHED') throw new Error(`visual analysis did not stop at the cap: ${await visualOf()}`);
  if (vision.calls !== 2) throw new Error(`expected 2 vision calls before the cap, saw ${String(vision.calls)}`);
  const pausedSpend = (await client.studio.state(second.id, secondProject)).aiSpend;
  if (pausedSpend.spentMicros !== 800_000) throw new Error(`footage description was not counted: ${JSON.stringify(pausedSpend)}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: '素材 1' }).click();
  const drawer = page.getByRole('complementary', { name: '素材' });
  await drawer.getByText('AI 额度已用完').waitFor({ timeout: 30_000 });
  const retryButton = drawer.getByRole('button', { name: '重新理解「harbor.mp4」的画面' });
  await retryButton.click();
  await drawer.getByText('这个工作区本月的 AI 额度（$0.70）已用完').waitFor({ timeout: 15_000 });
  if (vision.calls !== 2) throw new Error('a refused retry reached the model');
  await shot('05-footage-paused-zh');
  await page.getByRole('button', { name: /^任务/ }).click();
  await page.getByText('工作区本月 AI 额度已用完，画面理解暂停').waitFor({ timeout: 10_000 });
  await shot('06-tasks-paused-zh');
  await page.keyboard.press('Escape');
  pass('画面理解计入额度', `上传 4 秒素材：第 2 次视觉调用后本月 $0.80 ≥ $0.70，停下并入账；素材面板"画面 AI 额度已用完"+"再理解一次画面"；额度仍用完时点它 → 说明额度与恢复日期、模型没有被调用；任务中心列出暂停`);

  // 5. 提高上限后再理解一次 → 4 次调用完成，画面"已理解"，本月花费 $0.80 + $1.60
  configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000 });
  if (!(await drawer.isVisible())) await page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: '素材 1' }).click();
  await drawer.getByRole('button', { name: '重新理解「harbor.mp4」的画面' }).click();
  for (let attempt = 0; attempt < 120 && await visualOf() !== 'READY'; attempt += 1) await page.waitForTimeout(1_000);
  if (await visualOf() !== 'READY') throw new Error(`retry did not finish: ${await visualOf()}`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('toolbar', { name: '画布工具' }).getByRole('button', { name: '素材 1' }).click();
  await drawer.locator('[data-understanding="visual:READY"]').waitFor({ timeout: 30_000 });
  const finalSpend = (await client.studio.state(second.id, secondProject)).aiSpend;
  if (vision.calls !== 6 || finalSpend.spentMicros !== 2_400_000) throw new Error(`unexpected totals after retry: calls ${String(vision.calls)}, ${JSON.stringify(finalSpend)}`);
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('complementary', { name: 'Footage' }).getByText('Understood').first().waitFor({ timeout: 10_000 });
  await shot('07-footage-understood-en');
  pass('提高上限后再理解一次', `重新排队 → 4 次调用完成，"画面 已理解"；本月 $2.40（$0.80 + $1.60）`);

  // 6. 设了上限而导演模型没有单价：不调用，说明缺哪个模型的单价；运维补上单价后照常（按单价计费）
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000 });
  director.model = 'vendor-director';
  const callsBefore = director.calls;
  const third = await client.workspaces.create({ name: '未定价模型' });
  await page.goto(`${env.baseUrl}/w/${third.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('未定价');
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  await page.getByLabel('告诉 AI 怎么改').fill('看看有什么素材');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('AI 导演使用的模型（vendor-director）还没有单价').waitFor({ timeout: 60_000 });
  if (director.calls !== callsBefore) throw new Error('an unpriced model was called under a cap');
  await shot('08-unpriced-director-zh');
  configureDeploymentPolicy({ aiMonthlyCapMicros: 5_000_000, modelPrices: mergeModelPrices({ 'vendor-director': { input: 1, output: 4 } }) });
  await page.getByLabel('告诉 AI 怎么改').fill('再看看');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('看完了。').waitFor({ timeout: 60_000 });
  // 3 次调用 × 20 万输入 token × $1/MTok = $0.60
  await page.getByText('AI 用量 $0.60').waitFor({ timeout: 30_000 });
  if (director.calls !== callsBefore + 3) throw new Error(`expected 3 priced calls, saw ${String(director.calls - callsBefore)}`);
  await shot('09-priced-after-config-zh');
  pass('模型没有单价时不调用', `上限 $5、导演模型 vendor-director 无单价：不调用，对话里说明缺哪个模型的单价与 ANCS_MODEL_PRICES_JSON；补上单价（$1/$4 每百万 token）后 3 次调用计 $0.60`);

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nAI spend cap browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  configureDeploymentPolicy({});
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
