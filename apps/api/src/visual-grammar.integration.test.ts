import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher, LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * P04-04 验收（HTTP + SDK，真实 DB + Mock LLM；VisualPlan 为纯投影，可重复）：
 * - "对固定语义输入得到允许类型"：每个旁白块识别出语义，建议场景类型落在该语义的允许集合内；
 * - 图表类语义（requiresData）只能绑定**可绑定数据集**（非 synthetic/非空/有来源），并携带 data_source_ids（§10.3 MUST）；
 * - **受控降级**：数据不足（仅 synthetic 数据集）/ 无可追溯来源的数值 → 按 §10.3 阶梯降级，附明确 warning，绝不编造图表；
 * - 隔离：跨租户/未知计划一律 404（反枚举）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。</p>
<p>分析师预计 2025 年可能降息 2 个百分点，因为通胀压力缓解。</p>
</body></html>`;

const PASTED_TEXT = '内部渠道数据显示，某资产本月收益率涨幅为 3%，预计后续继续上行。';

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
    secret: 'visual-grammar-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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

async function makeArticleProject(
  client: AncsClient,
): Promise<{ workspaceId: string; projectId: string; documentId: string; sourceId: string }> {
  const workspace = await client.workspaces.create({ name: `视觉-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '视觉项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const sources = await client.content.sources(workspace.id, project.id);
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id, sourceId: sources[0]?.id ?? '' };
}

const fedDataset = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  title: '联邦基金利率路径',
  unit: '%',
  sourceIds: [sourceId],
  synthetic: false,
  series: [
    {
      id: 'ser_fed_funds',
      name: '联邦基金利率',
      points: [
        { t: '2023', v: 4.5, accuracy: 'anchor' as const },
        { t: '2024', v: 5.25, accuracy: 'anchor' as const },
        { t: '2025', v: 4.0, accuracy: 'anchor' as const },
      ],
    },
  ],
  ...overrides,
});

type VisualPlanItem = Awaited<ReturnType<AncsClient['narrative']['visualPlan']>>['items'][number];

function rateItem(items: VisualPlanItem[], rateClaimIds: Set<string>): VisualPlanItem {
  const item = items.find((candidate) => candidate.claimIds.some((claimId) => rateClaimIds.has(claimId)));
  expect(item, '存在引用利率事实的旁白块').toBeDefined();
  return item as VisualPlanItem;
}

describe('Visual Grammar（P04-04）', () => {
  it('每个旁白块得到允许类型；图表语义绑定可追溯数据集（data_source_ids）', async () => {
    const { client } = await newClient('visual-bind');
    const { workspaceId, projectId, documentId, sourceId } = await makeArticleProject(client);
    const dataset = await client.evidence.createDataset(workspaceId, projectId, fedDataset(sourceId));

    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    const plan = generated.plan;

    const visual = await client.narrative.visualPlan(workspaceId, projectId, plan.id);
    expect(visual.grammarVersion).toBe('visual-grammar-v1');
    expect(visual.planId).toBe(plan.id);
    expect(visual.items.length).toBe(plan.narrationBlocks.length);
    expect(new Set(visual.items.map((item) => item.narrationBlockId))).toEqual(new Set(plan.narrationBlocks.map((block) => block.id)));

    for (const item of visual.items) {
      expect(item.allowedSceneTypes.length).toBeGreaterThan(0);
      expect(item.recognition.method).toBe('DETERMINISTIC');
      if (item.fallbackStrategy === null) {
        // 未降级：建议场景类型必须落在允许集合内（固定语义 → 允许类型）
        expect(item.allowedSceneTypes, `${item.semanticType} → ${item.suggestedSceneType}`).toContain(item.suggestedSceneType);
      } else {
        // 降级：必须带明确原因（可审计）
        expect(item.warnings.length).toBeGreaterThan(0);
      }
      if (item.datasetId !== null) {
        // §10.3 MUST：图表 Scene 必须保存 data_source_ids（且只能来自可绑定数据集）
        expect(item.dataSourceIds.length).toBeGreaterThan(0);
        expect(item.fallbackStrategy).toBeNull();
      }
    }

    const claims = await client.evidence.claims(workspaceId, projectId);
    const rateClaimIds = new Set(claims.filter((claim) => claim.text.includes('利率')).map((claim) => claim.id));
    const rate = rateItem(visual.items, rateClaimIds);
    expect(rate.semanticType).toBe('PRICE_SERIES');
    expect(rate.datasetId).toBe(dataset.id);
    expect(rate.dataSourceIds).toContain(sourceId);
    expect(rate.suggestedSceneType).toBe('LINE_CHART');
    expect(rate.allowedSceneTypes).toContain('LINE_CHART');
    expect(rate.fallbackStrategy).toBeNull();

    expect(visual.summary.total).toBe(visual.items.length);
    expect(visual.summary.chartItems).toBe(visual.items.filter((item) => item.datasetId !== null).length);
    expect(visual.summary.bySemanticType['PRICE_SERIES']).toBeGreaterThanOrEqual(1);

    // 纯投影：同输入两次读取完全一致（可重复、可审计）
    const again = await client.narrative.visualPlan(workspaceId, projectId, plan.id);
    expect(JSON.stringify(again)).toBe(JSON.stringify(visual));
  });

  it('数据不足受控降级：仅 synthetic 数据集 → 不绑定图表，降级为 QUOTE/SOURCE_CARD 并附原因', async () => {
    const { client } = await newClient('visual-degrade');
    const { workspaceId, projectId, documentId, sourceId } = await makeArticleProject(client);
    const synthetic = await client.evidence.createDataset(workspaceId, projectId, fedDataset(sourceId, { title: '演示数据', synthetic: true }));

    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 120_000 });
    const visual = await client.narrative.visualPlan(workspaceId, projectId, generated.plan.id);

    // synthetic 数据集绝不被绑定
    expect(visual.items.every((item) => item.datasetId !== synthetic.id)).toBe(true);

    const claims = await client.evidence.claims(workspaceId, projectId);
    const rateClaimIds = new Set(claims.filter((claim) => claim.text.includes('利率')).map((claim) => claim.id));
    const rate = rateItem(visual.items, rateClaimIds);
    expect(rate.datasetId).toBeNull();
    expect(rate.fallbackStrategy === 'QUOTE' || rate.fallbackStrategy === 'SOURCE_CARD').toBe(true);
    expect(['QUOTE_CARD', 'SOURCE_CARD']).toContain(rate.suggestedSceneType);
    expect(rate.warnings.length).toBeGreaterThan(0);
    expect(visual.summary.degradedItems).toBeGreaterThanOrEqual(1);
  });

  it('无可追溯来源的数值 → TEXTUAL_EXPLANATION（不得无出处做大字报）', async () => {
    const { client } = await newClient('visual-nosource');
    const workspace = await client.workspaces.create({ name: `无源-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '粘贴稿', channelId: channel.id });
    const record = await client.content.create(workspace.id, project.id, { sourceType: 'PASTED_TEXT', text: PASTED_TEXT });
    await client.evidence.extract(workspace.id, project.id, record.document.id);

    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 90_000 });
    const visual = await client.narrative.visualPlan(workspace.id, project.id, generated.plan.id);

    const claims = await client.evidence.claims(workspace.id, project.id);
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims.every((claim) => claim.sourceIds.length === 0)).toBe(true);
    const numericClaimIds = new Set(claims.filter((claim) => claim.text.includes('3%')).map((claim) => claim.id));
    const item = rateItem(visual.items, numericClaimIds);
    expect(item.semanticType).toBe('PERCENT_CHANGE');
    expect(item.datasetId).toBeNull();
    expect(item.fallbackStrategy).toBe('TEXTUAL_EXPLANATION');
    expect(item.suggestedSceneType).toBe('SUMMARY');
    expect(item.warnings.length).toBeGreaterThan(0);
  });

  it('隔离与反枚举：跨租户/未知计划 → 404', async () => {
    const { client } = await newClient('visual-isolation');
    const { workspaceId, projectId, documentId } = await makeArticleProject(client);
    llm.scriptNext('valid');
    const generated = await client.narrative.generate(workspaceId, projectId, documentId, { targetDurationMs: 90_000 });

    const { client: intruder } = await newClient('visual-intruder');
    const crossed = await intruder.narrative.visualPlan(workspaceId, projectId, generated.plan.id).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);

    const missing = await client.narrative.visualPlan(workspaceId, projectId, 'plan_missing_visual').catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AncsApiError);
    expect((missing as AncsApiError).status).toBe(404);
  });
});
