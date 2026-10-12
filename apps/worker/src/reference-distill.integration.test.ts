import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { strategyPackSchema, type AgentModelAdapter, type AgentModelRequest, type DistillRun, type StrategyPack } from '@ancs/contracts';
import { assets, assetVersions, createDb, outboxEvents, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  getReferenceDistill,
  getStrategyPack,
  getWorkflowRun,
  listStrategyPacks,
  referenceDistillWorkflow,
  startReferenceDistill,
  strategyGuidanceText,
  updateStrategyPack,
  type DomainDeps,
  type ReferenceDistillPorts,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createStorageFrameSampler } from './frame-sampler-process.js';
import { createFfmpegReferenceAnalyzer } from './reference-analyzer-process.js';
import { createReferenceFetcher } from './reference-fetcher.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';

/**
 * V6-6 蒸馏器端到端（真实 PostgreSQL + 本地对象存储 + 真实 FFmpeg 测量 + 本地 HTTP 服务；撰写模型为脚本模型）：
 * 合成两条已知真值的参考视频——A：24 个 0.5 秒镜头，剪点全在 120 BPM 节拍上；B：4 个 3 秒镜头、黑场过渡、暖色、无节拍——
 * 1. 上传的 A + 直接链接的 B 合成一份风格：测出的镜头时长、每分钟剪切、卡点比例、BPM、黑场过渡、色彩与真值一致；规则版说明；
 * 2. 平台页面链接：没配置下载命令 → 明确失败（提示上传）；配置了下载命令 → 走命令下载；内网地址 → 拒绝；
 * 3. 配置了模型 → 模型写说明（看了抽帧），数值仍是测量值；编辑包的文字（版本 +1），内置预设不可改。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let root: string;
let server: Server;
let baseUrl: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  root = await mkdtemp(join(tmpdir(), 'ancs-distill-it-'));
  storage = new LocalObjectStorage({ rootDir: join(root, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `distill-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  // A：24 个 0.5 秒镜头（明暗交替，相邻镜头亮度差足够大，每个剪点都可检测），120 BPM 打击声与剪点对齐
  const palette = ['0xF0F0F0', '0x202060', '0xF0F040', '0x181818', '0x40F0F0', '0x600000', '0xF0A0C0', '0x004000'];
  const inputs = Array.from({ length: 24 }, (_, index) => ['-f', 'lavfi', '-i', `color=c=${palette[index % palette.length]!}:s=640x360:r=30:d=0.5`]).flat();
  const filter = `${Array.from({ length: 24 }, (_, index) => `[${String(index)}:v]`).join('')}concat=n=24:v=1[v]`;
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-f', 'lavfi', '-i', "aevalsrc='0.8*sin(2*PI*180*t)*exp(-30*mod(t,0.5))':s=44100:d=12",
    '-filter_complex', filter, '-map', '[v]', '-map', '24:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(root, 'beatcut.mp4')]);
  // B：4 个 3 秒暖色镜头，镜头之间淡出淡入到黑（黑场过渡 3 次），恒定音调（没有节拍）
  const warm = ['0xE08030', '0xC06020', '0xF0A050', '0xD07040'];
  const shots = warm.map((color, index) => `color=c=${color}:s=640x360:r=30:d=3,fade=t=in:st=0:d=${index === 0 ? '0' : '0.4'},fade=t=out:st=2.6:d=${index === 3 ? '0' : '0.4'}`);
  execFileSync('ffmpeg', ['-v', 'error', '-y', ...shots.flatMap((shot) => ['-f', 'lavfi', '-i', shot]), '-f', 'lavfi', '-i', "sine=frequency=330:sample_rate=44100:duration=12",
    '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1[v]', '-map', '[v]', '-map', '4:a', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(root, 'slowwarm.mp4')]);
  const slow = await readFile(join(root, 'slowwarm.mp4'));
  server = createServer((request, response) => {
    if (request.url === '/media/slowwarm.mp4') { response.writeHead(200, { 'content-type': 'video/mp4', 'content-length': String(slow.byteLength) }); response.end(slow); return; }
    if (request.url === '/go') { response.writeHead(302, { location: '/media/slowwarm.mp4' }); response.end(); return; }
    if (request.url?.startsWith('/watch')) { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<html><title>Creator video</title></html>'); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}, 120_000);

afterAll(async () => {
  await new Promise<void>((done) => server.close(() => done()));
  await handle.close();
  await rm(root, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const id = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${id}', 'distill', now(), now())`);
  return id;
}

/** 模拟一次已完成的上传（工作区素材库，不属于作品）。 */
async function uploaded(workspaceId: string, file: string, filename: string): Promise<string> {
  const bytes = await readFile(join(root, file));
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  const storageKey = `it/${versionId}.mp4`;
  await storage.putObject(storageKey, bytes);
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: null, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license: { kind: 'OWNED' }, currentVersionId: versionId, metadata: { filename } });
  await handle.db.insert(assetVersions).values({ id: versionId, assetId, workspaceId, versionNumber: 1, storageKey, mimeType: 'video/mp4', sizeBytes: bytes.byteLength, checksumSha256: createHash('sha256').update(bytes).digest('hex'), status: 'READY' });
  return assetId;
}

async function drive(ports: ReferenceDistillPorts, workspaceId: string, runId: string): Promise<DistillRun> {
  const handler = createWorkflowAdvanceHandler({ registry: new WorkflowRegistry().register(referenceDistillWorkflow(ports)) });
  for (let round = 0; round < 10; round += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) break;
    await handler.handle(deps(), { runId }, { jobId: row.activeJobId!, workspaceId, heartbeat: async () => undefined });
  }
  return getReferenceDistill(deps(), { workspaceId, runId });
}

const analyzer = createFfmpegReferenceAnalyzer({ timeoutMs: 120_000 });
const localFetcher = (downloadCommand?: string[]) => createReferenceFetcher({ allowPrivateNetwork: true, timeoutMs: 60_000, ...(downloadCommand === undefined ? {} : { downloadCommand }) });

describe('V6-6 蒸馏器（真实 FFmpeg 测量 + 本地链接）', () => {
  it('上传的卡点视频 + 直接链接的慢节奏视频 → 一份风格：测量与真值一致，规则版说明', { timeout: 300_000 }, async () => {
    const ws = await workspace();
    const assetId = await uploaded(ws, 'beatcut.mp4', 'beatcut.mp4');
    const started = await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ assetId }, { url: `${baseUrl}/go` }], name: null, locale: 'zh-CN' }, idempotencyKey: 'd1' });
    expect(started).toMatchObject({ status: 'RUNNING', step: 'fetch', packId: null });
    expect((await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ assetId }, { url: `${baseUrl}/go` }] }, idempotencyKey: 'd1' })).runId).toBe(started.runId);

    const done = await drive({ analyzer, fetcher: localFetcher() }, ws, started.runId);
    expect(done, JSON.stringify(done.error)).toMatchObject({ status: 'SUCCEEDED', step: 'save', composer: 'RULES' });
    expect(done.references).toEqual([
      { label: 'beatcut.mp4', url: null, assetId },
      { label: 'slowwarm.mp4', url: `${baseUrl}/go`, assetId: expect.stringMatching(/^ast_/) },
    ]);
    // 链接抓到的参考视频：工作区素材库里的资产，记录来源链接，不属于任何作品
    const fetched = (await handle.db.select().from(assets).where(eq(assets.id, done.references[1]!.assetId!)))[0]!;
    expect(fetched).toMatchObject({ projectId: null, origin: 'PUBLIC_SOURCE', status: 'READY', retentionClass: 'DRAFT_RENDER_30D' });
    expect(fetched.metadata).toMatchObject({ purpose: 'REFERENCE', sourceUrl: `${baseUrl}/go`, finalUrl: `${baseUrl}/media/slowwarm.mp4` });

    const run = await getWorkflowRun(deps(), { workspaceId: ws, runId: started.runId });
    const [a, b] = (run.outputs as { analyze: { measurements: { cuts: number[]; beats: { bpm: number; confidence: number } | null; blackDips: unknown[]; color: { warmth: number; saturation: number } }[] } }).analyze.measurements;
    expect(a!.cuts).toHaveLength(23);
    a!.cuts.forEach((cut, index) => expect(Math.abs(cut - 0.5 * (index + 1))).toBeLessThanOrEqual(0.04));
    expect(Math.abs(a!.beats!.bpm - 120)).toBeLessThan(1.5);
    expect(a!.beats!.confidence).toBeGreaterThan(0.5);
    expect(b!.blackDips).toHaveLength(3);
    expect(b!.beats === null || b!.beats.confidence < 0.3).toBe(true);
    expect(b!.color.warmth).toBeGreaterThan(0.1);

    const pack = await getStrategyPack(deps(), { workspaceId: ws, packId: done.packId! });
    expect(pack).toMatchObject({ kind: 'DISTILLED', genre: 'reference', version: 1, name: { 'zh-CN': '「beatcut.mp4」等 2 条视频的风格' } });
    expect(pack.editingDna.measured).toEqual({ references: 2, analyzedSeconds: 24, shots: 24 + 4 });
    expect(pack.editingDna.shotSeconds.median).toBe(0.5);
    expect(pack.editingDna.cutsPerMinute).toBe(65); // (23 + 3) 剪点 / 24 秒
    expect(pack.editingDna.beatCutRatio).toBe(1); // 只统计有节拍的 A：剪点全在拍上
    expect(pack.editingDna.transitionsPerMinute).toBe(7.5); // 3 次黑场过渡 / 24 秒
    expect(pack.knobs.map((knob) => knob.key)).toContain('beat_sync');
    expect(pack.summary['zh-CN']).toContain('落在音乐节拍上');
    expect(pack.source).toMatchObject({ referenceAssetId: assetId, referenceUrl: `${baseUrl}/go` });
    expect(pack.source?.confidenceNote).toContain('no model viewed the video');
    expect((await listStrategyPacks(deps(), { workspaceId: ws })).map((item) => item.id)).toContain(pack.id);
    expect(strategyGuidanceText(pack, {})).toContain('pacing curve');
  });

  it('平台页面：没配置下载命令 → 明确失败提示上传；配置了下载命令 → 走命令；内网地址 → 拒绝', { timeout: 300_000 }, async () => {
    const ws = await workspace();
    const page = `${baseUrl}/watch?v=abc123`;
    const notConfigured = await drive({ analyzer, fetcher: localFetcher() }, ws, (await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ url: page }] } })).runId);
    expect(notConfigured).toMatchObject({ status: 'FAILED', step: 'fetch', error: { reason: 'REFERENCE_FETCH_NOT_CONFIGURED' }, packId: null });
    expect(notConfigured.error?.message).toContain('上传');

    // 下载命令（替身：把本地夹具复制到 {output}，格式与 yt-dlp 的 -o 模板相同）
    const script = join(root, 'fake-downloader.mjs');
    await writeFile(script, `import { copyFileSync } from 'node:fs';\nconst [url, output] = process.argv.slice(2);\nif (!url.includes('/watch?v=')) process.exit(3);\ncopyFileSync(${JSON.stringify(join(root, 'beatcut.mp4'))}, output.replace('%(ext)s', 'mp4'));\n`);
    const viaCommand = await drive({ analyzer, fetcher: localFetcher([process.execPath, script, '{url}', '{output}']) }, ws, (await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ url: page }], name: '我喜欢的博主' } })).runId);
    expect(viaCommand, JSON.stringify(viaCommand.error)).toMatchObject({ status: 'SUCCEEDED', composer: 'RULES' });
    const pack = await getStrategyPack(deps(), { workspaceId: ws, packId: viaCommand.packId! });
    expect(pack.name).toEqual({ 'zh-CN': '我喜欢的博主', en: '我喜欢的博主' });
    expect(pack.editingDna.shotSeconds.median).toBe(0.5);

    const blocked = await drive({ analyzer, fetcher: createReferenceFetcher() }, ws, (await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ url: 'http://169.254.169.254/latest/meta-data/video.mp4' }] } })).runId);
    expect(blocked).toMatchObject({ status: 'FAILED', error: { reason: 'REFERENCE_FETCH_BLOCKED' } });
    await expect(startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ assetId: 'ast_missing' }] } })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('配置了模型：模型看测量与抽帧写说明，数值仍是测量值；编辑包的文字（版本 +1），内置预设不可改', { timeout: 300_000 }, async () => {
    const ws = await workspace();
    const assetId = await uploaded(ws, 'beatcut.mp4', 'Creator vlog.mp4');
    const requests: AgentModelRequest[] = [];
    const model: AgentModelAdapter = {
      providerId: 'scripted', implementation: 'SCRIPTED', model: 'claude-opus-5-5',
      respond: (request) => {
        requests.push(request);
        return Promise.resolve({ model: 'claude-opus-5-5', stopReason: 'end_turn', usage: { inputTokens: 3000, outputTokens: 400, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, content: [{ type: 'text', text: JSON.stringify({
          name: { 'zh-CN': '色块卡点', en: 'Color-block beat cuts' },
          summary: { 'zh-CN': '每拍一切，纯色块轮换。', en: 'One cut per beat, rotating flat colors.' },
          structureHints: ['Cut on every beat from the first frame.'],
          agentGuidance: 'Cut on every beat with short shots.',
          styleRubric: [{ key: 'beat_sync', criterion: 'Every cut lands on a beat.', weight: 3 }],
          captionStyle: null,
          visualNotes: 'flat full-frame color fields, no camera movement',
        }) }] });
      },
    };
    const frames = createStorageFrameSampler({ storage });
    const run = await drive({ analyzer, frames, model }, ws, (await startReferenceDistill(deps(), { workspaceId: ws, request: { references: [{ assetId }] } })).runId);
    expect(run, JSON.stringify(run.error)).toMatchObject({ status: 'SUCCEEDED', composer: 'MODEL' });
    expect(requests).toHaveLength(1);
    const images = requests[0]!.messages[0]!.content.filter((block) => block.type === 'image');
    expect(images.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(requests[0]!.messages[0]!.content[0])).toContain('cutsPerMinute');
    const pack = await getStrategyPack(deps(), { workspaceId: ws, packId: run.packId! });
    expect(pack.name).toEqual({ 'zh-CN': '色块卡点', en: 'Color-block beat cuts' });
    expect(pack.editingDna.shotSeconds.median).toBe(0.5); // 数值来自测量
    expect(pack.agentGuidance).toContain('model inference');
    expect(pack.source?.confidenceNote).toContain('claude-opus-5-5');
    await frames.close();

    const edited = await updateStrategyPack(deps(), { workspaceId: ws, packId: pack.id, changes: { name: { 'zh-CN': '我的卡点风格', en: 'My beat style' }, agentGuidance: 'Cut on the beat, always.' } });
    expect(edited).toMatchObject({ version: 2, name: { 'zh-CN': '我的卡点风格' }, agentGuidance: 'Cut on the beat, always.', editingDna: pack.editingDna });
    expect(strategyPackSchema.parse(await getStrategyPack(deps(), { workspaceId: ws, packId: pack.id }))).toMatchObject({ version: 2 } satisfies Partial<StrategyPack>);
    await expect(updateStrategyPack(deps(), { workspaceId: ws, packId: 'builtin:travel-beat', changes: { agentGuidance: 'x' } })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'STRATEGY_PACK_NOT_EDITABLE' } });
    expect(await handle.db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, ws))).toBeDefined();
  });
});
