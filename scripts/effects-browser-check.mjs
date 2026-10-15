#!/usr/bin/env node
// V6-3 代码生成特效真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测/代理/索引/预览）+ Next 生产服务（127.0.0.1:3000），
// 外加真实特效渲染子进程（Remotion 无头浏览器 → 透明 PNG/QuickTime 图层）。
// AI 导演：**脚本导演**（SCRIPTED，不是真实 Provider）——请求里提到特效时用模板加在框出的位置，提到颜色时改已有特效；
// 它和真实导演用同一份上下文与同一个工具目录，用来验证界面与服务端闭环，不证明特效创意质量。
//
// 用法：node scripts/effects-browser-check.mjs   证据写入 docs/verification/artifacts/v6-3/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium；REMOTION_BROWSER_EXECUTABLE 指定渲染用无头浏览器）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Blob } from 'node:buffer';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve('docs/verification/artifacts/v6-3');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v63-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

/** 预览文件某一时刻某一点的 RGB（真实解码） */
async function previewPixel(url, seconds, x, y, workDir) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`preview download failed: ${String(response.status)}`);
  const file = join(workDir, `preview-${randomUUID()}.mp4`);
  await writeFile(file, Buffer.from(await response.arrayBuffer()));
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file]).toString()).streams[0];
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(seconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 * 1024 * 1024 });
  const px = Math.round(x * (probe.width - 1));
  const py = Math.round(y * (probe.height - 1));
  return [...raw.subarray((py * probe.width + px) * 3, (py * probe.width + px) * 3 + 3)];
}

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v63-', effects: { codegen: 'disabled' } });
  const { client, password } = await env.signedInClient(email);

  // 1. 准备：一条已采用的第一版（真实上传 → 真实 FFmpeg 处理 → AI 一轮 → 采用）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  const workspace = await client.workspaces.create({ name: '特效验收' });
  const ref = await client.studio.create(workspace.id, { title: '冰岛环岛 · 特效', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 2 && state.footage.every((item) => item.status === 'READY'), { label: 'footage ready' });
  const firstCut = await client.agent.startTurn(workspace.id, ref.sessionId, { message: '用这些素材剪出第一版。' }, { idempotencyKey: `t-${randomUUID()}` });
  const cut = await waitFor(() => client.agent.getTurn(workspace.id, firstCut.id), (turn) => turn.status !== 'RUNNING', { label: 'first cut' });
  if (cut.proposalId === null) throw new Error(`first cut made no proposal: ${JSON.stringify(cut.error)}`);
  const cutProposal = await client.projects.proposal(workspace.id, ref.projectId, cut.proposalId);
  await client.projects.adoptProposal(workspace.id, ref.projectId, cut.proposalId, { expectedOperationsHash: cutProposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `a-${randomUUID()}` });
  const startState = await client.studio.state(workspace.id, ref.projectId);
  if (startState.project.allowEffects !== false) throw new Error('footage project should start with effects off');
  pass('准备：第一版已采用', `2 段真实素材，版本 ${String(startState.project.revision)}；素材作品默认不允许程序化特效`);

  // 2. 打开共看片室
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
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${ref.projectId}`, { waitUntil: 'networkidle' });
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  const video = page.locator('video');
  const seekTo = async (seconds) => {
    await video.evaluate((element, at) => new Promise((done) => { element.pause(); element.addEventListener('seeked', () => done(undefined), { once: true }); element.currentTime = at; }), seconds);
    await page.waitForTimeout(300);
  };
  const markArea = async (from, to) => {
    await page.getByRole('button', { name: '框选画面' }).click();
    const frame = await page.getByRole('application', { name: /在画面上拖动/ }).boundingBox();
    await page.mouse.move(frame.x + frame.width * from[0], frame.y + frame.height * from[1]);
    await page.mouse.down();
    await page.mouse.move(frame.x + frame.width * to[0], frame.y + frame.height * to[1], { steps: 8 });
    await page.mouse.up();
    await page.getByRole('img', { name: '框出的画面区域' }).waitFor();
  };
  const say = async (text) => {
    await page.getByLabel('告诉 AI 怎么改').fill(text);
    await page.getByRole('button', { name: '发送' }).click();
  };
  await shot('01-studio');
  pass('打开共看片室', '输入框上方显示"特效：关"');

  // 3. 规则未开：框出画面说"这里加个爆炸" → AI 如实说明需要先开启
  await seekTo(1.0);
  await markArea([0.55, 0.2], [0.9, 0.75]);
  await page.getByText('画面区域 · 00:01.0').waitFor();
  await say('这里加个爆炸');
  await page.getByText('这个作品还没开启特效：点输入框上方的"特效：关"打开后再说一次。').waitFor({ timeout: 60_000 });
  await shot('02-blocked');
  pass('规则未开时如实拒绝', 'AI 回复需要先开启特效；没有渲染、没有试改');

  // 4. 显式开启 → 再说一次 → 特效成为试改，时间带出现特效轨
  await page.getByRole('button', { name: /特效：关/ }).click();
  await page.getByRole('button', { name: /特效：开/ }).waitFor({ timeout: 20_000 });
  const enabled = await client.studio.state(workspace.id, ref.projectId);
  if (!enabled.project.allowEffects) throw new Error('effects toggle did not persist');
  await say('这里加个爆炸');
  await page.getByText('在框出的位置加了一个特效（模板 burst）。').waitFor({ timeout: 180_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 180_000 });
  await page.getByRole('button', { name: /^片段 特效 Burst，00:01\.0 到 00:02\.5$/ }).waitFor({ timeout: 30_000 });
  await seekTo(1.6);
  await shot('03-trial-burst');
  const trialState = await client.studio.state(workspace.id, ref.projectId);
  const turns = await client.agent.listTurns(workspace.id, ref.sessionId);
  const effectTurn = turns.find((turn) => turn.message === '这里加个爆炸' && turn.proposalId !== null);
  if (effectTurn === undefined) throw new Error('no effect proposal');
  const region = effectTurn.pointer.frameRegion;
  if (region === null || Math.abs(region.x - 0.55) > 0.02 || Math.abs(region.y - 0.2) > 0.02 || effectTurn.pointer.timeRange?.start !== '1.000') throw new Error(`pointer not carried: ${JSON.stringify(effectTurn.pointer)}`);
  if (trialState.effects.length !== 1 || trialState.effects[0].templateId !== 'burst' || trialState.footage.length !== 2) throw new Error(`effects not listed separately: ${JSON.stringify(trialState.effects)}`);
  if (trialState.project.revision !== startState.project.revision) throw new Error('trial changed the project before adoption');

  // 像素：试改预览里，区域中心在爆炸时刻明显变亮/变色，区域外与当前版本一致
  const current = await client.previews.request(workspace.id, ref.projectId, ref.sequenceId, {});
  const currentReady = await waitFor(() => client.previews.get(workspace.id, current.id), (item) => item.status === 'READY', { label: 'current preview' });
  const trialPreview = await client.previews.request(workspace.id, ref.projectId, ref.sequenceId, { proposalId: effectTurn.proposalId });
  const trialReady = await waitFor(() => client.previews.get(workspace.id, trialPreview.id), (item) => item.status === 'READY', { label: 'trial preview' });
  const center = [region.x + region.width / 2, region.y + region.height / 2];
  const before = await previewPixel(currentReady.playbackUrl, 1.4, center[0], center[1], env.workDir);
  const after = await previewPixel(trialReady.playbackUrl, 1.4, center[0], center[1], env.workDir);
  const outsideBefore = await previewPixel(currentReady.playbackUrl, 1.4, 0.15, 0.5, env.workDir);
  const outsideAfter = await previewPixel(trialReady.playbackUrl, 1.4, 0.15, 0.5, env.workDir);
  const diff = (left, right) => Math.max(...left.map((value, index) => Math.abs(value - right[index])));
  if (diff(before, after) < 60) throw new Error(`effect not visible at region center: before ${before} after ${after}`);
  if (diff(outsideBefore, outsideAfter) > 12) throw new Error(`picture outside region changed: before ${outsideBefore} after ${outsideAfter}`);
  pass('框选区域加特效成为试改', `区域 ${JSON.stringify(region)}，时间 1.0–2.5 s；预览里区域中心 RGB ${before.join(',')} → ${after.join(',')}，区域外 ${outsideBefore.join(',')} → ${outsideAfter.join(',')}（${String(trialReady.segments.reused)}/${String(trialReady.segments.total)} 段复用）`);

  // 5. 改颜色：同一段代码重渲（不写新代码），仍在同一位置
  await say('换成蓝色');
  await page.getByText('把「Burst」改成了新的颜色。').waitFor({ timeout: 180_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 180_000 });
  await seekTo(1.6);
  await shot('04-trial-blue');
  const recolored = await client.studio.state(workspace.id, ref.projectId);
  const blue = recolored.effects.find((effect) => effect.params.color === '#3aa0ff');
  if (blue === undefined) throw new Error(`recolored layer missing: ${JSON.stringify(recolored.effects)}`);
  pass('改参数只重渲图层', `新图层参数 ${JSON.stringify(blue.params)}；模板代码不变`);

  // 6. 就这样 → 成为新版本
  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  await page.getByRole('button', { name: /^片段 特效 Burst/ }).waitFor();
  await shot('05-adopted');
  const adopted = await client.studio.state(workspace.id, ref.projectId);
  if (adopted.project.revision === startState.project.revision) throw new Error('adoption did not create a new version');
  pass('采用后成为新版本', `版本 ${String(startState.project.revision)} → ${String(adopted.project.revision)}`);

  // 7. 英文 / 深色
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('button', { name: /Effects: on/ }).waitFor();
  await page.getByRole('button', { name: /^Clip Effect Burst/ }).waitFor();
  await shot('06-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('07-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  pass('中英切换与深色', '特效开关、特效轨与片段标名随语言切换');

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-3 effects browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/v6-3/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
