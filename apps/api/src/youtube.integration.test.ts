import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, renderApprovals, renders, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { MockYoutubeClient, YoutubeDistributionProvider, publicationKeyTag } from '@ancs/providers-youtube';
import type { ArticleFetcher, DistributionProvider } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P13-02 验收（真实 DB；**真实远端 BLOCKED OAuth 凭据——Mock 同构回放，不冒充**）：
 * YouTube 官方 API 参考实现经 YoutubeApiClient seam：
 * - 上传/元数据/状态/排期能力（能力矩阵与 Provider 声明一致）；
 * - **超时恢复不重复创建**：publish 上传后响应超时（结果未知）→ 行 FAILED 无 remoteId →
 *   reconcile 按幂等键回查远端 → 采纳既有上传 → PUBLISHED；**重复请求 deduped 不重发**
 *   （client.uploadCalls 恒为 1——远端恰一份上传）；
 * - AIGC 披露逐字进描述；validate 平台限制（标题 100 字符）。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。</p></body></html>`;

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
let youtubeClient: MockYoutubeClient;
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
  auth = createAuth({ db: handle.db, secret: 'youtube-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  youtubeClient = new MockYoutubeClient();
  const youtube = new YoutubeDistributionProvider(youtubeClient, async () => ({ accessToken: 'test-only-token' })); // secrets:check-ignore：测试专用假密钥
  const providers: DistributionProvider[] = [youtube];
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
    distribution: { providers },
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
  youtubeClient.remote.clear();
  youtubeClient.uploadCalls = 0;
  youtubeClient.failureMode = 'none';
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeApprovedRender(client: AncsClient): Promise<{ workspaceId: string; projectId: string; versionId: string; outputAssetId: string }> {
  const workspace = await client.workspaces.create({ name: `yt-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/yt/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  llm.scriptNext('valid');
  await client.narrative.generate(workspace.id, project.id, record.document.id, { targetDurationMs: 60_000 });
  const version = await client.projects.versions.create(project.id, { reason: 'FINAL_RENDER' });
  const outputAssetId = `ast_out_${randomUUID().slice(0, 8)}`;
  const manifestHash = `sha256-${randomUUID()}`;
  const render = await handle.db
    .insert(renders)
    .values({
      id: `rnd_${randomUUID()}`,
      workspaceId: workspace.id,
      projectId: project.id,
      profile: '1080p',
      status: 'READY',
      input: { projectVersionId: version.id },
      manifestHash,
      outputAssetIds: [outputAssetId],
    })
    .returning();
  await handle.db.insert(renderApprovals).values({
    id: `rapp_${randomUUID()}`,
    workspaceId: workspace.id,
    projectId: project.id,
    renderId: render[0]!.id,
    decision: 'APPROVED',
    manifestHashAtApproval: manifestHash,
    projectVersionIdAtApproval: version.id,
    projectRevisionAtApproval: 1,
  });
  return { workspaceId: workspace.id, projectId: project.id, versionId: version.id, outputAssetId };
}

describe('YouTube Provider（P13-02）', () => {
  it('发布：上传 + 元数据（标题/描述/AIGC 披露逐字）+ 排期字段；状态回填远端引用', async () => {
    const client = await newClient('yt-main');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client);
    const result = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'youtube', accountId: 'yt-account-1', projectVersionId: versionId, outputAssetId },
      title: '利率维持 5.25%',
      description: '每周利率解读',
      disclosure: '本视频包含 AI 生成内容',
    });
    expect(result.publication.state).toBe('PUBLISHED');
    expect(result.publication.remoteId).toMatch(/^yt-\d{3}$/);
    expect(result.publication.remoteUrl).toContain('youtube.com/watch');
    // 元数据：AIGC 披露逐字进描述；幂等标签双写（超时恢复依据）
    const remote = youtubeClient.remote.get(result.publication.remoteId ?? '');
    expect(remote?.description).toContain('【披露】本视频包含 AI 生成内容');
    expect(remote?.description).toContain(publicationKeyTag({ platformId: 'youtube', accountId: 'yt-account-1', projectVersionId: versionId, outputAssetId }));
    expect(youtubeClient.uploadCalls).toBe(1);
  }, 120_000);

  it('**超时恢复不重复创建**：上传后响应超时 → FAILED（无 remoteId）→ reconcile 按幂等键回查采纳 → PUBLISHED；重复请求 deduped（远端恰一份上传）', async () => {
    const client = await newClient('yt-timeout');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client);
    youtubeClient.failureMode = 'timeout_after_upload';

    // 发布：远端已上传但响应超时 → 结果未知 → API 502 + 行 FAILED（无 remoteId；不自动重发）
    await expectApiError(
      client.publications.request(workspaceId, projectId, {
        publicationKey: { platformId: 'youtube', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
        title: '利率维持 5.25%',
      }),
      502,
      'PROVIDER_PUBLISH_FAILED',
    );
    const failedList = await client.publications.list(workspaceId, projectId);
    const failedPublication = failedList.items.find((item) => item.accountId === 'acc-1');
    expect(failedPublication?.state).toBe('FAILED');
    expect(failedPublication?.remoteId).toBeNull();
    expect(youtubeClient.uploadCalls).toBe(1); // 远端实际已上传一份

    // 对账：按幂等键回查远端 → 采纳既有上传（不重复创建）
    const reconciled = await client.publications.reconcile(workspaceId, projectId, failedPublication!.id);
    expect(reconciled.state).toBe('PUBLISHED');
    expect(reconciled.remoteId).toMatch(/^yt-\d{3}$/);
    expect(reconciled.publishedAt).not.toBeNull();

    // 重复请求 → deduped（不重发；远端仍恰一份）
    const again = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'youtube', accountId: 'acc-1', projectVersionId: versionId, outputAssetId },
      title: '利率维持 5.25%',
    });
    expect(again.deduped).toBe(true);
    expect(again.publication.id).toBe(reconciled.id);
    expect(youtubeClient.uploadCalls).toBe(1);
    expect(youtubeClient.remote.size).toBe(1);
  }, 120_000);

  it('平台限制校验：标题超 100 字符 → validate 拒绝（FAILED + PROVIDER_VALIDATION_FAILED）；scheduledAt 记录（排期能力）', async () => {
    const client = await newClient('yt-validate');
    const { workspaceId, projectId, versionId, outputAssetId } = await makeApprovedRender(client);

    const scheduledAt = new Date(Date.now() + 86_400_000).toISOString();
    const result = await client.publications.request(workspaceId, projectId, {
      publicationKey: { platformId: 'youtube', accountId: 'acc-2', projectVersionId: versionId, outputAssetId },
      title: '利率维持 5.25%',
      scheduledAt,
    });
    expect(result.publication.scheduledAt).toBe(scheduledAt);

    // 标题 101 字符 → Provider validate error → 422 + 行 FAILED
    await expectApiError(
      client.publications.request(workspaceId, projectId, {
        publicationKey: { platformId: 'youtube', accountId: 'acc-3', projectVersionId: versionId, outputAssetId },
        title: '超'.repeat(101),
      }),
      422,
      'PROVIDER_VALIDATION_FAILED',
    );
    const failed = await client.publications.list(workspaceId, projectId);
    const failedRow = failed.items.find((item) => item.accountId === 'acc-3');
    expect(failedRow?.state).toBe('FAILED');
    expect(failedRow?.lastError).toContain('PROVIDER_VALIDATION_FAILED');
    expect(youtubeClient.remote.size).toBe(1); // 校验拒绝不上传
  }, 120_000);
});

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}
