import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P04-02 验收（HTTP + SDK，真实 DB）：
 * - **每个事实图表可追溯**：Claim → Citation(块+字符区间) → Source(url/contentHash)；Dataset → sourceIds；
 * - **缺数据不会自动生成虚构数列**：无数据集 → 降级阶梯（QUOTE/SOURCE_CARD/TEXTUAL_EXPLANATION/REQUEST_DATA）；
 *   synthetic / 空 / 无来源的数据集一律拒绝绑定事实图表；
 * - fact 类 Claim 必须有来源；锁定后拒绝修改；跨租户 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1>
<p>联邦基金利率维持在 5.25% 不变，为 2024 年以来的最高水平。</p>
<p>分析师预计 2025 年可能降息 2 个百分点，因为通胀压力缓解。</p>
<ul><li>美国 2024 年 GDP 增长 2.5%</li></ul>
</body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

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
    secret: 'evidence-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher },
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

async function makeProjectWithUrlArticle(client: AncsClient): Promise<{ workspaceId: string; projectId: string; documentId: string; sourceId: string }> {
  const workspace = await client.workspaces.create({ name: `证据-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '证据项目', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  const sources = await client.content.sources(workspace.id, project.id);
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id, sourceId: sources[0]?.id ?? '' };
}

const pngDataset = (sourceId: string, overrides: Record<string, unknown> = {}) => ({
  title: '联邦基金利率',
  unit: '%',
  sourceIds: [sourceId],
  synthetic: false,
  series: [
    {
      id: 'ser_fed_funds',
      name: '联邦基金利率',
      points: [
        { t: '2024', v: 5.25, accuracy: 'anchor' as const },
        { t: '2025', v: 3.25, accuracy: 'anchor' as const },
      ],
    },
  ],
  ...overrides,
});

describe('证据与数据（P04-02）', () => {
  it('抽取：Claim 带 Citation（块+字符区间+引文）与数值归一；可追溯链完整', async () => {
    const { client } = await newClient('evidence-extract');
    const { workspaceId, projectId, documentId, sourceId } = await makeProjectWithUrlArticle(client);

    const extraction = await client.evidence.extract(workspaceId, projectId, documentId);
    expect(extraction.method).toBe('DETERMINISTIC');
    expect(extraction.summary.claimCount).toBeGreaterThanOrEqual(2);
    expect(extraction.summary.numericCount).toBeGreaterThanOrEqual(3);
    expect(extraction.summary.timelineCount).toBeGreaterThanOrEqual(1);

    // 数值归一：5.25% → PERCENT；"2 个百分点" → PERCENT；"2.5%" → PERCENT
    const percentMentions = extraction.numericMentions.filter((mention) => mention.canonical === 'PERCENT');
    expect(percentMentions.some((mention) => mention.value === 5.25)).toBe(true);
    expect(percentMentions.some((mention) => mention.unit === '个百分点')).toBe(true);
    // 原始文本保留（可复核）
    expect(percentMentions.some((mention) => mention.raw.includes('5.25'))).toBe(true);

    // Claim 与 Citation
    const claims = await client.evidence.claims(workspaceId, projectId);
    expect(claims.length).toBeGreaterThanOrEqual(2);
    const rateClaim = claims.find((claim) => claim.text.includes('5.25%'));
    expect(rateClaim).toBeDefined();
    expect(rateClaim?.factuality).toBe('fact');
    expect(rateClaim?.sourceIds).toEqual([sourceId]);
    expect(rateClaim?.extraction).toMatchObject({ method: 'DETERMINISTIC', confidence: 1 });

    const citations = await client.evidence.citations(workspaceId, projectId, rateClaim?.id ?? '');
    expect(citations).toHaveLength(1);
    expect(citations[0]?.sourceId).toBe(sourceId);
    expect(citations[0]?.locator).toMatch(/^blk_[a-f0-9]+_[a-f0-9]+:\d+-\d+$/); // 块 ID + 字符区间（blk_<doc>_<digest>:start-end）
    expect(citations[0]?.quotedText).toContain('5.25%');

    // 幂等：重复抽取不重复创建 Claim
    const second = await client.evidence.extract(workspaceId, projectId, documentId);
    expect(second.summary.claimCount).toBe(0);
    expect((await client.evidence.claims(workspaceId, projectId)).length).toBe(claims.length);
  });

  it('可追溯链：Citation → Source（URL/内容哈希）可解析；跨项目来源被拒', async () => {
    const { client } = await newClient('evidence-chain');
    const { workspaceId, projectId, documentId, sourceId } = await makeProjectWithUrlArticle(client);
    await client.evidence.extract(workspaceId, projectId, documentId);
    const sources = await client.content.sources(workspaceId, projectId);
    const citedSource = sources.find((source) => source.id === sourceId);
    expect(citedSource).toBeDefined();
    expect(citedSource?.url).toContain('news.example');
    expect(citedSource?.contentHash).toMatch(/^[0-9a-f]{64}$/);

    // 跨项目引用来源 → 拒绝（SOURCE_NOT_IN_PROJECT）
    const otherProjectSameWorkspace = await client.projects.create(workspaceId, {
      title: '另一个项目',
      channelId: (await client.channels.create(workspaceId, { name: '另一栏目' })).id,
    });
    const failure = await client.evidence
      .createClaim(workspaceId, otherProjectSameWorkspace.id, { text: '跨项目引用', factuality: 'fact', sourceIds: [sourceId] })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ status: 422 });
    expect((failure as AncsApiError).details['reason']).toBe('SOURCE_NOT_IN_PROJECT');
  });

  it('fact 类 Claim 必须有来源；锁定后拒绝修改（§8.2）', async () => {
    const { client } = await newClient('evidence-claim-rules');
    const { workspaceId, projectId, sourceId } = await makeProjectWithUrlArticle(client);

    // 无来源的 fact → 422
    const noSource = await client.evidence
      .createClaim(workspaceId, projectId, { text: '没有来源的事实陈述', factuality: 'fact' })
      .catch((error: unknown) => error);
    expect(noSource).toMatchObject({ status: 422 });
    expect((noSource as AncsApiError).details['reason']).toBe('CLAIM_REQUIRES_SOURCE');

    // 带来源的 fact → 成功并自动建 Citation
    const created = await client.evidence.createClaim(workspaceId, projectId, {
      text: '联邦基金利率为 5.25%',
      factuality: 'fact',
      sourceIds: [sourceId],
      locator: 'manual',
      quotedText: '联邦基金利率维持在 5.25% 不变',
    });
    expect(created.claim.sourceIds).toEqual([sourceId]);
    expect(created.citations).toHaveLength(1);

    // 锁定 → 修改内容被拒（409 CLAIM_LOCKED）；解锁后可改
    const locked = await client.evidence.updateClaim(workspaceId, projectId, created.claim.id, { locked: true });
    expect(locked.locked).toBe(true);
    const blocked = await client.evidence
      .updateClaim(workspaceId, projectId, created.claim.id, { text: '试图静默修改' })
      .catch((error: unknown) => error);
    expect(blocked).toMatchObject({ status: 409 });
    expect((blocked as AncsApiError).details['reason']).toBe('CLAIM_LOCKED');
    await client.evidence.updateClaim(workspaceId, projectId, created.claim.id, { locked: false });
    const edited = await client.evidence.updateClaim(workspaceId, projectId, created.claim.id, { text: '修订后的陈述（已解锁）' });
    expect(edited.text).toBe('修订后的陈述（已解锁）');
  });

  it('缺数据不会自动生成虚构数列：降级阶梯 + 数据集绑定门控', async () => {
    const { client } = await newClient('evidence-fallback');
    const { workspaceId, projectId, documentId, sourceId } = await makeProjectWithUrlArticle(client);
    await client.evidence.extract(workspaceId, projectId, documentId);
    const claims = await client.evidence.claims(workspaceId, projectId);
    const claim = claims[0];
    expect(claim).toBeDefined();

    // 无数据集 → 有引文 → QUOTE（绝不编造）
    const quoteDecision = await client.evidence.factVisual(workspaceId, projectId, claim?.id ?? '');
    expect(quoteDecision.strategy).toBe('QUOTE');
    expect(quoteDecision.quoteText).toBeTruthy();
    expect(quoteDecision.dataSourceIds).toEqual([]);

    // synthetic 数据集：允许存在，但**不可绑定事实图表**
    const synthetic = await client.evidence.createDataset(workspaceId, projectId, pngDataset(sourceId, { title: '演示数据', synthetic: true }));
    const syntheticDecision = await client.evidence.factVisual(workspaceId, projectId, claim?.id ?? '', { datasetId: synthetic.id });
    expect(syntheticDecision.strategy).toBe('QUOTE'); // 仍降级：合成数据不参与事实图表
    const syntheticCheck = await client.evidence.datasetBindingCheck(workspaceId, projectId, synthetic.id).catch((error: unknown) => error);
    expect(syntheticCheck).toMatchObject({ status: 422 });
    expect((syntheticCheck as AncsApiError).details['reason']).toBe('SYNTHETIC_DATASET_NOT_BINDABLE');

    // 真实数据集（有来源、非空）→ CHART，且给出 data_source_ids
    const real = await client.evidence.createDataset(workspaceId, projectId, pngDataset(sourceId));
    const chartDecision = await client.evidence.factVisual(workspaceId, projectId, claim?.id ?? '', { datasetId: real.id });
    expect(chartDecision.strategy).toBe('CHART');
    expect(chartDecision.datasetId).toBe(real.id);
    expect(chartDecision.dataSourceIds).toEqual([sourceId]); // 图表 Scene 必须保存的 data_source_ids

    const binding = await client.evidence.datasetBindingCheck(workspaceId, projectId, real.id);
    expect(binding).toMatchObject({ bindable: true, pointCount: 2, dataSourceIds: [sourceId] });

    // 无来源的数据集 → 422 DATASET_REQUIRES_SOURCE（缺数据只能补，不能编）
    const withoutSource = await client.evidence
      .createDataset(workspaceId, projectId, pngDataset(sourceId, { sourceIds: [] }))
      .catch((error: unknown) => error);
    expect(withoutSource).toMatchObject({ status: 422 });
    expect((withoutSource as AncsApiError).details['reason']).toBe('DATASET_REQUIRES_SOURCE');

    // 空数据集 → 422 DATASET_EMPTY（不得渲染空图表）
    const empty = await client.evidence
      .createDataset(workspaceId, projectId, pngDataset(sourceId, { series: [{ id: 'ser_empty', name: '空序列', points: [] }] }))
      .catch((error: unknown) => error);
    expect(empty).toMatchObject({ status: 422 });
    expect((empty as AncsApiError).details['reason']).toBe('DATASET_EMPTY');
  });

  it('粘贴文本（无可追溯来源）：fact 降级为 uncertain 并给出提示；策略为 TEXTUAL_EXPLANATION/REQUEST_DATA', async () => {
    const { client } = await newClient('evidence-pasted');
    const workspace = await client.workspaces.create({ name: `粘贴-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '粘贴项目', channelId: channel.id });
    const record = await client.content.create(workspace.id, project.id, {
      sourceType: 'PASTED_TEXT',
      text: '联邦基金利率维持在 5.25% 不变。\n这可能只是暂时现象。',
    });
    const extraction = await client.evidence.extract(workspace.id, project.id, record.document.id);
    expect(extraction.summary.notes.some((note) => note.includes('无可追溯来源'))).toBe(true);

    const claims = await client.evidence.claims(workspace.id, project.id);
    const rateClaim = claims.find((claim) => claim.text.includes('5.25%'));
    expect(rateClaim?.factuality).toBe('uncertain'); // 无来源 → 不得声称事实
    expect(rateClaim?.sourceIds).toEqual([]);

    const decision = await client.evidence.factVisual(workspace.id, project.id, rateClaim?.id ?? '');
    expect(decision.strategy).toBe('TEXTUAL_EXPLANATION'); // 无可追溯来源 → 仅文本解释
    expect(decision.datasetId).toBeNull();
  });

  it('越权：跨租户不可读写 Claim/Dataset（404）', async () => {
    const owner = await newClient('evidence-owner');
    const stranger = await newClient('evidence-stranger');
    const { workspaceId, projectId, documentId } = await makeProjectWithUrlArticle(owner.client);
    await owner.client.evidence.extract(workspaceId, projectId, documentId);
    const claimId = (await owner.client.evidence.claims(workspaceId, projectId))[0]?.id ?? '';

    const strangerClaims = await stranger.client.evidence.claims(workspaceId, projectId).catch((error: unknown) => error);
    expect(strangerClaims).toMatchObject({ status: 404 });
    const strangerUpdate = await stranger.client.evidence
      .updateClaim(workspaceId, projectId, claimId, { locked: true })
      .catch((error: unknown) => error);
    expect(strangerUpdate).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const strangerExtract = await stranger.client.evidence
      .extract(workspaceId, projectId, documentId)
      .catch((error: unknown) => error);
    expect(strangerExtract).toMatchObject({ status: 404 });
  });
});
