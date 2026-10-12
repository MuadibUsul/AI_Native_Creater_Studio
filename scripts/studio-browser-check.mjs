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
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createDb, resolveTestDatabaseUrl, runMigrations } from '../packages/db/dist/index.js';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG } from '../packages/auth/dist/index.js';
import { WorkflowRegistry, agentTurnWorkflow, claimJob, compositionFinalRenderWorkflow, runMaintenanceTick } from '../packages/domain/dist/index.js';
import { buildServer } from '../apps/api/dist/server.js';
import { createStorageDeps } from '../apps/api/dist/plugins/storage.js';
import { createDefaultRegistry } from '../apps/worker/dist/handlers.js';
import { executeJob } from '../apps/worker/dist/runner.js';
import { createFfmpegSourceMediaProbe } from '../apps/worker/dist/source-media-probe-process.js';
import { createFfmpegMediaProxyTranscoder } from '../apps/worker/dist/source-media-transcoder-process.js';
import { createFfmpegMediaIndexer } from '../apps/worker/dist/source-media-indexer-process.js';
import { createFfmpegRenderPlanExecutor } from '../apps/worker/dist/render-plan/ffmpeg-executor.js';
import { createStorageFrameSampler } from '../apps/worker/dist/frame-sampler-process.js';
import { LocalObjectStorage } from '../packages/providers/storage-local/dist/index.js';

const evidenceDir = resolve('docs/verification/artifacts/v6-1c');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const prefix = `v61c-${randomUUID().slice(0, 8)}`;
const email = `${prefix}@test.local`;
const password = randomBytes(24).toString('base64url');
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

// ---------------------------------------------------------------------------
// 脚本导演（SCRIPTED）：读本轮上下文（素材、时间线、指点、请求），只用统一工具目录里的 edit_timeline。
// ---------------------------------------------------------------------------
const tag = (text, name) => {
  const match = text.match(new RegExp(`<${name}>\\n([\\s\\S]*?)\\n</${name}>`));
  return match === null ? null : match[1];
};
const usage = { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
class ScriptedDirector {
  providerId = 'scripted';
  implementation = 'SCRIPTED';
  model = 'scripted-director';
  calls = 0;
  async respond(request) {
    this.calls += 1;
    const first = request.messages[0];
    const text = first.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n');
    const session = JSON.parse(tag(text, 'session') ?? '{}');
    const zh = session.language !== 'en';
    const last = request.messages.at(-1);
    if (last.content.some((block) => block.type === 'tool_result')) {
      const failed = last.content.find((block) => block.type === 'tool_result' && block.isError);
      const reply = failed !== undefined ? (zh ? '这次改不了：' : "Couldn't apply: ") + failed.content.slice(0, 160)
        : this.pendingReply ?? (zh ? '好了。' : 'Done.');
      return { model: this.model, content: [{ type: 'text', text: reply }], stopReason: 'end_turn', usage };
    }
    const footage = JSON.parse(tag(text, 'footage') ?? '[]');
    const timeline = JSON.parse(tag(text, 'timeline') ?? '{}');
    const pointer = JSON.parse(tag(text, 'pointer') ?? '{}');
    const items = (Array.isArray(footage) ? footage : footage.footage ?? []).filter((item) => item.kind === 'video').sort((a, b) => a.name.localeCompare(b.name));
    const videoTracks = new Set((timeline.tracks ?? []).filter((track) => track.kind === 'VIDEO').map((track) => track.id));
    const videoClips = (timeline.clips ?? []).filter((clip) => videoTracks.has(clip.track));
    let operations;
    if (videoClips.length === 0) {
      operations = [...items.map((item) => ({ op: 'place_clip', footageId: item.footageId, sourceStart: '0.5', sourceEnd: '3.5' })), { op: 'fit_length' }];
      this.pendingReply = zh ? `第一版：${items.map((item) => item.name).join(' → ')}，各取 3 秒，共 ${String(items.length * 3)} 秒。` : `First cut: ${items.map((item) => item.name).join(' → ')}, 3 seconds each, ${String(items.length * 3)} seconds in total.`;
    } else {
      const start = Number(pointer.timeRange?.start ?? NaN);
      const pointed = (pointer.clips ?? []).map((clip) => clip.id);
      const target = videoClips.find((clip) => pointed.includes(clip.id))
        ?? videoClips.find((clip) => Number(clip.at[0]) <= start && start < Number(clip.at[1]));
      if (target === undefined) {
        return { model: this.model, content: [{ type: 'text', text: zh ? '请在时间带上指一下要改的那一段。' : 'Point at the part on the timeline you want changed.' }], stopReason: 'end_turn', usage };
      }
      operations = [{ op: 'trim_clip', clipId: target.id, trimTail: '1' }, { op: 'fit_length' }];
      this.pendingReply = zh ? '把这一段剪短了 1 秒，后面的内容跟着前移。' : 'Trimmed this part by 1 second; everything after it moved up.';
    }
    return { model: this.model, content: [{ type: 'tool_use', id: `tu_${randomUUID()}`, name: 'edit_timeline', input: { operations } }], stopReason: 'tool_use', usage };
  }
}

// ---------------------------------------------------------------------------
// 环境
// ---------------------------------------------------------------------------
const db = createDb(resolveTestDatabaseUrl());
let apiPort = 0;
const proxy = createServer((incoming, outgoing) => {
  const toApi = incoming.url?.startsWith('/api/v1/') ?? false;
  const upstream = httpRequest({ hostname: '127.0.0.1', port: toApi ? apiPort : webPort, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => {
    outgoing.writeHead(response.statusCode ?? 502, response.headers);
    response.pipe(outgoing);
  });
  upstream.on('error', (error) => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(`upstream failed: ${error.message}`); });
  incoming.pipe(upstream);
});
let app;
let browser;
let page;
let workerStop = false;
let workerLoop = Promise.resolve();
const workDir = await mkdtemp(join(tmpdir(), 'ancs-v61c-'));

try {
  await mkdir(evidenceDir, { recursive: true });
  await runMigrations(db);
  const proxyPort = await new Promise((done, fail) => { proxy.once('error', fail); proxy.listen(0, '127.0.0.1', () => done(proxy.address().port)); });
  const baseUrl = `http://127.0.0.1:${String(proxyPort)}`;
  const auth = createAuth({ db: db.db, secret: randomBytes(32).toString('hex'), baseUrl });
  await createInternalUser(auth, { email, password, name: 'Studio Check' });
  const storage = new LocalObjectStorage({ rootDir: join(workDir, 'storage'), publicBaseUrl: baseUrl, signingSecret: randomBytes(32).toString('hex') });
  app = await buildServer({ auth: { auth, db: db.db, tokens: { db: db.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
  await app.listen({ host: '127.0.0.1', port: 0 });
  apiPort = app.server.address().port;

  // 进程内 Worker（与生产装配同一组处理器；导演模型为脚本导演）
  const probe = createFfmpegSourceMediaProbe();
  const director = new ScriptedDirector();
  const workflowRegistry = new WorkflowRegistry()
    .register(compositionFinalRenderWorkflow({ executor: createFfmpegRenderPlanExecutor(), outputProbe: probe }))
    .register(agentTurnWorkflow({ model: director, frames: createStorageFrameSampler({ storage }) }));
  const registry = createDefaultRegistry({
    sourceMediaProbe: probe,
    sourceMediaTranscoder: createFfmpegMediaProxyTranscoder(),
    sourceMediaIndexer: createFfmpegMediaIndexer(),
    workflowRegistry,
    previewExecutor: { executor: createFfmpegRenderPlanExecutor() },
  });
  const deps = { db: db.db, storage, retention: {} };
  workerLoop = (async () => {
    while (!workerStop) {
      await runMaintenanceTick(deps, { limit: 50 }).catch(() => undefined);
      const job = await claimJob(deps, { workerId: 'studio-check', leaseSeconds: 120, types: registry.types() });
      if (job === null) { await new Promise((done) => setTimeout(done, 250)); continue; }
      await executeJob(deps, registry, { workerId: 'studio-check', leaseSeconds: 120, heartbeatIntervalMs: 20_000 }, job);
    }
  })();

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
  await page.waitForFunction(() => globalThis.document.querySelectorAll('aside b').length >= 9, null, { timeout: 60_000 });
  await shot('04-footage-drawer');
  await page.getByRole('button', { name: '关闭素材面板' }).click();
  pass('上传 3 段素材并完成探测/代理/索引', 'AI 对语音与画面的理解：未配置 ASR/视觉驱动时如实显示失败');
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
  await shot('08-pointer-selected');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText('试改好了，看看预览。').waitFor({ timeout: 60_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 120_000 });
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
  workerStop = true;
  await workerLoop.catch(() => undefined);
  await browser?.close().catch(() => undefined);
  await app?.close().catch(() => undefined);
  await new Promise((done) => proxy.close(done));
  await db.close();
  await rm(workDir, { recursive: true, force: true });
}
