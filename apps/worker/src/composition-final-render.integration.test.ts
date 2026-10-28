import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { COMPOSITION_FINAL_RENDER_ERROR_REASONS, PLAYBACK_ERROR_REASONS, legacyMillisecondsToMediaTime, type MediaRange } from '@ancs/contracts';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  compositionFinalRenderWorkflow,
  createChannel,
  createProject,
  createSequence,
  createTrack,
  createVisualObject,
  getWorkflowRun,
  processEdits,
  startCompositionFinalRender,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';

/**
 * V5-M4（§11.2）素材工程终渲染工作流（真实 PostgreSQL + 本地对象存储 + 真实 FFmpeg）：
 * 发起 → 推进任务处理器 → 冻结（RenderPlan + FINAL_RENDER 版本）→ 渲染（冻结源按校验和取字节）→
 * 产物入自有存储 → 技术 QA（从存储读回真实输出）→ 成功；
 * 负例：含不支持需求（图形对象）在冻结时 501、无任何产物；冻结源字节被篡改 → 不可重试失败、无产物。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let workRoot: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });
const PROFILE = { width: 320, height: 180, videoCrf: 23, audioBitrateKbps: 128, captionDelivery: 'SIDECAR' as const };

const registry = new WorkflowRegistry().register(compositionFinalRenderWorkflow({
  executor: createFfmpegRenderPlanExecutor({ timeoutMs: 120_000 }),
  outputProbe: createFfmpegSourceMediaProbe({ timeoutMs: 60_000 }),
}));
const handler = createWorkflowAdvanceHandler({ registry });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-final-render-it-'));
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `final-render-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4',
    '-f', 'lavfi', '-i', "aevalsrc='0.2*sin(2*PI*440*t)':s=48000:d=4:c=stereo",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workRoot, 'source.mp4')]);
});

afterAll(async () => {
  await handle.close();
  await rm(workRoot, { recursive: true, force: true });
});

/** 建工程：一个带音频的源片段插入 V1（关联音频片段在 A1），可选在 V1 上放一个图形对象。 */
async function fixture(options: { withGraphics?: boolean } = {}) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'final-render', now(), now())`);
  const channel = await createChannel(deps(), { workspaceId, createdBy: `usr_${randomUUID()}`, input: { name: '导出', language: 'zh' } });
  const project = await createProject(deps(), { workspaceId, input: { title: 'final-render', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(2_000) } });
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
    checksumSha256: createHash('sha256').update(bytes).digest('hex'), durationMs: probe.durationMs ?? 4_000, width: 320, height: 180, status: 'READY', mediaProbe: probe,
  });
  const revision = async () => Number((await handle.db.execute(`select revision from projects where id = '${project.id}'`)).rows[0]!['revision']);
  await processEdits(deps(), {
    workspaceId, projectId: project.id, actor: { type: 'USER', id: null },
    request: {
      baseProjectRevision: await revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`,
      operations: [{ op: 'insert_clip', sequenceId: sequence.id, trackId: v1.id, assetVersionId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(1_000, 3_000), mode: 'OVERWRITE', sequenceStart: mt(0), linkAudio: true, audioTrackId: null }],
    },
  });
  if (options.withGraphics === true) {
    const clipId = String((await handle.db.execute(`select id from sequence_clips where track_id = '${v1.id}' limit 1`)).rows[0]!['id']);
    await createVisualObject(deps(), { ...scope, input: { trackId: v1.id, kind: 'TEXT', timeBinding: { basis: 'CLIP_LOCAL', clipId, semanticCueId: null }, localRange: range(0, 1_000), parameters: { schemaVersion: '1.0', values: { text: '标题' } } } });
  }
  return { ...scope, assetVersionId, storageKey, revision: await revision() };
}

/** 扮演 Worker：按运行的有效推进任务执行处理器（引擎自己另起的重试任务也照此执行），直到终态。 */
async function drive(workspaceId: string, runId: string) {
  for (let round = 0; round < 6; round += 1) {
    const run = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN'].includes(run.status)) break;
    await handler.handle(deps(), { runId }, { jobId: run.activeJobId!, workspaceId, heartbeat: async () => undefined });
  }
  return getWorkflowRun(deps(), { workspaceId, runId });
}

describe('素材工程终渲染工作流（真实 PostgreSQL + 对象存储 + FFmpeg）', () => {
  it('冻结 → 渲染 → 技术 QA：产物落自有存储、哈希可复核、QA 从存储读回真实输出；同一幂等键不重复发起', { timeout: 180_000 }, async () => {
    const fx = await fixture();
    const run = await startCompositionFinalRender(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { profile: PROFILE, expectedRevision: fx.revision }, idempotencyKey: 'u:export-1', createdBy: null });
    const again = await startCompositionFinalRender(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { profile: PROFILE, expectedRevision: fx.revision }, idempotencyKey: 'u:export-1', createdBy: null });
    expect(again.id).toBe(run.id);

    const finished = await drive(fx.workspaceId, run.id);
    expect(finished.status).toBe('SUCCEEDED');
    expect(finished.steps.map((step) => `${step.stepKey}:${step.status}`)).toEqual(['freeze:SUCCEEDED', 'render:SUCCEEDED', 'qa:SUCCEEDED']);
    const frozen = finished.outputs['freeze'] as { planHash: string; projectVersionId: string; plan: { requirements: string[] } };
    expect(frozen.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(frozen.projectVersionId).toBeTruthy();
    const rendered = finished.outputs['render'] as { frameCount: string; outputs: { kind: string; assetVersionId: string; sha256: string }[] };
    expect(rendered.frameCount).toBe('60');
    expect(rendered.outputs.map((output) => output.kind).sort()).toEqual(['MANIFEST', 'VIDEO']);
    for (const output of rendered.outputs) {
      const row = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, output.assetVersionId)))[0]!;
      const bytes = await storage.getObject(row.storageKey!);
      expect(createHash('sha256').update(bytes!).digest('hex')).toBe(output.sha256);
      expect(row.checksumSha256).toBe(output.sha256);
    }
    const qa = finished.outputs['qa'] as { passed: boolean; checks: { name: string; passed: boolean }[] };
    expect(qa.passed).toBe(true);
    expect(qa.checks.map((check) => check.name)).toEqual(expect.arrayContaining(['VIDEO.storedHash', 'MANIFEST.storedHash', 'manifest.planHash', 'decode', 'video.size', 'video.frameCount', 'audio.layout']));
    expect(qa.checks.every((check) => check.passed)).toBe(true);
    // 只有用户自己的素材：不加 AI 生成标识（不误标）
    expect((finished.outputs['render'] as { contentLabel?: unknown }).contentLabel).toBeNull();
    expect(qa.checks.some((check) => check.name === 'aigc.metadata')).toBe(false);
    const videoOutput = rendered.outputs.find((output) => output.kind === 'VIDEO')!;
    const videoRow = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, videoOutput.assetVersionId)))[0]!;
    expect(Buffer.from((await storage.getObject(videoRow.storageKey!))!).includes(Buffer.from('"ProduceID"'))).toBe(false);
  });

  it('不支持的需求（图形对象）：冻结时 501，运行失败且没有任何产物', { timeout: 60_000 }, async () => {
    const fx = await fixture({ withGraphics: true });
    const run = await startCompositionFinalRender(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { profile: PROFILE } });
    const finished = await drive(fx.workspaceId, run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error).toMatchObject({ step: 'freeze', httpStatus: 501, details: { reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY, capability: 'GRAPHICS_COMPONENT_RENDER' } });
    expect(finished.outputs['render']).toBeUndefined();
  });

  it('工程在发起后又被改：冻结时 409 REVISION_CHANGED（不导出用户没看过的版本）', { timeout: 60_000 }, async () => {
    const fx = await fixture();
    const run = await startCompositionFinalRender(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { profile: PROFILE, expectedRevision: fx.revision - 1 } });
    const finished = await drive(fx.workspaceId, run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error).toMatchObject({ step: 'freeze', httpStatus: 409, details: { reason: COMPOSITION_FINAL_RENDER_ERROR_REASONS.REVISION_CHANGED } });
  });

  it('冻结源字节被篡改：渲染步骤不可重试失败（完整性优先），不产生产物', { timeout: 60_000 }, async () => {
    const fx = await fixture();
    await storage.putObject(fx.storageKey, new Uint8Array([1, 2, 3]));
    const run = await startCompositionFinalRender(deps(), { workspaceId: fx.workspaceId, projectId: fx.projectId, sequenceId: fx.sequenceId, request: { profile: PROFILE } });
    const finished = await drive(fx.workspaceId, run.id);
    expect(finished.status).toBe('FAILED');
    expect(finished.error).toMatchObject({ step: 'render', details: { reason: COMPOSITION_FINAL_RENDER_ERROR_REASONS.SOURCE_INTEGRITY_FAILED } });
    expect(finished.steps.filter((step) => step.stepKey === 'render')).toHaveLength(1);
    const produced = await handle.db.execute(`select count(*)::int as n from assets where workspace_id = '${fx.workspaceId}' and origin = 'SYSTEM_RENDER'`);
    expect(Number(produced.rows[0]!['n'])).toBe(0);
  });
});
