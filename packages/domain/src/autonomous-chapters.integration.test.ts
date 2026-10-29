import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AgentModelFailure,
  sourceMediaProbeResultSchema,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
} from '@ancs/contracts';
import { agentTurns, assetVersions, assets, autonomousChapters, autonomousRuns, createDb, projectSequences, proposals, resolveTestDatabaseUrl, runMigrations, workflowRuns, workspaces, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  advanceWorkflow,
  autonomousChapterWorkflow,
  autonomousProductionWorkflow,
  cancelAutonomousRun,
  createStudioProject,
  getAutonomousRun,
  getStudioState,
  signProjectAutonomy,
  startAutonomousRun,
  type AutonomousProductionPorts,
  type DomainDeps,
} from './index.js';
import { readTimelineSnapshot } from './edit-trial.js';

/**
 * V6-10 S3 分章并行（真实 PostgreSQL + 编辑内核 + 工作流引擎；导演是按交代里的 phase 行事的脚本模型）：
 * 定计划（只能读和写计划）→ 三章在各自的子序列上剪（资源池 2；第 2 章两次都失败，用完重试）→ 拼装（第 1、3 章按顺序拼进主序列）
 * → 通看收尾 → 交付；报告逐章写明，第 2 章没拼进去；花费含规划与各章各次尝试；停下时各章一起取消。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

function probe(durationMs: number) {
  const video = {
    index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0',
    durationTicks: String(durationMs * 15.36), durationMs, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 },
    frameCount: String(durationMs * 0.03), sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT' as const, sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
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

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  const userId = `usr_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V6-10 分章' });
  const ref = await createStudioProject(deps(), { workspaceId, request: { title: '冰岛长片', aspectRatio: '16:9', locale: 'zh-CN' } });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: ref.projectId, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'trip.mp4' } });
  await handle.db.insert(assetVersions).values({ id: footageId, assetId, workspaceId, versionNumber: 1, storageKey: `v610/${footageId}.mp4`, mimeType: 'video/mp4', sizeBytes: 4096, checksumSha256: 'c'.repeat(64), durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probe(30_000) });
  await signProjectAutonomy(deps(), { workspaceId, projectId: ref.projectId, actorId: userId, request: { approval: 'AUTO_SAFE', budgetMicros: 5_000_000 } });
  return { workspaceId, userId, projectId: ref.projectId, footageId };
}

const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
/** 每次调用按 Opus 5.5 单价计 6 万微美元 */
const CALL_MICROS = 60_000;
const reply = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason']): AgentModelResponse => ({ model: 'claude-opus-5-5', content, stopReason, usage });
const toolResults = (request: AgentModelRequest) => request.messages.at(-1)!.content.filter((block): block is Extract<AgentContentBlock, { type: 'tool_result' }> => block.type === 'tool_result');
const contextOf = (request: AgentModelRequest): string => (request.messages[0]!.content[0] as { text: string }).text;
const SCENES = [['ch_open', '出发', '0', '6'], ['ch_road', '路上', '6', '12'], ['ch_lake', '湖边', '12', '18']] as const;

/** 按交代里的 phase 行事的导演；同一轮内按已有的回复数推进（步骤重试、从日志续跑时不乱） */
class PhaseDirector implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly model = 'claude-opus-5-5';
  readonly calls: { phase: string; step: number; request: AgentModelRequest }[] = [];
  constructor(private readonly footageId: string, private readonly failChapter: number | null) {}
  respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const context = contextOf(request);
    const step = request.messages.filter((message) => message.role === 'assistant').length;
    const phase = /"phase":"([A-Z_]+)"/.exec(context)?.[1] ?? 'NONE';
    this.calls.push({ phase, step, request: structuredClone(request) });
    try {
      return Promise.resolve(this.answer(phase, step, context, request));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  private answer(phase: string, step: number, context: string, request: AgentModelRequest): AgentModelResponse {
    if (phase === 'PLAN_CHAPTERS') {
      if (step === 0) {
        return reply([
          { type: 'tool_use', id: 'plan', name: 'plan_production', input: {
            blueprint: { logline: '一天的冰岛', structure: '出发 → 路上 → 湖边', targetDurationSeconds: 18 },
            scenes: SCENES.map(([id, title, from, to]) => ({ id, title, goal: `讲${title}`, window: { start: from, end: to }, sources: [{ footageId: this.footageId, from, to }] })),
          } },
          { type: 'tool_use', id: 'sneak', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: this.footageId, sourceStart: '0', sourceEnd: '1' }] } },
        ], 'tool_use');
      }
      const [planned, sneak] = toolResults(request);
      expect(planned).toMatchObject({ isError: false });
      expect(sneak).toMatchObject({ isError: true });
      expect(JSON.parse(sneak!.content)).toMatchObject({ error: expect.stringContaining('only plans the chapters') });
      return reply([{ type: 'text', text: '分三章。' }], 'end_turn');
    }
    if (phase === 'CUT_CHAPTER') {
      const number = Number(/"number":(\d+)/.exec(context)?.[1]);
      if (number === this.failChapter) throw new AgentModelFailure('BAD_REQUEST', `chapter ${String(number)} cannot be cut`);
      const [, , from, to] = SCENES[number - 1]!;
      if (step === 0) {
        expect(context).toContain('<timeline>');
        return reply([{ type: 'tool_use', id: `cut${String(number)}`, name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: this.footageId, sourceStart: from, sourceEnd: to }, { op: 'fit_length' }] } }], 'tool_use');
      }
      expect(toolResults(request)[0]).toMatchObject({ isError: false });
      return reply([{ type: 'text', text: `第 ${String(number)} 章剪好了。` }], 'end_turn');
    }
    if (phase === 'FINISH_CHAPTERS') {
      if (step === 0) return reply([{ type: 'tool_use', id: 'look', name: 'get_timeline', input: {} }], 'tool_use');
      if (step === 1) {
        const timeline = JSON.parse(toolResults(request)[0]!.content) as { clips: { at: [string, string]; source: [string, string] | null; footageId: string | null }[] };
        const pictures = timeline.clips.filter((clip) => clip.footageId === this.footageId && clip.source !== null);
        expect(pictures.map((clip) => [clip.at, clip.source])).toEqual(expect.arrayContaining([[['0.000', '6.000'], ['0.000', '6.000']], [['6.000', '12.000'], ['12.000', '18.000']]]));
        return reply([{ type: 'tool_use', id: 'review', name: 'review_draft', input: {} }], 'tool_use');
      }
      return reply([{ type: 'text', text: '两章拼好了，第 2 章没剪成。' }], 'end_turn');
    }
    throw new Error(`unexpected phase ${phase}`);
  }
}

const ports = (model: AgentModelAdapter): AutonomousProductionPorts => ({ model, footageWait: { pollSeconds: 1 }, chapters: { minFootageSeconds: 20, concurrency: 2, retries: 1, pollSeconds: 1 } });

/** 推进父运行与它启动的各章子运行，直到父运行结束（或 until 返回 true） */
async function drive(model: AgentModelAdapter, workspaceId: string, parentRunId: string, until?: () => Promise<boolean>): Promise<string> {
  const registry = new WorkflowRegistry().register(autonomousProductionWorkflow(ports(model))).register(autonomousChapterWorkflow(ports(model)));
  for (let index = 0; index < 120; index += 1) {
    const parent = (await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, parentRunId)))[0]!;
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(parent.status)) return parent.status;
    const runs = await handle.db.select().from(workflowRuns).where(and(eq(workflowRuns.workspaceId, workspaceId), inArray(workflowRuns.status, ['RUNNING', 'CANCEL_REQUESTED'])));
    for (const run of runs.filter((item) => item.activeJobId !== null)) {
      await advanceWorkflow(deps(), registry, { workspaceId, runId: run.id, jobId: run.activeJobId! });
    }
    if (until !== undefined && await until()) return 'STOPPED';
  }
  throw new Error('workflow did not finish');
}

const chaptersOf = (runId: string) => handle.db.select().from(autonomousChapters).where(eq(autonomousChapters.runId, runId)).orderBy(asc(autonomousChapters.index));

describe('V6-10 S3 长素材分章并行', () => {
  it('定计划 → 三章并行剪（资源池 2）→ 第 2 章失败不挡其它章 → 拼装 → 通看收尾 → 交付，报告逐章写明', async () => {
    const f = await fixture();
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: { goal: '剪一条冰岛一日', targetDurationSeconds: 18 }, createdBy: null });
    const model = new PhaseDirector(f.footageId, 2);
    let sawPool = false;
    const status = await drive(model, f.workspaceId, started.workflowRunId!, async () => {
      const rows = await chaptersOf(started.id);
      if (rows.length === 3 && rows.filter((row) => row.status === 'RUNNING').length === 2 && rows[2]!.status === 'PENDING') sawPool = true;
      return false;
    });
    expect(status).toBe('SUCCEEDED');
    // 资源池：同时最多两章在剪
    expect(sawPool).toBe(true);

    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(run.mode).toBe('CHAPTERS');
    expect(run.chapters.map((chapter) => [chapter.title, chapter.status, chapter.attempts])).toEqual([['出发', 'SUCCEEDED', 1], ['路上', 'FAILED', 2], ['湖边', 'SUCCEEDED', 1]]);
    expect(run.chapters[1]!.error).toMatchObject({ message: expect.stringContaining('chapter 2 cannot be cut') });

    // 报告：逐章结果、没拼进去的章、花费含规划与各章（第 2 章两次失败的调用没有返回，不计费）
    const report = run.report!;
    expect(report.chapters.map((chapter) => [chapter.title, chapter.outcome, chapter.placement])).toEqual([
      ['出发', 'ASSEMBLED', ['0.000', '6.000']],
      ['路上', 'FAILED', null],
      ['湖边', 'ASSEMBLED', ['6.000', '12.000']],
    ]);
    expect(report.chapters[1]!.reason).toContain('chapter 2 cannot be cut');
    expect(report.unmet).toEqual(expect.arrayContaining([{ code: 'CHAPTER_NOT_ASSEMBLED', detail: '路上' }]));
    const billed = model.calls.filter((call) => !(call.phase === 'CUT_CHAPTER' && /"number":2/.test(contextOf(call.request)))).length;
    expect(report.cost.spentMicros).toBe(billed * CALL_MICROS);
    expect(report.plan).toMatchObject({ scenes: 3 });

    // 交付的那一版：第 1、3 章按顺序在主序列上；各章的草稿没有单独建提案
    const state = await getStudioState(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    const projectProposals = await handle.db.select({ id: proposals.id }).from(proposals).where(eq(proposals.projectId, f.projectId));
    expect(projectProposals).toHaveLength(1);
    expect([run.status, report.outcome, report.timeline]).toEqual(['DELIVERED', 'ADOPTED', { lengthSeconds: '12.000', clips: 2, captions: 0 }]);
    expect(report.unmet).toEqual(expect.arrayContaining([{ code: 'TARGET_DURATION', detail: '18/12.0' }]));
    const { timeline } = await readTimelineSnapshot(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    const seconds = (range: unknown) => { const value = range as { start: { ticks: string; timebase: { num: number; den: number } }; end: { ticks: string } }; const tb = value.start.timebase; return [Number(value.start.ticks) * tb.num / tb.den, Number(value.end.ticks) * tb.num / tb.den]; };
    const mainVideo = timeline.clips.filter((clip) => clip.sequenceId === state.sequenceId && timeline.tracks.find((track) => track.id === clip.trackId)?.kind === 'VIDEO');
    expect(mainVideo.map((clip) => [seconds(clip.sequenceRange), seconds(clip.sourceRange)]).sort()).toEqual([[[0, 6], [0, 6]], [[6, 12], [12, 18]]]);
    // 各章在主序列下的子序列上；共看片室仍然看主序列
    const children = await handle.db.select({ id: projectSequences.id, parent: projectSequences.parentSequenceId }).from(projectSequences).where(eq(projectSequences.projectId, f.projectId));
    expect(children.filter((row) => row.parent === state.sequenceId)).toHaveLength(3);
    expect(run.chapters.every((chapter) => chapter.progress.steps >= 0)).toBe(true);
    // 规划那一轮在主会话里，结束了；各章的轮次各在自己的会话里
    const turns = await handle.db.select({ purpose: agentTurns.purpose, status: agentTurns.status }).from(agentTurns).where(eq(agentTurns.projectId, f.projectId));
    expect(turns.filter((turn) => turn.purpose === 'AUTONOMOUS_PLAN').map((turn) => turn.status)).toEqual(['COMPLETED']);
    expect(turns.filter((turn) => turn.purpose === 'AUTONOMOUS_CHAPTER')).toHaveLength(4);
  });

  it('计划只有一个场景：不分章，退回一轮剪完（计划作为上下文交给那一轮；规划的花费照样计入）', async () => {
    const f = await fixture();
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: { goal: '剪一条冰岛一日', targetDurationSeconds: 6 }, createdBy: null });
    const phases: string[] = [];
    const model: AgentModelAdapter = {
      providerId: 'scripted', implementation: 'SCRIPTED', model: 'claude-opus-5-5',
      respond: (request) => {
        const context = contextOf(request);
        const phase = /"phase":"([A-Z_]+)"/.exec(context)?.[1] ?? 'NONE';
        const step = request.messages.filter((message) => message.role === 'assistant').length;
        phases.push(`${phase}:${String(step)}`);
        if (phase === 'PLAN_CHAPTERS' && step === 0) {
          return Promise.resolve(reply([{ type: 'tool_use', id: 'plan', name: 'plan_production', input: {
            blueprint: { logline: '一镜到底', structure: '一段' }, scenes: [{ id: 'only', title: '全片', goal: '一镜', sources: [{ footageId: f.footageId, from: '0', to: '6' }] }],
          } }], 'tool_use'));
        }
        if (phase === 'NONE' && step === 0) {
          expect(context).toContain('<production_plan>');
          return Promise.resolve(reply([{ type: 'tool_use', id: 'cut', name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: f.footageId, sourceStart: '0', sourceEnd: '6' }, { op: 'fit_length' }] } }], 'tool_use'));
        }
        return Promise.resolve(reply([{ type: 'text', text: '好了。' }], 'end_turn'));
      },
    };
    expect(await drive(model, f.workspaceId, started.workflowRunId!)).toBe('SUCCEEDED');
    const run = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect([run.mode, run.chapters, run.status, run.report?.timeline.clips]).toEqual(['SINGLE', [], 'DELIVERED', 1]);
    expect(phases).toEqual(['PLAN_CHAPTERS:0', 'PLAN_CHAPTERS:1', 'NONE:0', 'NONE:1']);
    expect(run.report?.cost.spentMicros).toBe(4 * CALL_MICROS);
  });

  it('分章中途停下：还在剪的章与没开始的章一起取消，运行记为已停下，不留进行中的轮次', async () => {
    const f = await fixture();
    const started = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: { goal: '剪一条冰岛一日', targetDurationSeconds: 18 }, createdBy: null });
    const model = new PhaseDirector(f.footageId, null);
    await drive(model, f.workspaceId, started.workflowRunId!, async () => (await chaptersOf(started.id)).some((row) => row.status === 'RUNNING'));
    await cancelAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: started.id });
    expect(await drive(model, f.workspaceId, started.workflowRunId!)).toBe('CANCELLED');
    const row = (await handle.db.select().from(autonomousRuns).where(eq(autonomousRuns.id, started.id)))[0]!;
    expect(row.status).toBe('CANCELLED');
    const rows = await chaptersOf(started.id);
    expect(rows.map((chapter) => chapter.status).every((value) => value === 'CANCELLED' || value === 'SUCCEEDED')).toBe(true);
    expect(rows.some((chapter) => chapter.status === 'CANCELLED')).toBe(true);
    const running = await handle.db.select({ id: agentTurns.id }).from(agentTurns).where(and(eq(agentTurns.projectId, f.projectId), eq(agentTurns.status, 'RUNNING')));
    expect(running).toHaveLength(0);
  });
});
