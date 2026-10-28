#!/usr/bin/env node
// 无限画布（共看片室，参照 Stitch）真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg）+ Next 生产服务（127.0.0.1:3000）。
// AI 导演：**脚本导演**（SCRIPTED）。交给 AI 剪完一次，让画布上有素材画框与制作计划画框（场景与剪辑意图）。
// 验证的是画布本身：平移（滚轮 / 拖动空白处）、缩放（Ctrl+滚轮、按钮）、看全部 / 只看成片（含 Shift+1 / Shift+2）、
// 缩放后在画面上框选仍然准确、素材画框的预览画面真实加载、计划"过期"如实（自己的采用不算）、中英、深色、手机一列。
//
// 用法：node scripts/board-browser-check.mjs   证据写入 docs/verification/artifacts/board/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/board');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `board-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  // 每一步慢一点（测试替身本身是瞬时的），才能在运行中看到剪辑师光标走到它正在处理的画框
  class PacedDirector extends ScriptedDirector {
    async respond(request) { await new Promise((done) => setTimeout(done, 2500)); return super.respond(request); }
  }
  env = await startStudioEnv({ director: new PacedDirector(), webPort, workDirPrefix: 'ancs-board-' });
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '无限画布验收' });
  const footageDir = join(env.workDir, 'footage');
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
  const settle = () => page.waitForFunction(() => globalThis.document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect?.getTiming().iterations === Infinity), undefined, { timeout: 2_000 }).catch(() => undefined);
  const shot = async (name) => { await settle(); await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const camera = () => page.evaluate(() => {
    const world = globalThis.document.querySelector('[data-board="on"] > div');
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(world?.style.transform ?? '');
    return match === null ? null : { x: Number(match[1]), y: Number(match[2]), k: Number(match[3]) };
  });

  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });

  // 1. 放入素材 → 交给 AI 剪完（自检通过直接用）→ 画布上并排：成片、素材、制作计划
  const project = await client.studio.create(workspace.id, { title: '冰岛环岛', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `board-${randomUUID()}` });
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${project.projectId}`, { waitUntil: 'networkidle' });
  const stage = page.getByRole('region', { name: '作品画面' });
  const view = stage.getByRole('toolbar', { name: '画布视图' });
  await view.waitFor();
  await stage.getByRole('button', { name: '和剪辑师说话' }).waitFor();
  await shot('01-empty-board');
  await page.locator('input[type=file]').setInputFiles(sources.map(([name]) => join(footageDir, name)));
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: '交给 AI 剪完…' }).click();
  const dialog = page.getByRole('dialog', { name: '交给 AI 剪完' });
  await dialog.getByLabel('你想要一条什么样的视频').fill('剪一条 9 秒的冰岛短片，开头要抓人');
  await dialog.getByRole('radio', { name: /自检通过就直接用/ }).click();
  await dialog.getByRole('button', { name: '交给 AI', exact: true }).click();
  // 剪辑师在场：写完计划时光标在计划画框旁、对话里是"第 1 步 · 在写制作计划"；开始剪时光标回到成片
  await page.locator('[data-target="plan"]').waitFor({ timeout: 120_000 });
  await page.getByText('第 1 步 · 在写制作计划').waitFor();
  const cursorText = await page.locator('[data-target="plan"]').textContent();
  await shot('02a-editor-at-plan');
  await page.locator('[data-target="monitor"]').waitFor({ timeout: 60_000 });
  await page.getByText(/^第 \d+ 步 · (在剪|在自检|在量节奏)$/).waitFor();
  await shot('02b-editor-cutting');
  await page.getByRole('article', { name: 'AI 自己剪' }).getByText('剪好了', { exact: true }).waitFor({ timeout: 240_000 });
  if (await page.locator('[data-target]').count() !== 0) throw new Error('the editor cursor should leave when the turn is done');
  pass('剪辑师在场', `运行中光标随真实工具记录移动：写计划时在计划画框旁（"${String(cursorText)}"），剪辑与自检时回到成片；结束后光标离开；对话里逐步显示"第 N 步 · 在做什么"`);
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  const planFrame = stage.getByRole('region', { name: '制作计划 · 第 1 版' });
  await stage.getByRole('region', { name: '素材 3' }).waitFor();
  await planFrame.waitFor({ timeout: 30_000 });
  await planFrame.getByText('钩子', { exact: true }).waitFor();
  if (await planFrame.getByText('计划之后作品又改过').count() !== 0) throw new Error('the plan is marked stale after its own cut was adopted');
  // 素材画框的预览画面真的加载了（签名地址 + 只读元数据）
  await page.waitForFunction(() => [...globalThis.document.querySelectorAll('video[aria-hidden="true"]')].filter((video) => video.readyState >= 2 && video.videoWidth > 0).length === 3, null, { timeout: 30_000 });
  const fitted = await camera();
  const inside = await page.evaluate(() => {
    const stageBox = globalThis.document.querySelector('[data-board="on"]').getBoundingClientRect();
    return [...globalThis.document.querySelectorAll('[data-board-frame]')].every((frame) => {
      const box = frame.getBoundingClientRect();
      return box.left >= stageBox.left - 1 && box.top >= stageBox.top - 1 && box.right <= stageBox.right + 1 && box.bottom <= stageBox.bottom + 1;
    });
  });
  if (!inside) throw new Error('"show all" does not fit every frame inside the canvas');
  if ((await view.getByRole('button', { name: '看全部' }).getAttribute('aria-pressed')) !== 'true') throw new Error('"show all" should be the initial view');
  await shot('02-board-show-all');
  pass('画布并排成片、素材、计划', `看全部 ${String(Math.round(fitted.k * 100))}%：3 个画框都在视口内；素材预览 3/3 真实加载；计划第 1 版带剪辑意图（钩子），自己的采用不算"之后又改过"`);

  // 2. 平移：滚轮（触控板双指滑动）与拖动空白处；缩放：Ctrl+滚轮（触控板捏合）以光标为中心
  const box = await stage.boundingBox();
  const blank = { x: box.x + box.width - 40, y: box.y + box.height - 40 };
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.wheel(120, 200);
  await page.waitForTimeout(150);
  const wheeled = await camera();
  if (Math.abs(wheeled.x - (fitted.x - 120)) > 1 || Math.abs(wheeled.y - (fitted.y - 200)) > 1) throw new Error(`wheel pan: ${JSON.stringify({ fitted, wheeled })}`);
  if ((await view.getByRole('button', { name: '看全部' }).getAttribute('aria-pressed')) !== 'false') throw new Error('panning should leave "show all"');
  await page.mouse.move(blank.x, blank.y);
  await page.mouse.down();
  await page.mouse.move(blank.x - 160, blank.y - 90, { steps: 6 });
  await page.mouse.up();
  const dragged = await camera();
  if (Math.abs(dragged.x - (wheeled.x - 160)) > 1 || Math.abs(dragged.y - (wheeled.y - 90)) > 1) throw new Error(`drag pan: ${JSON.stringify({ wheeled, dragged })}`);
  const anchor = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const worldAt = (cam) => ({ x: (anchor.x - box.x - cam.x) / cam.k, y: (anchor.y - box.y - cam.y) / cam.k });
  const before = worldAt(dragged);
  await page.mouse.move(anchor.x, anchor.y);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
  const zoomed = await camera();
  const after = worldAt(zoomed);
  if (!(zoomed.k > dragged.k * 1.5)) throw new Error(`ctrl+wheel did not zoom in: ${String(dragged.k)} → ${String(zoomed.k)}`);
  if (Math.abs(after.x - before.x) > 1 || Math.abs(after.y - before.y) > 1) throw new Error('zoom did not keep the point under the cursor still');
  await shot('03-zoomed-panned');
  pass('平移与缩放', `滚轮平移 (−120, −200)、拖动空白处平移 (−160, −90)；Ctrl+滚轮 ${String(Math.round(dragged.k * 100))}% → ${String(Math.round(zoomed.k * 100))}%，光标下的位置不动`);

  // 3. 只看成片 / 看全部（按钮与 Shift+2 / Shift+1）
  await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => undefined);
  await page.keyboard.press('Shift+Digit2');
  await page.waitForTimeout(150);
  const monitorOnly = await camera();
  const monitorBox = await page.locator('[data-board="on"] section[data-mode]').boundingBox();
  if ((await view.getByRole('button', { name: '只看成片' }).getAttribute('aria-pressed')) !== 'true' || !(monitorBox.width > box.width * 0.75)) throw new Error(`video-only did not fill the canvas: ${JSON.stringify(monitorBox)}`);
  await shot('04-video-only');
  await page.keyboard.press('Shift+Digit1');
  await page.waitForTimeout(150);
  const back = await camera();
  if (Math.abs(back.k - fitted.k) > 0.001 || Math.abs(back.x - fitted.x) > 1) throw new Error('show all did not return to the fitted view');
  await view.getByRole('button', { name: '放大' }).click();
  await view.getByRole('button', { name: '放大' }).click();
  const buttons = await camera();
  if (Math.abs(buttons.k - fitted.k * 1.5625) > 0.01) throw new Error(`zoom buttons: ${String(buttons.k)}`);
  pass('看全部 / 只看成片', `Shift+2 只看成片 ${String(Math.round(monitorOnly.k * 100))}%（成片宽 ${String(Math.round(monitorBox.width))} px），Shift+1 回到看全部；按钮放大两次 ×1.5625`);

  // 4. 缩放后在画面上框选：区域按画面比例准确（屏幕坐标与画面坐标一致）
  await view.getByRole('button', { name: '只看成片' }).click();
  await view.getByRole('button', { name: '缩小' }).click();
  await page.getByRole('button', { name: '框选画面' }).first().click();
  const draw = page.getByRole('application', { name: /在画面上拖动/ });
  const drawBox = await draw.boundingBox();
  await page.mouse.move(drawBox.x + drawBox.width * 0.25, drawBox.y + drawBox.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(drawBox.x + drawBox.width * 0.75, drawBox.y + drawBox.height * 0.6, { steps: 8 });
  await page.mouse.up();
  const region = page.getByRole('img', { name: '框出的画面区域' });
  await region.waitFor();
  const style = await region.evaluate((element) => ({ left: element.style.left, top: element.style.top, width: element.style.width, height: element.style.height }));
  const pct = (text) => Number(text.replace('%', ''));
  if (Math.abs(pct(style.left) - 25) > 1 || Math.abs(pct(style.top) - 25) > 1 || Math.abs(pct(style.width) - 50) > 1 || Math.abs(pct(style.height) - 35) > 1) throw new Error(`region under zoom is off: ${JSON.stringify(style)}`);
  await page.getByText(/^画面区域/).first().waitFor();
  await shot('05-region-under-zoom');
  pass('缩放后框选', `画面缩放 ${String(Math.round((await camera()).k * 100))}% 时从 25%,25% 拖到 75%,60%：区域 ${style.left} ${style.top} ${style.width}×${style.height}`);

  // 5. 中英、深色、手机一列
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Digit1');
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('toolbar', { name: 'Canvas view' }).getByRole('button', { name: 'Show all' }).waitFor();
  await page.getByRole('region', { name: 'Production plan · v1' }).getByText('Hook', { exact: true }).waitFor();
  await shot('06-board-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('07-board-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const phone = await page.evaluate(() => ({
    overflow: globalThis.document.documentElement.scrollWidth - globalThis.innerWidth,
    board: globalThis.document.querySelector('[data-board="on"]') !== null,
    frames: globalThis.document.querySelectorAll('[data-board-frame]').length,
  }));
  await shot('08-phone-single-column');
  if (phone.overflow > 1 || phone.board || phone.frames !== 0) throw new Error(`phone layout: ${JSON.stringify(phone)}`);
  pass('中英、深色、手机', '画布视图按钮与计划画框随语言切换；390 px 不做画布变换、不显示旁边的画框、无横向溢出');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nBoard browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
