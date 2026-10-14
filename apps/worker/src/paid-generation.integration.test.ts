import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  GENERATION_ERROR_REASONS,
  IDENTITY_CONSENT_STATEMENT_VERSION,
  OUTSIDE_REGION_CHANGE_THRESHOLD,
  mediaTimeSchema,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
  type MediaRange,
  type PaidGenerationExecutor,
} from '@ancs/contracts';
import { agentTurns, assets, assetVersions, createDb, creditHolds, creditLedger, generationRequests, identityConsentRecords, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  acceptGeneration,
  adoptProposal,
  advanceWorkflow,
  agentTurnWorkflow,
  compositionFinalRenderWorkflow,
  createAgentSession,
  createChannel,
  createIdentityProfile,
  createProject,
  createSequence,
  createTrack,
  declineGeneration,
  getAgentTurn,
  getStudioState,
  getWorkflowRun,
  grantIdentityConsent,
  loadProposalForRead,
  paidGenerationWorkflow,
  processEdits,
  revokeIdentityConsent,
  setIdentityReference,
  startAgentTurn,
  startCompositionFinalRender,
  updateProjectProductionPolicy,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createPaidGenerationExecutor, createProcessGenerationProvider, createScriptedGenerationProvider, type ScriptedGenerationBehavior } from './paid-generation.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { findRepoRoot } from './render-executor-process.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';

/**
 * V6-7 / V6-8 付费生成（真实 PostgreSQL + 本地对象存储 + 真实 FFmpeg；AI 为脚本模型，生成供应商为 FFmpeg 测试替身）：
 * 1. 选区重绘：AI 只报价 → 未设预算/金额不符被拒 → 确认（原子预留）→ 生成一次 → 拉回自有存储 → 作为"确认生成"这一轮的试改
 *    （GEN 轨 + 裁切到选区）→ 按供应商报告的费用结算；采用后终渲染：框内变了、框外与原片一致；圈外被改时如实标出；
 * 2. 失败分支：明确未扣费 → 失败并释放预留；结果不明 → 待对账（预留保持、不重试）；没报告费用 → 按报价上限结算并标明；放弃/过期；
 * 3. 数字人：身份档案 + 参考照片/声音 + 授权（只增不改）→ 报价（语言、授权检查）→ 确认 → 有声的画中画出镜；执行前撤回授权 → 失败不扣费；
 * 4. 进程协议：成功带费用 / 失败未扣费 / 崩溃 = 结果不明；子进程拿不到未声明的环境变量。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let workRoot: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const PROFILE = { width: 320, height: 180, videoCrf: 18, audioBitrateKbps: 128, captionDelivery: 'SIDECAR' as const };
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });
let behavior: ScriptedGenerationBehavior = 'normal';
let liveExecutor: PaidGenerationExecutor;

const ft = (frames: number) => mediaTimeSchema.parse({ ticks: String(frames), timebase: { num: 1, den: 30 } });
const range = (start: number, end: number): MediaRange => ({ start: ft(start), end: ft(end) });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-generation-it-'));
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `generation-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  liveExecutor = createPaidGenerationExecutor({ provider: createScriptedGenerationProvider({ behavior: () => behavior }), storage, probe });
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', join(workRoot, 'source.mp4')]);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x3b82f6:s=256x256:d=1', '-frames:v', '1', join(workRoot, 'face.png')]);
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', join(workRoot, 'voice.wav')]);
});

afterAll(async () => {
  await handle.close();
  await rm(workRoot, { recursive: true, force: true });
});

class ScriptedModel implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly model = 'scripted-director';
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly steps: ((request: AgentModelRequest) => AgentModelResponse)[]) {}
  respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const step = this.steps[this.requests.length];
    this.requests.push(structuredClone(request));
    if (step === undefined) return Promise.reject(new Error('no scripted step'));
    try { return Promise.resolve(step(request)); } catch (error) { return Promise.reject(error); }
  }
}
const reply = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason']): AgentModelResponse =>
  ({ model: 'scripted-director', content, stopReason, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });
const call = (id: string, name: string, input: Record<string, unknown>) => reply([{ type: 'tool_use', id, name, input }], 'tool_use');
const text = (value: string) => reply([{ type: 'text', text: value }], 'end_turn');
const lastResult = (request: AgentModelRequest) => request.messages[request.messages.length - 1]!.content
  .filter((block): block is Extract<AgentContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')[0]!;
const parsed = (request: AgentModelRequest) => ({ ...lastResult(request), body: JSON.parse(lastResult(request).content) as Record<string, unknown> });

async function storeAsset(input: { workspaceId: string; projectId: string | null; file: string; mimeType: string; assetType: 'USER_UPLOAD' | 'SOURCE_IMAGE' | 'VOICE_AUDIO'; filename: string }) {
  const bytes = await readFile(input.file);
  const media = await probe.probe({ filePath: input.file, declaredMimeType: input.mimeType });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  const storageKey = `it/${footageId}-${input.filename}`;
  await storage.putObject(storageKey, bytes);
  await handle.db.insert(assets).values({ id: assetId, workspaceId: input.workspaceId, projectId: input.projectId, assetType: input.assetType, origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: input.filename } });
  await handle.db.insert(assetVersions).values({
    id: footageId, assetId, workspaceId: input.workspaceId, versionNumber: 1, storageKey, mimeType: input.mimeType, sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'), durationMs: media.durationMs, width: 320, height: 180, status: 'READY', mediaProbe: media,
  });
  return { assetId, footageId };
}

async function fixture(options: { budget?: boolean } = {}) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'generation', now(), now())`);
  const channel = await createChannel(deps(), { workspaceId, input: { name: '生成', language: 'zh' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '生成', channelId: channel.id, mode: 'FOOTAGE_EDIT', aspectRatio: '16:9', brief: {} } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: 'Main', frameRate: { num: 30, den: 1 }, duration: ft(90) } });
  const scope = { workspaceId, projectId: project.id, sequenceId: sequence.id };
  const v1 = await createTrack(deps(), { ...scope, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const source = await storeAsset({ workspaceId, projectId: project.id, file: join(workRoot, 'source.mp4'), mimeType: 'video/mp4', assetType: 'USER_UPLOAD', filename: 'street.mp4' });
  const revision = async () => Number((await handle.db.execute(`select revision from projects where id = '${project.id}'`)).rows[0]!['revision']);
  const clipId = `clp_${randomUUID()}`;
  await processEdits(deps(), {
    workspaceId, projectId: project.id, actor: { type: 'USER', id: null },
    request: {
      baseProjectRevision: await revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`,
      operations: [{ op: 'insert_clip', sequenceId: sequence.id, trackId: v1.id, assetVersionId: source.footageId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(0, 90), mode: 'OVERWRITE', sequenceStart: ft(0), linkAudio: false, audioTrackId: null, createdClipId: clipId }],
    },
  });
  const session = await createAgentSession(deps(), { workspaceId, projectId: project.id, request: { sequenceId: sequence.id, locale: 'zh-CN' } });
  if (options.budget !== false) await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100_000, perJobMaxCredits: 0 } });
  return { ...scope, clipId, source, session, revision };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const registry = () => new WorkflowRegistry()
  .register(agentTurnWorkflow({ model: new ScriptedModel([]), generation: { offers: () => liveExecutor.offers() } }))
  .register(paidGenerationWorkflow({ executor: liveExecutor }));

async function drive(f: Fixture, runId: string, workflows = registry()): Promise<string> {
  for (let index = 0; index < 12; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN'].includes(row.status)) return row.status;
    await advanceWorkflow(deps(), workflows, { workspaceId: f.workspaceId, runId: row.id, jobId: row.activeJobId! });
  }
  throw new Error('workflow did not finish');
}

async function quoteTurn(f: Fixture, quote: Record<string, unknown>, options: { pointer?: Record<string, unknown>; expectRefusal?: boolean } = {}) {
  const seen: Record<string, unknown>[] = [];
  const model = new ScriptedModel([
    () => call('o1', 'list_generation_options', {}),
    (request) => { seen.push(parsed(request).body); return call('q1', 'quote_generation', quote); },
    (request) => { seen.push(parsed(request)); return text('报好价了，请确认。'); },
  ]);
  const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message: '报个价', ...(options.pointer === undefined ? {} : { pointer: options.pointer }) }, idempotencyKey: `turn-${randomUUID()}` });
  const workflows = new WorkflowRegistry().register(agentTurnWorkflow({ model, generation: { offers: () => liveExecutor.offers() } }));
  expect(await drive(f, turn.workflowRunId!, workflows)).toBe('SUCCEEDED');
  const options2 = seen[0]!;
  const result = seen[1] as { isError: boolean; body: Record<string, unknown> };
  expect(result.isError, JSON.stringify(result.body)).toBe(options.expectRefusal === true);
  const latest = (await handle.db.select().from(generationRequests).where(eq(generationRequests.projectId, f.projectId)).orderBy(desc(generationRequests.createdAt)).limit(1))[0];
  return { options: options2, result: result.body, generation: options.expectRefusal === true ? null : latest!, turnId: turn.id };
}

const failure = async (promise: Promise<unknown>): Promise<ApiFailure> => {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(ApiFailure);
  return error as ApiFailure;
};

async function accept(f: Fixture, generationId: string, expectedMaxMicros: number) {
  return acceptGeneration(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, generationId, request: { expectedMaxMicros }, actorId: null });
}

async function holdOf(generationId: string) {
  return (await handle.db.select().from(creditHolds).where(eq(creditHolds.jobId, generationId)))[0];
}

async function renderFrame(f: Fixture, atSeconds: number): Promise<{ at: (x: number, y: number) => number[] }> {
  const handler = createWorkflowAdvanceHandler({ registry: new WorkflowRegistry().register(compositionFinalRenderWorkflow({ executor: createFfmpegRenderPlanExecutor({ timeoutMs: 120_000 }), outputProbe: probe })) });
  const run = await startCompositionFinalRender(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: f.sequenceId, request: { profile: PROFILE } });
  for (let round = 0; round < 6; round += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN'].includes(row.status)) break;
    await handler.handle(deps(), { runId: run.id }, { jobId: row.activeJobId!, workspaceId: f.workspaceId, heartbeat: async () => undefined });
  }
  const finished = await getWorkflowRun(deps(), { workspaceId: f.workspaceId, runId: run.id });
  expect(finished.status).toBe('SUCCEEDED');
  const video = (finished.outputs['render'] as { outputs: { kind: string; assetVersionId: string }[] }).outputs.find((output) => output.kind === 'VIDEO')!;
  const row = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, video.assetVersionId)))[0]!;
  const file = join(workRoot, `${run.id}.mp4`);
  await writeFile(file, (await storage.getObject(row.storageKey))!);
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(atSeconds), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return { at: (x, y) => [...raw.subarray((y * PROFILE.width + x) * 3, (y * PROFILE.width + x) * 3 + 3)] };
}

const REGION = { x: 0.5, y: 0, width: 0.5, height: 0.5 };

describe('V6-7 / V6-8 付费生成（真实 FFmpeg，脚本导演 + 测试替身供应商）', () => {
  it('选区重绘：只报价 → 确认（预算预留）→ 生成一次 → 试改（裁切到选区）→ 结算；采用后框内变、框外不变', { timeout: 600_000 }, async () => {
    behavior = 'normal';
    const f = await fixture({ budget: false });

    // 制作规则不允许时，AI 的报价被服务端拒绝
    const blocked = await quoteTurn(f, { kind: 'VIDEO_REGION', summary: '把右上角的天空换成晚霞', prompt: 'sunset sky', clipId: f.clipId, start: '1', end: '3', region: REGION }, { expectRefusal: true });
    expect(blocked.result['reason']).toBe('PRODUCTION_POLICY_BLOCKED');
    expect((blocked.options['policy'] as Record<string, unknown>)['generatedVideo']).toBe(false);
    await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowGeneratedVideo: true } });

    const quoted = await quoteTurn(f, { kind: 'VIDEO_REGION', summary: '把右上角的天空换成晚霞', prompt: 'sunset sky', start: '1', end: '3' }, { pointer: { clipIds: [f.clipId], frameRegion: REGION } });
    expect(quoted.options['budget']).toMatchObject({ configured: false });
    expect(quoted.result).toMatchObject({ kind: 'VIDEO_REGION', seconds: '2', estimate: '$0.10–$0.80', expiresInMinutes: 30 });
    const generation = quoted.generation!;
    expect(generation).toMatchObject({ status: 'QUOTED', providerImplementation: 'SCRIPTED', estimateMinMicros: 100_000, estimateMaxMicros: 800_000, reserveCredits: 80, quoteTurnId: quoted.turnId, sessionId: f.session.id });
    // 报价那一轮没有改时间线，也没有花钱
    expect((await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: quoted.turnId })).proposalId).toBeNull();
    expect(await holdOf(generation.id)).toBeUndefined();

    // 未设预算：fail-closed；金额与报价不符：拒绝
    expect((await failure(accept(f, generation.id, 800_000))).details['reason']).toBe(GENERATION_ERROR_REASONS.BUDGET_NOT_SET);
    await upsertBudget(deps(), { workspaceId: f.workspaceId, input: { period: 'MONTHLY', limitCredits: 100_000, perJobMaxCredits: 0 } });
    expect((await failure(accept(f, generation.id, 700_000))).details['reason']).toBe(GENERATION_ERROR_REASONS.ESTIMATE_CHANGED);

    const accepted = await accept(f, generation.id, 800_000);
    expect(accepted).toMatchObject({ status: 'RUNNING', turnId: expect.any(String) as string });
    expect(await holdOf(generation.id)).toMatchObject({ status: 'HELD', reservedCredits: 80 });
    // 重复确认：返回同一状态，不重复预留、不重复生成
    expect((await accept(f, generation.id, 800_000)).turnId).toBe(accepted.turnId);
    const genTurn = (await handle.db.select().from(agentTurns).where(eq(agentTurns.id, accepted.turnId!)))[0]!;
    expect(genTurn).toMatchObject({ purpose: 'GENERATE', status: 'RUNNING', message: expect.stringContaining('确认生成：把右上角的天空换成晚霞') as string });

    expect(await drive(f, genTurn.workflowRunId!)).toBe('SUCCEEDED');
    const done = (await handle.db.select().from(generationRequests).where(eq(generationRequests.id, generation.id)))[0]!;
    expect(done).toMatchObject({ status: 'SUCCEEDED', chargedMicros: 450_000, costSource: 'PROVIDER', error: null });
    expect(done.outsideRegionChange).not.toBeNull();
    expect(done.outsideRegionChange!).toBeLessThan(OUTSIDE_REGION_CHANGE_THRESHOLD);
    expect(await holdOf(generation.id)).toMatchObject({ status: 'SETTLED', settledCredits: 45 });
    const debit = await handle.db.select().from(creditLedger).where(and(eq(creditLedger.workspaceId, f.workspaceId), eq(creditLedger.entryType, 'DEBIT')));
    expect(debit.map((row) => row.amount)).toEqual([45]);

    // 产物在自有存储里，来源可追溯
    const asset = (await handle.db.select().from(assets).where(eq(assets.id, done.assetId!)))[0]!;
    expect(asset).toMatchObject({ assetType: 'GENERATED_VIDEO', origin: 'GENERATED', provider: 'scripted-video', retentionClass: 'KEEP_PAID_GENERATED' });
    expect((asset.metadata as { generation: { generationId: string } }).generation.generationId).toBe(generation.id);

    const finishedTurn = await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: accepted.turnId! });
    expect(finishedTurn.status).toBe('COMPLETED');
    expect(finishedTurn.reply).toContain('实际花费 $0.45');
    expect(finishedTurn.proposalId).toBe(done.proposalId);
    const proposal = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: done.proposalId! });
    expect(proposal.operations.map((op) => op.op)).toEqual(['create_track', 'insert_clip', 'set_clip_crop']);
    const before = await f.revision();
    await adoptProposal(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: proposal.proposalId, expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}` });
    expect(await f.revision()).toBe(before + 1);

    // 终渲染：2 s 处框内（右上）被调色，框外（左下）与原片一致
    const frame = await renderFrame(f, 2);
    execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', '2', '-i', join(workRoot, 'source.mp4'), '-frames:v', '1', '-vf', 'scale=320:180', '-f', 'rawvideo', '-pix_fmt', 'rgb24', join(workRoot, 'source-frame.rgb')]);
    const original = await readFile(join(workRoot, 'source-frame.rgb'));
    const originalAt = (x: number, y: number) => [...original.subarray((y * 320 + x) * 3, (y * 320 + x) * 3 + 3)];
    const distance = (left: number[], right: number[]) => left.reduce((sum, value, index) => sum + Math.abs(value - right[index]!), 0);
    let inside = 0;
    let outside = 0;
    for (const [x, y] of [[200, 20], [240, 60], [280, 30], [300, 80]] as const) inside += distance(frame.at(x, y), originalAt(x, y));
    for (const [x, y] of [[20, 120], [60, 160], [120, 140], [40, 100]] as const) outside += distance(frame.at(x, y), originalAt(x, y));
    expect(inside / 4).toBeGreaterThan(40);
    expect(outside / 4).toBeLessThan(30);

    const studio = await getStudioState(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(studio.generations[0]).toMatchObject({ id: generation.id, status: 'SUCCEEDED', chargedMicros: 450_000 });
    expect(studio.generationBudget).toMatchObject({ configured: true, limitMicros: 1_000_000_000, spentMicros: 450_000, reservedMicros: 0 });
    expect(studio.footage.some((item) => item.footageId === done.footageId)).toBe(true);
  });

  it('失败分支：未扣费 → 释放；结果不明 → 待对账（不重试、预留保持）；圈外被改如实标出；没报告费用按上限；放弃与过期', { timeout: 600_000 }, async () => {
    const f = await fixture();
    await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowGeneratedVideo: true } });
    const quote = { kind: 'VIDEO_REGION', summary: '重绘', prompt: 'snow', clipId: f.clipId, start: '0.5', end: '1.5', region: REGION };
    const runOnce = async (mode: ScriptedGenerationBehavior) => {
      behavior = mode;
      const { generation } = await quoteTurn(f, quote);
      const accepted = await accept(f, generation!.id, generation!.estimateMaxMicros);
      const turnRow = (await handle.db.select().from(agentTurns).where(eq(agentTurns.id, accepted.turnId!)))[0]!;
      const status = await drive(f, turnRow.workflowRunId!);
      const row = (await handle.db.select().from(generationRequests).where(eq(generationRequests.id, generation!.id)))[0]!;
      return { status, row, hold: await holdOf(generation!.id), turn: await getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: accepted.turnId! }) };
    };

    const refused = await runOnce('fail-not-charged');
    expect(refused.status).toBe('FAILED');
    expect(refused.row).toMatchObject({ status: 'FAILED', chargedMicros: 0, error: { reason: GENERATION_ERROR_REASONS.PROVIDER_FAILED } });
    expect(refused.hold).toMatchObject({ status: 'RELEASED' });
    expect(refused.turn).toMatchObject({ status: 'FAILED', proposalId: null });
    expect(refused.turn.reply).toContain('没有扣费，预留已释放');

    const unknown = await runOnce('fail-unknown');
    expect(unknown.row).toMatchObject({ status: 'NEEDS_RECONCILIATION', chargedMicros: null, error: { reason: GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN } });
    expect(unknown.row.providerCalledAt).not.toBeNull();
    expect(unknown.hold).toMatchObject({ status: 'HELD' });
    expect(unknown.turn.reply).toContain('不会自动重试');
    // 生成步骤只尝试了一次
    const steps = await handle.db.execute(`select count(*)::int as n from workflow_steps where run_id = (select workflow_run_id from generation_requests where id = '${unknown.row.id}') and step_key = 'generate'`);
    expect(Number(steps.rows[0]!['n'])).toBe(1);

    const touched = await runOnce('touch-outside');
    expect(touched.row.status).toBe('SUCCEEDED');
    expect(touched.row.outsideRegionChange!).toBeGreaterThan(OUTSIDE_REGION_CHANGE_THRESHOLD);
    expect(touched.turn.reply).toContain('框外的画面也改了');
    const crop = (await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: touched.row.proposalId! })).operations.at(-1);
    expect(crop).toMatchObject({ op: 'set_clip_crop' });

    // 上一个试改仍未采用：这一轮在它上面继续，旧试改被取代
    const omitted = await runOnce('omit-cost');
    expect(omitted.row).toMatchObject({ status: 'SUCCEEDED', costSource: 'QUOTE_MAX', chargedMicros: omitted.row.estimateMaxMicros });
    expect(omitted.turn.reply).toContain('按报价上限计');
    const stacked = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: omitted.row.proposalId! });
    expect(stacked.operations.filter((op) => op.op === 'insert_clip')).toHaveLength(2);

    behavior = 'normal';
    // 只框了画面、没点片段（界面上"框选画面"）：取那一刻画面里的素材片段，范围取指着的那一段
    const framedOnly = await quoteTurn(f, { kind: 'VIDEO_REGION', summary: '框里换成雪景', prompt: 'snow' }, { pointer: { timeRange: { start: '0.5', end: '1.5' }, frameRegion: REGION } });
    expect(framedOnly.generation!.request).toMatchObject({ clipId: f.clipId, start: ft(15), end: ft(45), region: REGION });
    const { generation: toDecline } = await quoteTurn(f, quote);
    expect((await declineGeneration(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, generationId: toDecline!.id })).status).toBe('DECLINED');
    expect((await failure(accept(f, toDecline!.id, toDecline!.estimateMaxMicros))).details['reason']).toBe(GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING);
    const { generation: stale } = await quoteTurn(f, quote);
    await handle.db.update(generationRequests).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(generationRequests.id, stale!.id));
    expect((await failure(accept(f, stale!.id, stale!.estimateMaxMicros))).details['reason']).toBe(GENERATION_ERROR_REASONS.QUOTE_EXPIRED);
    const studio = await getStudioState(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(studio.generations.find((item) => item.id === stale!.id)?.status).toBe('EXPIRED');
  });

  it('数字人：身份档案 + 授权（只增不改）→ 报价检查语言与授权 → 有声画中画；执行前撤回授权 → 失败不扣费', { timeout: 600_000 }, async () => {
    behavior = 'normal';
    const f = await fixture();
    await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowGeneratedVideo: true, allowGeneratedSpeech: true } });
    const identity = await createIdentityProfile(deps(), { workspaceId: f.workspaceId, name: '我自己' });
    const face = await storeAsset({ workspaceId: f.workspaceId, projectId: null, file: join(workRoot, 'face.png'), mimeType: 'image/png', assetType: 'SOURCE_IMAGE', filename: 'face.png' });
    const voice = await storeAsset({ workspaceId: f.workspaceId, projectId: null, file: join(workRoot, 'voice.wav'), mimeType: 'audio/wav', assetType: 'VOICE_AUDIO', filename: 'voice.wav' });
    // 照片当声音样本：拒绝
    expect((await failure(setIdentityReference(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'VOICE', assetId: face.assetId, actorId: null }))).details['reason']).toBe('IDENTITY_REFERENCE_INVALID');
    await setIdentityReference(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'LIKENESS', assetId: face.assetId, actorId: null });
    await setIdentityReference(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'VOICE', assetId: voice.assetId, actorId: null });

    const quote = { kind: 'AVATAR_CLIP', summary: '我出镜说开场白', identityId: identity.id, script: 'Hello, welcome to my street.', language: 'en', at: '0', framing: 'CORNER' };
    const noConsent = await quoteTurn(f, quote, { expectRefusal: true });
    expect(noConsent.result).toMatchObject({ reason: GENERATION_ERROR_REASONS.CONSENT_REQUIRED, missing: ['LIKENESS', 'VOICE'] });
    expect((noConsent.options['identities'] as unknown[])[0]).toMatchObject({ id: identity.id, likeness: 'NO_CONSENT', voice: 'NO_CONSENT' });

    expect((await failure(grantIdentityConsent(deps(), { workspaceId: f.workspaceId, identityId: identity.id, request: { kind: 'LIKENESS', subject: 'SELF', statementVersion: 'v0', locale: 'zh-CN' }, actorId: null }))).details['reason']).toBe('IDENTITY_STATEMENT_OUTDATED');
    for (const kind of ['LIKENESS', 'VOICE'] as const) {
      await grantIdentityConsent(deps(), { workspaceId: f.workspaceId, identityId: identity.id, request: { kind, subject: 'SELF', statementVersion: IDENTITY_CONSENT_STATEMENT_VERSION, locale: 'zh-CN' }, actorId: null });
    }
    // 授权记录只增不改
    const rewrite = await handle.db.update(identityConsentRecords).set({ subject: 'AUTHORIZED_OTHER' }).where(eq(identityConsentRecords.creatorIdentityId, identity.id)).then(() => null, (error: unknown) => error);
    expect(String((rewrite as { cause?: { message?: string } } | null)?.cause?.message)).toContain('append-only');

    const zh = await quoteTurn(f, { ...quote, language: 'zh' }, { expectRefusal: true });
    expect(zh.result).toMatchObject({ reason: GENERATION_ERROR_REASONS.LANGUAGE_UNSUPPORTED, languages: ['en'] });

    const quoted = await quoteTurn(f, quote);
    expect(quoted.generation).toMatchObject({ kind: 'AVATAR_CLIP', providerId: 'scripted-avatar', estimatedSeconds: '2.5' });
    const snapshot = quoted.generation!.identitySnapshot as { likeness: { footageId: string; consentRecordId: string } };
    expect(snapshot.likeness.footageId).toBe(face.footageId);
    const accepted = await accept(f, quoted.generation!.id, quoted.generation!.estimateMaxMicros);
    const turnRow = (await handle.db.select().from(agentTurns).where(eq(agentTurns.id, accepted.turnId!)))[0]!;
    expect(await drive(f, turnRow.workflowRunId!)).toBe('SUCCEEDED');
    const done = (await handle.db.select().from(generationRequests).where(eq(generationRequests.id, quoted.generation!.id)))[0]!;
    expect(done.status).toBe('SUCCEEDED');
    const avatar = (await handle.db.select().from(assets).where(eq(assets.id, done.assetId!)))[0]!;
    expect(avatar.assetType).toBe('AVATAR_CLIP');
    const ops = (await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId: done.proposalId! })).operations;
    expect(ops.map((op) => op.op)).toEqual(['create_track', 'create_track', 'insert_clip', 'set_clip_transform']);
    expect(ops[1]).toMatchObject({ track: { kind: 'AUDIO', name: 'AV1' } });
    expect(ops[2]).toMatchObject({ linkAudio: true });

    // 确认之后、执行之前撤回声音授权：执行时复查 → 失败、不调用供应商、不扣费
    const second = await quoteTurn(f, { ...quote, at: '1', summary: '再说一句' });
    const accepted2 = await accept(f, second.generation!.id, second.generation!.estimateMaxMicros);
    await revokeIdentityConsent(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'VOICE', actorId: null });
    const turnRow2 = (await handle.db.select().from(agentTurns).where(eq(agentTurns.id, accepted2.turnId!)))[0]!;
    expect(await drive(f, turnRow2.workflowRunId!)).toBe('FAILED');
    const revoked = (await handle.db.select().from(generationRequests).where(eq(generationRequests.id, second.generation!.id)))[0]!;
    expect(revoked).toMatchObject({ status: 'FAILED', chargedMicros: 0, providerCalledAt: null, error: { reason: GENERATION_ERROR_REASONS.CONSENT_REQUIRED } });
    expect(await holdOf(second.generation!.id)).toMatchObject({ status: 'RELEASED' });
    const records = await handle.db.select().from(identityConsentRecords).where(eq(identityConsentRecords.creatorIdentityId, identity.id));
    expect(records.map((row) => `${row.kind}:${row.action}`).sort()).toEqual(['LIKENESS:GRANT', 'VOICE:GRANT', 'VOICE:REVOKE']);

    // 换参考照片：之前的授权不再适用于新照片
    await setIdentityReference(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'LIKENESS', assetId: voice.assetId, actorId: null }).catch(() => undefined);
    const face2 = await storeAsset({ workspaceId: f.workspaceId, projectId: null, file: join(workRoot, 'face.png'), mimeType: 'image/png', assetType: 'SOURCE_IMAGE', filename: 'face2.png' });
    const replaced = await setIdentityReference(deps(), { workspaceId: f.workspaceId, identityId: identity.id, kind: 'LIKENESS', assetId: face2.assetId, actorId: null });
    expect(replaced.likeness).toMatchObject({ consent: null, ready: false });

    // 单独删除授权记录：拒绝；删除整个工作区：随之清理（经 workspace_id 级联时身份档案可能还在）
    const removal = await handle.db.delete(identityConsentRecords).where(eq(identityConsentRecords.creatorIdentityId, identity.id)).then(() => null, (error: unknown) => error);
    expect(String((removal as { cause?: { message?: string } } | null)?.cause?.message)).toContain('append-only');
    await handle.db.execute(`delete from workspaces where id = '${f.workspaceId}'`);
    expect(await handle.db.select().from(identityConsentRecords).where(eq(identityConsentRecords.workspaceId, f.workspaceId))).toEqual([]);
  });

  it('进程协议：成功带费用 / 失败未扣费 / 崩溃 = 结果不明；子进程拿不到未声明的环境变量', { timeout: 300_000 }, async () => {
    const example = resolve(findRepoRoot(process.cwd()) ?? process.cwd(), 'scripts/generation-process-example.mjs');
    const offers = [{ kind: 'VIDEO_SHOT' as const, providerId: 'example', implementation: 'REAL' as const, model: 'ffmpeg-example', perSecondMicros: { min: 50_000, max: 400_000 }, maxSeconds: 8, languages: [] }];
    const job = { generationId: 'gen_x', kind: 'VIDEO_SHOT' as const, providerId: 'example', prompt: 'a lake', script: null, language: null, seconds: 1.5, maxSeconds: 1.5, width: 320, height: 180, frameRate: { num: 30, den: 1 }, likeness: null, voice: null, source: null, region: null };
    const run = (args: string[]) => createPaidGenerationExecutor({ provider: createProcessGenerationProvider({ executable: process.execPath, args: [example, ...args], offers }), storage, probe }).execute(job, { beforeProviderCall: async () => undefined });

    const product = await run([]);
    expect(product).toMatchObject({ costMicros: 150_000, model: 'ffmpeg-example', hasAudio: false, outsideRegionChange: null });
    expect(product.durationMs).toBeGreaterThanOrEqual(1_400);
    expect(product.providerJobId).toMatch(/^example-/);
    await expect(run(['--fail'])).rejects.toMatchObject({ outcome: 'NOT_CHARGED', message: 'the example provider refused this request' });
    await expect(run(['--crash'])).rejects.toMatchObject({ outcome: 'UNKNOWN' });

    // 环境白名单：只传声明的变量
    const probeScript = join(workRoot, 'env-probe.mjs');
    await writeFile(probeScript, "process.stdout.write(JSON.stringify({ error: [process.env.ANCS_IT_DECLARED ?? '-', process.env.ANCS_IT_SECRET ?? '-'].join(','), costMicros: 0 }) + '\\n'); process.exit(2);\n");
    process.env['ANCS_IT_DECLARED'] = 'declared';
    process.env['ANCS_IT_SECRET'] = 'leaked'; // secrets:check-ignore: test-only dummy
    const provider = createProcessGenerationProvider({ executable: process.execPath, args: [probeScript], offers, passEnv: ['ANCS_IT_DECLARED'] });
    await expect(provider.generate({ kind: 'VIDEO_SHOT', providerId: 'example', prompt: 'x', script: null, language: null, seconds: 1, maxSeconds: 1, width: 64, height: 64, fps: 30, outputPath: join(workRoot, 'x.mp4'), likenessPath: null, voicePath: null, sourcePath: null, region: null }))
      .rejects.toMatchObject({ message: 'declared,-' });
    delete process.env['ANCS_IT_DECLARED'];
    delete process.env['ANCS_IT_SECRET'];
  });
});
