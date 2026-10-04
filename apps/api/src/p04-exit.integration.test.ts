import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { STANDARD_SCENE_TYPES, type ArticleFetcher, type LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * P04 阶段退出条件核验（计划 §8 P04 退出条件）：
 * **真实文章能够形成可解释、可编辑、来源完整的 Scene Graph。**
 *
 * 全链路（仅 LLM 为 Mock，其余为真实实现）：
 *   URL 文章 → ContentDocument（块/来源）→ 确定性抽取（Claim+Citation）
 *   → NarrativePlan（Mock LLM + 修复/门控）→ VisualPlan（确定性识别 + §10.3 门控/降级）
 *   → DirectorPlan（场景/资产/任务/成本/告警 + 四类验证）→ 应用（编辑协议）→ Scene Graph。
 *
 * 断言三个"完整"：
 * - **可解释**：每个旁白块有识别规则与原因；计划有决策摘要与告警；降级有明确原因；
 * - **可编辑**：应用后场景可经编辑协议修改（revision 递增），且可撤销（补偿事件）；
 * - **来源完整**：图表场景必须携带 data_source_ids 与 dataBinding；引用事实的场景带 sourceBindings；
 *   绝不出现"无数据来源的表图"。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。</p>
<p>分析师预计 2025 年可能降息 2 个百分点，因为通胀压力缓解。</p>
</body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }) {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`unreachable: ${input.url}`);
    return { finalUrl: input.url, contentType: response.contentType, bytes: response.bytes };
  }
}
const fetcher = new ScriptedFetcher();

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'p04-exit-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm: llm as LlmAdapter },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return { client, email };
}

describe('P04 阶段退出条件（真实文章 → 可解释/可编辑/来源完整的 Scene Graph）', () => {
  it('全链路端到端：文章 → 文档/抽取 → 叙事 → 视觉 → 导演 → 应用 → 图 → 编辑 → 撤销', async () => {
    const { client } = await newClient('p04-exit');

    // 1) 输入归一化（P04-01）：URL 文章 → ContentDocument（块 + 来源）
    const workspace = await client.workspaces.create({ name: `退出核验-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '利率周报视频', channelId: channel.id, targetDurationMs: 120_000 });
    const articleUrl = `https://news.example/rates/${randomUUID()}`;
    fetcher.responses.set(articleUrl, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url: articleUrl });
    expect(record.document.blocks.length).toBeGreaterThanOrEqual(2);
    expect(record.sourceId).not.toBeNull();
    const sources = await client.content.sources(workspace.id, project.id);
    expect(sources.length).toBe(1);
    const sourceId = sources[0]?.id ?? '';

    // 2) 证据与数据（P04-02）：Claim + Citation（块 + 字符区间 + 引文）与可绑定数据集
    const extraction = await client.evidence.extract(workspace.id, project.id, record.document.id);
    expect(extraction.claims.length).toBeGreaterThanOrEqual(2);
    expect(extraction.citations.length).toBeGreaterThanOrEqual(2);
    const claims = await client.evidence.claims(workspace.id, project.id);
    expect(claims.every((claim) => claim.sourceIds.includes(sourceId))).toBe(true);
    const dataset = await client.evidence.createDataset(workspace.id, project.id, {
      title: '联邦基金利率路径',
      unit: '%',
      sourceIds: [sourceId],
      synthetic: false,
      series: [
        {
          id: 'ser_fed',
          name: '联邦基金利率',
          points: [
            { t: '2023', v: 4.5, accuracy: 'anchor' },
            { t: '2024', v: 5.25, accuracy: 'anchor' },
            { t: '2025', v: 4.0, accuracy: 'anchor' },
          ],
        },
      ],
    });

    // 3) 叙事（P04-03，Mock LLM + 修复/锁定/口语化门控）
    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 120_000 });
    const plan = generated.plan;
    expect(plan.narrationBlocks.length).toBeGreaterThanOrEqual(3);
    expect(generated.meta.repairs).toBeDefined();

    // 4) 视觉计划（P04-04）：每个旁白块有识别规则/原因与允许类型；图表绑定必须带 data_source_ids
    const visual = await client.narrative.visualPlan(workspace.id, project.id, plan.id);
    expect(visual.items.length).toBe(plan.narrationBlocks.length);
    for (const item of visual.items) {
      expect(item.recognition.rule.length).toBeGreaterThan(0);
      expect(item.recognition.reasons.length).toBeGreaterThan(0);
      expect(item.allowedSceneTypes.length).toBeGreaterThan(0);
      if (item.datasetId !== null) expect(item.dataSourceIds.length).toBeGreaterThan(0);
      if (item.fallbackStrategy !== null) expect(item.warnings.length).toBeGreaterThan(0);
    }
    const rateItem = visual.items.find((item) => item.semanticType === 'PRICE_SERIES');
    expect(rateItem).toMatchObject({ datasetId: dataset.id, suggestedSceneType: 'LINE_CHART' });

    // 5) SpeechPlan（P04-06）：供应商无关；与旁白块一一对应
    const speech = await client.narrative.speechPlan(workspace.id, project.id, plan.id);
    expect(speech.segments.length).toBe(plan.narrationBlocks.length);
    expect(speech.segments[0]?.sceneRole).toBe('HOOK');

    // 6) Director（P04-05）：场景/资产/任务/成本/告警/决策摘要；验证后应用
    const director = await client.narrative.directorPlan(workspace.id, project.id, plan.id);
    expect(director.decisionSummary.length).toBeGreaterThan(10);
    expect(director.scenes.length).toBeGreaterThanOrEqual(plan.narrationBlocks.length); // 含章节标题结构场景
    expect(director.scenes.some((scene) => scene.sceneType === 'CHAPTER_TITLE')).toBe(true);
    expect(director.providerJobs.length).toBeGreaterThan(0); // 任务计划（当前被诚实阻止）
    expect(director.assetPlan.length).toBeGreaterThan(0);
    expect(director.warnings.length).toBeGreaterThan(0); // 可解释：告警随计划输出
    expect(director.blocked).toBe(false);

    const applied = await client.narrative.applyDirectorPlan(workspace.id, project.id, plan.id, { idempotencyKey: `idem_p04exit_${randomUUID()}` });
    expect(applied.scenes.length).toBe(director.scenes.length);

    // 7) Scene Graph：结构/来源完整性
    const graph = await client.projects.graph(project.id);
    expect(graph.scenes.length).toBe(director.scenes.length);
    const standard = new Set<string>(STANDARD_SCENE_TYPES);
    for (const scene of graph.scenes) {
      expect(standard.has(scene.sceneType), `非 V1 标准场景类型：${scene.sceneType}`).toBe(true);
      expect(scene.semanticType.length).toBeGreaterThan(0);
      if (scene.narrationBlockIds.length > 0) expect(scene.narration.length).toBeGreaterThan(0);
      // 来源完整：图表场景必须绑定数据集并携带 data_source_ids（经 sourceBindings.datasetIds 表达）
      if (['LINE_CHART', 'DUAL_LINE_CHART', 'BAR_CHART', 'SPREAD_AREA_CHART'].includes(scene.sceneType)) {
        expect(scene.dataBindings.length).toBeGreaterThan(0);
        const boundSources = scene.sourceBindings.flatMap((binding) => binding.datasetIds);
        expect(boundSources.length).toBeGreaterThan(0);
      }
      // 绝不出现"无来源的事实图表"：任何带数据集绑定的场景必有来源引用
      if (scene.dataBindings.length > 0) expect(scene.sourceBindings.length).toBeGreaterThan(0);
    }
    const chartScene = graph.scenes.find((scene) => scene.sceneType === 'LINE_CHART');
    expect(chartScene?.dataBindings.some((binding) => binding.datasetId === dataset.id)).toBe(true);

    // 8) 可编辑：经编辑协议修改（revision 递增）→ 撤销（补偿事件，历史不改写）
    const target = graph.scenes[0];
    expect(target).toBeDefined();
    const edited = await client.projects.edit(project.id, {
      baseProjectRevision: graph.projectRevision,
      expectedSceneRevisions: { [target?.id ?? '']: target?.revision ?? 1 },
      operations: [{ op: 'update_scene', sceneId: target?.id ?? '', changes: { narration: '（作者修订）开场旁白' } }],
      idempotencyKey: `idem_p04edit_${randomUUID()}`,
      intent: '退出核验：作者可编辑',
    });
    expect(edited.project.revision).toBe(graph.projectRevision + 1);
    expect(edited.scenes.find((scene) => scene.id === target?.id)?.narration).toBe('（作者修订）开场旁白');

    const undone = await client.projects.undo(project.id, { idempotencyKey: `idem_p04undo_${randomUUID()}` });
    expect(undone.project.revision).toBeGreaterThan(edited.project.revision);
    expect(undone.scenes.find((scene) => scene.id === target?.id)?.narration).not.toBe('（作者修订）开场旁白');
  });

  it('降级路径同样来源完整：数据不足的数值/图表语义绝不产生伪造图表', async () => {
    const { client } = await newClient('p04-exit-degrade');
    const workspace = await client.workspaces.create({ name: `降级核验-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '降级项目', channelId: channel.id });
    const articleUrl = `https://news.example/rates/${randomUUID()}`;
    fetcher.responses.set(articleUrl, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url: articleUrl });
    const sources = await client.content.sources(workspace.id, project.id);
    await client.evidence.extract(workspace.id, project.id, record.document.id);
    // 只提供 synthetic 数据集：绝不可被绑定为事实图表
    await client.evidence.createDataset(workspace.id, project.id, {
      title: '演示数据',
      unit: '%',
      sourceIds: [sources[0]?.id ?? ''],
      synthetic: true,
      series: [
        {
          id: 'ser_demo',
          name: '演示',
          points: [
            { t: '2023', v: 1, accuracy: 'reconstructed' },
            { t: '2024', v: 2, accuracy: 'reconstructed' },
            { t: '2025', v: 3, accuracy: 'reconstructed' },
          ],
        },
      ],
    });

    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
    const director = await client.narrative.directorPlan(workspace.id, project.id, generated.plan.id);
    for (const scene of director.scenes) {
      if (['LINE_CHART', 'DUAL_LINE_CHART', 'BAR_CHART', 'SPREAD_AREA_CHART'].includes(scene.sceneType)) {
        expect(scene.datasetId).not.toBeNull();
      }
      expect(scene.datasetId === null || scene.dataSourceIds.length > 0).toBe(true);
    }
    expect(director.warnings.some((warning) => warning.code === 'DATA_DEGRADED')).toBe(true);

    const applied = await client.narrative.applyDirectorPlan(workspace.id, project.id, generated.plan.id, { idempotencyKey: `idem_p04exit_d_${randomUUID()}` });
    const graph = await client.projects.graph(project.id);
    expect(graph.scenes.length).toBe(applied.scenes.length);
    // 没有任何图表场景（因为唯一数据集是 synthetic）
    expect(graph.scenes.some((scene) => ['LINE_CHART', 'BAR_CHART'].includes(scene.sceneType))).toBe(false);
  });
});

