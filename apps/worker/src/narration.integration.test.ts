import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import type { AgentContentBlock, AgentEffectPorts, AgentModelAdapter, AgentModelRequest, AgentModelResponse, AgentNarrationPorts } from '@ancs/contracts';
import { assets, assetVersions, compositionCaptionSpans, createDb, jobs, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  adoptProposal,
  advanceWorkflow,
  agentTurnWorkflow,
  compositionFinalRenderWorkflow,
  createStudioProject,
  getAgentTurn,
  getSequencePreview,
  getStudioState,
  getWorkflowRun,
  listProjectComposition,
  loadProposalForRead,
  requestSequencePreview,
  startAgentTurn,
  startCompositionFinalRender,
  updateProjectProductionPolicy,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createProcessEffectRenderer } from './effect-renderer-process.js';
import { createFliteNarrationSynthesizer, createProcessNarrationSynthesizer } from './narration-synthesizer-process.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { findRepoRoot } from './render-executor-process.js';
import { createPreviewRenderHandler } from './preview-render-handler.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';

/**
 * V6-5 文章 → 讲述 + 图解（真实 PostgreSQL + 本地对象存储 + 真实 flite 语音合成 + 真实特效渲染子进程 + 真实 FFmpeg；AI 为脚本模型）：
 * 1. 从文章新建：图文工程（允许讲述、图解、字幕，不允许生成画面）；文章按段进入 AI 上下文；
 *    讲述逐句合成 → 讲述轨 VO1 上首尾相接的两段、每句一条字幕（绑定讲述片段）；数据图解里编造的数字被拒绝，
 *    出自文章的数字通过；自检把整画面图解卡当作画面；采用后终渲染：有声音、卡片画面在成片里。
 * 2. 规则与能力：素材工程默认不允许合成语音；开启后中文讲述被只会英文的声音如实拒绝；
 *    没有文章时数据图解被拒绝；未配置引擎时明确报不可用；移除讲述连同它的字幕一起移除。
 */

let handle: DbHandle;
let storage: LocalObjectStorage;
let workRoot: string;
const deps = (): DomainDeps => ({ db: handle.db, storage });
const PROFILE = { width: 320, height: 180, videoCrf: 18, audioBitrateKbps: 128, captionDelivery: 'SIDECAR' as const };
const probe = createFfmpegSourceMediaProbe({ timeoutMs: 60_000 });
const effects: AgentEffectPorts = { renderer: createProcessEffectRenderer({ probe }), codegen: 'disabled' };
const narration: AgentNarrationPorts = { synthesizer: createFliteNarrationSynthesizer({ probe }) };
const ARTICLE = {
  title: 'Fresh water',
  text: [
    'Water covers about 71 percent of the surface of the Earth.',
    'Only 2.5 percent of all water is fresh water, and most of it is frozen in glaciers.',
    'In 2023 the city planted 1,200 trees to protect its river.',
  ].join('\n'),
};

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-narration-it-'));
  storage = new LocalObjectStorage({ rootDir: join(workRoot, 'storage'), publicBaseUrl: 'http://127.0.0.1:1', signingSecret: `narration-it-${randomUUID()}` }); // secrets:check-ignore: test-only dummy
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
const lastResult = (request: AgentModelRequest) => request.messages[request.messages.length - 1]!.content
  .filter((block): block is Extract<AgentContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')[0]!;
const ok = <T,>(request: AgentModelRequest): T => {
  const result = lastResult(request);
  expect(result.isError, result.content).toBe(false);
  return JSON.parse(result.content) as T;
};
const refused = (request: AgentModelRequest): { reason: string; error: string; missing?: string[] } => {
  const result = lastResult(request);
  expect(result.isError, result.content).toBe(true);
  return JSON.parse(result.content) as { reason: string; error: string; missing?: string[] };
};

async function workspace(): Promise<string> {
  const id = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${id}', 'narration', now(), now())`);
  return id;
}

async function runTurn(ref: { workspaceId: string; sessionId: string }, model: AgentModelAdapter, message: string, ports: { effects?: AgentEffectPorts; narration?: AgentNarrationPorts } = { effects, narration }) {
  const turn = await startAgentTurn(deps(), { workspaceId: ref.workspaceId, sessionId: ref.sessionId, request: { message }, idempotencyKey: `turn-${randomUUID()}` });
  const registry = new WorkflowRegistry().register(agentTurnWorkflow({ model, ...ports }));
  for (let index = 0; index < 10; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, turn.workflowRunId!)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) break;
    await advanceWorkflow(deps(), registry, { workspaceId: ref.workspaceId, runId: row.id, jobId: row.activeJobId! });
  }
  return getAgentTurn(deps(), { workspaceId: ref.workspaceId, turnId: turn.id });
}

type Placed = { clipId: string; at: [string, string]; sentences: { text: string; at: [string, string] }[]; captions: number | string };

describe('V6-5 文章 → 讲述 + 图解（真实 flite + 渲染 + FFmpeg，脚本导演）', () => {
  it('从文章新建 → 讲述两段首尾相接、逐句字幕 → 编造数字被拒、文章数字通过 → 自检 → 采用后终渲染有声音有卡片', { timeout: 900_000 }, async () => {
    const workspaceId = await workspace();
    const ref = await createStudioProject(deps(), { workspaceId, request: { title: 'Fresh water', locale: 'en', article: ARTICLE, narration: true } });
    const ids = { workspaceId, sessionId: ref.sessionId };
    const before = await getStudioState(deps(), { workspaceId, projectId: ref.projectId });
    expect(before.project).toMatchObject({ allowNarration: true, allowEffects: true, article: { title: 'Fresh water', paragraphs: 3, characters: ARTICLE.text.length } });
    expect(before.footage).toEqual([]);

    let first!: Placed;
    let second!: Placed;
    const turn = await runTurn(ids, new ScriptedModel([
      (request) => {
        const context = (request.messages[0]!.content[0] as { text: string }).text;
        expect(context).toContain('<article>');
        expect(context).toContain('"n":2,"text":"Only 2.5 percent of all water is fresh water');
        expect(request.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_voices', 'add_narration', 'remove_narration', 'read_article']));
        return call('v1', 'list_voices', {});
      },
      (request) => {
        const listed = ok<{ available: boolean; allowedByProjectRules: boolean; engine: string; voices: { id: string; languages: string[] }[] }>(request);
        expect(listed).toMatchObject({ available: true, allowedByProjectRules: true, engine: 'flite' });
        expect(listed.voices.map((voice) => voice.id)).toContain('flite-slt');
        return call('n1', 'add_narration', { text: 'Water covers about 71 percent of the Earth. Only 2.5 percent of it is fresh water.', voice: 'flite-slt' });
      },
      (request) => {
        first = ok<Placed>(request);
        expect(first.at[0]).toBe('0.000');
        expect(first.sentences).toHaveLength(2);
        expect(first.captions).toBe(2);
        expect(Number(first.sentences[1]!.at[0])).toBeGreaterThan(Number(first.sentences[0]!.at[1]));
        return call('n2', 'add_narration', { text: 'In 2023 the city planted 1,200 trees to protect its river.' });
      },
      (request) => {
        second = ok<Placed>(request);
        // 不给 at：接在已有讲述后面
        expect(second.at[0]).toBe(first.at[1]);
        return call('c0', 'add_effect', { template: 'bar-chart', at: '0', seconds: first.at[1], params: { title: 'Water on Earth', items: 'Fresh: 2.5|Salt: 97.5', unit: '%' } });
      },
      (request) => {
        const rejected = refused(request);
        expect(rejected).toMatchObject({ reason: 'EFFECT_NUMBERS_NOT_IN_SOURCE', missing: ['97.5'] });
        return call('c1', 'add_effect', { template: 'title-card', at: '0', seconds: first.at[1], params: { title: 'Fresh water', subtitle: 'Only 2.5 percent of all water' } });
      },
      (request) => {
        ok(request);
        const length = (Number(second.at[1]) - Number(second.at[0])).toFixed(3);
        return call('c2', 'add_effect', { template: 'big-number', at: second.at[0], seconds: length, params: { value: '1,200', label: 'trees planted in 2023' } });
      },
      (request) => {
        ok(request);
        return call('r1', 'review_draft', {});
      },
      (request) => {
        const review = ok<{ findings: { kind: string; severity: string }[] }>(request);
        expect(review.findings.filter((finding) => finding.kind === 'PICTURE_GAP' || finding.kind === 'EMPTY_TIMELINE')).toEqual([]);
        return call('t1', 'get_timeline', {});
      },
      (request) => {
        const view = ok<{ tracks: { name: string; kind: string }[]; clips: { id: string; narration?: string; effect?: string }[]; captions: { text: string }[] }>(request);
        expect(view.tracks.map((track) => track.name)).toEqual(expect.arrayContaining(['V1', 'A1', 'VO1', 'C1', 'FX1']));
        expect(view.clips.find((clip) => clip.id === first.clipId)).toMatchObject({ narration: expect.stringContaining('Water covers about 71 percent') });
        expect(view.clips.filter((clip) => clip.effect !== undefined).map((clip) => clip.effect).sort()).toEqual(['Big number', 'Title card']);
        expect(view.captions.map((caption) => caption.text)).toEqual([
          'Water covers about 71 percent of the Earth.', 'Only 2.5 percent of it is fresh water.', 'In 2023 the city planted 1,200 trees to protect its river.',
        ]);
        return reply([{ type: 'text', text: 'First cut: narration with a title card and a key number.' }], 'end_turn');
      },
    ]), 'Make a short explainer from my article.');
    expect(turn, JSON.stringify(turn.error)).toMatchObject({ status: 'COMPLETED' });
    expect(turn.proposalId).not.toBeNull();

    // 讲述音频资产：GENERATED、可解码、带每句位置；不在素材里
    const voiced = await handle.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
      .where(and(eq(assets.projectId, ref.projectId), eq(assets.assetType, 'VOICE_AUDIO')));
    expect(voiced).toHaveLength(2);
    for (const row of voiced) {
      expect(row.asset).toMatchObject({ origin: 'GENERATED', status: 'READY', provider: 'flite' });
      expect(row.version).toMatchObject({ mimeType: 'audio/wav', status: 'READY', probeStatus: 'READY' });
      expect(row.version.mediaProbe).toMatchObject({ status: 'READY', streams: [expect.objectContaining({ type: 'AUDIO' })] });
      expect((row.asset.metadata as { narration: { kind: string; engine: string } }).narration).toMatchObject({ kind: 'NARRATION', engine: 'flite', voice: 'flite-slt' });
    }
    const studio = await getStudioState(deps(), { workspaceId, projectId: ref.projectId });
    expect(studio.footage).toEqual([]);
    expect(studio.narration.map((item) => item.text).sort()).toEqual(['In 2023 the city planted 1,200 trees to protect its river.', 'Water covers about 71 percent of the Earth. Only 2.5 percent of it is fresh water.']);
    expect(studio.effects.map((item) => item.templateId).sort()).toEqual(['big-number', 'title-card']);

    // 采用 → 字幕绑定讲述片段 → 终渲染
    const proposal = await loadProposalForRead(deps(), { workspaceId, projectId: ref.projectId, proposalId: turn.proposalId! });
    await adoptProposal(deps(), { workspaceId, projectId: ref.projectId, proposalId: turn.proposalId!, expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `adopt-${randomUUID()}` });
    const committed = await listProjectComposition(deps(), { workspaceId, projectId: ref.projectId });
    expect(committed.clips.filter((clip) => clip.id === first.clipId || clip.id === second.clipId)).toHaveLength(2);
    const captions = await handle.db.select().from(compositionCaptionSpans).where(eq(compositionCaptionSpans.projectId, ref.projectId));
    expect(captions.filter((caption) => caption.speechAnchorId === first.clipId)).toHaveLength(2);
    expect(captions.filter((caption) => caption.speechAnchorId === second.clipId)).toHaveLength(1);

    // 预览（分段渲染、分段缓存）：讲述音频 + 图解卡也能出预览
    const preview = await requestSequencePreview(deps(), { workspaceId, projectId: ref.projectId, sequenceId: ref.sequenceId, request: {} });
    const previewJob = (await handle.db.select().from(jobs).where(eq(jobs.input, { previewId: preview.id })))[0];
    await createPreviewRenderHandler({ executor: createFfmpegRenderPlanExecutor({ timeoutMs: 180_000 }) })
      .handle(deps(), { previewId: preview.id }, { jobId: previewJob?.id ?? 'job_x', workspaceId, heartbeat: async () => undefined });
    const previewDone = await getSequencePreview(deps(), { workspaceId, previewId: preview.id });
    expect(previewDone.status, JSON.stringify(previewDone.error)).toBe('READY');

    const handler = createWorkflowAdvanceHandler({ registry: new WorkflowRegistry().register(compositionFinalRenderWorkflow({ executor: createFfmpegRenderPlanExecutor({ timeoutMs: 180_000 }), outputProbe: probe })) });
    const run = await startCompositionFinalRender(deps(), { workspaceId, projectId: ref.projectId, sequenceId: ref.sequenceId, request: { profile: PROFILE } });
    for (let round = 0; round < 6; round += 1) {
      const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id)))[0]!;
      if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_HUMAN'].includes(row.status)) break;
      await handler.handle(deps(), { runId: run.id }, { jobId: row.activeJobId!, workspaceId, heartbeat: async () => undefined });
    }
    const finished = await getWorkflowRun(deps(), { workspaceId, runId: run.id });
    expect(finished.status, JSON.stringify(finished)).toBe('SUCCEEDED');
    const video = (finished.outputs['render'] as { outputs: { kind: string; assetVersionId: string }[] }).outputs.find((output) => output.kind === 'VIDEO')!;
    const row = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, video.assetVersionId)))[0]!;
    const file = join(workRoot, `${run.id}.mp4`);
    await writeFile(file, (await storage.getObject(row.storageKey))!);
    // 成片有讲述声音（volumedetect 把统计写在 stderr）
    const volumeReport = spawnSync('ffmpeg', ['-nostdin', '-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr;
    const volume = Number(/mean_volume: (-?[\d.]+) dB/.exec(volumeReport)?.[1] ?? 'NaN');
    expect(volume).toBeGreaterThan(-35);
    const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
    expect(Math.abs(duration - Number(second.at[1]))).toBeLessThan(0.2);
    // 1 秒处是标题卡：右下角是卡片底色 #0f1720（终渲染画面来自图解卡，不是黑场；左上角留给 AI 生成标识）
    const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', '1', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const pixel = (x: number, y: number): number[] => [...raw.subarray((y * PROFILE.width + x) * 3, (y * PROFILE.width + x) * 3 + 3)];
    const corner = pixel(PROFILE.width - 6, PROFILE.height - 6);
    expect(Math.abs(corner[0]! - 0x0f) + Math.abs(corner[1]! - 0x17) + Math.abs(corner[2]! - 0x20)).toBeLessThan(24);
    // 讲述是合成语音（GENERATED）：成片带 AI 生成标识——开头左上角有白色文字，文件元数据有 AIGC 字段（附录 E 键序）
    let brightInBadge = 0;
    for (let y = 5; y < 30; y += 1) for (let x = 5; x < 60; x += 1) if (Math.min(...pixel(x, y)) > 200) brightInBadge += 1;
    expect(brightInBadge).toBeGreaterThan(5);
    const tags = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file]).toString()) as { format: { tags: Record<string, string> } };
    expect(Object.keys(JSON.parse(tags.format.tags['AIGC']!) as Record<string, string>)).toEqual(['Label', 'ContentProducer', 'ProduceID', 'ReservedCode1', 'ContentPropagator', 'PropagateID', 'ReservedCode2']);
    expect(JSON.parse(tags.format.tags['AIGC']!)).toMatchObject({ Label: '1', ProduceID: run.id, PropagateID: run.id });
    // 未指定标识语言 → 英文（面向全球市场）；界面按当前语言传 labelLanguage
    expect((finished.outputs['render'] as { contentLabel: { explicitText: string } | null }).contentLabel?.explicitText).toBe('AI-generated');
    expect((finished.outputs['qa'] as { checks: { name: string; passed: boolean }[] }).checks.find((check) => check.name === 'aigc.metadata')?.passed).toBe(true);
  });

  it('进程驱动（部署方接入任意供应商）：按协议逐句调用参考实现，拼成一条音频，句界精确、可解码', { timeout: 120_000 }, async () => {
    const synthesizer = createProcessNarrationSynthesizer({
      executable: process.execPath,
      args: [join(findRepoRoot(process.cwd()) ?? process.cwd(), 'scripts/narration-process-example.mjs')],
      voices: [{ id: 'slt', name: 'SLT', languages: ['en'], description: 'flite example' }],
      probe,
    });
    expect(synthesizer).toMatchObject({ implementation: 'REAL', engine: 'process:node' });
    const output = await synthesizer.synthesize({ sentences: ['First sentence here.', 'And a second one.'], voice: 'slt', speed: 1 });
    expect(output.probe).toMatchObject({ status: 'READY', streams: [expect.objectContaining({ type: 'AUDIO' })] });
    expect(output.sentences).toHaveLength(2);
    expect(output.sentences[0]!.startMs).toBe(0);
    expect(output.sentences[1]!.startMs - output.sentences[0]!.endMs).toBeCloseTo(250, 0);
    expect(output.durationMs).toBeCloseTo(output.sentences[1]!.endMs, 0);
    await expect(synthesizer.synthesize({ sentences: ['x'], voice: 'nobody', speed: 1 })).rejects.toThrow(/unknown voice/);
  });

  it('规则与能力：素材工程默认不允许合成语音；中文讲述被英文声音拒绝；没有文章时数据图解被拒；未配置引擎；移除讲述连同字幕', { timeout: 600_000 }, async () => {
    const workspaceId = await workspace();
    const ref = await createStudioProject(deps(), { workspaceId, request: { title: '素材作品', locale: 'zh-CN' } });
    const ids = { workspaceId, sessionId: ref.sessionId };
    expect((await getStudioState(deps(), { workspaceId, projectId: ref.projectId })).project).toMatchObject({ allowNarration: false, article: null });

    const blocked = await runTurn(ids, new ScriptedModel([
      () => call('v1', 'list_voices', {}),
      (request) => {
        expect(ok<{ allowedByProjectRules: boolean }>(request).allowedByProjectRules).toBe(false);
        return call('n1', 'add_narration', { text: 'Hello there.' });
      },
      (request) => {
        expect(refused(request).reason).toBe('PRODUCTION_POLICY_BLOCKED');
        return reply([{ type: 'text', text: '这个作品的规则不允许合成配音。' }], 'end_turn');
      },
    ]), '加个配音');
    expect(blocked).toMatchObject({ status: 'COMPLETED', proposalId: null });
    expect(await handle.db.select().from(assets).where(and(eq(assets.projectId, ref.projectId), eq(assets.assetType, 'VOICE_AUDIO')))).toHaveLength(0);

    await updateProjectProductionPolicy(deps(), { workspaceId, projectId: ref.projectId, actorId: null, changes: { allowGeneratedSpeech: true, allowProceduralGraphics: true, allowCaptions: true } });
    let clipId = '';
    const languages = await runTurn(ids, new ScriptedModel([
      () => call('n1', 'add_narration', { text: '地球表面约百分之七十一是水。' }),
      (request) => {
        expect(refused(request)).toMatchObject({ reason: 'NARRATION_LANGUAGE_UNSUPPORTED' });
        return call('c1', 'add_effect', { template: 'big-number', params: { value: '71%', label: 'water' } });
      },
      (request) => {
        expect(refused(request)).toMatchObject({ reason: 'EFFECT_NUMBERS_NOT_IN_SOURCE', error: expect.stringContaining('no article') });
        return call('n2', 'add_narration', { text: 'Water covers most of the planet. It is mostly salt water.' });
      },
      (request) => {
        clipId = ok<Placed>(request).clipId;
        return call('d1', 'remove_narration', { clipId });
      },
      (request) => {
        expect(ok<{ removed: string; captionsRemoved: number }>(request)).toEqual({ removed: clipId, captionsRemoved: 2 });
        return call('t1', 'get_timeline', {});
      },
      (request) => {
        const view = ok<{ clips: unknown[]; captions: unknown[] }>(request);
        expect(view.clips).toEqual([]);
        expect(view.captions).toEqual([]);
        return reply([{ type: 'text', text: '中文需要配置中文声音。' }], 'end_turn');
      },
    ]), '用中文讲一遍');
    expect(languages, JSON.stringify(languages.error)).toMatchObject({ status: 'COMPLETED' });

    const unconfigured = await runTurn(ids, new ScriptedModel([
      () => call('v1', 'list_voices', {}),
      (request) => {
        expect(ok<{ available: boolean }>(request).available).toBe(false);
        return call('n1', 'add_narration', { text: 'Hello.' });
      },
      (request) => {
        expect(refused(request).reason).toBe('NARRATION_UNAVAILABLE');
        return reply([{ type: 'text', text: '这个部署没有配置配音。' }], 'end_turn');
      },
    ]), '加个配音', { effects });
    // 上一轮的试改还没采用：这一轮在它上面继续（continuesTrial），工具的拒绝已在脚本里逐条断言
    expect(unconfigured).toMatchObject({ status: 'COMPLETED' });
    expect(await handle.db.select().from(assets).where(and(eq(assets.projectId, ref.projectId), eq(assets.assetType, 'VOICE_AUDIO')))).toHaveLength(1);
  });
});
