import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_RUN_ERROR_REASONS,
  AUTONOMY_ERROR_REASONS,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  sourceMediaProbeResultSchema,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
} from '@ancs/contracts';
import { agentTurns, assetVersions, assets, autonomousRuns, createDb, mediaTranscriptRuns, mediaTranscriptVersions, projectOpLog, projects, proposals, resolveTestDatabaseUrl, runMigrations, workflowRuns, workspaces, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  advanceWorkflow,
  autonomousProductionWorkflow,
  cancelAutonomousRun,
  createStudioProject,
  getAutonomousRun,
  getLatestProductionPlan,
  listAutonomousRuns,
  revokeProjectAutonomy,
  signProjectAutonomy,
  startAutonomousRun,
  type DomainDeps,
} from './index.js';

/**
 * V6-9 自主制作闭环（裁决 0020，AP-05；真实 PostgreSQL + 编辑内核 + 工作流引擎；导演为脚本模型，按真实单价计费以验证预算）：
 * - 等素材：处理中 → 等待（不计失败尝试）；就绪后自动开始导演；
 * - 导演：交代进入上下文（需求、目标时长、档位、预算）；写计划、剪、原声字幕、自检、测节奏；付费生成被拒；
 * - 交付：自动审批 → 系统采用（记为 AI 改动）；逐项审批 → 留作试改；自检有警告 → 不采用；运行中授权被撤回 → 不采用；
 * - 预算：总预算是硬上限（模型花费到上限即停，第二次运行因剩余不足被拒）；没有签署 → 不能开始；同一工程只有一个进行中的运行；
 * - 停止：等素材时停止 → 取消，留下记录。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

const ms = { numerator: 1, denominator: 1000 };
function probe(durationMs: number) {
  const video = {
    index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0',
    durationTicks: '122880', durationMs, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 },
    frameCount: '240', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT' as const, sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
  };
  const audio = {
    ...video, index: 1, type: 'AUDIO' as const, codecName: 'aac', codecLongName: 'AAC', profile: 'LC', width: null, height: null, rotationDegrees: null, pixelFormat: null,
    colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null, frameCount: null, sampleRate: 48_000, channels: 2, channelLayout: 'stereo',
  };
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs, bitRate: 92_000, streams: [video, audio],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function fixture(options: { processing?: boolean } = {}) {
  const workspaceId = `ws_${randomUUID()}`;
  const userId = `usr_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V6-9 自主制作' });
  const ref = await createStudioProject(deps(), { workspaceId, request: { title: '冰川口播', aspectRatio: '16:9', locale: 'zh-CN' } });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: ref.projectId, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: options.processing === true ? 'PROCESSING' : 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'talk.mp4' } });
  await handle.db.insert(assetVersions).values({ id: footageId, assetId, workspaceId, versionNumber: 1, storageKey: `v69/${footageId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'f'.repeat(64), durationMs: 8_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probe(8_000) });
  const runId = `mtr_${randomUUID()}`;
  await handle.db.insert(mediaTranscriptRuns).values({ id: runId, workspaceId, sourceAssetVersionId: footageId, sourceChecksumSha256: 'f'.repeat(64), processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION, status: 'READY', currentVersion: 1 });
  await handle.db.insert(mediaTranscriptVersions).values({ id: `mtv_${randomUUID()}`, workspaceId, runId, version: 1, source: 'ASR', provider: 'test-asr', model: 'test', snapshot: {
    language: 'zh-CN', speakers: [], terminology: [],
    words: [[200, 500, '今天'], [520, 800, '我们'], [820, 1400, '去冰川。']].map(([start, end, text], ordinal) => ({ ordinal, text, speakerId: null, confidencePermille: 900, sourceStartPts: String(start), sourceEndPts: String(end), timeBase: ms })),
    segments: [{ id: 'seg_1', ordinal: 0, text: '今天我们去冰川。', speakerId: null, wordStartOrdinal: 0, wordEndOrdinal: 2, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '200', sourceEndPts: '1400', timeBase: ms }],
  } });
  return { workspaceId, userId, projectId: ref.projectId, sessionId: ref.sessionId, footageId, assetId };
}

const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
/** 每次调用按 Opus 5.5 单价计 6 万微美元（$0.06）：输入 1 万 token × $4/M + 输出 1 千 token × $20/M */
const CALL_MICROS = 60_000;
const reply = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason']): AgentModelResponse => ({ model: 'claude-opus-5-5', content, stopReason, usage });
const toolResults = (request: AgentModelRequest) => request.messages.at(-1)!.content.filter((block): block is Extract<AgentContentBlock, { type: 'tool_use' | 'tool_result' }> => block.type === 'tool_result');

class ScriptedModel implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly model = 'claude-opus-5-5';
  readonly requests: AgentModelRequest[] = [];
  constructor(private readonly steps: ((request: AgentModelRequest) => AgentModelResponse)[]) {}
  respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const step = this.steps[this.requests.length];
    this.requests.push(structuredClone(request));
    return step === undefined ? Promise.reject(new Error('no scripted step')) : Promise.resolve(step(request));
  }
}

/** 一位守规矩的导演：计划 → 剪 → 原声字幕 → 试一次付费生成（应被拒）→ 自检与节奏 → 交付说明 */
function directorScript(footageId: string, options: { gap?: boolean } = {}) {
  return [
    (request: AgentModelRequest) => {
      const context = (request.messages[0]!.content[0] as { text: string }).text;
      expect(context).toContain('<autonomous_production>');
      expect(context).toContain('"goal":"剪一条 6 秒的冰川口播，温暖克制"');
      expect(context).toContain('"targetDurationSeconds":6');
      expect(request.tools.map((tool) => tool.name)).toContain('plan_production');
      return reply([{ type: 'tool_use', id: 'p1', name: 'plan_production', input: {
        blueprint: { logline: '冰川口播', structure: '一句话说完', targetDurationSeconds: 6, paceTarget: { cutsPerMinute: 10, wordsPerSecond: null } },
        scenes: [{ id: 'scene_1', title: '全片', goal: '把话说清楚', sources: [{ footageId, from: '0', to: '6' }], intents: [{ id: 'i_hook', type: 'HOOK', targetFeeling: '开门见山', reason: '第一句就是主题' }] }],
      } }], 'tool_use');
    },
    () => reply([{ type: 'tool_use', id: 'e1', name: 'edit_timeline', input: { operations: options.gap === true
      ? [{ op: 'place_clip', footageId, sourceStart: '0', sourceEnd: '2' }, { op: 'place_clip', footageId, sourceStart: '2', sourceEnd: '6', at: '3' }, { op: 'fit_length' }]
      : [{ op: 'place_clip', footageId, sourceStart: '0', sourceEnd: '6' }, { op: 'fit_length' }] } }], 'tool_use'),
    (request: AgentModelRequest) => {
      expect(toolResults(request)[0]).toMatchObject({ isError: false });
      return reply([{ type: 'tool_use', id: 'c1', name: 'caption_speech', input: {} }, { type: 'tool_use', id: 'g1', name: 'quote_generation', input: { kind: 'VIDEO_SHOT', prompt: 'glacier' } }], 'tool_use');
    },
    (request: AgentModelRequest) => {
      const [captions, quote] = toolResults(request);
      expect(captions).toMatchObject({ isError: false });
      expect(quote).toMatchObject({ isError: true });
      expect(JSON.parse(quote!.content)).toMatchObject({ error: expect.stringContaining('not available in an autonomous run') });
      return reply([{ type: 'tool_use', id: 'r1', name: 'review_draft', input: {} }, { type: 'tool_use', id: 'm1', name: 'measure_pace', input: {} }], 'tool_use');
    },
    () => reply([{ type: 'text', text: '剪好了：6 秒一镜到底，加了原声字幕。' }], 'end_turn'),
  ];
}

async function drive(model: AgentModelAdapter, workspaceId: string, workflowRunId: string, stopAfter?: (status: string) => boolean): Promise<string> {
  const registry = new WorkflowRegistry().register(autonomousProductionWorkflow({ model, footageWait: { pollSeconds: 1 } }));
  for (let index = 0; index < 20; index += 1) {
    const row = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, workflowRunId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(row.status)) return row.status;
    if (row.activeJobId === null) throw new Error(`run ${workflowRunId} has no active job (${row.status})`);
    await advanceWorkflow(deps(), registry, { workspaceId, runId: workflowRunId, jobId: row.activeJobId });
    if (stopAfter !== undefined) {
      const auto = (await handle.db.select().from(autonomousRuns).where(eq(autonomousRuns.workflowRunId, workflowRunId)))[0]!;
      if (stopAfter(auto.status)) return auto.status;
    }
  }
  throw new Error('workflow did not finish');
}

const sign = (f: { workspaceId: string; projectId: string; userId: string }, approval: 'ASK_EACH' | 'AUTO_SAFE' | 'FULL', budgetMicros = 5_000_000) =>
  signProjectAutonomy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: f.userId, request: { approval, budgetMicros } });

const GOAL = { goal: '剪一条 6 秒的冰川口播，温暖克制', targetDurationSeconds: 6 } as const;

describe('V6-9 自主制作闭环（AP-05）', () => {
  it('自动审批：等素材 → 计划、剪、字幕、自检 → 系统采用（记为 AI）→ 交付报告', async () => {
    const f = await fixture({ processing: true });
    await expect(startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: AUTONOMY_ERROR_REASONS.NOT_SIGNED } });
    await sign(f, 'AUTO_SAFE');
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null, idempotencyKey: 'go' });
    expect(started).toMatchObject({ status: 'WAITING_FOR_FOOTAGE', approval: 'AUTO_SAFE', policyVersion: 1, budgetMicros: 5_000_000, modelCapMicros: null });
    expect((await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null, idempotencyKey: 'go' })).id).toBe(started.id);
    await expect(startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: AUTONOMOUS_RUN_ERROR_REASONS.RUN_IN_PROGRESS } });

    const model = new ScriptedModel(directorScript(f.footageId));
    // 素材还在处理：等待（不留失败尝试，也不调用模型）
    await drive(model, f.workspaceId, started.workflowRunId!, (status) => status === 'WAITING_FOR_FOOTAGE');
    expect(model.requests).toHaveLength(0);
    expect((await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id })).status).toBe('WAITING_FOR_FOOTAGE');
    await handle.db.update(assets).set({ status: 'READY' }).where(eq(assets.id, f.assetId));
    const revisionBefore = (await handle.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, f.projectId)))[0]!.revision;

    expect(await drive(model, f.workspaceId, started.workflowRunId!)).toBe('SUCCEEDED');
    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(run).toMatchObject({ status: 'DELIVERED', progress: { steps: 6, lastTool: 'measure_pace' } });
    expect(run.modelCapMicros).toBe(5_000_000 - 500_000);
    expect(run.adoptedRevision).toBeGreaterThan(revisionBefore);
    const turn = (await handle.db.select().from(agentTurns).where(eq(agentTurns.id, run.turnId!)))[0]!;
    expect(turn).toMatchObject({ purpose: 'AUTONOMOUS', status: 'COMPLETED', costMicros: 5 * CALL_MICROS });
    expect((await handle.db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, run.proposalId!)))[0]!.status).toBe('COMMITTED');
    // 采用如实记为 AI 在授权下的改动
    const actors = await handle.db.select({ actorType: projectOpLog.actorType, actorId: projectOpLog.actorId }).from(projectOpLog).where(and(eq(projectOpLog.projectId, f.projectId), eq(projectOpLog.revision, run.adoptedRevision!)));
    expect(actors.length).toBeGreaterThan(0);
    expect(actors.every((actor) => actor.actorType === 'AI' && actor.actorId === `autonomous:${run.id}`)).toBe(true);

    expect(run.report).toMatchObject({
      outcome: 'ADOPTED',
      note: '剪好了：6 秒一镜到底，加了原声字幕。',
      notAdoptedReason: null,
      timeline: { lengthSeconds: '6.000', captions: 1 },
      sources: { footage: [{ footageId: f.footageId, name: 'talk.mp4', seconds: '6.000' }], generated: [], originalShare: 1 },
      review: { warnings: 0 },
      plan: { version: 1, logline: '冰川口播', scenes: 1, intents: 1 },
      unmet: [],
      cost: { spentMicros: 5 * CALL_MICROS, budgetMicros: 5_000_000, unpricedCalls: 0 },
    });
    expect(run.report!.pace).toMatchObject({ cutsPerMinute: 0, target: { cutsPerMinute: 10 } });
    expect((await getLatestProductionPlan(deps(), f))!.turnId).toBe(run.turnId);
    expect((await listAutonomousRuns(deps(), f)).map((item) => item.id)).toEqual([run.id]);
  }, 120_000);

  it('逐项审批：交付为试改，等用户采用', async () => {
    const f = await fixture();
    await sign(f, 'ASK_EACH');
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null });
    expect(await drive(new ScriptedModel(directorScript(f.footageId)), f.workspaceId, started.workflowRunId!)).toBe('SUCCEEDED');
    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(run).toMatchObject({ status: 'NEEDS_REVIEW', adoptedRevision: null, report: { outcome: 'TRIAL', notAdoptedReason: 'APPROVAL_ASK_EACH', timeline: { captions: 1 } } });
    expect((await handle.db.select({ status: proposals.status }).from(proposals).where(eq(proposals.id, run.proposalId!)))[0]!.status).toBe('OPEN');
  }, 120_000);

  it('自检门禁：有警告（画面空洞）→ 不自动采用，警告列在报告里', async () => {
    const f = await fixture();
    await sign(f, 'FULL');
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null });
    expect(await drive(new ScriptedModel(directorScript(f.footageId, { gap: true })), f.workspaceId, started.workflowRunId!)).toBe('SUCCEEDED');
    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(run).toMatchObject({ status: 'NEEDS_REVIEW', report: { outcome: 'TRIAL', notAdoptedReason: 'REVIEW_GATE' } });
    expect(run.report!.review.warnings).toBeGreaterThan(0);
    expect(run.report!.review.findings.map((finding) => finding.kind)).toContain('PICTURE_GAP');
  }, 120_000);

  it('运行中授权被撤回 → 不采用；总预算是硬上限：花到上限即停，剩余不够时不能再开始', async () => {
    const f = await fixture();
    await sign(f, 'AUTO_SAFE');
    const first = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null });
    // 导演还在剪的时候，用户撤回了授权
    const script = directorScript(f.footageId);
    const revoking: AgentModelAdapter = {
      providerId: 'scripted', implementation: 'SCRIPTED', model: 'claude-opus-5-5',
      respond: async (request) => {
        const index = request.messages.filter((message) => message.role === 'assistant').length;
        if (index === script.length - 1) await revokeProjectAutonomy(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actorId: f.userId });
        return script[index]!(request);
      },
    };
    expect(await drive(revoking, f.workspaceId, first.workflowRunId!)).toBe('SUCCEEDED');
    expect(await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: first.id })).toMatchObject({ status: 'NEEDS_REVIEW', report: { notAdoptedReason: 'AUTHORIZATION_CHANGED' } });

    // 新签 0.25 美元：上限 = 0.25 − 0.025 余量 = 0.225；每次调用 0.06 → 第 4 次后达到上限，停下并说明
    await sign(f, 'AUTO_SAFE', 250_000);
    const second = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null });
    expect(await drive(new ScriptedModel(directorScript(f.footageId)), f.workspaceId, second.workflowRunId!)).toBe('SUCCEEDED');
    const capped = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: second.id });
    expect(capped.modelCapMicros).toBe(225_000);
    expect(capped.report!.cost.spentMicros).toBe(4 * CALL_MICROS);
    expect(capped.report!.unmet.map((item) => item.code)).toContain('BUDGET_REACHED');
    await expect(startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED } });
  }, 180_000);

  it('等素材时停止 → 取消；已结束的运行不能再停止', async () => {
    const f = await fixture({ processing: true });
    await sign(f, 'AUTO_SAFE');
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: GOAL, createdBy: null });
    await drive(new ScriptedModel([]), f.workspaceId, started.workflowRunId!, (status) => status === 'WAITING_FOR_FOOTAGE');
    await cancelAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(await drive(new ScriptedModel([]), f.workspaceId, started.workflowRunId!)).toBe('CANCELLED');
    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(run).toMatchObject({ status: 'CANCELLED', error: { reason: 'CANCELLED' }, turnId: null });
    await expect(cancelAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: AUTONOMOUS_RUN_ERROR_REASONS.NOT_CANCELLABLE } });
  }, 120_000);
});
