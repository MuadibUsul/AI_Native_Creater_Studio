#!/usr/bin/env node
// V6-9 交给 AI 剪完（自主制作，裁决 0020 / Proposal 0.1 AP-05）真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测 / 代理 / 索引 / 预览）+ Next 生产服务（127.0.0.1:3000）。
// AI 导演：**脚本导演**（SCRIPTED，不是真实 Provider）——写一份计划、每条素材取 3 秒拼成第一版、自检与节奏、交付说明。
// 它和真实导演用同一份上下文（含 autonomous_production 区块）与同一个工具目录，用来验证授权、等素材、门禁、按档位采用、
// 交付报告与界面闭环，不证明剪辑质量；脚本导演没有价格表，报告会如实写"未定价"。
//
// 用法：node scripts/autonomous-browser-check.mjs   证据写入 docs/verification/artifacts/v6-9/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/v6-9');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v69-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const GOAL = '剪一条 15 秒的冰岛旅行短片，节奏轻快，开头要抓人';

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v69-' });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '交给 AI 剪完验收' });

  // 测试素材（真实编码的 H.264/AAC 文件，画面各不相同）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  const files = sources.map(([name]) => join(footageDir, name));

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' && /hydrat|did not match/i.test(message.text())) pageErrors.push(`console: ${message.text()}`); });
  const settle = () => page.waitForFunction(() => globalThis.document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity), undefined, { timeout: 2_000 }).catch(() => undefined);
  const shot = async (name) => { await settle(); await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const overflow = () => page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);

  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  // 1. 新建页：勾上"交给 AI 自己剪完"，写需求、目标 15 秒、"自检通过就直接用"、上限 $2 → 交给 AI
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByLabel('作品名称').fill('冰岛环岛');
  await page.getByRole('checkbox', { name: '交给 AI 自己剪完' }).check();
  await page.getByLabel('你想要一条什么样的视频').fill(GOAL);
  await page.getByLabel('目标时长').selectOption('15');
  await page.getByRole('radio', { name: /自检通过就直接用/ }).click();
  await page.getByLabel('AI 费用上限（美元）').fill('2');
  await shot('01-new-delegate');
  await page.getByRole('button', { name: '交给 AI', exact: true }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const projectId = page.url().split('/studio/')[1];
  const card = page.getByRole('article', { name: 'AI 自己剪' });
  await card.getByText('等素材准备好').waitFor({ timeout: 30_000 });
  const signed = await client.autonomy.get(workspace.id, projectId);
  if (signed.approval !== 'AUTO_SAFE' || signed.budgetMicros !== 2_000_000 || signed.signature === null) throw new Error(`authorization not signed as chosen: ${JSON.stringify(signed)}`);
  await shot('02-waiting-for-footage');
  pass('新建页交给 AI', `授权第 ${String(signed.signature.version)} 版：自检通过就直接用、上限 $2.00（签署人与时间由服务端写入）；进入共看片室显示"等素材准备好"`);

  // 2. 放入素材 → AI 等处理完自己开始 → 计划、粗剪、自检、节奏 → 自检通过 → 直接采用 → 交付报告
  const started = Date.now();
  const revisionBefore = (await client.studio.state(workspace.id, projectId)).project.revision;
  await page.locator('input[type=file]').setInputFiles(files);
  await card.getByText(/^(剪好了|剪好了，等你看|没能剪完)$/).waitFor({ timeout: 240_000 });
  const deliveredSeconds = (Date.now() - started) / 1000;
  const runs = await client.autonomy.listRuns(workspace.id, projectId);
  const run = runs[0];
  if (run.status !== 'DELIVERED' || run.report?.outcome !== 'ADOPTED') throw new Error(`expected an adopted delivery, got ${run.status} / ${JSON.stringify(run.report)}`);
  const after = await client.studio.state(workspace.id, projectId);
  if (after.project.revision === revisionBefore || run.adoptedRevision !== after.project.revision) throw new Error(`adoption did not become the current version (${String(revisionBefore)} → ${String(after.project.revision)}, run ${String(run.adoptedRevision)})`);
  const plan = await client.autonomy.latestPlan(workspace.id, projectId);
  if (plan === null || plan.scenes.length !== 3) throw new Error('the production plan was not saved');
  const report = card.getByRole('region', { name: '交付报告' });
  await report.getByText('成片 9.000 秒 · 3 个片段 · 0 条字幕 · 画面里 100% 来自你的素材').waitFor({ timeout: 10_000 });
  await report.getByText('用到的素材：glacier.mp4 （3.000 秒）、lake.mp4 （3.000 秒）、road.mp4 （3.000 秒）').waitFor();
  // 没有语音识别：自检如实说明"句中剪断"没检查（翻译成界面语言，不显示给导演看的英文原文）
  await report.getByText('没有检查：句中剪断（没有转写）').waitFor();
  await report.getByText('时长：目标 15 秒，实际 9.0 秒').waitFor();
  await report.getByText('导演模型没有价格表，花费无法核算').waitFor();
  await report.getByText(/^花费 \$0 \/ 上限 \$2\.00 · 另有 \d+ 次调用未定价$/).waitFor();
  await card.getByText('已采用为当前版本，可以撤销。').waitFor();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  await page.getByRole('region', { name: '和 AI 说' }).getByText(GOAL).first().waitFor();
  await shot('03-delivered-adopted');
  pass('等素材 → 自己剪完 → 自检通过直接采用', `从放入素材到交付 ${deliveredSeconds.toFixed(1)} s；版本 ${String(revisionBefore)} → ${String(after.project.revision)}（AI 采用）；计划 ${String(plan.scenes.length)} 场；报告：9 秒 / 3 段 / 原片 100%，如实列出"目标 15 秒、实际 9 秒"与"未定价"`);

  // 3. 英文、深色、手机宽度（交付报告同一结构）
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  const cardEn = page.getByRole('article', { name: 'AI editing on its own' });
  await cardEn.getByText('Done', { exact: true }).waitFor();
  await cardEn.getByText('Length: target 15 s, actual 9.0 s').waitFor();
  await cardEn.getByText('Adopted as the current version. You can undo it.').waitFor();
  await shot('04-delivered-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('05-delivered-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await card.scrollIntoViewIfNeeded();
  const studioOverflow = await overflow();
  await shot('06-delivered-mobile');
  if (studioOverflow > 1) throw new Error(`horizontal overflow at 390 px in the studio: ${String(studioOverflow)} px`);
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.getByRole('checkbox', { name: '交给 AI 自己剪完' }).check();
  await page.waitForTimeout(300);
  const newOverflow = await overflow();
  await shot('07-new-delegate-mobile');
  if (newOverflow > 1) throw new Error(`horizontal overflow at 390 px on the new page: ${String(newOverflow)} px`);
  await page.setViewportSize({ width: 1440, height: 900 });
  pass('中英切换、深色、手机宽度', '交付卡与报告随语言切换；共看片室与新建页在 390 px 无横向溢出');

  // 4. 共看片室里交给 AI（"先给我看"）：自检通过也只做成试改 → 在对话里"就这样"采用
  const second = await client.studio.create(workspace.id, { title: '湖边', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `v69-${randomUUID()}` });
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${second.projectId}`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles(files);
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '交给 AI 剪完…' }).click();
  const dialog = page.getByRole('dialog', { name: '交给 AI 剪完' });
  await dialog.getByLabel('你想要一条什么样的视频').fill('剪一条湖边的短片，安静一点');
  await dialog.getByLabel('AI 费用上限（美元）').fill('1');
  if ((await dialog.getByRole('radio', { name: /先给我看/ }).getAttribute('aria-checked')) !== 'true') throw new Error('"Show me first" should be the default tier');
  await shot('08-studio-dialog');
  await dialog.getByRole('button', { name: '交给 AI', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });
  const secondCard = page.getByRole('article', { name: 'AI 自己剪' });
  await secondCard.getByText('剪好了，等你看').waitFor({ timeout: 240_000 });
  await secondCard.getByText('保留为试改：在对话里"就这样"采用，或"撤回"。你选了"先给我看"。').waitFor();
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  const trialRevision = (await client.studio.state(workspace.id, second.projectId)).project.revision;
  await shot('09-trial-ask-each');
  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  const kept = await client.studio.state(workspace.id, second.projectId);
  if (kept.project.revision === trialRevision) throw new Error('keeping the trial did not create a new version');
  pass('共看片室里交给 AI（先给我看）', `做成试改不改作品（版本 ${String(trialRevision)} 不变）；你在对话里"就这样"后成为版本 ${String(kept.project.revision)}`);

  // 5. 等素材时停下：没有素材的工程交给 AI → "等素材准备好" → 停下 → "已停下"（没有花钱，也没有改作品）
  const third = await client.studio.create(workspace.id, { title: '还没拍', aspectRatio: '9:16', locale: 'zh-CN' }, { idempotencyKey: `v69-${randomUUID()}` });
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${third.projectId}`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '交给 AI 剪完…' }).click();
  await page.getByRole('dialog', { name: '交给 AI 剪完' }).getByLabel('你想要一条什么样的视频').fill('竖屏短片');
  await page.getByRole('dialog', { name: '交给 AI 剪完' }).getByRole('button', { name: '交给 AI', exact: true }).click();
  const thirdCard = page.getByRole('article', { name: 'AI 自己剪' });
  await thirdCard.getByText('等素材准备好').waitFor({ timeout: 30_000 });
  await thirdCard.getByRole('button', { name: '停下' }).click();
  await thirdCard.getByText('已停下').waitFor({ timeout: 30_000 });
  const stopped = (await client.autonomy.listRuns(workspace.id, third.projectId))[0];
  if (stopped.status !== 'CANCELLED' || stopped.turnId !== null) throw new Error(`stop while waiting: ${stopped.status} / turn ${String(stopped.turnId)}`);
  await shot('10-stopped-waiting');
  pass('等素材时停下', '运行结束为"已停下"；没有开始导演（没有模型调用），作品没变');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-9 autonomous browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
