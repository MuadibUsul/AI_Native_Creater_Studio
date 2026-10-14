#!/usr/bin/env node
// V6-4 批注式审片真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测/代理/索引/预览）+ Next 生产服务（127.0.0.1:3000）。
// AI 导演：**脚本导演**（SCRIPTED，不是真实 Provider）——讨论批注时只回方案，一次执行时按批注指着的片段修改；
// 它和真实导演用同一份上下文与同一个工具目录，用来验证界面与服务端闭环，不证明剪辑质量。
//
// 用法：node scripts/review-browser-check.mjs   证据写入 docs/verification/artifacts/v6-4/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { Blob } from 'node:buffer';
import { join, relative, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve(process.env.ANCS_EVIDENCE_DIR ?? 'docs/verification/artifacts/v6-4'); // ANCS_EVIDENCE_DIR：另存一套证据（如界面改版前后对比），不覆盖里程碑证据
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v64-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v64-' });
  // 1. 准备：一条已采用的第一版（真实上传 → 真实 FFmpeg 处理 → AI 一轮 → 采用）
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  // 先编码素材再登录：编码耗时数秒，登录后的空闲连接会被服务端 keep-alive 超时关掉（复用时 ECONNRESET）
  const { client, password } = await env.signedInClient(email);
  const workspace = await client.workspaces.create({ name: '审片验收' });
  const ref = await client.studio.create(workspace.id, { title: '冰岛环岛 · 审片', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 3 && state.footage.every((item) => item.status === 'READY'), { label: 'footage ready' });
  const firstCut = await client.agent.startTurn(workspace.id, ref.sessionId, { message: '用这些素材剪出第一版。' }, { idempotencyKey: `t-${randomUUID()}` });
  const cut = await waitFor(() => client.agent.getTurn(workspace.id, firstCut.id), (turn) => turn.status !== 'RUNNING', { label: 'first cut' });
  if (cut.proposalId === null) throw new Error(`first cut made no proposal: ${JSON.stringify(cut.error)}`);
  const cutProposal = await client.projects.proposal(workspace.id, ref.projectId, cut.proposalId);
  await client.projects.adoptProposal(workspace.id, ref.projectId, cut.proposalId, { expectedOperationsHash: cutProposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `a-${randomUUID()}` });
  const startRevision = (await client.studio.state(workspace.id, ref.projectId)).project.revision;
  pass('准备：第一版已采用', `3 段真实素材，版本 ${String(startRevision)}`);

  // 2. 手机尺寸打开审片页
  browser = await chromium.launch({ headless: true, ...(process.env.ANCS_BROWSER_EXECUTABLE ? { executablePath: process.env.ANCS_BROWSER_EXECUTABLE } : {}) });
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light' });
  page = await phone.newPage();
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  const shot = async (name) => { await page.screenshot({ path: resolve(evidenceDir, `${name}.png`) }); };
  const reviewUrl = `${env.baseUrl}/w/${workspace.id}/review/${ref.projectId}`;
  await page.goto(`${env.baseUrl}/sign-in`, { waitUntil: 'networkidle' });
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/sign-in'), { timeout: 20_000 });
  await page.goto(reviewUrl, { waitUntil: 'networkidle' });
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
  if (overflow > 0) throw new Error(`horizontal overflow on phone: ${String(overflow)} px`);
  await shot('01-phone-empty');
  pass('手机打开审片页', '390×844，播放当前版本，无横向溢出');

  // 3. 逐处标记（含一处画面框选）
  const video = page.locator('video');
  const seekTo = async (seconds) => {
    await video.evaluate((element, at) => new Promise((done) => { element.pause(); element.addEventListener('seeked', () => done(undefined), { once: true }); element.currentTime = at; }), seconds);
  };
  const addNote = async (seconds, text, box) => {
    await seekTo(seconds);
    await page.getByRole('button', { name: '在这里标记' }).click();
    if (box) {
      await page.getByRole('button', { name: '框出画面里的位置（可选）' }).click();
      const frame = await page.getByRole('application', { name: '在画面上拖出一个框' }).boundingBox();
      await page.mouse.move(frame.x + frame.width * 0.2, frame.y + frame.height * 0.25);
      await page.mouse.down();
      await page.mouse.move(frame.x + frame.width * 0.6, frame.y + frame.height * 0.7, { steps: 6 });
      await page.mouse.up();
      await page.getByRole('button', { name: '已框选画面' }).waitFor();
      await shot('02-phone-composer-box');
    }
    await page.getByLabel('这里有什么问题？').fill(text);
    await page.getByRole('button', { name: '添加批注' }).click();
    // 等批注卡片出现（受控 textarea 的文字也在 DOM 文本里，不能用 getByText 判断）
    await page.locator('li').filter({ hasText: text }).waitFor({ timeout: 20_000 });
    await page.getByLabel('这里有什么问题？').waitFor({ state: 'detached' });
  };
  await addNote(1.5, '开头太拖了', true);
  await addNote(4.5, '中间这段颜色太暗', false);
  await addNote(7.5, '结尾太突然', false);
  await page.getByRole('heading', { name: '批注 3' }).waitFor();
  await shot('03-phone-notes');
  const marked = await client.review.state(workspace.id, ref.projectId);
  const boxed = marked.notes.find((item) => item.text === '开头太拖了');
  if (boxed?.region === null || boxed?.pointer.clipIds.length !== 1) throw new Error(`first note lacks region or clip: ${JSON.stringify(boxed)}`);
  // 每条批注落在拖到的那一刻前后各 1 秒（播放器能跳转，依赖存储端点的字节范围）
  const starts = Object.fromEntries(marked.notes.map((item) => [item.text, Number(item.pointer.timeRange.start)]));
  for (const [text, expected] of [['开头太拖了', 0.5], ['中间这段颜色太暗', 3.5], ['结尾太突然', 6.5]]) {
    if (Math.abs(starts[text] - expected) > 0.1) throw new Error(`note "${text}" starts at ${String(starts[text])}, expected ${String(expected)}`);
  }
  pass('逐处标记 3 条', `位置 ${Object.values(starts).map((value) => value.toFixed(1)).join(' / ')} s；第一条带画面框选 ${JSON.stringify(boxed.region)} 与所指片段；轮次基于版本 ${String(marked.round.baseRevision)}`);

  // 4. 逐条讨论与确定
  const card = (text) => page.locator('li', { hasText: text });
  await card('开头太拖了').getByRole('button', { name: '问 AI 怎么改' }).click();
  await card('开头太拖了').getByText(/^把这一段剪短 1 秒/).waitFor({ timeout: 60_000 });
  await shot('04-phone-discussion');
  const before = await client.studio.state(workspace.id, ref.projectId);
  if (before.project.revision !== startRevision) throw new Error('discussion changed the project');
  await card('开头太拖了').getByRole('button', { name: '就按这个改' }).click();
  await card('开头太拖了').getByText('已确定').waitFor();
  await card('中间这段颜色太暗').getByRole('button', { name: '交给 AI 决定' }).click();
  await card('中间这段颜色太暗').getByText('方案：让 AI 按批注自己决定').waitFor();
  await card('结尾太突然').getByRole('button', { name: '不改了' }).click();
  await card('结尾太突然').getByText('不改了', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: /全部执行（2 条）/ }).waitFor();
  await shot('05-phone-decided');
  pass('逐条讨论与确定', 'AI 讨论只给方案（工程版本不变）；2 条确定、1 条不改');

  // 5. 全部执行 → 试改就地播放（只重渲改动的分段）→ 就这样
  await page.getByRole('button', { name: /全部执行（2 条）/ }).click();
  await page.getByText('改好了：看看试改，满意就采用。').waitFor({ timeout: 120_000 });
  await page.getByText('按批注修改后的试改 · 还没采用').waitFor({ timeout: 120_000 });
  const reused = await page.getByText(/^只重渲了改动的部分（复用 \d+\/\d+ 段）$/).textContent({ timeout: 30_000 });
  await video.evaluate((element) => element.play());
  await page.waitForTimeout(1200);
  const playedTo = await video.evaluate((element) => { element.pause(); return element.currentTime; });
  if (!(playedTo > 0.5)) throw new Error(`trial did not play (${String(playedTo)})`);
  await shot('06-phone-trial');
  const ready = await client.review.state(workspace.id, ref.projectId);
  if (ready.round.status !== 'READY' || (await client.studio.state(workspace.id, ref.projectId)).project.revision !== startRevision) throw new Error('trial changed the project before adoption');
  pass('全部执行成为一个试改并就地播放', `${reused}；播放到 ${playedTo.toFixed(2)} s；采用前工程不变`);

  await page.getByRole('button', { name: /就这样/ }).click();
  await page.getByText(/^已采用，成为新版本（版本 \d+）/).first().waitFor({ timeout: 30_000 });
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  await shot('07-phone-applied');
  const applied = await client.review.state(workspace.id, ref.projectId);
  const statuses = applied.notes.map((item) => `${item.text}:${item.status}`).sort();
  if (applied.round.status !== 'APPLIED' || applied.round.appliedRevision !== applied.projectRevision) throw new Error(`round not applied: ${JSON.stringify(applied.round)}`);
  if (statuses.join('|') !== ['中间这段颜色太暗:APPLIED', '开头太拖了:APPLIED', '结尾太突然:DISMISSED'].sort().join('|')) throw new Error(`unexpected note states ${statuses.join(', ')}`);
  pass('采用后成为新版本', `版本 ${String(startRevision)} → ${String(applied.projectRevision)}；批注状态 ${statuses.join('，')}`);

  // 6. 英文 / 深色（手机）
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByText(/^Kept as the new version/).first().waitFor();
  await shot('08-phone-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('09-phone-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  pass('中英切换与深色', '文案即时切换，作品与批注不变');

  // 7. 新一轮：采用后再标记 → 新的一轮基于新版本
  await addNote(2, '第二轮：开头再亮一点', false);
  const second = await client.review.state(workspace.id, ref.projectId);
  if (second.round.id === marked.round.id || second.round.baseRevision !== applied.projectRevision || second.notes.length !== 1) throw new Error(`no new round: ${JSON.stringify(second.round)}`);
  pass('采用后再标记开新一轮', `新一轮基于版本 ${String(second.round.baseRevision)}`);

  // 8. 桌面：共看片室顶栏进入审片；两列布局；PWA 清单
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN', timezoneId: 'Asia/Shanghai', colorScheme: 'light', storageState: await phone.storageState() });
  page = await desk.newPage();
  page.on('pageerror', (error) => pageErrors.push(`${page.url()}: ${error.message}`));
  await page.goto(`${env.baseUrl}/w/${workspace.id}/studio/${ref.projectId}`, { waitUntil: 'networkidle' });
  await page.getByRole('link', { name: '审片' }).click();
  await page.waitForURL(`**/w/${workspace.id}/review/${ref.projectId}`);
  await page.getByText('当前版本', { exact: true }).waitFor({ timeout: 120_000 });
  await shot('10-desktop');
  const manifest = await page.request.get(`${env.baseUrl}/manifest.webmanifest`);
  const body = await manifest.json();
  const icon = await page.request.get(`${env.baseUrl}${body.icons[1].src}`);
  if (!manifest.ok() || body.display !== 'standalone' || !icon.ok() || icon.headers()['content-type'] !== 'image/png') throw new Error('manifest or icon not served');
  pass('桌面：从共看片室进入审片；可添加到主屏幕', `manifest ${body.name}，${String(body.icons.length)} 个图标`);

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-4 review browser check passed (${String(results.length)} checks). Evidence: ${relative(process.cwd(), evidenceDir)}/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
}
