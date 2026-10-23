import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  mediaTimeSchema,
  type AgentContentBlock,
  type AgentEffectPorts,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
  type MediaRange,
} from '@ancs/contracts';
import { assets, assetVersions, createDb, outboxEvents, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  adoptProposal,
  advanceWorkflow,
  agentTurnWorkflow,
  compositionFinalRenderWorkflow,
  createAgentSession,
  createChannel,
  createProject,
  createSequence,
  createTrack,
  getAgentTurn,
  getStudioState,
  getWorkflowRun,
  listProjectComposition,
  loadProposalForRead,
  processEdits,
  startAgentTurn,
  startCompositionFinalRender,
  updateProjectProductionPolicy,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createProcessEffectRenderer } from './effect-renderer-process.js';
import { createProcessMotionValidator } from './motion-validator-process.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';

/**
 * V6-3 代码生成特效端到端（真实 PostgreSQL + 本地对象存储 + 真实特效渲染子进程（无头浏览器）+ 真实 FFmpeg；AI 为脚本模型）：
 * 1. 素材工程默认不允许程序化特效：add_effect 如实回给 AI "项目规则不允许"，不渲染、不落资产；
 * 2. 用户显式开启（写工作区事件）→ AI 用模板在框出的区域、所指时间加特效 → 透明图层资产（PNG/rgba，经真实探测）
 *    + 草稿：新建 FX 轨、放片段、区域变换；工作台状态把图层列为特效（不在素材里）；
 * 3. 改参数（update_effect）只用同一段代码重渲：新图层替换旧片段、起点不变；
 * 4. 采用后终渲染：区域里的像素被特效改变，区域外保持素材原样（透明通道生效）。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let workRoot: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });
/** 与共看片室同一序列时基：30 fps 帧网格 */
const ft = (frames: number) => mediaTimeSchema.parse({ ticks: String(frames), timebase: { num: 1, den: 30 } });
const range = (startFrame: number, endFrame: number): MediaRange => ({ start: ft(startFrame), end: ft(endFrame) });
const PROFILE = { width: 320, height: 180, videoCrf: 18, audioBitrateKbps: 128, captionDelivery: 'SIDECAR' as const };
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });
const effects: AgentEffectPorts = { renderer: createProcessEffectRenderer({ probe }), validator: createProcessMotionValidator(), codegen: 'enabled' };
const REGION = { x: 0.5, y: 0.25, width: 0.4, height: 0.5 };

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-effects-it-'));
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `effects-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
  // 深灰底素材：特效的亮像素与素材本身一眼可分
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x202020:s=320x180:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workRoot, 'source.mp4')]);
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
const toolResults = (request: AgentModelRequest) => request.messages[request.messages.length - 1]!.content
  .filter((block): block is Extract<AgentContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'effects', now(), now())`);
  const channel = await createChannel(deps(), { workspaceId, input: { name: '特效', language: 'zh' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '特效', channelId: channel.id, mode: 'FOOTAGE_EDIT', aspectRatio: '16:9', brief: {} } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: 'Main', frameRate: { num: 30, den: 1 }, duration: ft(90) } });
  const scope = { workspaceId, projectId: project.id, sequenceId: sequence.id };
  const v1 = await createTrack(deps(), { ...scope, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const bytes = await readFile(join(workRoot, 'source.mp4'));
  const media = await probe.probe({ filePath: join(workRoot, 'source.mp4'), declaredMimeType: 'video/mp4' });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  const storageKey = `it/${footageId}.mp4`;
  await storage.putObject(storageKey, bytes);
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: project.id, assetType: 'USER_UPLOAD', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'gray.mp4' } });
  await handle.db.insert(assetVersions).values({
    id: footageId, assetId, workspaceId, versionNumber: 1, storageKey, mimeType: 'video/mp4', sizeBytes: bytes.byteLength,
    checksumSha256: createHash('sha256').update(bytes).digest('hex'), durationMs: 4_000, width: 320, height: 180, status: 'READY', mediaProbe: media,
  });
  const revision = async () => Number((await handle.db.execute(`select revision from projects where id = '${project.id}'`)).rows[0]!['revision']);
  await processEdits(deps(), {
    workspaceId, projectId: project.id, actor: { type: 'USER', id: null },
    request: {
      baseProjectRevision: await revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`,
      operations: [{ op: 'insert_clip', sequenceId: sequence.id, trackId: v1.id, assetVersionId: footageId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(0, 90), mode: 'OVERWRITE', sequenceStart: ft(0), linkAudio: false, audioTrackId: null }],
    },
  });
  const session = await createAgentSession(deps(), { workspaceId, projectId: project.id, request: { sequenceId: sequence.id, locale: 'zh-CN' } });
  return { ...scope, footageId, session, revision };
}

async function runTurn(f: Awaited<ReturnType<typeof fixture>>, model: AgentModelAdapter, message: string, pointer?: Record<string, unknown>, ports = effects) {
  const turn = await startAgentTurn(deps(), { workspaceId: f.workspaceId, sessionId: f.session.id, request: { message, ...(pointer === undefined ? {} : { pointer }) }, idempotencyKey: `turn-${randomUUID()}` });
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model, effects: ports }));
  for (let index = 0; index < 10; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, turn.workflowRunId!)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) break;
    await advanceWorkflow(deps(), registry, { workspaceId: f.workspaceId, runId: row.id, jobId: row.activeJobId! });
  }
  return getAgentTurn(deps(), { workspaceId: f.workspaceId, turnId: turn.id });
}

async function adopt(f: Awaited<ReturnType<typeof fixture>>, proposalId: string) {
  const proposal = await loadProposalForRead(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId });
  await adoptProposal(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, proposalId, expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}` });
}

/** 终渲染并取 t 秒那一帧的 RGB 像素 */
async function renderFrame(f: Awaited<ReturnType<typeof fixture>>, atSeconds: number): Promise<{ at: (x: number, y: number) => number[] }> {
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

describe('V6-3 代码生成特效（真实渲染子进程 + FFmpeg，脚本导演）', () => {
  it('规则拦截 → 显式开启 → 框选区域加特效 → 改参数重渲 → 采用后终渲染只改区域内像素', { timeout: 600_000 }, async () => {
    const f = await fixture();

    // 1) 素材工程默认不允许：工具如实拒绝，不渲染
    const blocked = await runTurn(f, new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'b1', name: 'add_effect', input: { template: 'glow' } }], 'tool_use'),
      (request) => {
        const [result] = toolResults(request);
        expect(result).toMatchObject({ isError: true });
        expect(JSON.parse(result!.content)).toMatchObject({ reason: 'PRODUCTION_POLICY_BLOCKED' });
        return reply([{ type: 'text', text: '这个作品的规则不允许加特效，打开"特效"开关后再说一次。' }], 'end_turn');
      },
    ]), '这里加个光效');
    expect(blocked).toMatchObject({ status: 'COMPLETED', proposalId: null });
    expect(await handle.db.select().from(assets).where(and(eq(assets.projectId, f.projectId), eq(assets.assetType, 'CUSTOM_MOTION_RENDER')))).toHaveLength(0);

    // 2) 用户显式开启（写工作区事件）
    const policy = await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowProceduralGraphics: true } });
    expect(policy).toMatchObject({ mode: 'FOOTAGE_EDIT', allowProceduralGraphics: true, allowGeneratedVideo: false });
    const events = await handle.db.select().from(outboxEvents).where(and(eq(outboxEvents.workspaceId, f.workspaceId), eq(outboxEvents.type, 'project.production_policy.updated')));
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ projectId: f.projectId, changes: { allowProceduralGraphics: { from: false, to: true } }, actorType: 'USER' })]);

    let clipId = '';
    const added = await runTurn(f, new ScriptedModel([
      (request) => {
        const context = (request.messages[0]!.content[0] as { text: string }).text;
        expect(context).toContain('"frameRegion":{"x":0.5,"y":0.25,"width":0.4,"height":0.5}');
        return reply([{ type: 'tool_use', id: 'l1', name: 'list_effects', input: {} }], 'tool_use');
      },
      (request) => {
        const listed = JSON.parse(toolResults(request)[0]!.content) as { allowedByProjectRules: boolean; codeWriting: string; templates: { id: string }[]; onTimeline: unknown[] };
        expect(listed).toMatchObject({ allowedByProjectRules: true, codeWriting: 'enabled', onTimeline: [] });
        expect(listed.templates.map((template) => template.id)).toEqual(expect.arrayContaining(['burst', 'glow', 'sparkles', 'shockwave', 'light-leak', 'confetti']));
        // 不给 region / at：取框出的区域与所指时间的起点
        return reply([{ type: 'tool_use', id: 'a1', name: 'add_effect', input: { template: 'glow', params: { color: '#ffffff', intensity: 1, pulses: 0 }, seconds: '1.5' } }], 'tool_use');
      },
      (request) => {
        const result = toolResults(request)[0]!;
        expect(result.isError).toBe(false);
        const body = JSON.parse(result.content) as { clipId: string; effect: { region: unknown; at: string[]; template: string } };
        expect(body.effect).toMatchObject({ template: 'glow', region: REGION, at: ['0.500', '2.000'] });
        clipId = body.clipId;
        expect(result.images?.[0]?.mediaType).toBe('image/png'); // 预览帧给 AI 看
        return reply([{ type: 'tool_use', id: 't1', name: 'get_timeline', input: {} }], 'tool_use');
      },
      (request) => {
        const view = JSON.parse(toolResults(request)[0]!.content) as { tracks: { name: string; position: number }[]; clips: { id: string; effect?: string }[] };
        expect(view.tracks.map((track) => track.name)).toEqual(['V1', 'FX1']);
        expect(view.clips.find((clip) => clip.id === clipId)).toMatchObject({ effect: 'Glow' });
        return reply([{ type: 'text', text: '在框出的位置加了一个光晕。' }], 'end_turn');
      },
    ]), '这里加个光效', { timeRange: { start: '0.5', end: '2' }, clipIds: [], frameRegion: REGION });
    expect(added, JSON.stringify(added.error)).toMatchObject({ status: 'COMPLETED' });
    expect(added.proposalId).not.toBeNull();

    const layers = await handle.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
      .where(and(eq(assets.projectId, f.projectId), eq(assets.assetType, 'CUSTOM_MOTION_RENDER')));
    expect(layers).toHaveLength(1);
    const layer = layers[0]!;
    expect(layer.asset).toMatchObject({ origin: 'GENERATED', status: 'READY', retentionClass: 'KEEP_FINAL' });
    expect(layer.version).toMatchObject({ mimeType: 'video/quicktime', width: 768, height: 540, durationMs: 1500, status: 'READY' });
    expect(layer.version.mediaProbe).toMatchObject({ status: 'READY', streams: [expect.objectContaining({ type: 'VIDEO', codecName: 'png', pixelFormat: 'rgba' })] });
    expect((layer.asset.metadata as { effect: unknown }).effect).toMatchObject({ kind: 'EFFECT_LAYER', source: 'TEMPLATE', templateId: 'glow', region: REGION, render: { width: 768, height: 540, fps: 30, durationInFrames: 45 } });

    // 工作台：特效单独列出，不在素材里
    const studio = await getStudioState(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(studio.project.allowEffects).toBe(true);
    expect(studio.footage.map((item) => item.name)).toEqual(['gray.mp4']);
    expect(studio.effects).toEqual([{ footageId: layer.version.id, name: 'Glow', templateId: 'glow', source: 'TEMPLATE', params: { color: '#ffffff', intensity: 1, pulses: 0 } }]);

    await adopt(f, added.proposalId!);
    const committed = await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    const fx = committed.clips.find((clip) => clip.id === clipId)!;
    expect(fx).toMatchObject({ assetVersionId: layer.version.id, sequenceRange: { start: { ticks: '15' }, end: { ticks: '60' } } });
    expect(fx.parameters).toMatchObject({ transform: { position: { x: 0.5, y: 0.25 }, scale: { x: 0.4, y: 0.5 }, anchor: { x: 0.5, y: 0.5 } } });

    // 3) 改参数：同一段代码重渲，替换旧片段、起点不变
    const updated = await runTurn(f, new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'u1', name: 'update_effect', input: { clipId, params: { color: '#ff0000' } } }], 'tool_use'),
      (request) => {
        const result = toolResults(request)[0]!;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content)).toMatchObject({ effect: { template: 'glow', params: { color: '#ff0000', intensity: 1, pulses: 0 }, at: ['0.500', '2.000'] } });
        return reply([{ type: 'text', text: '改成红色了。' }], 'end_turn');
      },
    ]), '换成红色');
    expect(updated.proposalId).not.toBeNull();
    await adopt(f, updated.proposalId!);
    const after = await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    const effectClips = after.clips.filter((clip) => clip.assetVersionId !== f.footageId);
    expect(effectClips).toHaveLength(1);
    expect(effectClips[0]!.assetVersionId).not.toBe(layer.version.id);
    expect(effectClips[0]!.sequenceRange.start).toMatchObject({ ticks: '15' });

    // 4) 终渲染：区域中心被红色光晕覆盖，区域外保持深灰素材
    const frame = await renderFrame(f, 1.25);
    const inside = frame.at(Math.round((REGION.x + REGION.width / 2) * PROFILE.width), Math.round((REGION.y + REGION.height / 2) * PROFILE.height));
    const outside = frame.at(40, 90);
    expect(inside[0]!).toBeGreaterThan(150);
    expect(inside[0]! - inside[2]!).toBeGreaterThan(60);
    for (const channel of outside) expect(Math.abs(channel - 0x20)).toBeLessThanOrEqual(6);
  });

  it('AI 写特效代码：部署关闭时拒绝；开启后先过四道门禁——联网代码被拒（报告交还 AI）；非法时间作为工具错误交还；合法代码渲染成图层', { timeout: 600_000 }, async () => {
    const f = await fixture();
    await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowProceduralGraphics: true } });
    const good = "registerMotion({ name: 'Ring', component: function Ring(props) { const frame = useCurrentFrame(); const config = useVideoConfig(); const size = interpolate(frame, [0, config.durationInFrames - 1], [0.2, 0.9]) * config.height; return React.createElement(AbsoluteFill, null, React.createElement('div', { style: { position: 'absolute', left: '50%', top: '50%', width: size, height: size, transform: 'translate(-50%, -50%)', borderRadius: '50%', border: '6px solid ' + String(props.color || '#00ff00') } })); } });";
    const bad = "registerMotion({ name: 'Leak', component: function Leak() { fetch('https://example.invalid/x'); return React.createElement(AbsoluteFill, null); } });";

    const disabled = await runTurn(f, new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'c0', name: 'add_effect', input: { code: good, name: 'Ring' } }], 'tool_use'),
      (request) => {
        expect(JSON.parse(toolResults(request)[0]!.content)).toMatchObject({ reason: 'EFFECT_CODEGEN_DISABLED' });
        return reply([{ type: 'text', text: '用模板吧。' }], 'end_turn');
      },
    ]), '画个圆环', undefined, { ...effects, codegen: 'disabled' });
    expect(disabled.proposalId).toBeNull();

    const written = await runTurn(f, new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'c1', name: 'add_effect', input: { code: bad, name: 'Leak' } }], 'tool_use'),
      (request) => {
        const rejected = JSON.parse(toolResults(request)[0]!.content) as { reason: string; failed: { stage: string }[] };
        expect(rejected.reason).toBe('EFFECT_VALIDATION_REJECTED');
        expect(rejected.failed.map((stage) => stage.stage)).toEqual(['STATIC_ANALYSIS']);
        // 非法时间：作为工具错误交还 AI（不让整轮失败）
        return reply([{ type: 'tool_use', id: 'c1b', name: 'add_effect', input: { template: 'glow', at: 'soon' } }], 'tool_use');
      },
      (request) => {
        expect(JSON.parse(toolResults(request)[0]!.content)).toMatchObject({ reason: 'AGENT_EDIT_INVALID' });
        return reply([{ type: 'tool_use', id: 'c2', name: 'add_effect', input: { code: good, name: 'Ring', params: { color: '#00ff00' }, at: '0', seconds: '1' } }], 'tool_use');
      },
      (request) => {
        const result = toolResults(request)[0]!;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content)).toMatchObject({ effect: { name: 'Ring', template: null, region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, at: ['0.000', '1.000'] } });
        return reply([{ type: 'text', text: '画好了。' }], 'end_turn');
      },
    ]), '画个圆环');
    expect(written.proposalId).not.toBeNull();
    const layers = await handle.db.select().from(assets).where(and(eq(assets.projectId, f.projectId), eq(assets.assetType, 'CUSTOM_MOTION_RENDER')));
    expect(layers).toHaveLength(1);
    expect((layers[0]!.metadata as { effect: unknown }).effect).toMatchObject({
      source: 'CODE', templateId: null, name: 'Ring', params: { color: '#00ff00' },
      validation: { verdict: 'APPROVED', stages: ['STATIC_ANALYSIS', 'TYPE_CHECK', 'SANDBOX_EVALUATION', 'FRAME_SAMPLES'] },
    });
  });

  it('只指着时间带上的一段说"这里加个冲击波"（没有时间段、没给 at）：特效放在那一段的起点，不是 0 秒', { timeout: 300_000 }, async () => {
    const f = await fixture();
    await updateProjectProductionPolicy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: null, changes: { allowProceduralGraphics: true } });
    const before = await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    // 第二段素材盖在 2 秒处（60 帧起），指着它说话
    await processEdits(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, actor: { type: 'USER', id: null },
      request: {
        baseProjectRevision: await f.revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`,
        operations: [{ op: 'insert_clip', sequenceId: f.sequenceId, trackId: before.clips[0]!.trackId, assetVersionId: f.footageId, nestedSequenceId: null, sourceStreamId: null, sourceRange: range(0, 30), mode: 'OVERWRITE', sequenceStart: ft(60), linkAudio: false, audioTrackId: null }],
      },
    });
    const pointed = (await listProjectComposition(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).clips.find((clip) => clip.sequenceRange.start.ticks === '60')!;
    const turn = await runTurn(f, new ScriptedModel([
      () => reply([{ type: 'tool_use', id: 'p1', name: 'add_effect', input: { template: 'shockwave', seconds: '0.5' } }], 'tool_use'),
      (request) => {
        const result = toolResults(request)[0]!;
        expect(result.isError).toBe(false);
        expect(JSON.parse(result.content)).toMatchObject({ effect: { template: 'shockwave', at: ['2.000', '2.500'] } });
        return reply([{ type: 'text', text: '加好了。' }], 'end_turn');
      },
    ]), '这里加个冲击波', { timeRange: null, clipIds: [pointed.id], frameRegion: null });
    expect(turn, JSON.stringify(turn.error)).toMatchObject({ status: 'COMPLETED' });
    expect(turn.proposalId).not.toBeNull();
  });
});
