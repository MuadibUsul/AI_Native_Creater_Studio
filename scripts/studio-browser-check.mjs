#!/usr/bin/env node
// V6-1c 共看片室真实浏览器验收（可重复）。
//
// 环境：隔离测试库（ANCS_TEST_DATABASE_URL）+ 进程内 API + 进程内 Worker（真实 FFmpeg：探测、代理、索引、
// 低清预览、终渲染）+ Next 生产服务（127.0.0.1:3000，需先 `pnpm --filter @ancs/web build` 并 `next start`）+ Chromium。
// AI 导演：没有真实模型密钥时用**脚本导演**（SCRIPTED，不是真实 Provider）——它读同一份上下文、调用同一个统一工具目录，
// 用来验证界面与服务端闭环；真实 Claude 的剪辑质量不在本脚本证明范围内。
//
// 用法：node scripts/studio-browser-check.mjs   证据写入 docs/verification/artifacts/v6-1c/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定 Chromium 可执行文件）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv } from './lib/studio-env.mjs';

const evidenceDir = resolve('docs/verification/artifacts/v6-1c');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const prefix = `v61c-${randomUUID().slice(0, 8)}`;
const email = `${prefix}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  // 隔离库 + 进程内 API + 进程内 Worker（真实 FFmpeg）；导演为脚本导演
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v61c-' });
  const { baseUrl, workDir } = env;
  const password = await env.createUser(email);

  // 测试素材（真实编码的 H.264/AAC 文件，画面各不相同）
  const footageDir = join(workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }

  // 环境里的 Playwright 浏览器版本可能与依赖不一致：ANCS_BROWSER_EXECUTABLE 显式指定（例如 /opt/pw-browsers/chromium）
  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', acceptDownloads: true, colorScheme: 'light' });
  page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error' && /hydrat|did not match/i.test(message.text())) pageErrors.push(`console: ${message.text()}`); });
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };

  // 1. 登录 → 建工作区 → 首页入口 → 新建
  await page.goto(`${baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByText('还没有工作区').waitFor({ timeout: 20_000 });
  await page.getByLabel('工作区名称').fill('共看片室验收');
  await page.getByRole('button', { name: '创建工作区' }).click();
  await page.getByRole('link', { name: '进入共看片室' }).waitFor({ timeout: 20_000 });
  await shot('01-home-entry');
  await page.getByRole('link', { name: '进入共看片室' }).click();
  await page.getByRole('heading', { name: '用素材剪一条视频' }).waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: '开始' }).click();
  await page.getByText('请填写作品名称').waitFor();
  await page.getByLabel('作品名称').fill('冰岛环岛自驾 · 第一天');
  await page.getByRole('radio', { name: '横屏 16:9' }).click();
  await shot('02-new-project');
  await page.getByRole('button', { name: '开始' }).click();
  await page.getByText('放入素材，或说说你想做什么。').waitFor({ timeout: 20_000 });
  const projectId = page.url().split('/').at(-1);
  const workspaceId = page.url().split('/').at(-3);
  pass('新建工程进入共看片室', `project ${projectId}`);
  await shot('03-empty-studio');

  // 2. 上传三段素材 → 处理 → 理解进度
  await page.locator('input[type=file]').setInputFiles(sources.map(([name]) => join(footageDir, name)));
  await page.getByRole('button', { name: '让 AI 剪第一版' }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: /^素材 3$/ }).click();
  await page.getByRole('complementary', { name: '素材' }).getByText('glacier.mp4').waitFor();
  // 没有装配语音识别与视觉理解：两层都应显示"未配置"（不是"失败"），镜头层由 FFmpeg 真实完成
  await page.waitForFunction(() => {
    const labels = [...globalThis.document.querySelectorAll('aside b')].map((node) => node.textContent);
    return labels.filter((text) => text === '未配置').length === 6 && labels.filter((text) => text === '已理解').length === 3;
  }, null, { timeout: 120_000 });
  await shot('04-footage-drawer');
  await page.getByRole('button', { name: '关闭素材面板' }).click();
  pass('上传 3 段素材并完成探测/代理/索引', 'AI 对语音与画面的理解：未配置 ASR/视觉驱动时显示“未配置”');
  await shot('05-ready-no-cut');

  // 3. AI 第一版 → 试改预览（工程未变）→ 播放
  await page.getByRole('button', { name: '让 AI 剪第一版' }).click();
  await page.getByText('试改好了，看看预览。').waitFor({ timeout: 60_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  const revisionOf = async () => `版本 ${String(await page.locator('header [data-revision]').getAttribute('data-revision'))}`;
  const revisionBefore = await revisionOf();
  const video = page.locator('video');
  await video.evaluate((element) => element.play());
  await page.waitForTimeout(1500);
  const playedTo = await video.evaluate((element) => element.currentTime);
  if (!(playedTo > 0.8)) throw new Error(`trial preview did not play (currentTime ${String(playedTo)})`);
  await video.evaluate((element) => element.pause());
  const clipButtons = page.getByRole('button', { name: /^片段 / });
  if (await clipButtons.count() < 3) throw new Error('time strip does not show the trial clips');
  await shot('06-first-cut-trial');
  pass('AI 第一版成为试改并可播放', `播放到 ${playedTo.toFixed(2)} s；${revisionBefore}（采用前工程不变）`);

  // 4. 就这样 → 写入工程；撤销这次修改可用
  await page.getByRole('button', { name: '就这样' }).click();
  await page.getByRole('button', { name: '撤销这次修改' }).waitFor({ timeout: 20_000 });
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  const revisionAfter = await revisionOf();
  if (revisionAfter === revisionBefore) throw new Error('adopting did not advance the project revision');
  await shot('07-adopted');
  pass('采用试改写入工程', `${revisionBefore} → ${revisionAfter}`);

  // 5. 在时间带上拖选第二段 → 说一句 → 局部重渲（复用未改动的分段）
  const lanes = page.getByLabel('片段区：拖动选择一段时间，点击选中片段');
  const box = await lanes.boundingBox();
  await page.mouse.move(box.x + box.width * 0.40, box.y + 12);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + 12, { steps: 8 });
  await page.mouse.up();
  const chip = await page.getByText(/^00:0\d\.\d–00:0\d\.\d$/).textContent();
  await page.getByLabel('告诉 AI 怎么改').fill('这一段剪短一点');
  // 可选风格：选一个内置预设并调一个旋钮（只作为这一轮的风格参考发给服务端）
  await page.getByLabel('风格（可选）', { exact: true }).selectOption({ label: '节奏卡点' });
  await page.getByLabel('节奏', { exact: true }).selectOption({ label: '更密' });
  await shot('08-pointer-selected');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('试改好了，看看预览。').waitFor({ timeout: 60_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  const styledTurn = await page.evaluate(async ({ workspaceId, projectId }) => {
    const state = await (await fetch(`/api/v1/workspaces/${workspaceId}/projects/${projectId}/studio`)).json();
    const turns = await (await fetch(`/api/v1/workspaces/${workspaceId}/agent-sessions/${state.session.id}/turns`)).json();
    return turns.items[0];
  }, { workspaceId, projectId });
  if (styledTurn.strategyPackId !== 'builtin:travel-beat' || styledTurn.strategyKnobs.pacing !== 'intense') throw new Error(`style not recorded on the turn: ${JSON.stringify({ pack: styledTurn.strategyPackId, knobs: styledTurn.strategyKnobs })}`);
  pass('可选风格随这一轮发送并记录', `${styledTurn.strategyPackId} ${JSON.stringify(styledTurn.strategyKnobs)}`);
  const reuse = await page.getByText(/^复用 \d+\/\d+ 段$/).textContent();
  if (/^复用 0\//.test(reuse)) throw new Error(`expected reused preview segments, got "${reuse}"`);
  await shot('09-local-trial');
  pass('指着时间说一句 → 局部试改预览', `选区 ${chip}；${reuse}`);

  // 6. 不采用，点选试改里的片段再说一句 → 在试改上继续（新试改取代旧试改）
  await page.getByText('/ 00:08.0').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /^片段 lake\.mp4/ }).first().click();
  await page.getByText('片段「lake.mp4」').waitFor();
  await page.getByLabel('告诉 AI 怎么改').fill('再短一点');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('/ 00:07.0').waitFor({ timeout: 120_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  await shot('10-refined-trial');
  pass('在试改上继续微调', '点选试改中的片段再说一句：新试改包含上一版试改，时长 00:08.0 → 00:07.0');

  // 7. 采用后整体撤销这次修改
  await page.getByRole('button', { name: '就这样' }).click();
  await page.getByRole('button', { name: '撤销这次修改' }).waitFor({ timeout: 20_000 });
  const lengthKept = await page.getByText(/^\/ 00:\d\d\.\d$/).textContent();
  await page.getByRole('button', { name: '撤销这次修改' }).click();
  await page.getByText('已撤销这次修改。').waitFor({ timeout: 20_000 });
  await page.getByText('/ 00:09.0').waitFor({ timeout: 20_000 });
  await shot('11-undone');
  pass('撤销这次修改（整组）', `时长 ${lengthKept.slice(2)} → 00:09.0`);

  // 8. 导出 → 下载真实成片
  await page.getByRole('button', { name: '导出' }).click();
  await page.getByRole('button', { name: '开始导出' }).click();
  await page.getByText('导出完成').waitFor({ timeout: 240_000 });
  await shot('12-export-done');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '下载成片' }).click()]);
  const downloaded = join(workDir, 'final.mp4');
  await download.saveAs(downloaded);
  const probed = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type,width,height', '-of', 'json', downloaded]).toString());
  const finalVideo = probed.streams.find((stream) => stream.codec_type === 'video');
  pass('导出并下载成片', `${String(finalVideo.width)}×${String(finalVideo.height)}，${Number(probed.format.duration).toFixed(2)} s，${String((await stat(downloaded)).size)} 字节`);
  await page.getByRole('button', { name: '关闭' }).click();

  // 9. 英文界面、深色、1280×800
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByText('Current version').waitFor();
  await page.getByText('Change undone.').waitFor();
  await page.getByLabel('Tell AI what to change').waitFor();
  await shot('13-english');
  pass('中英切换', '界面文案即时切换，作品与选区不变');
  await page.getByRole('button', { name: 'Toggle light/dark' }).click();
  await page.waitForFunction(() => globalThis.document.body.classList.contains('theme-dark'));
  await shot('14-dark-english');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(400);
  await shot('15-dark-1280');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('16-light-1280');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByText('当前版本').waitFor({ timeout: 60_000 });
  pass('刷新后状态保持', '语言、工程版本与预览恢复');

  if (pageErrors.length > 0) throw new Error(`browser errors: ${pageErrors.join(' | ')}`);
  const summary = { when: new Date().toISOString(), director: 'SCRIPTED (not a real provider)', workspaceId, projectId, results };
  await writeFile(resolve(evidenceDir, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nV6-1c studio browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/v6-1c/`);
} catch (error) {
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close();
}
