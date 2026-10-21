import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, productionPlanInputSchema, sourceMediaProbeResultSchema, type ProductionPlanInput } from '@ancs/contracts';
import { assetVersions, assets, createDb, productionPlans, projects, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { compileAgentContext } from './agent-prompt.js';
import { createChannel, createProject, createSequence, getLatestProductionPlan, type DomainDeps } from './index.js';
import { compactPlanView } from './production-plan.js';
import { defaultAgentToolCatalog, type AgentToolContext } from './agent-tools.js';

/**
 * AP-04 导演蓝图与场景契约（含 0.2 A0 剪辑意图；真实 PostgreSQL）：
 * - plan_production 校验素材与区间、同一份计划里 id 不重复；每次保存新增一版（版本号递增），记录制定时的工程版本号；
 * - 计划不改时间线；工程之后又改过 → 读取时如实标出；
 * - 计划摘要进入导演的每轮上下文（<production_plan>），完整内容可经 get_production_plan 读取。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

const probe = sourceMediaProbeResultSchema.parse({
  schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs: 10_000, bitRate: 92_000,
  streams: [{
    index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0',
    durationTicks: '153600', durationMs: 10_000, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 },
    frameCount: '300', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
  }],
  decodeCheck: { status: 'PASSED', errorCode: null, message: null },
  capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
});

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'AP-04 计划' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '旅行' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '冰岛', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(1_000) } });
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: footageId, metadata: { filename: 'glacier.mp4' } });
  await handle.db.insert(assetVersions).values({ id: footageId, assetId, workspaceId, versionNumber: 1, storageKey: `ap04/${footageId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'e'.repeat(64), durationMs: 10_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probe });
  const revision = (await handle.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, project.id)))[0]!.revision;
  const context: AgentToolContext = { deps: deps(), workspaceId, projectId: project.id, sequenceId: sequence.id, actorId: 'agent', locale: 'zh-CN', draft: { baseRevision: revision, operations: [] } };
  return { context, footageId, workspaceId, projectId: project.id };
}

const plan = (footageId: string, patch: Partial<ProductionPlanInput> = {}): ProductionPlanInput => ({
  blueprint: { logline: '一个人开车去看冰川', structure: '钩子 → 出发 → 冰川 → 回望', targetDurationSeconds: 45, mustKeep: ['冰川崩落的镜头'] },
  scenes: [
    {
      id: 'scene_hook', title: '开场', goal: '先给最美的画面作为开场承诺', window: { start: '0', end: '4' },
      sources: [{ footageId, from: '6', to: '9.5' }], needs: ['CAPTIONS'],
      intents: [{ id: 'intent_hook', type: 'HOOK', targetFeeling: '一眼被冰川的蓝吸引', reason: '6–9.5 秒的冰川特写最亮、最有冲击力', evidence: [`${footageId}@6-9.5`], rejectedAlternatives: [{ description: '延时摄影开场', reason: '与温暖克制的调性不符' }] }],
    },
    { id: 'scene_road', title: '出发', goal: '交代路途', sources: [{ footageId, from: '0', to: '5' }], intents: [{ id: 'intent_setup', type: 'SETUP', targetFeeling: '路很远', reason: '公路镜头' }] },
  ],
  ...patch,
});

const catalog = defaultAgentToolCatalog();
const run = (name: string, context: AgentToolContext, input: unknown) => {
  const tool = catalog.get(name)!;
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) return Promise.resolve({ isError: true, content: JSON.stringify(parsed.error.issues), summary: 'invalid input' });
  return tool.run(context, parsed.data);
};

describe('AP-04 制作计划（工具与规划记录）', () => {
  it('校验素材与区间、id 不重复；每次保存新增一版；不改时间线；工程改过如实标出；摘要进入上下文', async () => {
    const f = await fixture();
    expect((await run('plan_production', f.context, plan('av_unknown'))).isError).toBe(true);
    const outOfRange = await run('plan_production', f.context, plan(f.footageId, { scenes: [{ id: 's1', title: 't', goal: 'g', sources: [{ footageId: f.footageId, from: '8', to: '12' }] }] }));
    expect(outOfRange.isError).toBe(true);
    expect(JSON.parse(outOfRange.content)).toMatchObject({ error: 'scene sources reach past the end of the footage' });
    const duplicate = plan(f.footageId);
    duplicate.scenes[1]!.id = 'scene_hook';
    expect(productionPlanInputSchema.safeParse(duplicate).success).toBe(false);
    expect(await getLatestProductionPlan(deps(), f)).toBeNull();

    const first = await run('plan_production', f.context, plan(f.footageId));
    expect(first.isError, first.content).toBe(false);
    expect(JSON.parse(first.content)).toMatchObject({ saved: true, version: 1, scenes: 2, intents: 2 });
    expect('draftOperations' in first).toBe(false);
    const second = await run('plan_production', f.context, plan(f.footageId, { blueprint: { logline: '冰川在后退', structure: '对比：十年前 → 现在' } }));
    expect(JSON.parse(second.content)).toMatchObject({ version: 2 });
    const latest = await getLatestProductionPlan(deps(), f);
    expect(latest).toMatchObject({ version: 2, baseRevision: f.context.draft.baseRevision, currentRevision: f.context.draft.baseRevision, blueprint: { logline: '冰川在后退' } });
    expect(latest!.scenes[0]!.intents[0]).toMatchObject({ type: 'HOOK', rejectedAlternatives: [{ description: '延时摄影开场' }] });
    expect(await handle.db.select({ count: sql<number>`count(*)::int` }).from(productionPlans).where(eq(productionPlans.projectId, f.projectId))).toEqual([{ count: 2 }]);

    // 计划之后工程又改过：读取时如实标出（计划不阻塞编辑，也不被自动改写）
    await handle.db.update(projects).set({ revision: sql`${projects.revision} + 1` }).where(eq(projects.id, f.projectId));
    const stale = await getLatestProductionPlan(deps(), f);
    expect(stale!.currentRevision).toBe(stale!.baseRevision + 1);
    const compact = compactPlanView(stale!);
    expect(compact).toMatchObject({ version: 2, projectChangedSincePlan: true, scenes: [{ id: 'scene_hook', window: ['0', '4'], intents: [{ id: 'intent_hook', type: 'HOOK' }] }, { id: 'scene_road' }] });

    const summary = JSON.parse((await run('get_production_plan', f.context, {})).content) as { plan: Record<string, unknown> };
    expect(summary.plan).toEqual(compact);
    const full = JSON.parse((await run('get_production_plan', f.context, { full: true })).content) as { plan: { scenes: { sources: unknown[] }[]; changedSincePlan: boolean } };
    expect(full.plan.scenes[0]!.sources).toEqual([{ footageId: f.footageId, from: '6', to: '9.5' }]);
    expect(full.plan.changedSincePlan).toBe(true);

    const context = compileAgentContext({ locale: 'zh-CN', project: { title: '冰岛', mode: 'FOOTAGE_EDIT' }, timeline: {}, footage: [], pointer: {}, plan: compact, strategy: null, recentTurns: [], request: '开头不够抓人' });
    expect(context).toContain('<production_plan>\n{"version":2,"projectChangedSincePlan":true,"logline":"冰川在后退"');
    expect(context.indexOf('<production_plan>')).toBeLessThan(context.indexOf('<request>'));
  }, 60_000);
});
