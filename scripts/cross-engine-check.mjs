#!/usr/bin/env node
// 跨浏览器引擎冒烟（界面精修第四阶段）：用 Gecko（Firefox）与 WebKit（WebKitGTK）打开核心页面，
// 检查页面不横向溢出、关键操作在屏幕内、时间带片段与实测波形出现、英文界面没有中文残留，并截图。
//
// 不依赖 npm 包：Firefox 走 WebDriver BiDi（Node 22 自带 WebSocket），WebKit 走 WebKitWebDriver（W3C WebDriver HTTP）。
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg）+ Next 生产服务（127.0.0.1:3000）。
// AI 导演为脚本导演（不调用付费 Provider）。
//
// 用法：
//   ANCS_FIREFOX_EXECUTABLE=<firefox 可执行文件> ANCS_WEBKIT_WEBDRIVER=WebKitWebDriver \
//   ANCS_WEBKIT_BROWSER=<MiniBrowser 路径> node scripts/cross-engine-check.mjs
//   只设其中一个引擎的变量就只跑那一个。WebKitGTK 需要显示服务（无显示时用 xvfb-run 包一层）。
//   证据写入 ANCS_EVIDENCE_DIR（默认 docs/verification/artifacts/ui-refresh/cross-engine/）。
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { Blob } from 'node:buffer';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/ui-refresh/cross-engine');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `xeng-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const freePort = () => new Promise((done, fail) => { const server = createServer(); server.once('error', fail); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => done(port)); }); });

/** 页面里执行的检查函数：只返回可序列化的数据 */
const PAGE_PROBES = {
  layout: () => {
    const width = globalThis.window.innerWidth;
    const overflow = globalThis.document.documentElement.scrollWidth - width;
    const exportButton = [...globalThis.document.querySelectorAll('button')].find((button) => /^(导出|Export)$/.test(button.textContent?.trim() ?? ''));
    const rect = exportButton?.getBoundingClientRect();
    return {
      width,
      overflow,
      lang: globalThis.document.documentElement.lang,
      h1: globalThis.document.querySelector('h1')?.textContent?.trim() ?? null,
      exportInView: rect === undefined ? null : rect.left >= 0 && rect.right <= width && rect.top >= 0 && rect.bottom <= globalThis.window.innerHeight,
      clips: globalThis.document.querySelectorAll('[data-clip-id]').length,
      waveforms: globalThis.document.querySelectorAll('[data-waveform] path').length,
      // "中文"是英文界面里切回中文的按钮（用目标语言写自己的名字），不算残留
      cjk: (globalThis.document.body.innerText.match(/[一-鿿]+/g) ?? []).filter((run) => run !== '中文').slice(0, 12),
      supports: { textWrapBalance: globalThis.CSS.supports('text-wrap', 'balance'), scrollbarColor: globalThis.CSS.supports('scrollbar-color', 'auto'), hasSelector: globalThis.CSS.supports('selector(:has(*))') },
    };
  },
  ready: () => globalThis.document.readyState === 'complete' && globalThis.document.querySelector('h1, [data-clip-id], main') !== null,
  studioReady: () => globalThis.document.querySelectorAll('[data-clip-id]').length > 0 && globalThis.document.querySelectorAll('[data-waveform] path').length > 0,
};

/** Firefox：WebDriver BiDi */
async function firefoxEngine(executable) {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'ancs-ff-profile-'));
  await writeFile(join(profile, 'user.js'), ['browser.shell.checkDefaultBrowser', 'datareporting.policy.dataSubmissionEnabled', 'toolkit.telemetry.reportingpolicy.firstRun'].map((key) => `user_pref("${key}", false);`).join('\n'));
  const child = spawn(executable, ['--headless', '--no-remote', '--profile', profile, `--remote-debugging-port=${String(port)}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MOZ_HEADLESS: '1' } });
  await new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error('Firefox did not start WebDriver BiDi')), 60_000);
    child.stderr.on('data', (chunk) => { if (/WebDriver BiDi listening/.test(String(chunk))) { clearTimeout(timer); done(); } });
    child.once('exit', (code) => fail(new Error(`Firefox exited (${String(code)})`)));
  });
  const socket = new globalThis.WebSocket(`ws://127.0.0.1:${String(port)}/session`);
  await new Promise((done, fail) => { socket.onopen = done; socket.onerror = () => fail(new Error('BiDi socket failed')); });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const waiter = message.id === undefined ? undefined : pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.type === 'error') waiter.fail(new Error(`${message.error}: ${message.message}`)); else waiter.done(message.result);
  };
  const send = (method, params) => new Promise((done, fail) => { const id = nextId++; pending.set(id, { done, fail }); socket.send(JSON.stringify({ id, method, params })); });
  const version = (await send('session.new', { capabilities: {} })).capabilities.browserVersion;
  const context = (await send('browsingContext.getTree', {})).contexts[0].context;
  return {
    name: 'firefox',
    version: `Firefox ${version}`,
    setViewport: (width, height) => send('browsingContext.setViewport', { context, viewport: { width, height } }),
    open: (url) => send('browsingContext.navigate', { context, url, wait: 'complete' }),
    evaluate: async (fn, ...args) => {
      const result = await send('script.evaluate', { expression: `(async () => JSON.stringify(await (${fn.toString()})(...${JSON.stringify(args)})))()`, target: { context }, awaitPromise: true, resultOwnership: 'none' });
      if (result.type !== 'success') throw new Error(`evaluate failed: ${JSON.stringify(result.exceptionDetails?.text ?? result)}`);
      return JSON.parse(result.result.value);
    },
    screenshot: async (path) => { const { data } = await send('browsingContext.captureScreenshot', { context }); await writeFile(path, Buffer.from(data, 'base64')); },
    close: async () => { await send('session.end', {}).catch(() => undefined); socket.close(); child.kill('SIGKILL'); await rm(profile, { recursive: true, force: true }); },
  };
}

/** WebKit：WebKitWebDriver（W3C WebDriver） */
async function webkitEngine(driver, browserBinary) {
  const port = await freePort();
  const child = spawn(driver, [`--port=${String(port)}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  const base = `http://127.0.0.1:${String(port)}`;
  const call = async (method, path, body) => {
    const response = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    if (!response.ok) throw new Error(`WebDriver ${method} ${path}: ${JSON.stringify(json.value)}`);
    return json.value;
  };
  for (let attempt = 0; attempt < 60; attempt += 1) { try { await call('GET', '/status'); break; } catch { await sleep(250); } }
  const options = { args: ['--automation'], ...(browserBinary ? { binary: browserBinary } : {}) };
  const session = await call('POST', '/session', { capabilities: { alwaysMatch: { 'webkitgtk:browserOptions': options } } });
  const id = session.sessionId;
  return {
    name: 'webkit',
    version: `WebKitGTK ${String(session.capabilities.browserVersion ?? '?')}`,
    setViewport: async (width, height) => {
      // 窗口尺寸 ≠ 视口尺寸：按实际视口差值修正一次
      await call('POST', `/session/${id}/window/rect`, { width, height });
      const inner = await call('POST', `/session/${id}/execute/sync`, { script: 'return [globalThis.window.innerWidth, globalThis.window.innerHeight];', args: [] });
      if (inner[0] !== width || inner[1] !== height) await call('POST', `/session/${id}/window/rect`, { width: width + (width - inner[0]), height: height + (height - inner[1]) });
    },
    open: (url) => call('POST', `/session/${id}/url`, { url }),
    evaluate: async (fn, ...args) => {
      const script = `const done = arguments[arguments.length - 1]; (async () => (${fn.toString()})(...${JSON.stringify(args)}))().then((value) => done(JSON.stringify(value)), (error) => done(JSON.stringify({ __error: String(error) })));`;
      const value = JSON.parse(await call('POST', `/session/${id}/execute/async`, { script, args: [] }));
      if (value !== null && typeof value === 'object' && '__error' in value) throw new Error(`evaluate failed: ${value.__error}`);
      return value;
    },
    screenshot: async (path) => { await writeFile(path, Buffer.from(await call('GET', `/session/${id}/screenshot`), 'base64')); },
    close: async () => { await call('DELETE', `/session/${id}`).catch(() => undefined); child.kill('SIGKILL'); },
  };
}

async function until(engine, probe, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await engine.evaluate(probe).catch(() => false)) return;
    if (Date.now() > deadline) throw new Error(`${engine.name}: timed out waiting for ${label}`);
    await sleep(500);
  }
}

let env;
const engines = [];
try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-xeng-' });
  // 准备：一条已采用的第一版（真实上传 → 真实 FFmpeg 处理与索引 → AI 一轮 → 采用）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: 'Cross-engine check' });
  const ref = await client.studio.create(workspace.id, { title: 'Iceland ring road', aspectRatio: '16:9', locale: 'en' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 3 && state.footage.every((item) => item.status === 'READY' && item.understanding.index !== 'WORKING'), { label: 'footage ready' });
  const firstCut = await client.agent.startTurn(workspace.id, ref.sessionId, { message: 'Cut a first version from this footage.' }, { idempotencyKey: `t-${randomUUID()}` });
  const cut = await waitFor(() => client.agent.getTurn(workspace.id, firstCut.id), (turn) => turn.status !== 'RUNNING', { label: 'first cut' });
  if (cut.proposalId === null) throw new Error(`first cut made no proposal: ${JSON.stringify(cut.error)}`);
  const proposal = await client.projects.proposal(workspace.id, ref.projectId, cut.proposalId);
  await client.projects.adoptProposal(workspace.id, ref.projectId, cut.proposalId, { expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `a-${randomUUID()}` });
  pass('准备：第一版已采用', '3 段真实素材（带正弦音轨）');

  if (process.env.ANCS_FIREFOX_EXECUTABLE) engines.push(await firefoxEngine(process.env.ANCS_FIREFOX_EXECUTABLE));
  if (process.env.ANCS_WEBKIT_WEBDRIVER) engines.push(await webkitEngine(process.env.ANCS_WEBKIT_WEBDRIVER, process.env.ANCS_WEBKIT_BROWSER));
  if (engines.length === 0) throw new Error('set ANCS_FIREFOX_EXECUTABLE and/or ANCS_WEBKIT_WEBDRIVER');

  const pages = [
    ['home', '/'],
    ['studio', `/w/${workspace.id}/studio/${ref.projectId}`],
    ['review', `/w/${workspace.id}/review/${ref.projectId}`],
    ['settings', `/w/${workspace.id}/settings`],
  ];
  for (const engine of engines) {
    // 登录：在页面里用同源 fetch 调登录接口（浏览器自己保存 httpOnly 会话 Cookie）
    await engine.setViewport(1440, 900);
    await engine.open(`${env.baseUrl}/sign-in`);
    const signedIn = await engine.evaluate(async (credentials) => {
      const response = await fetch('/api/v1/auth/sign-in', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', 'x-client-type': 'web', 'x-client-version': '0.1.0' }, body: JSON.stringify(credentials) });
      return response.status;
    }, { email, password });
    if (signedIn !== 200) throw new Error(`${engine.name}: sign-in HTTP ${String(signedIn)}`);
    for (const locale of ['zh-CN', 'en']) {
      await engine.evaluate((value) => { globalThis.document.cookie = `ancs-locale=${value}; Path=/; Max-Age=31536000; SameSite=Lax`; return true; }, locale);
      for (const [width, height] of [[1440, 900], [390, 844]]) {
        await engine.setViewport(width, height);
        for (const [name, path] of pages) {
          await engine.open(`${env.baseUrl}${path}`);
          await until(engine, PAGE_PROBES.ready, `${name} ready`);
          if (name === 'studio') await until(engine, PAGE_PROBES.studioReady, 'studio clips and waveform', 90_000);
          await sleep(400);
          const metrics = await engine.evaluate(PAGE_PROBES.layout);
          const shotName = `${engine.name}-${locale === 'en' ? 'en' : 'zh'}-${String(width)}-${name}.png`;
          await engine.screenshot(resolve(evidenceDir, shotName));
          const problems = [];
          if (metrics.overflow > 1) problems.push(`horizontal overflow ${String(metrics.overflow)} px`);
          if (metrics.lang !== locale) problems.push(`<html lang> ${String(metrics.lang)}`);
          if (name === 'studio' && metrics.exportInView !== true) problems.push('export button not on screen');
          if (name === 'studio' && metrics.waveforms === 0) problems.push('no waveform');
          if (locale === 'en' && metrics.cjk.length > 0) problems.push(`Chinese text: ${metrics.cjk.join(' ')}`);
          if (problems.length > 0) throw new Error(`${engine.version} ${locale} ${String(width)} ${name}: ${problems.join('; ')}`);
          pass(`${engine.version} · ${locale} · ${String(width)} px · ${name}`, `无横向溢出${name === 'studio' ? `；片段 ${String(metrics.clips)}、波形 ${String(metrics.waveforms)}、导出按钮在屏幕内` : ''}；text-wrap:balance ${metrics.supports.textWrapBalance ? '支持' : '不支持（退回默认换行）'}，scrollbar-color ${metrics.supports.scrollbarColor ? '支持' : '不支持'}`);
        }
      }
    }
  }
  const summary = resolve(evidenceDir, 'summary.json');
  await writeFile(summary, `${JSON.stringify({ engines: engines.map((engine) => engine.version), results }, null, 2)}\n`);
  console.log(`Cross-engine check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const engine of engines) await engine.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
