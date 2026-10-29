#!/usr/bin/env node
// V6-10 长素材分章并行（docs/V06/milestones/V6-10.md）真实浏览器验收（可重复）。
//
// 环境：同 autonomous-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测 / 代理 / 索引 / 预览）+ Next 生产服务（127.0.0.1:3000）。
// 分章门槛调低到 10 秒、资源池 2，三条 6 秒素材就会分成三章。
// AI 导演：**脚本导演**（SCRIPTED，不是真实 Provider）——每条素材一章，每章取 3 秒；第 2 章（lake.mp4）故意剪不成，
// 重做前去掉这个故障。用来验证逐章进度、交付报告里的各章结果、只重做没剪成的那一章并放回原位，不证明剪辑质量。
//
// 用法：node scripts/autonomous-chapters-browser-check.mjs   证据写入 docs/verification/artifacts/v6-10/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { readTimelineSnapshot } from '../packages/domain/dist/edit-trial.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/v6-10');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v610-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const GOAL = '把三段素材剪成一条冰岛短片，按素材顺序';

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  const director = new ScriptedDirector({ failChapters: ['lake.mp4'], chapterDelayMs: 1500 });
  env = await startStudioEnv({ director, webPort, workDirPrefix: 'ancs-v610-', chapters: { minFootageSeconds: 10, concurrency: 2, retries: 1 } });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '分章验收' });

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

  // 1. 共看片室：放入三条素材 → 交给 AI 剪完（自检通过就直接用）→ 素材够长，分章在剪：逐章显示进度
  const ref = await client.studio.create(workspace.id, { title: '冰岛三段', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `v610-${randomUUID()}` });
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${ref.projectId}`, { waitUntil: 'networkidle' });
  await page.locator('input[type=file]').setInputFiles(files);
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '交给 AI 剪完…' }).click();
  const dialog = page.getByRole('dialog', { name: '交给 AI 剪完' });
  await dialog.getByLabel('你想要一条什么样的视频').fill(GOAL);
  await dialog.getByRole('radio', { name: /自检通过就直接用/ }).click();
  await dialog.getByLabel('AI 费用上限（美元）').fill('2');
  await dialog.getByRole('button', { name: '交给 AI', exact: true }).click();
  await dialog.waitFor({ state: 'detached', timeout: 15_000 });
  const card = page.getByRole('article', { name: 'AI 自己剪' });
  const chapters = card.getByRole('list', { name: '各章' });
  await card.getByText('分章在剪', { exact: true }).waitFor({ timeout: 60_000 });
  await chapters.getByText('剪辑中').first().waitFor({ timeout: 60_000 });
  const cuttingLines = await chapters.getByRole('listitem').allTextContents();
  if (cuttingLines.length !== 3) throw new Error(`expected 3 chapters while cutting, got ${JSON.stringify(cuttingLines)}`);
  await shot('01-chapters-cutting');
  pass('分章在剪：逐章进度', cuttingLines.join(' | '));

  // 2. 交付：第 1、3 章拼进成片，第 2 章没剪成（写明原因），可以只重做这一章
  await card.getByText(/^(剪好了|剪好了，等你看|没能剪完)$/).waitFor({ timeout: 240_000 });
  const first = (await client.autonomy.listRuns(workspace.id, ref.projectId))[0];
  if (first.mode !== 'CHAPTERS' || first.status !== 'DELIVERED' || first.report?.outcome !== 'ADOPTED') throw new Error(`expected an adopted chapter delivery, got ${first.mode} / ${first.status} / ${first.report?.outcome}`);
  if (first.chapters.map((chapter) => chapter.status).join(',') !== 'SUCCEEDED,FAILED,SUCCEEDED') throw new Error(`chapter statuses: ${JSON.stringify(first.chapters.map((chapter) => [chapter.title, chapter.status]))}`);
  await chapters.getByText('在成片 0.000–3.000 秒').waitFor();
  await chapters.getByText('在成片 3.000–6.000 秒').waitFor();
  await chapters.getByText('没剪成').waitFor();
  await card.getByText('没拼进成片的章节：lake.mp4').waitFor();
  const deliveredLines = await chapters.getByRole('listitem').allTextContents();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  // 对话栏会滚到最底：截图前把卡片顶部（状态与各章）滚进视野
  await card.evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await shot('02-delivered-chapter-missing');
  pass('交付报告逐章写明', deliveredLines.join(' | '));

  // 3. 只重做第 2 章：去掉脚本故障 → 点"重做「lake.mp4」"→ 新的一次运行，只剪这一章
  director.failChapters.clear();
  const callsBefore = director.calls;
  await card.getByRole('button', { name: '重做「lake.mp4」' }).click();
  await card.getByText('重做第 2 章「lake.mp4」，剪好后放回原来的位置').waitFor({ timeout: 30_000 });
  await card.getByText('分章在剪', { exact: true }).waitFor({ timeout: 30_000 }).catch(() => undefined);
  await shot('03-redo-cutting');
  await card.getByText(/^(剪好了|剪好了，等你看|没能剪完)$/).waitFor({ timeout: 240_000 });
  const redo = (await client.autonomy.listRuns(workspace.id, ref.projectId))[0];
  if (redo.id === first.id || redo.redoOf?.runId !== first.id || redo.status !== 'DELIVERED' || redo.report?.outcome !== 'ADOPTED') throw new Error(`redo run: ${JSON.stringify({ id: redo.id, redoOf: redo.redoOf, status: redo.status, outcome: redo.report?.outcome })}`);
  if (JSON.stringify(redo.report.chapters.map((chapter) => [chapter.title, chapter.outcome, chapter.placement])) !== JSON.stringify([['lake.mp4', 'ASSEMBLED', ['3.000', '6.000']]])) {
    throw new Error(`redo report chapters: ${JSON.stringify(redo.report.chapters)}`);
  }
  await card.getByRole('list', { name: '各章' }).getByText('在成片 3.000–6.000 秒').waitFor();
  // 作品：三段按顺序，第 3 章后移到 6–9 秒
  const state = await client.studio.state(workspace.id, ref.projectId);
  const names = new Map(state.footage.map((item) => [item.footageId, item.name]));
  const { timeline } = await readTimelineSnapshot(env.deps, { workspaceId: workspace.id, projectId: ref.projectId });
  const seconds = (time) => Number(time.ticks) * time.timebase.num / time.timebase.den;
  const pictures = timeline.clips
    .filter((clip) => clip.sequenceId === state.sequenceId && timeline.tracks.find((track) => track.id === clip.trackId)?.kind === 'VIDEO')
    .map((clip) => [names.get(clip.assetVersionId), seconds(clip.sequenceRange.start), seconds(clip.sequenceRange.end)])
    .sort((a, b) => a[1] - b[1]);
  if (JSON.stringify(pictures) !== JSON.stringify([['glacier.mp4', 0, 3], ['lake.mp4', 3, 6], ['road.mp4', 6, 9]])) throw new Error(`main sequence after the redo: ${JSON.stringify(pictures)}`);
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  await shot('04-redo-delivered');
  pass('只重做没剪成的那一章', `新的一次运行（${String(director.calls - callsBefore)} 次模型调用，没有再定计划）；lake.mp4 插回 3–6 秒，road.mp4 后移到 6–9 秒；成片 ${redo.report.timeline.lengthSeconds} 秒，AI 采用`);

  // 4. 英文、深色、手机宽度
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  const cardEn = page.getByRole('article', { name: 'AI editing on its own' });
  await cardEn.getByText('Redoing chapter 2, “lake.mp4”, then putting it back in its place').waitFor();
  await cardEn.getByRole('list', { name: 'Chapters' }).getByText('at 3.000–6.000 s in the film').waitFor();
  await shot('05-redo-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('06-redo-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(400);
  await card.scrollIntoViewIfNeeded();
  const mobileOverflow = await overflow();
  await shot('07-redo-mobile');
  if (mobileOverflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(mobileOverflow)} px`);
  pass('中英切换、深色、手机宽度', '分章卡片随语言切换；390 px 无横向溢出');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-10 chapters browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
