import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, type EditOperation, type MediaRange } from '@ancs/contracts';
import { assets, assetVersions, createDb, jobs, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import {
  compileSequenceRenderPlan,
  createChannel,
  createProject,
  createProposalBranch,
  createSequence,
  createTrack,
  getSequencePreview,
  listProjectComposition,
  previewProfileFor,
  processEdits,
  requestSequencePreview,
  type DomainDeps,
} from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createPreviewRenderHandler } from './preview-render-handler.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * V6-1d 改哪里渲染哪里（真实 PostgreSQL + 本地对象存储 + 真实 FFmpeg）：
 * - 首次预览：每个 2 秒窗口与整条声音都渲染；同一计划再次请求 → 同一预览（不重渲）；
 * - 只改后半段：前半段窗口直接复用，只重渲受影响窗口 + 声音；
 * - 提案预览：事务内试改后回滚，工程不变；与已渲染内容相同的窗口复用；
 * - 拼接结果与一次性整片渲染逐帧对照（PSNR）：窗口接缝处没有错帧、丢帧或重复帧；帧数与时长正确。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let workRoot: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });
const executor = createFfmpegRenderPlanExecutor({ timeoutMs: 120_000 });
const handler = createPreviewRenderHandler({ executor });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-preview-it-'));
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `preview-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=8',
    '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*440*t)':s=48000:d=8:c=stereo",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workRoot, 'source.mp4')]);
});

afterAll(async () => {
  await handle.close();
  await rm(workRoot, { recursive: true, force: true });
});

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'preview', now(), now())`);
  const channel = await createChannel(deps(), { workspaceId, createdBy: `usr_${randomUUID()}`, input: { name: '预览', language: 'zh' } });
  const project = await createProject(deps(), { workspaceId, input: { title: 'preview', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(4_000) } });
  const scope = { workspaceId, projectId: project.id, sequenceId: sequence.id };
  const v1 = await createTrack(deps(), { ...scope, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  await createTrack(deps(), { ...scope, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
  const bytes = await readFile(join(workRoot, 'source.mp4'));
  const probe = await createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }).probe({ filePath: join(workRoot, 'source.mp4'), declaredMimeType: 'video/mp4' });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  const storageKey = `it/${assetVersionId}.mp4`;
  await storage.putObject(storageKey, bytes);
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license: { kind: 'OWNED' }, currentVersionId: assetVersionId });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId, versionNumber: 1, storageKey, mimeType: 'video/mp4', sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'), durationMs: probe.durationMs ?? 8_000, width: 320, height: 180, status: 'READY', mediaProbe: probe,
  });
  const revision = async () => Number((await handle.db.execute(`select revision from projects where id = '${project.id}'`)).rows[0]!['revision']);
  const edit = async (operations: EditOperation[]) => processEdits(deps(), {
    workspaceId, projectId: project.id, actor: { type: 'USER', id: null },
    request: { baseProjectRevision: await revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`, operations },
  });
  // 0–2 s 用源 1–3 s，2–4 s 用源 5–7 s（两段不同内容，接缝在窗口边界上）
  await edit([
    { op: 'insert_clip', sequenceId: sequence.id, trackId: v1.id, assetVersionId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(1_000, 3_000), mode: 'OVERWRITE', sequenceStart: mt(0), linkAudio: true, audioTrackId: null },
    { op: 'insert_clip', sequenceId: sequence.id, trackId: v1.id, assetVersionId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(5_000, 7_000), mode: 'OVERWRITE', sequenceStart: mt(2_000), linkAudio: true, audioTrackId: null },
  ]);
  return { ...scope, v1: v1.id, assetVersionId, revision, edit };
}

async function renderPreview(workspaceId: string, previewId: string) {
  const job = (await handle.db.select().from(jobs).where(eq(jobs.input, { previewId })))[0];
  return handler.handle(deps(), { previewId }, { jobId: job?.id ?? 'job_x', workspaceId, heartbeat: async () => undefined });
}

const probeStreams = (path: string) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,nb_read_frames,width,height:format=duration', '-of', 'json', path]).toString('utf8')) as {
  streams: { codec_type: string; nb_read_frames?: string; width?: number; height?: number }[]; format: { duration: string };
};

async function downloadPreview(workspaceId: string, previewId: string): Promise<string> {
  const preview = await getSequencePreview(deps(), { workspaceId, previewId });
  const row = (await handle.db.execute(`select storage_key from sequence_previews where id = '${previewId}'`)).rows[0]!;
  const bytes = await storage.getObject(String(row['storage_key']));
  const path = join(workRoot, `${preview.id}.mp4`);
  await writeFile(path, bytes!);
  return path;
}

describe('低清预览：时间窗缓存（真实 FFmpeg）', () => {
  it('首次全部渲染、同计划去重；只改后半段 → 前半段复用；拼接与整片渲染逐帧一致', { timeout: 300_000 }, async () => {
    const fx = await fixture();
    const first = await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: {} });
    expect(first).toMatchObject({ status: 'QUEUED', source: 'REVISION', width: 960, height: 540, playbackUrl: null });
    expect((await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: {} })).id).toBe(first.id);

    const result = await renderPreview(fx.workspaceId, first.id);
    expect(result).toMatchObject({ segments: 3, reused: 0, rendered: 3 });
    const ready = await getSequencePreview(deps(), { workspaceId: fx.workspaceId, previewId: first.id });
    expect(ready.status).toBe('READY');
    expect(ready.playbackUrl).toMatch(/^http/);
    const path = await downloadPreview(fx.workspaceId, first.id);
    const info = probeStreams(path);
    expect(info.streams.find((stream) => stream.codec_type === 'video')).toMatchObject({ nb_read_frames: '120', width: 960, height: 540 });
    expect(info.streams.some((stream) => stream.codec_type === 'audio')).toBe(true);
    expect(Math.abs(Number(info.format.duration) - 4)).toBeLessThan(0.1);

    // 与一次性整片渲染（同一计划、同一档位）逐帧对照：接缝处没有错帧
    const plan = await compileSequenceRenderPlan(deps(), fx);
    const fullDir = await mkdtemp(join(workRoot, 'full-'));
    await execFileSync('mkdir', ['-p', join(fullDir, 'assets')]);
    await writeFile(join(fullDir, 'assets', 'src.mp4'), await readFile(join(workRoot, 'source.mp4')));
    await executor.execute({ plan, profile: previewProfileFor('16:9'), workDir: fullDir, sources: [{ assetVersionId: fx.assetVersionId, fileName: 'src.mp4' }] });
    const psnr = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', path, '-i', join(fullDir, 'out', 'final.mp4'), '-lavfi', '[0:v][1:v]psnr=stats_file=-', '-f', 'null', '-']).toString('utf8');
    const perFrame = psnr.trim().split('\n').map((line) => Number(/psnr_avg:([0-9.inf]+)/.exec(line)?.[1] === 'inf' ? 99 : /psnr_avg:([0-9.]+)/.exec(line)?.[1]));
    expect(perFrame).toHaveLength(120);
    expect(Math.min(...perFrame)).toBeGreaterThan(30);

    // 只改后半段（换源区间）→ 新预览：第一窗复用，第二窗与声音重渲
    const composition = await listProjectComposition(deps(), fx);
    const later = composition.clips.find((clip) => clip.trackId === fx.v1 && clip.sequenceRange.start.ticks === '2000')!;
    await fx.edit([{ op: 'slip_clip', clipId: later.id, sourceRange: range(4_000, 6_000) }]);
    const second = await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: {} });
    expect(second.id).not.toBe(first.id);
    expect(await renderPreview(fx.workspaceId, second.id)).toMatchObject({ segments: 3, reused: 1, rendered: 2 });

    // 提案预览：只动前半段 → 第二窗复用（声音因原声随片段改变而重渲）；工程不变
    const before = await fx.revision();
    const earlier = composition.clips.find((clip) => clip.trackId === fx.v1 && clip.sequenceRange.start.ticks === '0')!;
    const proposal = await createProposalBranch(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, request: { baseProjectRevision: before, selectionAnchorId: null, intentRevisionId: null, operations: [{ op: 'slip_clip', clipId: earlier.id, sourceRange: range(2_000, 4_000) }] } });
    const trial = await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { proposalId: proposal.proposalId } });
    expect(trial).toMatchObject({ source: 'PROPOSAL', proposalId: proposal.proposalId, projectRevision: before + 1 });
    expect(await fx.revision()).toBe(before);
    expect(await renderPreview(fx.workspaceId, trial.id)).toMatchObject({ segments: 3, reused: 1, rendered: 2 });
    expect((await getSequencePreview(deps(), { workspaceId: fx.workspaceId, previewId: trial.id })).status).toBe('READY');
  });

  it('不支持的内容（后端缺能力）→ 预览失败并说明原因，不重试刷费用；失败的预览可再次请求', { timeout: 120_000 }, async () => {
    const fx = await fixture();
    const composition = await listProjectComposition(deps(), fx);
    const clip = composition.clips.find((item) => item.trackId === fx.v1)!;
    // 变速（TIME_REMAP）目前 FFmpeg 后端不支持
    await fx.edit([{ op: 'update_clip', clipId: clip.id, changes: { timeMapping: { kind: 'LINEAR', rate: { num: 2, den: 1 }, direction: 'FORWARD', preservePitch: true }, sourceRange: range(1_000, 5_000) } }]);
    const preview = await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: {} });
    expect(await renderPreview(fx.workspaceId, preview.id)).toMatchObject({ failed: true });
    const failed = await getSequencePreview(deps(), { workspaceId: fx.workspaceId, previewId: preview.id });
    expect(failed.status).toBe('FAILED');
    expect(failed.error).toMatchObject({ reason: 'PREVIEW_UNSUPPORTED_CONTENT' });
    const retry = await requestSequencePreview(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: {} });
    expect(retry.id).not.toBe(preview.id);
  });
});
