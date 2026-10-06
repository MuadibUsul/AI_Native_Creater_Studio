import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, publications, redactDatabaseUrl, renderApprovals, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { createMockDistributionProvider, ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { and, eq } from 'drizzle-orm';
import type { ArticleFetcher } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P13-01 验收（真实 DB）：发布核心（Publication / 能力分级 / 验证 / 状态查询 / 对账）。
 * - **未批准版本不能发布**（无批准 / manifest 漂移 / 输出资产不属于该版本 → 明确拒绝）；
 * - **重复请求只形成一个逻辑发布**（幂等键四元组唯一；deduped=true；不重发）；
 * - **结果未知时先查询和对账**（reconcile 以 Provider getStatus 为准回填——绝不自动重发）；
 * - 能力分级：无 DIRECT_PUBLISH 能力的平台明确拒绝（与真实 capability 一致）；未注册 501。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。</p></body></html>`;

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
  auth = createAuth({ db: handle.db, secret: 'publications-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
    distribution: { providers: [createMockDistributionProvider(), createMockDistributionProvider({ providerId: 'mock.p4', capabilities: ['EXPORT_PACKAGE', 'UPLOAD_DRAFT'] })] },
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

/** 建项目 + 冻结版本 + 产出该版本的 Render（outputAssetIds）+ 可选批准。 */
async function makeProjectWithRender(client: AncsClient, options: { approve: boolean; manifestHash?: string }): Promise<{
  workspaceId: string;
  projectId: string;
  versionId: string;
  outputAssetId: string;
}> {
  const workspace = await client.workspaces.create({ name: `发布-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/pub/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 60_000 });

  const version = await client.projects.versions.create(project.id, { reason: 'FINAL_RENDER' });
  const outputAssetId = `ast_out_${randomUUID().slice(0, 8)}`;
  const manifestHash = options.manifestHash ?? `sha256-${randomUUID()}`;
  await handle.db.insert(renders).values({
    id: `rnd_${randomUUID()}`,
    workspaceId: workspace.id,
    projectId: project.id,
    profile: '1080p',
    status: 'READY',
    input: { projectVersionId: version.id },
    manifestHash,
    outputAssetIds: [outputAssetId],
  });
  if (options.approve) {
    await handle.db.insert(renderApprovals).values({
      id: `rapp_${randomUUID()}`,
      workspaceId: workspace.id,
      projectId: project.id,
      renderId: (await handle.db.select().from(renders).where(and(eq(renders.workspaceId, workspace.id), eq(renders.projectId, project.id))))[0]!.id,
      decision: 'APPROVED',
      manifestHashAtApproval: manifestHash,
      projectVersionIdAtApproval: version.id,
      projectRevisionAtApproval: 1,
    });
  }
  return { workspaceId: workspace.id, projectId: project.id, versionId: version.id, outputAssetId };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('发布核心（P13-01）', () => {
  it('未批准版本不能发布：无批准 → 409；manifest 漂移 → 409；输出资产不属于该版本 → 422', async () => {
    const client = await newClient('pub-gates');
    // 无批准
    const a = await makeProjectWithRender(client, { approve: false });
    await expectApiError(
      client.publications.request(a.workspaceId, a.projectId, {
        publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: a.versionId, outputAssetId: a.outputAssetId },
        title: '利率周报',
      }),
      409,
      'NOT_APPROVED',
    );

    // manifest 漂移（批准的 hash ≠ Render 当前 hash）
    const b = await makeProjectWithRender(client, { approve: true, manifestHash: 'sha256-approved' });
    await handle.db
      .update(renders)
      .set({ manifestHash: 'sha256-drifted' })
      .where(and(eq(renders.workspaceId, b.workspaceId), eq(renders.projectId, b.projectId)));
    await expectApiError(
      client.publications.request(b.workspaceId, b.projectId, {
        publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: b.versionId, outputAssetId: b.outputAssetId },
        title: '利率周报',
      }),
      409,
      'NOT_APPROVED',
    );

    // 输出资产不属于该版本的任何 Render
    const c = await makeProjectWithRender(client, { approve: true });
    await expectApiError(
      client.publications.request(c.workspaceId, c.projectId, {
        publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: c.versionId, outputAssetId: 'ast_not-mine' },
        title: '利率周报',
      }),
      422,
      'OUTPUT_ASSET_UNKNOWN',
    );
  }, 120_000);

  it('批准后发布成功；**重复请求只形成一个逻辑发布**（deduped=true；不重发）', async () => {
    const client = await newClient('pub-idem');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeProjectWithRender(client, { approve: true });

    const first = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
      title: '利率周报',
      description: ' weekly',
      disclosure: '含 AI 生成内容',
    });
    expect(first.deduped).toBe(false);
    expect(first.publication.state).toBe('PUBLISHED');
    expect(first.publication.remoteId).toContain('mock-remote');
    expect(first.publication.remoteUrl).toContain('mock.platform/watch');
    expect(first.publication.publishedAt).not.toBeNull();
    expect(first.publication.disclosure).toBe('含 AI 生成内容');

    // 重复请求（同四元组）→ 命中既有逻辑发布；不产生第二行、不重发
    const second = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
      title: '利率周报（改标题也不重发）',
    });
    expect(second.deduped).toBe(true);
    expect(second.publication.id).toBe(first.publication.id);
    expect(second.publication.title).toBe('利率周报'); // 既有行不被覆盖

    // 恰一行
    const list = await client.publications.list(workspaceId, projectId);
    expect(list.items).toHaveLength(1);

    // 状态查询单条
    const got = await client.publications.get(workspaceId, projectId, first.publication.id);
    expect(got.state).toBe('PUBLISHED');
  }, 120_000);

  it('对账以 Provider 为准（不自动重发）；能力分级：无 DIRECT_PUBLISH → 422；未注册平台 → 501', async () => {
    const client = await newClient('pub-recon');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeProjectWithRender(client, { approve: true });
    const created = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'mock.platform', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
      title: '利率周报',
    });

    // 模拟"结果未知"（本地状态被改写为 PUBLISHING）→ reconcile 以 Provider getStatus 为准回到 PUBLISHED
    await handle.db
      .update(publications)
      .set({ state: 'PUBLISHING' })
      .where(and(eq(publications.id, created.publication.id), eq(publications.workspaceId, workspaceId)));
    const reconciled = await client.publications.reconcile(workspaceId, projectId, created.publication.id);
    expect(reconciled.state).toBe('PUBLISHED');
    expect(reconciled.remoteId).toBe(created.publication.remoteId); // 远端引用不变——没有重发

    // 能力分级：P4 平台（无 DIRECT_PUBLISH）→ 422
    await expectApiError(
      client.publications.request(workspaceId, projectId, {
        publicationKey: { platformId: 'mock.p4', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
        title: '利率周报',
      }),
      422,
      'CAPABILITY_MISSING',
    );

    // 未注册平台 → 501（真实平台接入随 P13-02/03；不冒充）
    await expectApiError(
      client.publications.request(workspaceId, projectId, {
        publicationKey: { platformId: 'youtube', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
        title: '利率周报',
      }),
      501,
      'PROVIDER_UNREGISTERED',
    );
  }, 120_000);
});
