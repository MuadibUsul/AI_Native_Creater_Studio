#!/usr/bin/env node
// 宣传片素材采集：在**真实产品**里走一遍主流程并截图（英文界面、深色、2× 分辨率），给 LaunchTrailer 当画面。
//
// 环境：同 board-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测 / 代理 / 索引 / 预览 / 特效渲染 / 导出）
// + Next 生产服务（127.0.0.1:3000）+ Realtime Gateway（语音识别连本地同协议假服务）。
// AI 导演：**脚本导演**（SCRIPTED，不调用任何模型，没有费用）——画面里 AI 的计划、剪辑、特效与回复都由它按固定规则产生；
// 预告片片尾如实标注"AI 回复为预发布版本的脚本演示"。素材是 apps/render-worker/src/promo 里程序生成的原创风光（不含第三方素材）。
//
// 用法：node scripts/promo/capture-ui.mjs --clips <dir with aurora|coast|road|waterfall.mp4> --out <public dir>
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
// 输出：<out>/<name>.png（单张）与 <out>/<burst>-NN.jpg（连拍，预告片里按序播放成真实界面的延时动画）+ <out>/capture.json
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { deepgramResult, deepgramUtteranceEnd } from '../../apps/realtime/dist/index.js';
import { ScriptedDirector } from '../lib/scripted-director.mjs';
import { startStudioEnv } from '../lib/studio-env.mjs';

const { values } = parseArgs({ options: { clips: { type: 'string' }, out: { type: 'string' } } });
if (values.clips === undefined || values.out === undefined) throw new Error('usage: capture-ui.mjs --clips <dir> --out <dir>');
const clipsDir = resolve(values.clips);
const out = resolve(values.out);
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `promo-${randomUUID().slice(0, 8)}@test.local`;
const BRIEF = 'A 12-second Iceland road-trip teaser. Upbeat, open on the aurora.';
const CLIPS = ['aurora', 'coast', 'road', 'waterfall'];
const captured = {};
const boxes = {};
const log = (message) => console.log(`[capture] ${message}`);

/** 每一步慢一点（脚本导演本身是瞬时的），才能拍到剪辑师光标走到它正在处理的画框；把测试替身的自述换成平实的交付说明 */
class PromoDirector extends ScriptedDirector {
  async respond(request) {
    await new Promise((done) => setTimeout(done, 2200));
    const response = await super.respond(request);
    if (response.stopReason === 'end_turn') {
      const text = response.content.find((block) => block.type === 'text')?.text ?? '';
      if (text.startsWith('First cut done:')) {
        response.content = [{ type: 'text', text: 'First cut is ready: aurora → coast → road → waterfall, 3 s each, 12 s in total. It opens on the aurora.' }];
      }
    }
    return response;
  }
}

// 语音：英文一句，"here" 绑定说出那一刻指着的画面
const voiceScript = () => [
  { atSeconds: 1.0, message: deepgramResult({ words: [['Add', 0.3, 0.5], ['a', 0.5, 0.6], ['shockwave', 0.6, 1.1]], isFinal: false }) },
  { atSeconds: 2.0, message: deepgramResult({ words: [['Add', 0.3, 0.5], ['a', 0.5, 0.6], ['shockwave', 0.6, 1.1], ['right', 1.2, 1.4], ['here.', 1.4, 1.7]], isFinal: true, speechFinal: true }) },
  { atSeconds: 2.6, message: deepgramUtteranceEnd(1.7) },
];

let env;
let browser;
let page;
try {
  await mkdir(out, { recursive: true });
  env = await startStudioEnv({ director: new PromoDirector(), webPort, workDirPrefix: 'ancs-promo-', effects: { codegen: 'disabled' }, voice: { script: voiceScript } });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: 'Northbound Films' });
  // 首页"继续创作"里有几条作品（只是名字，不含内容）
  for (const title of ['Night run · vertical', 'Why glaciers are retreating', 'Launch event highlights']) {
    await client.studio.create(workspace.id, { title, aspectRatio: '16:9', locale: 'en' }, { idempotencyKey: `p-${randomUUID()}` });
  }
  const micFile = join(env.workDir, 'mic.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', micFile]);

  browser = await chromium.launch({
    headless: true,
    ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2, locale: 'en-US', timezoneId: 'Atlantic/Reykjavik', colorScheme: 'dark' });
  await context.grantPermissions(['microphone'], { origin: env.baseUrl });
  page = await context.newPage();
  const settle = () => page.waitForFunction(() => globalThis.document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity), undefined, { timeout: 2_000 }).catch(() => undefined);
  /** 画面里关键元素的位置（CSS 像素，视口 1600×900）：预告片的镜头推拉对准真实界面元素 */
  const boxesOf = () => page.evaluate(() => {
    const result = {};
    const put = (name, element) => {
      if (element === null) return;
      const box = element.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) result[name] = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    };
    const one = (selector) => globalThis.document.querySelector(selector);
    put('prompt', one('form.ui-prompt'));
    put('monitor', one('video[aria-label]'));
    put('card', one('article[aria-label="AI editing on its own"]'));
    put('caption', one('[data-voice-caption]'));
    put('dock', one('[data-voice-dock]'));
    put('area', one('[role="img"][aria-label="Framed area of the picture"]'));
    put('cursor', one('[data-target]'));
    put('timeline', one('[aria-label="Timeline"]'));
    put('chat', one('[aria-label="Talk to AI"]'));
    put('input', one('textarea'));
    put('canvas', one('[data-board="on"]'));
    [...globalThis.document.querySelectorAll('[data-board-frame]')].forEach((frame, index) => put(`frame:${frame.getAttribute('aria-label') ?? String(index)}`, frame));
    [...globalThis.document.querySelectorAll('[role="dialog"], [role="complementary"]')].forEach((element, index) => put(`panel:${element.getAttribute('aria-label') ?? String(index)}`, element));
    return result;
  });
  const shot = async (name, { wait = true } = {}) => {
    if (wait) await settle();
    await page.screenshot({ path: join(out, `${name}.png`) });
    captured[name] = `${name}.png`;
    boxes[name] = await boxesOf();
    log(name);
  };
  /** 连拍：每隔 intervalMs 拍一张 JPEG，直到 until() 为真或拍满 max 张 */
  const burst = async (name, until, { intervalMs = 350, max = 60 } = {}) => {
    const frames = [];
    for (let index = 0; index < max; index += 1) {
      const file = `${name}-${String(index).padStart(2, '0')}.jpg`;
      await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 90 });
      frames.push(file);
      if (index === 0) boxes[name] = await boxesOf();
      if (await until()) break;
      await page.waitForTimeout(intervalMs);
    }
    captured[name] = frames;
    log(`${name} ×${String(frames.length)}`);
  };
  const step = async (name, run) => {
    try { await run(); } catch (error) {
      log(`step "${name}" failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
      await page.screenshot({ path: join(out, `failed-${name}.png`) }).catch(() => undefined);
    }
  };

  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  // 1. 首页：一句话说要什么（逐字输入，连拍成打字动画）
  await page.goto(`${env.baseUrl}/`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'What video shall we make today?' }).waitFor({ timeout: 30_000 });
  const prompt = page.getByLabel('The video you want');
  await prompt.click();
  await shot('home-empty');
  const typed = [];
  for (let index = 0; index < BRIEF.length; index += 1) {
    await prompt.pressSequentially(BRIEF[index]);
    if (index % 3 === 2 || index === BRIEF.length - 1) {
      const file = `home-type-${String(typed.length).padStart(2, '0')}.jpg`;
      await page.screenshot({ path: join(out, file), type: 'jpeg', quality: 92 });
      typed.push(file);
    }
  }
  captured['home-type'] = typed;
  boxes['home-type'] = await boxesOf();
  await shot('home-typed');

  // 2. 新建页：交给 AI 剪完（自检通过就直接用、上限 $2）
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.waitForURL(/\/studio\/new/, { timeout: 30_000 });
  await page.locator('#studio-title').fill('Iceland Ring Road');
  await page.getByRole('checkbox', { name: 'Let AI finish the edit' }).check();
  await page.getByLabel('Target length').selectOption('15').catch(() => undefined);
  await page.getByRole('radio', { name: /Use it if the check passes/ }).click();
  await page.getByLabel('AI spending cap (USD)').fill('2');
  await shot('new-delegate');
  await page.getByRole('button', { name: 'Hand it to AI', exact: true }).click();
  await page.waitForURL(/\/studio\/prj_/, { timeout: 30_000 });
  const projectId = page.url().split('/studio/')[1];
  const card = page.getByRole('article', { name: 'AI editing on its own' });
  await card.getByText('Waiting for footage').waitFor({ timeout: 30_000 });
  await shot('studio-waiting');

  // 3. 放入素材 → AI 等处理完自己开始：写计划 → 剪 → 自检 → 采用（连拍整个过程）
  await page.locator('input[type=file]').setInputFiles(CLIPS.map((id) => join(clipsDir, `${id}.mp4`)));
  await page.locator('[data-target="plan"]').waitFor({ timeout: 180_000 });
  await shot('board-plan', { wait: false });
  await burst('board-run', async () => (await card.getByText(/^(Done|Done, waiting for you|Could not finish)$/).count()) > 0, { intervalMs: 300, max: 70 });
  await card.getByText(/^(Done|Done, waiting for you|Could not finish)$/).waitFor({ timeout: 240_000 });
  await page.getByText('Current version', { exact: true }).waitFor({ timeout: 120_000 });
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('video[aria-hidden="true"]')].filter((video) => video.readyState >= 2 && video.videoWidth > 0).length >= 4, null, { timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  await shot('board-done');

  const video = page.locator('video[aria-label]');
  const seekTo = async (seconds) => {
    await video.evaluate((element, at) => new Promise((done) => { element.pause(); element.addEventListener('seeked', () => done(undefined), { once: true }); element.currentTime = at; }), seconds);
    await page.waitForTimeout(400);
  };
  await step('video-only', async () => {
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Shift+Digit2');
    await page.waitForTimeout(400);
    for (const [index, at] of [[0, 1.5], [1, 4.5], [2, 7.5], [3, 10.5]]) {
      await seekTo(at);
      await shot(`monitor-${CLIPS[index]}`);
    }
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(400);
  });

  /** 时间带上某个特效片段的起止秒数（读它的无障碍名称 "Clip Effect Burst, 00:01.2 to 00:02.7"） */
  const effectSpan = async (name) => {
    const label = await page.getByRole('button', { name: new RegExp(`^Clip .*${name}, `) }).first().getAttribute('aria-label');
    const match = /(\d+):(\d+(?:\.\d+)?) to (\d+):(\d+(?:\.\d+)?)$/.exec(label ?? '');
    if (match === null) throw new Error(`no ${name} clip on the timeline: ${String(label)}`);
    return [Number(match[1]) * 60 + Number(match[2]), Number(match[3]) * 60 + Number(match[4])];
  };

  // 4. 特效：打开"特效"，在画面上框出一块，说"这里加个爆炸" → 产品特效模板渲染成透明图层，成为试改
  await step('effects', async () => {
    await page.getByRole('button', { name: /Effects: off/ }).click();
    await page.getByRole('button', { name: /Effects: on/ }).waitFor({ timeout: 20_000 });
    await page.keyboard.press('Shift+Digit2');
    await seekTo(1.2);
    await page.getByRole('button', { name: 'Mark an area' }).click();
    const frame = await page.getByRole('application', { name: /Drag on the picture/ }).boundingBox();
    await page.mouse.move(frame.x + frame.width * 0.3, frame.y + frame.height * 0.18);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width * 0.7, frame.y + frame.height * 0.78, { steps: 10 });
    await page.mouse.up();
    await page.getByRole('img', { name: 'Framed area of the picture' }).waitFor();
    await shot('effect-marked');
    await page.getByLabel('Tell AI what to change').fill('Add an explosion over the mountains here');
    await shot('effect-asked');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Trial preview · not kept yet').waitFor({ timeout: 240_000 });
    await page.waitForTimeout(1200);
    const [from, to] = await effectSpan('Burst');
    for (const [name, p] of [['effect-trial-a', 0.12], ['effect-trial-b', 0.3], ['effect-trial-c', 0.55]]) {
      await seekTo(from + (to - from) * p);
      await shot(name);
    }
    await page.getByRole('button', { name: 'Keep it' }).first().click();
    await page.getByText('Current version', { exact: true }).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(600);
    // 清掉框选，下面的语音"这里"改为指着时间带上的片段
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
    await page.keyboard.press('Escape');
  });

  // 5. 语音：点选时间带上的 road.mp4，开麦说"Add a shockwave right here." → "here" 绑定这一段 → 试改
  await step('voice', async () => {
    const dock = page.locator('[data-voice-dock]');
    const caption = page.locator('[data-voice-caption]');
    await page.getByRole('button', { name: /^Clip road\.mp4/ }).first().click();
    await seekTo(6.4);
    await page.getByRole('button', { name: 'Start voice' }).click();
    await caption.filter({ hasText: 'shockwave' }).waitFor({ timeout: 20_000 });
    await shot('voice-partial', { wait: false });
    await burst('voice-run', async () => (await page.getByText('Trial preview · not kept yet').count()) > 0, { intervalMs: 400, max: 50 });
    await page.getByText('Trial preview · not kept yet').waitFor({ timeout: 240_000 });
    await page.waitForTimeout(1200);
    const [from, to] = await effectSpan('Shockwave');
    for (const [name, p] of [['voice-trial-a', 0.15], ['voice-trial-b', 0.35], ['voice-trial-c', 0.6]]) {
      await seekTo(from + (to - from) * p);
      await shot(name);
    }
    await dock.getByRole('button', { name: 'Keep' }).click().catch(async () => { await page.getByRole('button', { name: 'Keep it' }).first().click(); });
    await page.getByText('Current version', { exact: true }).waitFor({ timeout: 120_000 });
    await dock.getByRole('button', { name: 'End voice' }).click().catch(() => undefined);
    await page.keyboard.press('Shift+Digit1');
    await page.waitForTimeout(600);
    await shot('board-final');
  });

  // 6. 导出 → 下载成片（预告片里当"真实产出"用）→ 任务中心
  await step('export', async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('button', { name: 'Start export' }).click();
    await page.getByText('Export finished').waitFor({ timeout: 300_000 });
    await shot('export-done');
    // 成片文件：和界面上"下载视频"同一个资产，经 SDK 取短期下载地址
    const runs = await client.finalRenders.list(workspace.id, projectId);
    const rendered = runs.find((run) => run.status === 'SUCCEEDED')?.outputs?.['render'];
    const assetId = rendered?.outputs?.find((output) => output.kind === 'VIDEO')?.assetId;
    if (assetId !== undefined) {
      const link = await client.assets.downloadUrl(workspace.id, assetId);
      const response = await fetch(new URL(link.url, env.baseUrl));
      if (response.ok) {
        await writeFile(join(out, 'export.mp4'), Buffer.from(await response.arrayBuffer()));
        captured['export-video'] = 'export.mp4';
        log('export.mp4');
      }
    }
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: /^Tasks/ }).click();
    await page.getByRole('complementary', { name: 'Tasks' }).waitFor({ timeout: 20_000 });
    await shot('tasks');
    await page.keyboard.press('Escape');
  });

  await writeFile(join(out, 'capture.json'), JSON.stringify({ projectId, workspaceId: workspace.id, director: 'SCRIPTED', viewport: { width: 1600, height: 900, deviceScaleFactor: 2 }, captured, boxes }, null, 2));
  log(`done → ${out}`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => undefined);
  await writeFile(join(out, 'capture.json'), JSON.stringify({ director: 'SCRIPTED', viewport: { width: 1600, height: 900, deviceScaleFactor: 2 }, captured, boxes, failed: true }, null, 2)).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
