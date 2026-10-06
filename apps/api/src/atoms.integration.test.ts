import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P11-02 验收（真实 DB）：
 * - **Atom 可独立追溯来源**：claimId/sourceId 必须真实存在于项目内——悬空引用 422；合法创建后 Atom 携带引用；
 * - **Recipe 版本化数据**：官方种子幂等（三渠道）；需求为数据；
 * - **Channel Fit 规则化评估**：RECOMMENDED / OPTIONAL / **NOT_RECOMMENDED（200 正常结果 + BLOCKING 原因）**；
 *   输入快照可复核；未知渠道 404。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p><p>核心通胀升至 3.2%。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
const PASSWORD = 'password-1234';
const deps = (): DomainDeps => ({ db: handle.db });

class ScriptedFetcher implements ArticleFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { contentType: string | null; bytes: Uint8Array }>();
  async fetch(input: { url: string }): Promise<{ finalUrl: string; contentType: string | null; bytes: Uint8Array }> {
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
  auth = createAuth({ db: handle.db, secret: 'atoms-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeProjectWithContent(client: AncsClient): Promise<{ workspaceId: string; projectId: string; claimIds: string[]; sourceId: string }> {
  const workspace = await client.workspaces.create({ name: `Atom-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const projectClaims = await client.evidence.claims(workspace.id, project.id);
  const sources = await client.content.sources(workspaceId2(workspace), project.id);
  return { workspaceId: workspace.id, projectId: project.id, claimIds: projectClaims.map((claim) => claim.id), sourceId: sources[0]?.id ?? '' };
}
const workspaceId2 = (workspace: { id: string }): string => workspace.id;

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Atom / Recipe / Fit（P11-02）', () => {
  it('Atom 追溯：合法创建（claim 引用）与悬空引用 422；列表携带来源', async () => {
    const client = await newClient('atom-main');
    const { workspaceId, projectId, claimIds, sourceId } = await makeProjectWithContent(client);
    expect(claimIds.length).toBeGreaterThan(0);

    // 合法：引用真实 claim
    const atom = await client.content.atoms.create(workspaceId, projectId, {
      kind: 'KEY_NUMBER',
      title: '利率维持 5.25%',
      text: '联邦基金利率维持在 5.25% 不变。',
      sourceRefs: [{ claimId: claimIds[0] as string }],
      payload: { value: 5.25, unit: '%' },
    });
    expect(atom.kind).toBe('KEY_NUMBER');
    expect(atom.sourceRefs[0]?.claimId).toBe(claimIds[0]);

    // 合法：引用真实 source
    const bySource = await client.content.atoms.create(workspaceId, projectId, {
      kind: 'SUB_TOPIC',
      title: '通胀分主题',
      text: '核心通胀升至 3.2%。',
      sourceRefs: [{ sourceId }],
    });
    expect(bySource.sourceRefs[0]?.sourceId).toBe(sourceId);

    // 悬空引用 → 422（claim 与 source 均不存在——不可追溯）
    await expectApiError(
      client.content.atoms.create(workspaceId, projectId, {
        kind: 'CONCLUSION',
        title: '无来源结论',
        text: '凭空结论（应被拒绝）。',
        sourceRefs: [{ claimId: 'claim_nonexistent' }],
      }),
      422,
      'SOURCE_REF_NOT_TRACEABLE',
    );

    const listed = await client.content.atoms.list(workspaceId, projectId);
    expect(listed).toHaveLength(2);
  }, 120_000);

  it('Recipe：官方种子幂等（三渠道、需求为数据）；Fit：有数字 Atom → RECOMMENDED；空内容 → NOT_RECOMMENDED（200 + BLOCKING）', async () => {
    const client = await newClient('atom-fit');
    const { workspaceId, projectId, claimIds } = await makeProjectWithContent(client);

    // 种子幂等：目录六渠道（视频三 + P12-03 文字三；每次请求都 ensure，行不重复）
    const recipes = await client.content.channelRecipes.list(workspaceId);
    expect(recipes.map((recipe) => recipe.channelKey).sort()).toEqual(['CAROUSEL', 'NEWSLETTER', 'SHORT_INSIGHT', 'TEXT_POST', 'TEXT_THREAD', 'YOUTUBE_EXPLAINER']);
    const recipesAgain = await client.content.channelRecipes.list(workspaceId);
    expect(recipesAgain.map((recipe) => recipe.id).sort()).toEqual(recipes.map((recipe) => recipe.id).sort());

    // 空内容（无 Atom）→ SHORT_INSIGHT 需要数字 Atom → NOT_RECOMMENDED（200 正常结果）
    const notRecommended = await client.content.channelFit(workspaceId, projectId, 'SHORT_INSIGHT');
    expect(notRecommended.verdict).toBe('NOT_RECOMMENDED');
    expect(notRecommended.reasons.some((reason) => reason.code === 'NO_NUMBER_ATOMS' && reason.severity === 'BLOCKING')).toBe(true);

    // 创建关键数字 Atom → SHORT_INSIGHT → RECOMMENDED（全条件 SATISFIED）
    await client.content.atoms.create(workspaceId, projectId, {
      kind: 'KEY_NUMBER',
      title: '利率维持 5.25%',
      text: '联邦基金利率维持在 5.25% 不变。',
      sourceRefs: [{ claimId: claimIds[0] as string }],
      payload: { value: 5.25, unit: '%' },
    });
    const recommended = await client.content.channelFit(workspaceId, projectId, 'SHORT_INSIGHT');
    expect(recommended.verdict).toBe('RECOMMENDED');
    expect(recommended.reasons.every((reason) => reason.severity !== 'BLOCKING')).toBe(true);
    expect(recommended.inputs.numberAtomCount).toBe(1);
    expect(recommended.inputs.coreInputsDigest).toBeNull(); // 未迁移核心——评估不阻断

    // 未知渠道 → 404
    await expectApiError(client.content.channelFit(workspaceId, projectId, 'TIKTOK_STORYTIME'), 404, 'CHANNEL_NOT_FOUND');
  }, 120_000);

  it('Fit OPTIONAL 与 BLOCKING 边界：CAROUSEL 素材薄 → OPTIONAL；YOUTUBE_EXPLAINER 事实不足 → NOT_RECOMMENDED；迁移后 digest 随评估输出', async () => {
    const client = await newClient('atom-optional');
    const { workspaceId, projectId, claimIds } = await makeProjectWithContent(client);

    // CAROUSEL：minAtoms=3 —— 仅 1 条 Atom → OPTIONAL（MATERIAL_THIN 为 ADVISORY）
    await client.content.atoms.create(workspaceId, projectId, {
      kind: 'SUB_TOPIC',
      title: '通胀分主题',
      text: '核心通胀升至 3.2%。',
      sourceRefs: [{ claimId: claimIds[0] as string }],
    });
    const optional = await client.content.channelFit(workspaceId, projectId, 'CAROUSEL');
    expect(optional.verdict).toBe('OPTIONAL');
    expect(optional.reasons.some((reason) => reason.code === 'MATERIAL_THIN' && reason.severity === 'ADVISORY')).toBe(true);
    expect(optional.reasons.some((reason) => reason.severity === 'BLOCKING')).toBe(false);

    // YOUTUBE_EXPLAINER：minFacts=2 —— 确定性抽取可能只产出少量 fact 事实；如不足 → NOT_RECOMMENDED
    const youtube = await client.content.channelFit(workspaceId, projectId, 'YOUTUBE_EXPLAINER');
    if (youtube.inputs.factCount < 2) {
      expect(youtube.verdict).toBe('NOT_RECOMMENDED');
      expect(youtube.reasons.some((reason) => reason.code === 'INSUFFICIENT_VERIFIED_FACTS')).toBe(true);
    } else {
      expect(youtube.verdict).not.toBe('NOT_RECOMMENDED');
    }

    // 迁移核心后再评估 → digest 随输入快照返回（血缘可复核）
    await client.content.contentCore.migrate(workspaceId, projectId);
    const afterCore = await client.content.channelFit(workspaceId, projectId, 'CAROUSEL');
    expect(afterCore.inputs.coreInputsDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);
});
