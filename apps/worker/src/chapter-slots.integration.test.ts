import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sourceMediaProbeResultSchema, type AgentContentBlock, type AgentModelAdapter, type AgentModelRequest, type AgentModelResponse } from '@ancs/contracts';
import { assetVersions, assets, createDb, resolveTestDatabaseUrl, runMigrations, workflowRuns, workspaces, type DbHandle } from '@ancs/db';
import {
  WorkflowRegistry,
  autonomousChapterWorkflow,
  autonomousProductionWorkflow,
  claimJob,
  createStudioProject,
  getAutonomousRun,
  runMaintenanceTick,
  signProjectAutonomy,
  startAutonomousRun,
  type AutonomousProductionPorts,
  type DomainDeps,
} from '@ancs/domain';
import { createDefaultRegistry } from './handlers.js';
import { executeJob } from './runner.js';
import { runJobSlots } from './slots.js';

/**
 * V6-10 S4 任务槽实测（真实 PostgreSQL + 工作流引擎 + Worker 执行器与任务槽；导演是每次调用固定耗时的脚本模型）：
 * 同一条六章的长素材自主制作，分别用 1 个槽和 4 个槽的 Worker 跑完，比较墙钟时间与同时在等模型的调用数。
 *
 * 只测编排：模型耗时是脚本设定的，真实模型的耗时与花费不在这里（NOT_VERIFIED）。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl(), { max: 10 });
  await runMigrations(handle);
});
afterAll(async () => {
  await handle.close();
});

/** 每次模型调用的耗时 */
const LATENCY_MS = 500;
const CHAPTERS = 6;
const FOOTAGE_SECONDS = 30;

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
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V6-10 任务槽' });
  const ref = await createStudioProject(deps(), { workspaceId, request: { title: '六章长片', aspectRatio: '16:9', locale: 'zh-CN' } });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: ref.projectId, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'long.mp4' } });
  await handle.db.insert(assetVersions).values({ id: footageId, assetId, workspaceId, versionNumber: 1, storageKey: `v610s4/${footageId}.mp4`, mimeType: 'video/mp4', sizeBytes: 4096, checksumSha256: 'd'.repeat(64), durationMs: FOOTAGE_SECONDS * 1000, width: 1920, height: 1080, status: 'READY', mediaProbe: probe(FOOTAGE_SECONDS * 1000) });
  await signProjectAutonomy(deps(), { workspaceId, projectId: ref.projectId, actorId: `usr_${randomUUID()}`, request: { approval: 'AUTO_SAFE', budgetMicros: 5_000_000 } });
  return { workspaceId, projectId: ref.projectId, footageId };
}

const usage = { inputTokens: 10_000, outputTokens: 1_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
const reply = (content: AgentContentBlock[], stopReason: AgentModelResponse['stopReason']): AgentModelResponse => ({ model: 'claude-opus-5-5', content, stopReason, usage });
const contextOf = (request: AgentModelRequest): string => (request.messages[0]!.content[0] as { text: string }).text;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 每次调用固定耗时、按交代里的 phase 行事的导演；记录同时在等的调用数 */
class SlowDirector implements AgentModelAdapter {
  readonly providerId = 'scripted';
  readonly implementation = 'SCRIPTED' as const;
  readonly model = 'claude-opus-5-5';
  calls = 0;
  waiting = 0;
  peakWaiting = 0;
  constructor(private readonly footageId: string) {}
  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    this.calls += 1;
    this.waiting += 1;
    this.peakWaiting = Math.max(this.peakWaiting, this.waiting);
    try {
      await sleep(LATENCY_MS);
    } finally {
      this.waiting -= 1;
    }
    const context = contextOf(request);
    const step = request.messages.filter((message) => message.role === 'assistant').length;
    const phase = /"phase":"([A-Z_]+)"/.exec(context)?.[1] ?? 'NONE';
    const seconds = FOOTAGE_SECONDS / CHAPTERS;
    if (phase === 'PLAN_CHAPTERS') {
      if (step > 0) return reply([{ type: 'text', text: '分六章。' }], 'end_turn');
      const scenes = Array.from({ length: CHAPTERS }, (_, index) => {
        const from = String(index * seconds);
        const to = String((index + 1) * seconds);
        return { id: `ch_${String(index + 1)}`, title: `第${String(index + 1)}段`, goal: '讲这一段', window: { start: from, end: to }, sources: [{ footageId: this.footageId, from, to }] };
      });
      return reply([{ type: 'tool_use', id: 'plan', name: 'plan_production', input: { blueprint: { logline: '一段长素材', structure: '六段', targetDurationSeconds: FOOTAGE_SECONDS }, scenes } }], 'tool_use');
    }
    if (phase === 'CUT_CHAPTER') {
      if (step > 0) return reply([{ type: 'text', text: '这一章剪好了。' }], 'end_turn');
      const number = Number(/"number":(\d+)/.exec(context)?.[1]);
      const from = String((number - 1) * seconds);
      const to = String(number * seconds);
      return reply([{ type: 'tool_use', id: `cut${String(number)}`, name: 'edit_timeline', input: { operations: [{ op: 'place_clip', footageId: this.footageId, sourceStart: from, sourceEnd: to }, { op: 'fit_length' }] } }], 'tool_use');
    }
    return reply([{ type: 'text', text: '拼好了。' }], 'end_turn');
  }
}

async function produceWith(slots: number) {
  const f = await fixture();
  const model = new SlowDirector(f.footageId);
  const ports: AutonomousProductionPorts = { model, footageWait: { pollSeconds: 1 }, chapters: { minFootageSeconds: 20, concurrency: 3, retries: 0, pollSeconds: 1 } };
  const registry = createDefaultRegistry({ workflowRegistry: new WorkflowRegistry().register(autonomousProductionWorkflow(ports)).register(autonomousChapterWorkflow(ports)) });
  const workerId = `slots-${String(slots)}-${randomUUID()}`;

  const started = Date.now();
  const run = await startAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, request: { goal: '把这段长素材剪成一条', targetDurationSeconds: FOOTAGE_SECONDS }, createdBy: null });
  let finished = false;
  const report = await runJobSlots({
    slots,
    pollMs: 50,
    claim: () => claimJob(deps(), { workerId, leaseSeconds: 30, types: registry.types(), workspaceId: f.workspaceId }),
    execute: async (job) => {
      await executeJob(deps(), registry, { workerId, leaseSeconds: 30, heartbeatIntervalMs: 1000 }, job);
      const parent = (await handle.db.select({ status: workflowRuns.status }).from(workflowRuns).where(eq(workflowRuns.id, run.workflowRunId!)))[0];
      if (parent !== undefined && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(parent.status)) finished = true;
    },
    maintain: async () => {
      await runMaintenanceTick(deps(), { limit: 50 });
    },
    stopping: () => finished,
  });
  const elapsedMs = Date.now() - started;
  const result = await getAutonomousRun(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, runId: run.id });
  // 分章阶段：第一章开始到最后一章结束（规划与收尾本来就不能并行）
  const starts = result.chapters.map((chapter) => Date.parse(chapter.startedAt!));
  const ends = result.chapters.map((chapter) => Date.parse(chapter.completedAt!));
  const chaptersMs = Math.max(...ends) - Math.min(...starts);
  return { elapsedMs, chaptersMs, result, model, report };
}

describe('V6-10 S4 Worker 任务槽实测', () => {
  it(`六章、每次模型调用 ${String(LATENCY_MS)} ms：4 个槽的墙钟时间明显短于 1 个槽，结果相同`, async () => {
    const serial = await produceWith(1);
    const parallel = await produceWith(4);

    for (const { result } of [serial, parallel]) {
      expect(result.mode).toBe('CHAPTERS');
      expect(result.chapters.map((chapter) => chapter.status)).toEqual(Array.from({ length: CHAPTERS }, () => 'SUCCEEDED'));
      expect([result.status, result.report?.outcome, result.report?.timeline.lengthSeconds]).toEqual(['DELIVERED', 'ADOPTED', `${String(FOOTAGE_SECONDS)}.000`]);
    }
    // 两次调用次数相同：规划 2 + 各章 2 × 6 + 收尾 1
    expect([serial.model.calls, parallel.model.calls]).toEqual([2 + 2 * CHAPTERS + 1, 2 + 2 * CHAPTERS + 1]);
    // 1 个槽时同一时刻只有一次调用在等模型；4 个槽时资源池（3 章）同时在等
    expect(serial.model.peakWaiting).toBe(1);
    expect(parallel.model.peakWaiting).toBe(3);
    expect(serial.report.peak).toBe(1);
    expect(parallel.report.peak).toBeGreaterThanOrEqual(3);

    const ratio = (a: number, b: number) => Number((a / b).toFixed(2));
    console.log(JSON.stringify({
      measurement: 'V6-10 S4 wall clock', latencyMs: LATENCY_MS, chapters: CHAPTERS, calls: serial.model.calls,
      total: { slots1Ms: serial.elapsedMs, slots4Ms: parallel.elapsedMs, ratio: ratio(parallel.elapsedMs, serial.elapsedMs) },
      chapterPhase: { slots1Ms: serial.chaptersMs, slots4Ms: parallel.chaptersMs, ratio: ratio(parallel.chaptersMs, serial.chaptersMs) },
    }));
    expect(parallel.elapsedMs).toBeLessThan(serial.elapsedMs * 0.8);
    expect(parallel.chaptersMs).toBeLessThan(serial.chaptersMs * 0.65);
  }, 120_000);
});
