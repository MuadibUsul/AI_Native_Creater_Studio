#!/usr/bin/env node
// V6-2 流式双语语音 + 共同注意力：真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg）+ Realtime Gateway（真实网关进程代码）+
// Next 生产服务（127.0.0.1:3000）+ Chrome（假麦克风：从 WAV 文件采集，走真实 getUserMedia → AudioWorklet → WebSocket）。
// 流式识别：真实 Deepgram 适配器连**本地同协议假服务**（SCRIPTED，按收到的音频时长回放脚本转写）——证明协议、断句、
// 指代绑定与界面闭环，不证明 Deepgram 的识别质量；AI 导演为脚本导演。
//
// 用法：node scripts/voice-browser-check.mjs   证据写入 docs/verification/artifacts/v6-2/
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { Blob } from 'node:buffer';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { deepgramResult, deepgramUtteranceEnd } from '../apps/realtime/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve('docs/verification/artifacts/v6-2');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v62-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

// 按音频时长回放的脚本（秒相对开麦）。中文：说"这里"在 0.7 s；英文：一句以 but 结尾先保留，后半句接上
const zhScript = () => [
  { atSeconds: 1.2, message: deepgramResult({ words: [['把', 0.5, 0.6], ['这里', 0.7, 0.9]], isFinal: false }) },
  { atSeconds: 3.2, message: deepgramResult({ words: [['把', 0.5, 0.6], ['这里', 0.7, 0.9], ['剪短', 1.0, 1.3], ['一点', 1.3, 1.6]], isFinal: true, speechFinal: true }) },
  { atSeconds: 3.8, message: deepgramUtteranceEnd(1.6) },
];
const enScript = () => [
  { atSeconds: 1.0, message: deepgramResult({ words: [['Make', 0.4, 0.5], ['this', 0.5, 0.7]], isFinal: false }) },
  { atSeconds: 1.6, message: deepgramResult({ words: [['Make', 0.4, 0.5], ['this', 0.5, 0.7], ['shorter,', 0.7, 1.0], ['but', 1.1, 1.3]], isFinal: true, speechFinal: true }) },
  { atSeconds: 2.6, message: deepgramResult({ words: [['keep', 2.0, 2.2], ['the', 2.2, 2.3], ['sound.', 2.3, 2.6]], isFinal: true, speechFinal: true }) },
];

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({
    director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v62-',
    voice: { script: (query) => (query.get('language') === 'en' ? enScript() : zhScript()) },
  });
  const { client, password } = await env.signedInClient(email);

  // 准备：一条已采用的第一版（3 段真实素材）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  // 假麦克风的声音（Chrome 从这个文件采集）
  const micFile = join(env.workDir, 'mic.wav');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', micFile]);

  const workspace = await client.workspaces.create({ name: '语音验收' });
  const ref = await client.studio.create(workspace.id, { title: '冰岛环岛 · 语音', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 3 && state.footage.every((item) => item.status === 'READY'), { label: 'footage ready' });
  const firstCut = await client.agent.startTurn(workspace.id, ref.sessionId, { message: '用这些素材剪出第一版。' }, { idempotencyKey: `t-${randomUUID()}` });
  const cut = await waitFor(() => client.agent.getTurn(workspace.id, firstCut.id), (turn) => turn.status !== 'RUNNING', { label: 'first cut' });
  const cutProposal = await client.projects.proposal(workspace.id, ref.projectId, cut.proposalId);
  await client.projects.adoptProposal(workspace.id, ref.projectId, cut.proposalId, { expectedOperationsHash: cutProposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `a-${randomUUID()}` });
  pass('准备：第一版已采用', '3 段真实素材');

  browser = await chromium.launch({
    headless: true,
    ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, '--autoplay-policy=no-user-gesture-required'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  await context.grantPermissions(['microphone'], { origin: env.baseUrl });
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

  // 1. 指着 lake.mp4 开麦；说到一半（转写出现后）改指 glacier.mp4 —— "这里"应绑定说出那一刻的 lake
  const lakeFootage = (await client.studio.state(workspace.id, ref.projectId)).footage.find((item) => item.name === 'lake.mp4');
  const composition = (await client.projects.state(ref.projectId, { schemaVersion: '1.0' })).document.composition;
  const videoTracks = new Set(composition.tracks.filter((track) => track.kind === 'VIDEO').map((track) => track.id));
  const lakeClipId = composition.clips.find((clip) => clip.assetVersionId === lakeFootage?.footageId && videoTracks.has(clip.trackId))?.id ?? null;
  await page.getByRole('button', { name: /^片段 lake\.mp4/ }).first().click();
  await page.getByRole('button', { name: '开始语音' }).click();
  await page.getByText('正在听，边看边说').waitFor({ timeout: 20_000 });
  await page.getByText('语音识别：测试替身').waitFor();
  await page.getByText('把这里', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText(/^指的是：片段「lake\.mp4」（说"这里"时）$/).waitFor();
  await shot('01-listening-partial');
  await page.getByRole('button', { name: /^片段 glacier\.mp4/ }).first().click();
  await page.getByText('试改好了，看看预览。').waitFor({ timeout: 60_000 });
  const turns = await client.agent.listTurns(workspace.id, ref.sessionId);
  const spoken = turns.find((turn) => turn.message === '把这里剪短一点');
  if (spoken === undefined) throw new Error(`voice turn not found: ${turns.map((turn) => turn.message).join(' | ')}`);
  if (lakeClipId === null || spoken.pointer.clipIds.join(',') !== lakeClipId) throw new Error(`deixis bound to ${JSON.stringify(spoken.pointer)}, expected lake ${String(lakeClipId)}`);
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
  await shot('02-voice-trial');
  const zhConnection = env.voiceAsrConnections[0];
  pass('中文：边说边出 → "这里"绑定说出那一刻的片段 → 作为一轮发出 → 试改', `指向 lake（说"这里"后已改指 glacier）；识别参数 ${zhConnection.query.get('model')}/${zhConnection.query.get('language')}，收到音频 ${(zhConnection.audioBytes / 32_000).toFixed(1)} s`);

  // 2. 关麦：网关收尾后关闭
  await page.getByRole('button', { name: '结束语音' }).click();
  await page.getByRole('button', { name: '开始语音' }).waitFor({ timeout: 20_000 });
  pass('关麦', '网关收到 CloseStream 后关闭连接');

  // 3. 英文：以 but 结尾先保留，后半句接上成一句
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('button', { name: 'Start voice' }).click();
  await page.getByText('Listening — talk while you watch').waitFor({ timeout: 20_000 });
  await page.getByText('Sounds unfinished — keep going…').waitFor({ timeout: 20_000 });
  await shot('03-english-held');
  // 界面换成英文后，AI 会话按英文新开（AI 用会话语言回应）：在最新的会话里找
  const english = await waitFor(async () => {
    const session = (await client.studio.state(workspace.id, ref.projectId)).session;
    return session === null ? [] : client.agent.listTurns(workspace.id, session.id);
  }, (items) => items.some((turn) => turn.message === 'Make this shorter, but keep the sound.'), { timeoutMs: 30_000, label: 'english voice turn' });
  const enTurn = english.find((turn) => turn.message === 'Make this shorter, but keep the sound.');
  await page.getByRole('button', { name: 'End voice' }).click();
  await shot('04-english-sent');
  const enConnection = env.voiceAsrConnections[1];
  pass('英文：未说完先保留，后半句接上', `"${enTurn.message}"；识别参数 ${enConnection.query.get('model')}/${enConnection.query.get('language')}`);

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-2 voice browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/v6-2/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
