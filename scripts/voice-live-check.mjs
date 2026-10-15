#!/usr/bin/env node
// Issue #9 画布内连续语音：真实服务的浏览器验收（真实语音识别 + 真实语音合成 + 真实 Claude 导演；不是测试替身）。
//
// 环境：同 voice-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg + Realtime Gateway + Next 生产服务 + Chrome）。
// - 识别 / 合成：OpenAI 兼容接口（/audio/transcriptions、/audio/speech），Key 与地址只从环境变量读：
//   OPENAI_API_KEY、ANCS_OPENAI_BASE_URL（可选）、ANCS_REALTIME_ASR_MODEL / ANCS_REALTIME_TTS_MODEL（可选）。
// - 导演：Claude（ANTHROPIC_API_KEY、ANCS_ANTHROPIC_BASE_URL 可选、ANCS_AGENT_MODEL 缺省 claude-opus-5-5）。第一版用脚本导演准备（不计费），之后每一句都交给真实 Claude。
// - "用户的声音"：先用真实语音合成生成几句中英文测试语音（换一个声音），再通过替换 getUserMedia 的方式从真实 Web Audio 管线送进页面——
//   之后走的是产品的真实路径：AudioWorklet → 16 kHz PCM → 网关断句 → 真实识别 → 一句话交给 AI → 真实合成念回应。
// - 费用：识别按音频时长、合成按字符、Claude 按 token；脚本只做固定的几句，不自动重试任何付费调用，结束时汇总用量写进 summary.json。
// - Key 只放在请求头里，不打印、不写证据文件。
//
// 用法：node scripts/voice-live-check.mjs   证据写入 docs/verification/artifacts/v6-2/issue-9/
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Blob } from 'node:buffer';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createOpenAiSpeechSynthesizer, createOpenAiTranscriptionRecognizer } from '../apps/realtime/dist/index.js';
import { closeVoiceSession } from '../packages/domain/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/v6-2/issue-9');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const audioKey = process.env.OPENAI_API_KEY;
const audioBase = process.env.ANCS_OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
const claudeKey = process.env.ANTHROPIC_API_KEY;
const claudeModel = process.env.ANCS_AGENT_MODEL ?? 'claude-opus-5-5';
const asrModel = process.env.ANCS_REALTIME_ASR_MODEL ?? 'gpt-4o-transcribe';
const ttsModel = process.env.ANCS_REALTIME_TTS_MODEL ?? 'gpt-4o-mini-tts';
if (!audioKey || !claudeKey) {
  console.error('[NOT RUN] 需要环境变量 OPENAI_API_KEY（OpenAI 兼容语音接口）与 ANTHROPIC_API_KEY（Claude）。不会回退到测试替身。');
  process.exit(2);
}

const email = `issue9-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const metrics = { utterances: [], replies: [], bargeIns: [], stopSpeaking: null, connect: [], claudeTurns: [] };
const usage = { asrRequests: 0, asrAudioSeconds: 0, ttsRequests: 0, ttsCharacters: 0, clipTtsRequests: 0, clipTtsCharacters: 0, badKeyAsrRequests: 0 };
const gatewayEvents = [];

/** 计数的 fetch：只记请求数与计费量（音频秒数 / 字符数），不记内容与请求头 */
const counting = (kind) => async (input, init) => {
  if (kind === 'asr' || kind === 'asr-bad') {
    const file = init.body.get('file');
    if (kind === 'asr') { usage.asrRequests += 1; usage.asrAudioSeconds += Math.max(0, file.size - 44) / 32_000; } else usage.badKeyAsrRequests += 1;
  } else {
    usage.ttsRequests += 1;
    usage.ttsCharacters += JSON.parse(init.body).input.length;
  }
  return fetch(input, init);
};

// 测试用的"用户的话"（真实合成，用和 AI 不同的声音）；带 0.3 s 前置静音
const LEAD_SECONDS = 0.3;
const CLIPS = {
  zh_edit1: { locale: 'zh-CN', text: '把这一段剪短一点。' },
  zh_edit2: { locale: 'zh-CN', text: '好，然后呢，把这里的音乐调小一点。' },
  zh_fix: { locale: 'zh-CN', text: '不对，第一段不用剪那么多，保留三秒就行。' },
  zh_barge: { locale: 'zh-CN', text: '等一下，先这样，再把结尾淡出一点。' },
  zh_short: { locale: 'zh-CN', text: '把开头剪掉一秒。' },
  en_edit: { locale: 'en', text: 'Make this clip a little shorter.' },
  en_barge: { locale: 'en', text: 'Hold on. Also turn the music down here.' },
};

async function synthesizeClips(dir) {
  await mkdir(dir, { recursive: true });
  const out = {};
  for (const [name, clip] of Object.entries(CLIPS)) {
    const hash = createHash('sha256').update(`${ttsModel}|alloy|${clip.text}`).digest('hex').slice(0, 16);
    const file = join(dir, `${name}-${hash}.pcm`);
    if (!existsSync(file)) {
      usage.clipTtsRequests += 1;
      usage.clipTtsCharacters += clip.text.length;
      const response = await fetch(`${audioBase.replace(/\/+$/, '')}/audio/speech`, {
        method: 'POST',
        headers: { authorization: `Bearer ${audioKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: ttsModel, voice: 'alloy', input: clip.text, response_format: 'pcm' }),
      });
      if (!response.ok) throw new Error(`clip synthesis failed: HTTP ${String(response.status)}`);
      const pcm = Buffer.from(await response.arrayBuffer());
      await writeFile(file, Buffer.concat([Buffer.alloc(Math.round(LEAD_SECONDS * 24_000) * 2), pcm]));
    }
    const bytes = await readFile(file);
    out[name] = { ...clip, base64: bytes.toString('base64'), seconds: bytes.length / 2 / 24_000 };
  }
  return out;
}

// 可切换的导演：准备第一版时用脚本导演（不计费），之后交给真实 Claude
function switchingDirector(live) {
  const scripted = new ScriptedDirector();
  const state = { live: false };
  return {
    state,
    get providerId() { return state.live ? live.providerId : scripted.providerId; },
    get implementation() { return state.live ? live.implementation : scripted.implementation; },
    get model() { return state.live ? live.model : scripted.model; },
    respond: (request) => (state.live ? live.respond(request) : scripted.respond(request)),
  };
}

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  const { AnthropicAgentModel } = await import('../packages/providers/anthropic/dist/index.js');
  const claude = new AnthropicAgentModel({ apiKey: claudeKey, model: claudeModel, ...(process.env.ANCS_ANTHROPIC_BASE_URL ? { baseURL: process.env.ANCS_ANTHROPIC_BASE_URL } : {}) });
  const director = switchingDirector(claude);
  const log = (event, detail) => { gatewayEvents.push({ at: Date.now(), event, ...detail }); };
  const voices = [{ id: 'coral', name: 'Coral' }, { id: 'onyx', name: 'Onyx' }, { id: 'nova', name: 'Nova' }];
  const realVoice = () => ({
    recognizer: createOpenAiTranscriptionRecognizer({ apiKey: audioKey, baseUrl: audioBase, model: asrModel, fetch: counting('asr'), log }),
    synthesizer: createOpenAiSpeechSynthesizer({ apiKey: audioKey, baseUrl: audioBase, model: ttsModel, voices, fetch: counting('tts') }),
    log,
  });
  env = await startStudioEnv({ director, webPort, workDirPrefix: 'ancs-issue9-', voice: realVoice() });
  const clips = await synthesizeClips(process.env.ANCS_VOICE_CLIPS_DIR ?? join(env.workDir, 'clips'));
  pass('准备：测试语音（真实合成，声音 alloy）', Object.values(clips).map((clip) => `${clip.text}（${clip.seconds.toFixed(1)} s）`).join(' / '));
  const { client, password } = await env.signedInClient(email);

  // 第一版（脚本导演，3 段真实素材，各带一段持续的"背景音乐"音调）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  const workspace = await client.workspaces.create({ name: 'Issue 9 语音' });
  const ref = await client.studio.create(workspace.id, { title: '冰岛环岛 · 连续语音', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 3 && state.footage.every((item) => item.status === 'READY'), { label: 'footage ready' });
  const firstCut = await client.agent.startTurn(workspace.id, ref.sessionId, { message: '用这些素材剪出第一版。' }, { idempotencyKey: `t-${randomUUID()}` });
  const cut = await waitFor(() => client.agent.getTurn(workspace.id, firstCut.id), (turn) => turn.status !== 'RUNNING', { label: 'first cut' });
  const cutProposal = await client.projects.proposal(workspace.id, ref.projectId, cut.proposalId);
  await client.projects.adoptProposal(workspace.id, ref.projectId, cut.proposalId, { expectedOperationsHash: cutProposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `a-${randomUUID()}` });
  director.state.live = true;
  pass('准备：第一版已采用（脚本导演）；之后每一句交给真实 Claude', `${claude.providerId}/${claudeModel}${process.env.ANCS_ANTHROPIC_BASE_URL ? '（经兼容网关）' : ''}`);

  const composition = (await client.projects.state(ref.projectId, { schemaVersion: '1.0' })).document.composition;
  const footage = (await client.studio.state(workspace.id, ref.projectId)).footage;
  const videoTracks = new Set(composition.tracks.filter((track) => track.kind === 'VIDEO').map((track) => track.id));
  const clipIdOf = (name) => composition.clips.find((clip) => clip.assetVersionId === footage.find((item) => item.name === name)?.footageId && videoTracks.has(clip.trackId))?.id ?? null;

  browser = await chromium.launch({
    headless: true,
    ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}),
    args: ['--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
  const pageErrors = [];
  const voiceSockets = [];

  /** 新开一个浏览器页面：替换 getUserMedia 为可控的"麦克风"（真实 Web Audio 管线），并记录语音条阶段与反馈的每次变化（页面时钟） */
  async function openStudio(options) {
    const context = await browser.newContext({ viewport: options.viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: options.colorScheme ?? 'light', ...(options.mobile ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    await context.grantPermissions(['microphone'], { origin: env.baseUrl });
    await context.addInitScript(() => {
      const mic = { ctx: null, dest: null, clips: {}, deny: false, log: [], current: null };
      globalThis.__mic = mic;
      const ensure = () => { if (mic.ctx === null) mic.ctx = new globalThis.AudioContext(); return mic.ctx; };
      globalThis.navigator.mediaDevices.getUserMedia = async () => {
        if (mic.deny) throw new globalThis.DOMException('Permission denied', 'NotAllowedError');
        const ctx = ensure();
        await ctx.resume();
        mic.dest = ctx.createMediaStreamDestination();
        return mic.dest.stream;
      };
      mic.load = (name, base64, rate) => {
        const bytes = Uint8Array.from(globalThis.atob(base64), (char) => char.charCodeAt(0));
        const view = new DataView(bytes.buffer);
        const ctx = ensure();
        const buffer = ctx.createBuffer(1, bytes.length / 2, rate);
        const data = buffer.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = view.getInt16(index * 2, true) / 32768;
        mic.clips[name] = buffer;
        return buffer.duration;
      };
      mic.play = (name) => {
        const ctx = ensure();
        const source = ctx.createBufferSource();
        source.buffer = mic.clips[name];
        source.connect(mic.dest);
        const startedAt = globalThis.performance.now();
        source.start();
        mic.current = new Promise((done) => { source.onended = () => done({ startedAt, endedAt: globalThis.performance.now() }); });
        return startedAt;
      };
      const record = () => {
        const dock = globalThis.document.querySelector('[data-voice-dock]');
        const phase = dock?.getAttribute('data-phase') ?? 'off';
        const caption = globalThis.document.querySelector('[data-voice-caption]')?.textContent ?? '';
        const last = mic.log[mic.log.length - 1];
        if (last === undefined || last.phase !== phase || last.caption !== caption) mic.log.push({ t: globalThis.performance.now(), phase, caption });
      };
      new globalThis.MutationObserver(record).observe(globalThis.document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-phase'] });
    });
    const tab = await context.newPage();
    tab.on('pageerror', (error) => pageErrors.push(`${tab.url()}: ${error.message}`));
    tab.on('websocket', (socket) => voiceSockets.push(socket.url()));
    await tab.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
    await tab.getByLabel('邮箱').fill(email);
    await tab.getByLabel('密码').fill(password);
    await tab.getByRole('button', { name: '登录', exact: true }).click();
    await tab.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
    await tab.goto(`${env.baseUrl}/w/${workspace.id}/studio/${ref.projectId}`, { waitUntil: 'networkidle' });
    await tab.locator('video').waitFor({ timeout: 120_000 });
    for (const [name, clip] of Object.entries(clips)) await tab.evaluate(([clipName, base64]) => globalThis.__mic.load(clipName, base64, 24_000), [name, clip.base64]);
    return tab;
  }

  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const dock = () => page.locator('[data-voice-dock]');
  const waitPhase = (phase, timeout = 30_000) => page.locator(`[data-voice-dock][data-phase="${phase}"]`).waitFor({ timeout });
  const phaseLog = () => page.evaluate(() => globalThis.__mic.log);
  const play = (name) => page.evaluate((clipName) => globalThis.__mic.play(clipName), name);
  const playEnded = () => page.evaluate(() => globalThis.__mic.current);
  const now = () => page.evaluate(() => globalThis.performance.now());
  /** 页面时钟上，t0 之后第一条满足条件的阶段记录（轮询直到超时） */
  const firstAfter = async (t0, test, timeoutMs, label) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = (await phaseLog()).find((entry) => entry.t >= t0 && test(entry));
      if (hit !== undefined) return hit;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}: ${JSON.stringify((await phaseLog()).slice(-6))}`);
      await new Promise((done) => setTimeout(done, 40));
    }
  };
  const currentSession = async () => (await client.studio.state(workspace.id, ref.projectId)).session;
  const voiceTurns = async () => {
    const session = await currentSession();
    return session === null ? [] : (await client.agent.listTurns(workspace.id, session.id)).filter((turn) => turn.message !== '用这些素材剪出第一版。');
  };
  const waitTurns = (count, label, timeoutMs = 360_000) => waitFor(voiceTurns, (turns) => turns.length >= count && turns.every((turn) => turn.status !== 'RUNNING'), { timeoutMs, intervalMs: 1000, label });
  const isTranscript = (entry) => entry.phase === 'recognizing' && entry.caption !== '' && !entry.caption.startsWith('…');
  /** 说一句：记录开口检测、首个转写、说完到交给 AI 的时间（页面时钟，毫秒） */
  async function say(name, options = {}) {
    const clip = clips[name];
    const started = await play(name);
    const onset = started + LEAD_SECONDS * 1000;
    const speech = await firstAfter(onset - 100, (entry) => entry.phase === 'recognizing', 15_000, `${name} speech start`);
    if (options.duringSpeech !== undefined) await options.duringSpeech(speech.t);
    const transcript = await firstAfter(onset, isTranscript, 20_000, `${name} first transcript`);
    if (options.onTranscript !== undefined) await options.onTranscript();
    const ended = await playEnded();
    const delivered = await firstAfter(ended.endedAt, (entry) => entry.phase === 'thinking' || entry.phase === 'speaking' || entry.caption.includes('排队'), 30_000, `${name} delivered`);
    const record = {
      clip: name, locale: clip.locale, text: clip.text, speechSeconds: Number((clip.seconds - LEAD_SECONDS).toFixed(2)),
      speechStartMs: Math.round(speech.t - onset), firstTranscriptMs: Math.round(transcript.t - onset), firstTranscriptText: transcript.caption,
      endToDeliveredMs: Math.round(delivered.t - ended.endedAt), endedAt: ended.endedAt,
    };
    metrics.utterances.push(record);
    return record;
  }
  const rectsClear = () => page.evaluate(() => {
    const dockElement = globalThis.document.querySelector('[data-voice-dock]');
    if (dockElement === null) return { ok: false, reason: 'no dock' };
    const parts = [...dockElement.children].map((child) => child.getBoundingClientRect());
    const targets = {
      video: globalThis.document.querySelector('video')?.parentElement,
      strip: globalThis.document.querySelector('[role="group"][aria-label="时间带"], [role="group"][aria-label="Timeline"]'),
      play: globalThis.document.querySelector('button[aria-keyshortcuts="Space"]'),
      composer: globalThis.document.querySelector('[data-composer-input]'),
    };
    const overlaps = [];
    for (const [name, element] of Object.entries(targets)) {
      if (element === null || element === undefined) continue;
      const box = element.getBoundingClientRect();
      for (const part of parts) if (part.left < box.right && part.right > box.left && part.top < box.bottom && part.bottom > box.top) overlaps.push(name);
    }
    const inView = parts.every((part) => part.left >= 0 && part.right <= globalThis.innerWidth && part.top >= 0 && part.bottom <= globalThis.innerHeight);
    return { ok: overlaps.length === 0 && inView, overlaps, inView, checked: Object.entries(targets).filter(([, element]) => element != null).map(([name]) => name) };
  });
  const assertClear = async (label) => {
    const check = await rectsClear();
    if (!check.ok) throw new Error(`${label}: voice dock overlaps ${JSON.stringify(check)}`);
    return check;
  };
  const replyEvents = () => gatewayEvents.filter((event) => event.event === 'reply');
  /** 打断测量有效的前提：开口那一刻 AI 确实还在说，且停下后进入"正在听你说"（不是自己念完） */
  const assertSpeakingAt = async (onset, stoppedEntry, label) => {
    const before = (await phaseLog()).filter((entry) => entry.t <= onset);
    if (before.at(-1)?.phase !== 'speaking') throw new Error(`${label}: the reply had already finished before the user spoke (${JSON.stringify(before.slice(-3))})`);
    if (stoppedEntry.phase !== 'recognizing') throw new Error(`${label}: reply stopped into ${stoppedEntry.phase}, not because the user spoke`);
  };

  // ================= 中文：桌面 · 浅色 =================
  page = await openStudio({ viewport: { width: 1440, height: 900 } });
  await page.getByRole('button', { name: /^片段 lake\.mp4/ }).first().click();
  let t0 = await now();
  await page.getByRole('button', { name: '开始语音' }).click();
  await waitPhase('listening');
  metrics.connect.push({ label: 'zh desktop', ms: Math.round((await firstAfter(t0, (entry) => entry.phase === 'listening', 1000, 'listening')).t - t0) });
  if ((await dock().getByRole('combobox', { name: 'AI 的声音' }).locator('option').allTextContents()).join(',') !== 'Coral,Onyx,Nova') throw new Error('voice picker should list the configured real voices');
  await dock().getByRole('combobox', { name: 'AI 的声音' }).selectOption('nova');
  await assertClear('zh listening');
  await shot('01-zh-desktop-light-listening');
  pass('开麦：连续会话就绪（真实识别 + 真实合成）', `点"开始语音"到"在听" ${String(metrics.connect[0].ms)} ms；声音下拉只列真实可用的 Coral / Onyx / Nova，选 Nova；语音条不压画面、时间带、播放键与输入框`);

  // 第一句：指着 lake.mp4 说"把这一段剪短一点"
  const lakeClip = clipIdOf('lake.mp4');
  const glacierClip = clipIdOf('glacier.mp4');
  const first = await say('zh_edit1', { onTranscript: async () => { await shot('02-zh-desktop-light-recognizing'); } });
  await waitPhase('thinking', 30_000).catch(() => undefined);
  pass('第一句：边说边出 → 说完交给 AI', `开口 ${String(first.speechStartMs)} ms 后进入"正在听你说"；首个转写 ${String(first.firstTranscriptMs)} ms（"${first.firstTranscriptText}"）；说完到交出 ${String(first.endToDeliveredMs)} ms`);

  // 第二句（AI 还在处理第一句）：开口时指着 road，说到一半（"这里"之前）改指 glacier → 排队，按说"这里"那一刻的指向发出
  await page.getByRole('button', { name: /^片段 road\.mp4/ }).first().click();
  await page.waitForTimeout(300);
  const second = await say('zh_edit2', {
    duringSpeech: async () => { await page.waitForTimeout(150); await page.getByRole('button', { name: /^片段 glacier\.mp4/ }).first().click(); },
  });
  const queued = (await phaseLog()).some((entry) => entry.t >= second.endedAt - 50 && entry.caption.includes('排队'));
  if (queued) await shot('03-zh-desktop-light-thinking-queued');
  pass('第二句：说到一半换指向；AI 忙时排队', `${queued ? '已排队（"还有 1 句排队"）' : 'AI 已空闲，直接发出'}；首个转写 ${String(second.firstTranscriptMs)} ms；说完到交出 ${String(second.endToDeliveredMs)} ms`);

  // 第一句的回应：真实 Claude 完成 → 网关用真实合成念出来（选的 Nova）
  const speaking1 = await firstAfter(first.endedAt, (entry) => entry.phase === 'speaking', 360_000, 'first reply audio');
  metrics.replies.push({ after: 'zh_edit1', userEndToFirstAudioMs: Math.round(speaking1.t - first.endedAt) });
  await assertClear('zh speaking');
  await shot('04-zh-desktop-light-speaking');
  let turns = await waitTurns(2, 'two voice turns');
  const firstTurn = turns.find((turn) => turn.pointer.clipIds.includes(lakeClip ?? '-')) ?? turns[turns.length - 1];
  const secondTurn = turns.find((turn) => turn.message.includes('音乐') || turn.message.toLowerCase().includes('music'));
  if (secondTurn === undefined) throw new Error(`second voice turn not found: ${turns.map((turn) => turn.message).join(' | ')}`);
  if (!secondTurn.pointer.clipIds.includes(glacierClip ?? '-')) throw new Error(`mid-sentence switch: "这里" bound to ${JSON.stringify(secondTurn.pointer)}, expected glacier ${String(glacierClip)}`);
  if (!firstTurn.pointer.clipIds.includes(lakeClip ?? '-')) throw new Error(`first utterance bound to ${JSON.stringify(firstTurn.pointer)}, expected lake ${String(lakeClip)}`);
  const firstReply = replyEvents()[0];
  pass('AI 回应：真实 Claude → 真实语音合成念出来', `说完到听见回应 ${String(metrics.replies[0].userEndToFirstAudioMs)} ms（其中 Claude 这一轮 ${String(Math.round((Date.parse(firstTurn.completedAt) - Date.parse(firstTurn.createdAt)) / 1000))} s，合成首块 ${String(firstReply?.firstChunkMs ?? '?')} ms，声音 ${String(firstReply?.voice ?? '?')}）`);
  pass('指向绑定：第一句绑 lake；第二句开口指 road、说"这里"前改指 glacier → 绑 glacier', `第一轮"${firstTurn.message}"→ ${firstTurn.pointer.clipIds.join(',')}；第二轮"${secondTurn.message}"→ ${secondTurn.pointer.clipIds.join(',')}`);

  // 纠正：第三句
  await firstAfter(await now(), (entry) => entry.phase === 'listening', 120_000, 'idle before correction');
  const fix = await say('zh_fix');
  turns = await waitTurns(3, 'correction turn');
  const fixTurn = turns.find((turn) => turn.message.includes('不对') || turn.message.includes('三秒') || turn.message.includes('3 秒'));
  pass('纠正：作为新的一句交给 AI（带上前文）', `"${fixTurn?.message ?? turns[0].message}"；首个转写 ${String(fix.firstTranscriptMs)} ms`);

  // 打断：AI 念回应时开口 → 立刻停播
  const speaking3 = await firstAfter(fix.endedAt, (entry) => entry.phase === 'speaking', 360_000, 'correction reply audio');
  metrics.replies.push({ after: 'zh_fix', userEndToFirstAudioMs: Math.round(speaking3.t - fix.endedAt) });
  await page.waitForTimeout(700);
  const barge = await play('zh_barge');
  const bargeOnset = barge + LEAD_SECONDS * 1000;
  const stopped = await firstAfter(bargeOnset - 100, (entry) => entry.phase !== 'speaking', 10_000, 'barge-in stop');
  await assertSpeakingAt(bargeOnset, stopped, 'zh barge-in');
  metrics.bargeIns.push({ locale: 'zh-CN', speechOnsetToSilenceMs: Math.round(stopped.t - bargeOnset), phaseAfter: stopped.phase });
  await shot('05-zh-desktop-light-barge-in');
  await playEnded();
  await firstAfter(bargeOnset, (entry) => entry.phase === 'thinking', 30_000, 'barge utterance delivered');
  const stoppedReply = replyEvents().find((event) => event.stopped === true);
  pass('打断：AI 说话时开口，回应立即停下，这句话接着交给 AI', `开口到停声 ${String(metrics.bargeIns[0].speechOnsetToSilenceMs)} ms（阶段 → ${stopped.phase}）；网关记录被打断的回应 ${stoppedReply === undefined ? '未见' : `念了 ${String(stoppedReply.audioSeconds)} s 后中止`}`);

  // 继续：打断那句的回应 → "停止说话"只停声音
  const speaking4 = await firstAfter(stopped.t + 1, (entry) => entry.phase === 'speaking', 360_000, 'continue reply audio');
  metrics.replies.push({ after: 'zh_barge', userEndToFirstAudioMs: null });
  await page.waitForTimeout(300);
  if ((await page.locator('[data-voice-dock]').getAttribute('data-phase')) === 'speaking') {
    const before = await now();
    await dock().getByRole('button', { name: '停止说话' }).click();
    const silent = await firstAfter(before, (entry) => entry.phase !== 'speaking', 5000, 'stop speaking');
    metrics.stopSpeaking = { clickToSilenceMs: Math.round(silent.t - before), phaseAfter: silent.phase };
    await page.locator('[data-voice-caption]').filter({ hasText: '已停止说话' }).waitFor({ timeout: 5000 });
    pass('停止说话：只停声音，不影响这一轮与试改', `点击到停声 ${String(metrics.stopSpeaking.clickToSilenceMs)} ms（之后阶段 ${silent.phase}）`);
  } else {
    pass('停止说话：回应太短，按钮出现前已念完（未测）', `回应开始于页面时钟 ${String(Math.round(speaking4.t))} ms`);
  }
  turns = await waitTurns(4, 'continue turn');

  // 采用 / 撤销：改动只经试改，由用户明确采用
  const keepButton = dock().getByRole('button', { name: '采用' });
  await keepButton.waitFor({ timeout: 60_000 });
  await shot('06-zh-desktop-light-trial');
  const revisionBefore = (await client.studio.state(workspace.id, ref.projectId)).project.revision;
  await keepButton.click();
  await dock().getByRole('button', { name: '撤销改动' }).waitFor({ timeout: 60_000 });
  const revisionAdopted = (await client.studio.state(workspace.id, ref.projectId)).project.revision;
  await dock().getByRole('button', { name: '撤销改动' }).click();
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.project.revision > revisionAdopted, { timeoutMs: 60_000, label: 'undo' });
  pass('采用 → 撤销：改动只在用户点"采用"后生效，可撤销', `revision ${String(revisionBefore)} → 采用 ${String(revisionAdopted)} → 撤销后 ${String((await client.studio.state(workspace.id, ref.projectId)).project.revision)}`);

  // 结束语音（与停止说话 / 停止这一轮分开）
  await dock().getByRole('button', { name: '结束语音' }).click();
  await waitPhase('ended', 20_000);
  await shot('07-zh-desktop-light-ended');
  pass('结束语音：网关收尾后关闭 → "语音已结束"');

  // ================= 错误与恢复（桌面 · 浅色） =================
  const turnCount = async () => (await voiceTurns()).length;
  // 1) 断线：网关断开所有连接
  await page.getByRole('button', { name: '开始语音' }).click();
  await waitPhase('listening');
  let turnsBefore = await turnCount();
  let asrBefore = usage.asrRequests;
  await env.swapVoiceGateway(realVoice());
  await waitPhase('error');
  await page.locator('[data-voice-caption]').filter({ hasText: '语音连接断了' }).waitFor();
  await shot('10-error-connection-lost');
  await page.waitForTimeout(3000);
  if (usage.asrRequests !== asrBefore || (await turnCount()) !== turnsBefore) throw new Error('connection drop must not trigger provider calls or turns');
  await dock().getByRole('button', { name: '重新连接' }).click();
  await waitPhase('listening');
  if ((await turnCount()) !== turnsBefore) throw new Error('reconnect must not replay sent utterances');
  pass('断线：如实说明；不自动重连、不自动调用付费服务；点"重新连接"开新会话，已交出的话不重复执行', `断线后 3 s 内识别请求 +0、轮次 +0；重连后轮次仍 ${String(turnsBefore)}`);

  // 2) 会话过期 / 被撤销：之后说的话不交给 AI
  const sessionParam = new URL(voiceSockets[voiceSockets.length - 1]).searchParams.get('session');
  await closeVoiceSession(env.deps, { workspaceId: workspace.id, projectId: ref.projectId, sessionId: sessionParam });
  await play('zh_short');
  await page.locator('[data-voice-caption]').filter({ hasText: '语音会话已过期' }).waitFor({ timeout: 30_000 });
  await shot('11-error-session-expired');
  await playEnded();
  await page.waitForTimeout(1500);
  if ((await turnCount()) !== turnsBefore) throw new Error('an utterance from an expired session reached the AI');
  pass('会话过期：网关在交出前复查会话门，这句不交给 AI，界面提示重新连接', `轮次仍 ${String(turnsBefore)}`);

  // 3) 识别服务密钥失效：一次失败，不重试
  await env.swapVoiceGateway({ recognizer: createOpenAiTranscriptionRecognizer({ apiKey: 'invalid-key-for-failure-test-000000', baseUrl: audioBase, model: asrModel, fetch: counting('asr-bad') }), log }); // secrets:check-ignore：故意无效的假 Key
  await dock().getByRole('button', { name: '重新连接' }).click();
  await waitPhase('listening');
  await play('zh_short');
  await page.locator('[data-voice-caption]').filter({ hasText: '密钥无效或已过期' }).waitFor({ timeout: 30_000 });
  await shot('12-error-provider-auth');
  await playEnded();
  const badRequests = usage.badKeyAsrRequests;
  await page.waitForTimeout(4000);
  if (usage.badKeyAsrRequests !== badRequests) throw new Error('provider failure must not retry automatically');
  if (await dock().getByRole('button', { name: '重新连接' }).count() !== 0) throw new Error('reconnect is pointless when the provider key is invalid');
  pass('识别服务失败（密钥无效）：如实说明，不自动重试', `供应商请求 ${String(badRequests)} 次后停止；4 s 内无新请求；不提供"重新连接"（重连无用）`);

  // 4) 服务端没配置识别
  await env.swapVoiceGateway({ log });
  await dock().getByRole('button', { name: '关闭' }).click();
  await page.getByRole('button', { name: '开始语音' }).click();
  await page.locator('[data-voice-caption]').filter({ hasText: '服务端尚未接入语音识别' }).waitFor({ timeout: 20_000 });
  await shot('13-error-not-configured');
  pass('未配置识别：明确说明，不回退测试替身');

  // 5) 没有麦克风权限
  await dock().getByRole('button', { name: '关闭' }).click();
  await page.evaluate(() => { globalThis.__mic.deny = true; });
  await page.getByRole('button', { name: '开始语音' }).click();
  await page.locator('[data-voice-caption]').filter({ hasText: '没有麦克风权限' }).waitFor({ timeout: 20_000 });
  await shot('14-error-permission-denied');
  await page.evaluate(() => { globalThis.__mic.deny = false; });
  await dock().getByRole('button', { name: '关闭' }).click();
  pass('没有麦克风权限：说明原因，可在允许后重新连接');
  await env.swapVoiceGateway(realVoice());

  // 键盘：V 开始、Tab 进入语音条（可见焦点）、Enter 结束
  await page.evaluate(() => { globalThis.document.activeElement?.blur(); });
  await page.keyboard.press('v');
  await waitPhase('listening');
  let focusedInDock = false;
  for (let index = 0; index < 60 && !focusedInDock; index += 1) {
    await page.keyboard.press('Tab');
    focusedInDock = await page.evaluate(() => globalThis.document.activeElement?.closest('[data-voice-dock]') !== null && globalThis.document.activeElement?.tagName === 'BUTTON');
  }
  if (!focusedInDock) throw new Error('voice dock buttons are not reachable with Tab');
  const outline = await page.evaluate(() => globalThis.getComputedStyle(globalThis.document.activeElement).outlineStyle);
  await shot('15-keyboard-focus');
  await dock().getByRole('button', { name: '结束语音' }).focus();
  await page.keyboard.press('Enter');
  await waitPhase('ended', 20_000);
  pass('键盘：V 开关语音；Tab 可进入语音条且有可见焦点；Enter 结束', `焦点样式 outline=${outline}`);
  await page.close();

  // ================= English · desktop · dark =================
  page = await openStudio({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  if (!(await page.evaluate(() => globalThis.document.body.classList.contains('theme-dark')))) await page.getByRole('button', { name: 'Toggle light/dark' }).click();
  await page.getByRole('button', { name: /^Clip lake\.mp4/ }).first().click();
  t0 = await now();
  await page.getByRole('button', { name: 'Start voice' }).click();
  await waitPhase('listening');
  metrics.connect.push({ label: 'en desktop', ms: Math.round((await firstAfter(t0, (entry) => entry.phase === 'listening', 1000, 'listening')).t - t0) });
  await assertClear('en listening');
  await shot('20-en-desktop-dark-listening');
  const enEdit = await say('en_edit', { onTranscript: async () => { await shot('21-en-desktop-dark-recognizing'); } });
  const enSpeaking = await firstAfter(enEdit.endedAt, (entry) => entry.phase === 'speaking', 360_000, 'english reply audio');
  metrics.replies.push({ after: 'en_edit', userEndToFirstAudioMs: Math.round(enSpeaking.t - enEdit.endedAt) });
  await shot('22-en-desktop-dark-speaking');
  await page.waitForTimeout(600);
  const enBarge = await play('en_barge');
  const enOnset = enBarge + LEAD_SECONDS * 1000;
  const enStopped = await firstAfter(enOnset - 100, (entry) => entry.phase !== 'speaking', 10_000, 'english barge-in');
  await assertSpeakingAt(enOnset, enStopped, 'en barge-in');
  metrics.bargeIns.push({ locale: 'en', speechOnsetToSilenceMs: Math.round(enStopped.t - enOnset), phaseAfter: enStopped.phase });
  await playEnded();
  await firstAfter(enOnset, (entry) => entry.phase === 'thinking', 30_000, 'english barge delivered');
  const enTurns = await waitFor(async () => {
    const session = await currentSession();
    return session === null ? [] : client.agent.listTurns(workspace.id, session.id);
  }, (items) => items.length >= 2 && items.every((turn) => turn.status !== 'RUNNING'), { timeoutMs: 360_000, intervalMs: 1000, label: 'english turns' });
  await shot('23-en-desktop-dark-after');
  await page.locator('[data-voice-dock]').getByRole('button', { name: 'End voice' }).click();
  await waitPhase('ended', 20_000);
  pass('English: real speech in → real Claude → spoken reply → barge-in', `first transcript ${String(enEdit.firstTranscriptMs)} ms ("${enEdit.firstTranscriptText}"); end → audible reply ${String(metrics.replies.at(-1).userEndToFirstAudioMs)} ms; barge-in ${String(metrics.bargeIns.at(-1).speechOnsetToSilenceMs)} ms; turns: ${enTurns.slice(0, 2).map((turn) => `"${turn.message}"`).join(', ')}`);
  await page.close();

  // ================= 手机 · 浅色 / 深色 =================
  page = await openStudio({ viewport: { width: 390, height: 844 }, mobile: true });
  await page.getByRole('button', { name: '开始语音' }).click();
  await waitPhase('listening');
  await assertClear('phone listening');
  await shot('30-zh-phone-light-listening');
  const phone = await say('zh_short', { onTranscript: async () => { await shot('31-zh-phone-light-recognizing'); } });
  await assertClear('phone thinking');
  await shot('32-zh-phone-light-thinking');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(200);
  await shot('33-zh-phone-dark-thinking');
  const phoneSpeaking = await firstAfter(phone.endedAt, (entry) => entry.phase === 'speaking', 360_000, 'phone reply audio');
  metrics.replies.push({ after: 'zh_short (phone)', userEndToFirstAudioMs: Math.round(phoneSpeaking.t - phone.endedAt) });
  await assertClear('phone speaking');
  await shot('34-zh-phone-dark-speaking');
  await page.locator('[data-voice-dock]').getByRole('button', { name: '结束语音' }).click();
  await waitPhase('ended', 20_000);
  pass('手机：浅色 / 深色下语音条不遮挡画面、时间带、播放与输入；按钮只留图标（读屏仍读全名）', `首个转写 ${String(phone.firstTranscriptMs)} ms；说完到听见回应 ${String(metrics.replies.at(-1).userEndToFirstAudioMs)} ms`);

  // ================= 用量 =================
  const allTurns = [];
  for (const session of [ref.sessionId, (await currentSession())?.id].filter(Boolean)) allTurns.push(...await client.agent.listTurns(workspace.id, session));
  const seen = new Set();
  for (const turn of allTurns) {
    if (seen.has(turn.id) || turn.message === '用这些素材剪出第一版。') continue;
    seen.add(turn.id);
    metrics.claudeTurns.push({ message: turn.message, status: turn.status, seconds: turn.completedAt === null ? null : Math.round((Date.parse(turn.completedAt) - Date.parse(turn.createdAt)) / 100) / 10, tools: turn.toolCalls.map((call) => call.name), proposal: turn.proposalId !== null, usage: turn.usage, costMicros: turn.costMicros, reply: turn.reply });
  }
  const replies = replyEvents();
  const summary = {
    generatedAt: new Date().toISOString(),
    providers: { asr: `openai-compatible ${asrModel}`, tts: `openai-compatible ${ttsModel}`, director: `anthropic ${claudeModel}`, viaGateway: { audio: audioBase !== 'https://api.openai.com/v1', claude: Boolean(process.env.ANCS_ANTHROPIC_BASE_URL) } },
    results,
    metrics: {
      ...metrics,
      gatewayReplies: replies.map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'at' && key !== 'event'))),
      asrEvents: gatewayEvents.filter((event) => event.event.startsWith('asr_')).map((event) => Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'at'))),
    },
    usage: { ...usage, asrAudioSeconds: Number(usage.asrAudioSeconds.toFixed(1)), claudeTokens: metrics.claudeTurns.reduce((sum, turn) => ({ input: sum.input + (turn.usage?.inputTokens ?? 0), output: sum.output + (turn.usage?.outputTokens ?? 0), cacheRead: sum.cacheRead + (turn.usage?.cacheReadInputTokens ?? 0) }), { input: 0, output: 0, cacheRead: 0 }) },
  };
  await writeFile(join(evidenceDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  pass('用量', `识别 ${String(usage.asrRequests)} 次 / 计费音频 ${usage.asrAudioSeconds.toFixed(1)} s；回应合成 ${String(usage.ttsRequests)} 次 / ${String(usage.ttsCharacters)} 字符；测试语音合成 ${String(usage.clipTtsRequests)} 次；Claude ${String(metrics.claudeTurns.length)} 轮，输入 ${String(summary.usage.claudeTokens.input)} / 输出 ${String(summary.usage.claudeTokens.output)} token`);
  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nIssue #9 live voice check passed (${String(results.length)} checks). Evidence: ${evidenceDir}`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  await writeFile(join(evidenceDir, 'failure-metrics.json'), `${JSON.stringify({ results, metrics, usage }, null, 2)}\n`).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
