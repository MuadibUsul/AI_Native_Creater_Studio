#!/usr/bin/env node
// V6-6 蒸馏器真实浏览器验收（可重复）。
//
// 环境：同 studio-browser-check（隔离测试库 + 进程内 API/Worker，真实 FFmpeg 探测/代理/索引/预览）+ Next 生产服务（127.0.0.1:3000），
// 外加真实 FFmpeg 参考视频测量（镜头、黑场、色彩、响度、节拍）和一个本地 HTTP 服务（直接视频链接与"平台页面"链接）。
// 参考视频是合成的、真值已知：A 是 24 个 0.5 秒镜头、剪点全在 120 BPM 节拍上；B 是 4 个 3 秒暖色镜头、黑场过渡、无节拍。
// 风格说明用规则版（没有配置模型）；AI 导演是**脚本导演**（SCRIPTED，不是真实 Provider）：它和真实导演一样只从上下文读到
// 风格数据，用来验证"学到的风格作为可选参考进入对话"的闭环，不证明剪辑质量。
//
// 用法：node scripts/distill-browser-check.mjs   证据写入 docs/verification/artifacts/v6-6/
//       （可选 ANCS_BROWSER_EXECUTABLE 指定支持 H.264 的 Chromium）
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { Blob } from 'node:buffer';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const evidenceDir = resolve('docs/verification/artifacts/v6-6');
const webPort = Number(process.env.ANCS_QF_WEB_PORT ?? 3000);
const email = `v66-${randomUUID().slice(0, 8)}@test.local`;
const results = [];
const pass = (name, detail = '') => { results.push({ name, detail }); console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`); };

let env;
let browser;
let page;
let server;

/** 两条已知真值的参考视频（与 apps/worker/src/reference-distill.integration.test.ts 相同的合成方式）。 */
function makeReferences(dir) {
  const palette = ['0xF0F0F0', '0x202060', '0xF0F040', '0x181818', '0x40F0F0', '0x600000', '0xF0A0C0', '0x004000'];
  const inputs = Array.from({ length: 24 }, (_, index) => ['-f', 'lavfi', '-i', `color=c=${palette[index % palette.length]}:s=640x360:r=30:d=0.5`]).flat();
  const filter = `${Array.from({ length: 24 }, (_, index) => `[${String(index)}:v]`).join('')}concat=n=24:v=1[v]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*180*t)*exp(-30*mod(t,0.5))':s=44100:d=12",
    '-filter_complex', filter, '-map', '[v]', '-map', '24:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'beat-cut-reference.mp4')]);
  const warm = ['0xE08030', '0xC06020', '0xF0A050', '0xD07040'];
  const shots = warm.map((color, index) => `color=c=${color}:s=640x360:r=30:d=3,fade=t=in:st=0:d=${index === 0 ? '0' : '0.4'},fade=t=out:st=2.6:d=${index === 3 ? '0' : '0.4'}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...shots.flatMap((shot) => ['-f', 'lavfi', '-i', shot]), '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=44100:duration=12',
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1[v]', '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(dir, 'slow-warm.mp4')]);
}

try {
  await mkdir(evidenceDir, { recursive: true });
  env = await startStudioEnv({ director: new ScriptedDirector(), webPort, workDirPrefix: 'ancs-v66-', distill: { allowPrivateNetwork: true } });
  const { client, password } = await env.signedInClient(email);

  // 1. 准备：参考视频 + 本地链接服务；一个放好两段素材、还没剪的作品
  const refDir = join(env.workDir, 'references');
  await mkdir(refDir, { recursive: true });
  makeReferences(refDir);
  const slow = await readFile(join(refDir, 'slow-warm.mp4'));
  server = createServer((request, response) => {
    if (request.url === '/media/slow-warm.mp4') { response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(slow.byteLength) }); response.end(slow); return; }
    if (request.url?.startsWith('/watch')) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<html><title>Creator video</title></html>'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const linkBase = `http://127.0.0.1:${String(server.address().port)}`;

  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660]];
  for (const [name, video, tone] of sources) {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(footageDir, name)]);
  }
  const workspace = await client.workspaces.create({ name: '风格学习验收' });
  const ref = await client.studio.create(workspace.id, { title: '冰岛环岛 · 学风格', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
  for (const [name] of sources) {
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(join(footageDir, name))]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 2 && state.footage.every((item) => item.status === 'READY'), { label: 'footage ready' });
  pass('准备', `两条已知真值的参考视频；本地链接服务 ${linkBase}；作品里两段真实素材已就绪`);

  // 2. 打开共看片室 → 从参考视频学风格
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
  await page.getByRole('button', { name: '从参考视频学风格' }).click();
  const drawer = page.getByRole('complementary', { name: '从参考视频学风格' });
  await drawer.getByText('参考视频的版权由你负责').waitFor();
  await shot('01-drawer');
  pass('打开学风格抽屉', '入口在"风格（可选）"一行；说明测量内容与版权责任');

  // 3. 平台页面链接（没有配置下载工具）→ 如实失败，提示下载后上传
  await drawer.getByLabel('视频链接').fill(`${linkBase}/watch?v=creator`);
  await drawer.getByRole('button', { name: '添加链接' }).click();
  await drawer.getByRole('button', { name: '开始学习' }).click();
  await drawer.getByText('没能学成这个风格').waitFor({ timeout: 60_000 });
  await drawer.getByText('这个链接是网页，服务端还没配置下载工具。请先把视频下载下来，再用"添加视频文件"上传。').waitFor();
  await shot('02-page-link-not-configured');
  pass('平台页面链接未配置下载工具', '明确失败并提示下载后上传；没有猜测、没有伪造结果');
  await drawer.getByRole('button', { name: '重新开始' }).click();

  // 4. 上传文件 A + 直接视频链接 B → 进度 → 结果卡
  await drawer.locator('input[type="file"]').setInputFiles(join(refDir, 'beat-cut-reference.mp4'));
  await drawer.getByText('文件', { exact: true }).waitFor({ timeout: 60_000 });
  await drawer.getByLabel('视频链接').fill(`${linkBase}/media/slow-warm.mp4`);
  await drawer.getByRole('button', { name: '添加链接' }).click();
  await drawer.getByLabel('风格名（可选）').fill('快切卡点 + 慢暖');
  await shot('03-references');
  const learnStarted = Date.now();
  await drawer.getByRole('button', { name: '开始学习' }).click();
  await drawer.getByText('正在学习这些视频的风格…').waitFor({ timeout: 30_000 });
  await shot('04-progress');
  await drawer.getByRole('heading', { name: '快切卡点 + 慢暖' }).waitFor({ timeout: 180_000 });
  const learnSeconds = (Date.now() - learnStarted) / 1000;
  await drawer.getByText('按测量统计自动写的说明（没有 AI 看片）').waitFor();
  await shot('05-result');
  const packs = await client.agent.strategies(workspace.id);
  const learned = packs.find((pack) => pack.kind === 'DISTILLED');
  if (learned === undefined) throw new Error(`no distilled pack: ${JSON.stringify(packs.map((pack) => pack.id))}`);
  const full = await client.agent.strategy(workspace.id, learned.id);
  const dna = full.editingDna;
  const expectations = [
    ['measured references', dna.measured?.references === 2], ['analyzed 24 s', dna.measured?.analyzedSeconds === 24], ['28 shots', dna.measured?.shots === 28],
    ['median 0.5 s', dna.shotSeconds.median === 0.5], ['65 edits/min', dna.cutsPerMinute === 65], ['all cuts on beat', dna.beatCutRatio === 1],
    ['7.5 dips/min', dna.transitionsPerMinute === 7.5], ['beat knob', full.knobs.some((knob) => knob.key === 'beat_sync')],
  ];
  const wrong = expectations.filter(([, ok]) => !ok).map(([label]) => label);
  if (wrong.length > 0) throw new Error(`measurements differ from ground truth (${wrong.join(', ')}): ${JSON.stringify(dna)}`);
  for (const text of ['中位 0.5 秒（多在 0.5 秒）', '100% 的剪点在节拍上', '测量依据：2 条视频，共 0.4 分钟，28 个镜头']) {
    await drawer.getByText(text, { exact: true }).waitFor().catch(async () => { throw new Error(`result card is missing "${text}": ${await drawer.innerText()}`); });
  }
  await drawer.getByText(/还没测：.*景别/).waitFor();
  pass('测量结果与真值一致', `中位镜头 ${String(dna.shotSeconds.median)} s，每分钟 ${String(dna.cutsPerMinute)} 次剪辑，卡点 ${String(dna.beatCutRatio * 100)}%，黑场过渡每分钟 ${String(dna.transitionsPerMinute)} 次，节奏曲线 ${dna.pacing.join('/')}；测不到的（景别、推拉、变速、字幕）如实列出；从点"开始学习"到结果卡 ${learnSeconds.toFixed(1)} s`);

  // 5. 改说明 → 保存（版本 +1）
  await drawer.getByRole('button', { name: '改说明' }).click();
  await drawer.getByLabel('说明').fill('短镜头卡在节拍上，偶尔用黑场换节奏，暖色。');
  await drawer.getByRole('button', { name: '保存' }).click();
  await drawer.getByText('已保存。').waitFor({ timeout: 30_000 });
  const edited = await client.agent.strategy(workspace.id, learned.id);
  if (edited.version !== 2 || edited.summary['zh-CN'] !== '短镜头卡在节拍上，偶尔用黑场换节奏，暖色。' || edited.editingDna.shotSeconds.median !== 0.5) throw new Error(`edit not saved: ${JSON.stringify(edited)}`);
  pass('改说明', `版本 1 → ${String(edited.version)}；测量数值不变`);

  // 6. 英文 / 深色 / 手机宽度
  await page.getByRole('button', { name: '切换为英文界面' }).click();
  await page.getByRole('complementary', { name: 'Learn a style from videos' }).getByText('Measured from 2 videos, 0.4 min, 28 shots', { exact: true }).waitFor();
  await shot('06-result-english');
  await page.getByRole('button', { name: 'Switch the interface to Chinese' }).click();
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.waitForTimeout(300);
  await shot('07-result-dark');
  await page.getByRole('button', { name: '切换浅深色' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => globalThis.document.documentElement.scrollWidth - globalThis.innerWidth);
  await shot('08-result-mobile');
  if (overflow > 1) throw new Error(`horizontal overflow at 390 px: ${String(overflow)} px`);
  await page.setViewportSize({ width: 1440, height: 900 });
  pass('中英切换、深色、手机宽度', '结果卡随语言切换；390 px 宽没有横向溢出');

  // 7. 用这个风格 → 对话带上风格 → AI 按风格剪第一版（试改）
  await drawer.getByRole('button', { name: '用这个风格' }).click();
  await drawer.waitFor({ state: 'detached' });
  const selected = await page.getByLabel('风格（可选）').inputValue();
  if (selected !== learned.id) throw new Error(`style not selected: ${selected}`);
  await page.getByLabel('告诉 AI 怎么改').fill('用这些素材剪出第一版。');
  await page.getByRole('button', { name: '发送' }).click();
  await page.getByText(/按参考风格剪了第一版：镜头中位 0\.5 秒.*共 12 个镜头/).waitFor({ timeout: 120_000 });
  await page.getByText('试改预览 · 还没采用').waitFor({ timeout: 180_000 });
  await shot('09-first-cut-in-style');
  const turns = await client.agent.listTurns(workspace.id, ref.sessionId);
  const styled = turns.find((turn) => turn.message === '用这些素材剪出第一版。');
  if (styled?.proposalId === null || styled === undefined) throw new Error(`no proposal from the styled turn: ${JSON.stringify(styled)}`);
  const proposal = await client.projects.proposal(workspace.id, ref.projectId, styled.proposalId);
  pass('风格进入对话', `这一轮带上 ${learned.id}（策略包只作为上下文数据）；脚本导演按测得的 0.5 秒镜头切了 12 个镜头，成为试改 ${proposal.proposalId}`);

  if (pageErrors.length > 0) throw new Error(`page errors:\n${pageErrors.join('\n')}`);
  console.log(`\nV6-6 distill browser check passed (${String(results.length)} checks). Evidence: docs/verification/artifacts/v6-6/`);
} catch (error) {
  console.error(error);
  if (page) await page.screenshot({ path: resolve(evidenceDir, 'failure.png') }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => undefined);
  await env?.close().catch(() => undefined);
  await new Promise((done) => (server ? server.close(() => done(undefined)) : done(undefined)));
}
