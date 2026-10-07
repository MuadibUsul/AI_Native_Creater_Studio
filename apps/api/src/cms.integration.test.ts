import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import type { ArticleFetcher } from '@ancs/contracts';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { buildServer } from './server.js';

/**
 * P13-06 验收（真实 DB）：CMS 输入（机器建项目 + 摄取幂等 + 来源版本）。
 * - **同一事件重放不重复建项目**（contentHash 唯一 → deduped=true，项目/文档数量不变）；
 * - **正文变化产生新来源版本**（同 externalId 新 contentHash → 同项目新 ContentDocument，
 *   旧文档保留——来源版本历史）；
 * - URL 路径（抓取器）与 HTML 路径（直供）均可摄取。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;
let vault: LocalCredentialVault;
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
  auth = createAuth({ db: handle.db, secret: 'cms-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  llm = new MockLlmAdapter();
  vault = new LocalCredentialVault({ keys: `v1:${Buffer.alloc(32, 6).toString('base64')}` });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { articleFetcher: fetcher, llm },
    credentials: { cipher: vault },
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

async function makeWorkspaceWithChannel(client: AncsClient): Promise<{ workspaceId: string; channelId: string }> {
  const workspace = await client.workspaces.create({ name: `cms-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  return { workspaceId: workspace.id, channelId: channel.id };
}

describe('CMS 输入（P13-06）', () => {
  it('HTML 直供：机器建项目 + 摄取；**同一事件重放 deduped=true 不重复建项目**；正文变化 → 同项目新来源版本（旧文档保留）', async () => {
    const client = await newClient('cms-main');
    const { workspaceId, channelId } = await makeWorkspaceWithChannel(client);

    const html = '<html><body><h1>利率周报 v1</h1><p>联邦基金利率维持在 5.25% 不变。</p></body></html>';
    const first = await client.cms.ingest(workspaceId, {
      source: 'CMS_WEBHOOK',
      externalId: 'cms-article-001',
      title: '利率周报',
      channelId,
      content: { kind: 'HTML', html },
    });
    expect(first.deduped).toBe(false);
    expect(first.newSourceVersion).toBe(false);
    expect(first.ingestion.status).toBe('INGESTED');
    expect(first.ingestion.contentHash).toMatch(/^[0-9a-f]{64}$/);

    const projectsBefore = (await client.projects.list(workspaceId)).length;

    // **重放（同内容）**：deduped=true；同一项目/文档；不新建项目
    const replay = await client.cms.ingest(workspaceId, {
      source: 'CMS_WEBHOOK',
      externalId: 'cms-article-001',
      title: '利率周报（标题变化不影响幂等——hash 基于内容）',
      channelId,
      content: { kind: 'HTML', html },
    });
    expect(replay.deduped).toBe(true);
    expect(replay.projectId).toBe(first.projectId);
    expect(replay.documentId).toBe(first.documentId);
    expect((await client.projects.list(workspaceId)).length).toBe(projectsBefore);

    // **正文变化**：同 externalId 新 contentHash → 同项目新 ContentDocument（新来源版本）
    const changed = await client.cms.ingest(workspaceId, {
      source: 'CMS_WEBHOOK',
      externalId: 'cms-article-001',
      title: '利率周报',
      channelId,
      content: { kind: 'HTML', html: html.replace('5.25%', '5.50%') },
    });
    expect(changed.deduped).toBe(false);
    expect(changed.newSourceVersion).toBe(true);
    expect(changed.ingestion.status).toBe('NEW_SOURCE_VERSION');
    expect(changed.projectId).toBe(first.projectId);
    expect(changed.documentId).not.toBe(first.documentId);

    // 两个来源版本都在同一项目（旧版本保留）
    const docs = await client.content.list(workspaceId, changed.projectId);
    expect(docs).toHaveLength(2);

    // 摄取列表
    const list = await client.cms.list(workspaceId);
    expect(list.items).toHaveLength(2);
  }, 120_000);

  it('URL 路径（抓取器）：同 URL 重放 deduped（hash 基于内容字节）；首次建项目', async () => {
    const client = await newClient('cms-url');
    const { workspaceId, channelId } = await makeWorkspaceWithChannel(client);
    const url = `https://news.example/cms/${randomUUID()}`;
    fetcher.responses.set(url, {
      contentType: 'text/html; charset=utf-8',
      bytes: new TextEncoder().encode('<html><body><h1>发布事件</h1><p>核心通胀升至 3.2%。</p></body></html>'),
    });

    const first = await client.cms.ingest(workspaceId, {
      source: 'ARTICLE_PUBLISH',
      externalId: 'pub-77',
      title: '发布事件文章',
      channelId,
      content: { kind: 'URL', url },
    });
    expect(first.deduped).toBe(false);

    // 重放（同 URL 同内容）→ deduped（hash 基于抓取字节）
    const replay = await client.cms.ingest(workspaceId, {
      source: 'ARTICLE_PUBLISH',
      externalId: 'pub-77',
      title: '发布事件文章',
      channelId,
      content: { kind: 'URL', url },
    });
    expect(replay.deduped).toBe(true);
    expect(replay.documentId).toBe(first.documentId);

    // 不同 externalId 的另一篇文章 → 新项目（互不影响）
    const other = await client.cms.ingest(workspaceId, {
      source: 'ARTICLE_PUBLISH',
      externalId: 'pub-78',
      title: '另一篇',
      channelId,
      content: { kind: 'URL', url },
    });
    expect(other.deduped).toBe(false);
    expect(other.projectId).not.toBe(first.projectId);
  }, 120_000);

  it('P13-07 回写目标 API：Secret 只回掩码；私网 URL 拒绝；跨租户反枚举', async () => {
    const owner = await newClient('cms-writeback-owner');
    const outsider = await newClient('cms-writeback-outsider');
    const { workspaceId } = await makeWorkspaceWithChannel(owner);
    await makeWorkspaceWithChannel(outsider);
    const configured = await owner.cms.upsertWritebackTarget(workspaceId, {
      callbackUrl: 'https://cms.example/callback',
      signingSecret: 'cms-api-test-secret-1234', // secrets:check-ignore：测试专用假密钥
    });
    expect(configured.maskedSecret).toBe('••••1234');
    expect(configured).not.toHaveProperty('signingSecret');
    expect((await owner.cms.getWritebackTarget(workspaceId)).id).toBe(configured.id);
    expect((await owner.cms.listWritebackAttempts(workspaceId)).items).toEqual([]);
    await expect(owner.cms.upsertWritebackTarget(workspaceId, { callbackUrl: 'http://127.0.0.1/callback' })).rejects.toMatchObject({ status: 403 });
    await expect(outsider.cms.getWritebackTarget(workspaceId)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.cms.upsertWritebackTarget(workspaceId, { enabled: false })).rejects.toMatchObject({ status: 404 });
    await expect(outsider.cms.listWritebackAttempts(workspaceId)).rejects.toMatchObject({ status: 404 });
    await expect(outsider.cms.retryWriteback(workspaceId, 'cmsd_foreign')).rejects.toMatchObject({ status: 404 });
  });
});
