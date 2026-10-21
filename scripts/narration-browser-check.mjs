#!/usr/bin/env node
// V6-5 文章 → 讲述 + 图解 真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 预览/终渲染）+ Next 生产服务（127.0.0.1:3000），
// 外加真实特效渲染子进程（图解卡）与真实语音合成（FFmpeg 内置 flite 本地英文语音——真实合成，不是测试替身，但音质基础、只会英文）。
// AI 导演：**脚本导演**（SCRIPTED，不是真实 Provider）——直接用文章段落当讲述稿、每段配一张图解卡；真实导演会改写成口语讲述稿。
// 它和真实导演用同一份上下文（文章按段进入）与同一个工具目录，用来验证界面与服务端闭环，不证明讲述与图解的质量。
//
// 用法：node scripts/narration-browser-check.mjs   证据写入 docs/verification/artifacts/v6-5/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium；REMOTION_BROWSER_EXECUTABLE 指定渲染用无头浏览器）
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/v6-5'); // ANCS_EVIDENCE_DIR：另存一套证据（如界面改版），不覆盖里程碑证据
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v65-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const ARTICLE = [
  'Water covers about 71 percent of the surface of the Earth. Yet very little of it is fresh.',
  'Only 2.5 percent of all water is fresh water, and most of that is frozen in glaciers and ice caps.',
  'Rivers and lakes hold a tiny share. Protecting them protects the water we drink.',
].join('\n\n');

let env;
let browser;
let page;

async function download(url, workDir) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`preview download failed: ${String(response.status)}`);
  const file = join(workDir, `preview-${randomUUID()}.mp4`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

function pixel(file, seconds, x, y) {
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]).toString()).streams[0];
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const px = Math.round(x * (probe.width - 1));
  const py = Math.round(y * (probe.height - 1));
  return [...raw.subarray((py * probe.width + px) * 3, (py * probe.width + px) * 3 + 3)];
}

try {
  await mkdir(evidenceDir, { recursive: true });
  // 从链接导入：真实抓取器会拦下本机地址（SSRF 守卫），这里注入脚本化抓取器返回一篇文章网页
  const articleUrl = 'https://news.example/fresh-water';
  const articleHtml = `<!doctype html><html><head><meta charset="utf-8"><title>Fresh water</title><script>tracking()</script></head><body><nav>Home</nav><article>${ARTICLE.split('\n\n').map((paragraph) => `<p>${paragraph}</p>`).join('')}</article></body></html>`;
  const articleFetcher = { kind: 'scripted', fetch: async ({ url }) => { if (url !== articleUrl) throw new Error(`unexpected url ${url}`); return { finalUrl: url, contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(articleHtml) }; } };
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v65-', effects: { codegen: 'disabled' }, narration: {}, articleFetcher });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '文章转视频验收' });

  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  // 1. 首页"链接导入" → 新建页自动抓取正文（标题取网页标题；脚本、导航不进原文）→ 核对后开始
  await page.goto(`${env.baseUrl}/?workspaceId=${workspace.id}`, { waitUntil: 'networkidle' });
  await page.getByRole('radio', { name: '链接导入' }).click();
  await page.getByRole('textbox', { name: '想做的视频' }).fill(articleUrl);
  await page.getByRole('button', { name: '开始创作' }).click();
  await page.getByText('已从 news.example 导入 3 段正文。请核对，AI 只会用这里的内容。').waitFor({ timeout: 30_000 });
  if ((await page.getByLabel('文章或讲稿').inputValue()) !== ARTICLE) throw new Error(`imported text differs: ${await page.getByLabel('文章或讲稿').inputValue()}`);
  if ((await page.getByLabel('作品名称').inputValue()) !== 'Fresh water') throw new Error('title should come from the page title');
  if ((await page.getByRole('radio', { name: /从文章开始/ }).getAttribute('aria-checked')) !== 'true') throw new Error('article start should be chosen');
  pass('首页链接导入 → 抓取正文给人核对', `${articleUrl}：3 段正文、标题取网页标题；网页脚本与导航不进原文`);
  const narrationChecked = await page.getByRole('checkbox', { name: 'AI 配音讲述' }).isChecked();
  if (!narrationChecked) throw new Error('voice-over should be chosen by default');
  await shot('01-new-from-article');
  await page.getByRole('button', { name: '开始' }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  await page.getByText('文章已就绪（3 段）').waitFor({ timeout: 60_000 });
  const projectId = page.url().split('/studio/')[1];
  if ((await page.getByRole('button', { name: /配音：开/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('voice-over rule should be on');
  if ((await page.getByRole('button', { name: /特效：开/ }).getAttribute('aria-pressed')) !== 'true') throw new Error('diagram cards (procedural graphics) should be allowed');
  await shot('02-article-ready');
  const created = await client.studio.state(workspace.id, projectId);
  pass('从文章新建', `图文工程：文章 ${String(created.project.article.characters)} 字 / ${String(created.project.article.paragraphs)} 段；配音与图解已允许；没有素材`);

  // 2. 让 AI 讲成视频 → 试改：讲述轨 + 图解卡 + 逐句字幕
  const started = Date.now();
  await page.getByRole('button', { name: '让 AI 讲成视频' }).click();
  await page.getByText(/^第一版：3 段讲述/).waitFor({ timeout: 300_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 300_000 });
  const firstCutSeconds = (Date.now() - started) / 1000;
  await page.getByText('讲述', { exact: true }).waitFor();
  const narrationClips = page.getByRole('button', { name: /^片段 讲述「/ });
  if ((await narrationClips.count()) !== 3) throw new Error(`expected 3 narration clips, found ${String(await narrationClips.count())}`);
  const cardClips = page.getByRole('button', { name: /^片段 特效 / });
  if ((await cardClips.count()) !== 3) throw new Error(`expected 3 diagram cards, found ${String(await cardClips.count())}`);
  const video = page.locator('video[aria-label]');
  const seekTo = async (seconds) => {
    await video.evaluate((element, at) => new Promise((done) => { element.pause(); element.addEventListener('seeked', () => done(undefined), { once: true }); element.currentTime = at; }), seconds);
    await page.waitForTimeout(400);
  };
  await seekTo(1.5);
  await page.getByText('Water covers about 71 percent of the surface of the Earth.', { exact: true }).waitFor({ timeout: 10_000 });
  await shot('03-trial-title-card');

  const state = await client.studio.state(workspace.id, projectId);
  const turns = await client.agent.listTurns(workspace.id, state.session.id);
  const firstCut = turns.find((turn) => turn.proposalId !== null);
  if (firstCut === undefined) throw new Error('first cut made no proposal');
  if (state.narration.length !== 3 || state.footage.length !== 0) throw new Error(`narration ${String(state.narration.length)}, footage ${String(state.footage.length)}`);
  if (state.effects.map((item) => item.templateId).join(',') !== 'title-card,big-number,key-points') throw new Error(`cards: ${state.effects.map((item) => item.templateId).join(',')}`);
  const preview = await client.previews.request(workspace.id, projectId, state.sequenceId, { proposalId: firstCut.proposalId });
  const ready = await waitFor(() => client.previews.get(workspace.id, preview.id), (item) => item.status === 'READY', { label: 'trial preview', timeoutMs: 300_000 });
  const file = await download(ready.playbackUrl, env.workDir);
  const volume = Number(/mean_volume: (-?[\d.]+) dB/.exec(spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)?.[1] ?? 'NaN');
  if (!(volume > -35)) throw new Error(`preview narration is too quiet or missing: ${String(volume)} dB`);
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  const parts = state.narration.length;
  const corners = [0.5, duration / 2, duration - 0.5].map((at) => pixel(file, at, 0.02, 0.04));
  const isCard = ([r, g, b]) => Math.abs(r - 0x0f) + Math.abs(g - 0x17) + Math.abs(b - 0x20) < 30;
  if (!corners.every(isCard)) throw new Error(`cards do not cover the video: ${JSON.stringify(corners)}`);
  pass('AI 讲成视频（试改）', `${String(parts)} 段讲述（flite 真实合成）+ 3 张图解卡（标题卡 / 大数字 2.5% / 要点）+ 逐句字幕；预览 ${duration.toFixed(1)} s，平均音量 ${String(volume)} dB；开头、中段、结尾都是卡片画面；从点按钮到试改预览 ${firstCutSeconds.toFixed(1)} s`);

  await seekTo(duration / 2);
  await shot('04-trial-big-number');

  // 3. 就这样 → 成为当前版本
  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 300_000 });
  const adopted = await client.studio.state(workspace.id, projectId);
  if (adopted.project.revision === created.project.revision) throw new Error('adoption did not create a new version');
  await shot('05-adopted');
  pass('采用', `版本 ${String(created.project.revision)} → ${String(adopted.project.revision)}；讲述轨与图解卡留在时间带上`);

  // 3b. 导出：讲述是合成语音、卡片是 AI 写的图层 → 成片带 AI 生成标识（导出面板如实告诉用户；文件里有 AIGC 元数据）
  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '开始导出' }).click();
  await page.getByText('导出完成').waitFor({ timeout: 300_000 });
  await page.locator('[data-aigc-label]').waitFor({ timeout: 10_000 });
  await shot('05b-export-ai-labelled');
  const [exported] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载成片' }).click()]);
  const downloaded = join(evidenceDir, '.tmp-export.mp4');
  await exported.saveAs(downloaded);
  const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', downloaded]).toString()).format.tags ?? {};
  const aigc = JSON.parse(tags.AIGC ?? 'null');
  if (aigc?.Label !== '1' || typeof aigc.ProduceID !== 'string') throw new Error(`exported file has no AIGC metadata: ${JSON.stringify(tags)}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1', '-i', downloaded, '-frames:v', '1', join(evidenceDir, '05c-export-frame-1s.png')]);
  await rm(downloaded, { force: true });
  await page.getByRole('button', { name: '关闭' }).click();
  pass('导出带 AI 生成标识', `导出面板说明已加标识；下载的成片 AIGC 元数据 Label=1、ProduceID=${String(aigc.ProduceID)}；1 秒处画面见 05c`);

  // 4. 英文 / 深色 / 手机宽度
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('button', { name: /Voice-over: on/ }).waitFor();
  await page.getByText('Voice-over', { exact: true }).waitFor();
  await shot('06-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('07-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/new`, { waitUntil: 'networkidle' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('radio', { name: /从文章开始/ }).click();
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
  await shot('08-new-mobile');
  if (overflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(overflow)} px`);
  pass('中英切换、深色、手机宽度', '"配音：开"/"Voice-over: on"、讲述轨随语言切换；新建页 390 px 无横向溢出');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-5 narration browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
