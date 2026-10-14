#!/usr/bin/env node
// V6-7 / V6-8 付费生成 真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 预览）+ Next 生产服务（127.0.0.1:3000）。
// AI：**脚本导演**（SCRIPTED）——听到"重绘/数字人"就先看可用选项再报价，只验证界面与服务端闭环。
// 生成供应商：**FFmpeg 测试替身**（SCRIPTED，卡片上标明"测试替身"）——选区重绘 = 框内调色、框外原样；数字人 = 参考照片 + flite 读讲稿。
// 它们不是供应商：真实 HeyGen / Fish Audio / 视频生成的验证见 docs/V06/integration-checklist.md。
//
// 用法：node scripts/generation-browser-check.mjs   证据写入 docs/verification/artifacts/v6-7/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { upsertBudget } from '../packages/domain/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve('docs/verification/artifacts/v6-7');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v67-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v67-', generation: {} });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '付费生成验收' });
  // 工作区生成预算 $20（2000 Credits）；没有预算时确认会被拒绝（另由集成测试覆盖）
  await upsertBudget(env.deps, { workspaceId: workspace.id, input: { period: 'MONTHLY', limitCredits: 2000, perJobMaxCredits: 0 } });
  const media = join(env.workDir, 'media');
  await mkdir(media, { recursive: true });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(media, 'old-town.mp4')]);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xf59e0b:s=512x512:d=1', '-frames:v', '1', join(media, 'face.png')]);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'flite=text=This is my voice sample for the studio.:voice=slt', join(media, 'my-voice.wav')]);

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const say = async (text) => {
    await page.getByLabel('告诉 AI 怎么改').fill(text);
    await page.getByRole('button', { name: '发送' }).click();
  };
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  // 0. 一条素材作品：上传 → AI 第一版 → 采用
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('老城散步');
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const projectId = page.url().split('/studio/')[1];
  await page.locator('input[type=file]').first().setInputFiles(join(media, 'old-town.mp4'));
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '让 AI 剪第一版' }).click();
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });

  // 1. 生成开关（素材作品默认不允许）
  const toggle = page.getByRole('button', { name: /生成：关/ });
  await toggle.click();
  await page.getByRole('button', { name: /生成：开/ }).waitFor();
  pass('生成规则开关', '素材作品默认"生成：关"，显式打开后才允许 AI 报价');

  // 2. 框出右上角 → 说"重绘" → AI 只报价 → 报价卡
  await page.getByRole('button', { name: '框选画面' }).click();
  const frame = await page.getByRole('application', { name: /在画面上拖动/ }).boundingBox();
  await page.mouse.move(frame.x + frame.width * 0.55, frame.y + frame.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width * 0.95, frame.y + frame.height * 0.45, { steps: 8 });
  await page.mouse.up();
  await page.getByRole('img', { name: '框出的画面区域' }).waitFor();
  await say('把框里的天空换成「sunset sky with warm clouds」');
  const regionCard = page.getByRole('article', { name: /^重绘框出的区域 · / });
  await regionCard.waitFor({ timeout: 60_000 });
  await page.getByText(/^报好价了：约 /).waitFor({ timeout: 30_000 });
  const cardText = await regionCard.innerText();
  if (!cardText.includes('测试替身') || !cardText.includes('本期还剩 $20.00')) throw new Error(`quote card is missing the test-double label or budget: ${cardText}`);
  const quoted = (await client.studio.state(workspace.id, projectId)).generations[0];
  if (quoted.status !== 'QUOTED') throw new Error(`expected a quote, got ${quoted.status}`);
  await shot('01-region-quote');
  pass('选区重绘报价', `报价卡：${quoted.estimatedSeconds} 秒，$${(quoted.estimate.minMicros / 1e6).toFixed(2)}–$${(quoted.estimate.maxMicros / 1e6).toFixed(2)}，测试替身已标明，预算剩余 $20.00；此时没有生成、没有扣费`);

  // 3. 确认 → 生成 → 试改
  const started = Date.now();
  await regionCard.getByRole('button', { name: /确认生成/ }).click();
  await page.getByText(/^选区重绘好了/).waitFor({ timeout: 300_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 300_000 });
  const regionSeconds = (Date.now() - started) / 1000;
  await page.getByRole('button', { name: /^片段 重绘框出的区域，/ }).waitFor({ timeout: 10_000 });
  const afterRegion = await client.studio.state(workspace.id, projectId);
  const done = afterRegion.generations.find((item) => item.id === quoted.id);
  if (done.status !== 'SUCCEEDED' || done.outsideRegionChange === null || done.outsideRegionChange > 4) throw new Error(`region generation: ${JSON.stringify(done)}`);
  const proposal = await client.projects.proposal(workspace.id, projectId, done.proposalId);
  if (!JSON.stringify(proposal).includes('set_clip_crop')) throw new Error('the regenerated layer is not cropped to the region');
  await shot('02-region-trial');
  pass('确认后生成并放进试改', `实际花费 $${(done.chargedMicros / 1e6).toFixed(2)}（${done.costSource}）；GEN 轨 + 裁切到选区；圈外平均差 ${String(done.outsideRegionChange)}；预算剩余 $${((afterRegion.generationBudget.limitMicros - afterRegion.generationBudget.spentMicros) / 1e6).toFixed(2)}；从确认到试改预览 ${regionSeconds.toFixed(1)} s`);
  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });

  // 4. 我的形象与声音：上传照片与声音样本，读声明并授权
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/identity`, { waitUntil: 'networkidle' });
  await page.getByLabel('档案名字').fill('我自己');
  await page.getByRole('button', { name: '新建档案' }).click();
  const card = page.getByRole('region', { name: '我自己' });
  await card.waitFor({ timeout: 20_000 });
  await card.locator('input[type=file][aria-label="上传照片"]').setInputFiles(join(media, 'face.png'));
  await card.getByText('参考：face.png').waitFor({ timeout: 60_000 });
  await card.getByRole('button', { name: '我同意以上声明' }).first().click();
  await card.getByText(/授权（这是我本人）/).first().waitFor({ timeout: 20_000 });
  await card.locator('input[type=file][aria-label="上传声音样本"]').setInputFiles(join(media, 'my-voice.wav'));
  await card.getByText('参考：my-voice.wav').waitFor({ timeout: 60_000 });
  await card.getByRole('button', { name: '我同意以上声明' }).click();
  await waitFor(async () => (await card.getByText('可用于生成').count()), (count) => count === 2, { label: 'both parts ready', timeoutMs: 20_000 });
  await card.getByText(/^授权记录 \(2\)$/).click();
  await shot('03-identity');
  const profiles = await client.identities.list(workspace.id);
  pass('我的形象与声音', `照片与声音样本上传后各读一次声明并授权；授权记录 ${String(profiles[0].history.length)} 条（只增不改）；两项都"可用于生成"`);

  // 5. 数字人出镜（画中画）：需要允许合成语音
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${projectId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: /配音：关/ }).click();
  await page.getByRole('button', { name: /配音：开/ }).waitFor();
  await say('用我的数字人在右下角说「Welcome to the old town.」');
  const avatarCard = page.getByRole('article', { name: /^数字人出镜 · / });
  await avatarCard.waitFor({ timeout: 60_000 });
  await avatarCard.getByRole('link', { name: '我的形象与声音' }).waitFor();
  await shot('04-avatar-quote');
  await avatarCard.getByRole('button', { name: /确认生成/ }).click();
  await page.getByText(/^数字人出镜好了/).waitFor({ timeout: 300_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 300_000 });
  const avatar = (await client.studio.state(workspace.id, projectId)).generations.find((item) => item.kind === 'AVATAR_CLIP');
  if (avatar?.status !== 'SUCCEEDED') throw new Error(`avatar generation: ${JSON.stringify(avatar)}`);
  const avatarProposal = JSON.stringify(await client.projects.proposal(workspace.id, projectId, avatar.proposalId));
  if (!avatarProposal.includes('"AV1"') || !avatarProposal.includes('set_clip_transform')) throw new Error('avatar clip is not placed with its voice in the corner');
  await page.getByRole('button', { name: /^片段 数字人出镜，/ }).first().waitFor();
  const video = page.locator('video');
  await video.evaluate((element) => new Promise((done) => { element.pause(); element.addEventListener('seeked', () => done(undefined), { once: true }); element.currentTime = 1; }));
  await page.waitForTimeout(400);
  await shot('05-avatar-trial');
  pass('数字人出镜（画中画）', `报价 → 确认 → 有声片段：GEN 轨画面缩到右下角 + AV1 人声轨；实际花费 $${(avatar.chargedMicros / 1e6).toFixed(2)}`);

  // 6. 英文、深色、手机宽度
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('button', { name: /Generation: on/ }).waitFor();
  await shot('06-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('07-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/identity`, { waitUntil: 'networkidle' });
  await page.getByRole('region', { name: '我自己' }).waitFor();
  const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
  await shot('08-identity-mobile');
  if (overflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(overflow)} px`);
  pass('中英切换、深色、手机宽度', '"Generation: on"；我的形象与声音页 390 px 无横向溢出');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-7/V6-8 generation browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/v6-7/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
