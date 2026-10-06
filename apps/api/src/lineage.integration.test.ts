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
 * P11-04 验收（真实 DB）：
 * - analyze 每次运行**追加**一条 PLAN 血缘行（输入快照：coreInputsDigest + 规模）；
 * - **更新 Core → 旧行 stale=true（提示过期），行保留、状态不变**；
 * - **批准不因过期被覆盖**：approve 后再更新核心 → 行仍 APPROVED + stale 提示；重复 approve 409。
 */

const ARTICLE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>利率周报</title></head><body>
<h1>美联储利率决议</h1><p>联邦基金利率维持在 5.25% 不变。市场预计年内降息一次。</p></body></html>`;

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
  auth = createAuth({ db: handle.db, secret: 'lineage-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeProjectWithContent(client: AncsClient): Promise<{ workspaceId: string; projectId: string; documentId: string; claimIds: string[] }> {
  const workspace = await client.workspaces.create({ name: `血缘-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  const url = `https://news.example/rates/${randomUUID()}`;
  fetcher.responses.set(url, { contentType: 'text/html; charset=utf-8', bytes: new TextEncoder().encode(ARTICLE_HTML) });
  const record = await client.content.create(workspace.id, project.id, { sourceType: 'URL_ARTICLE', url });
  await client.evidence.extract(workspace.id, project.id, record.document.id);
  const projectClaims = await client.evidence.claims(workspace.id, project.id);
  return { workspaceId: workspace.id, projectId: project.id, documentId: record.document.id, claimIds: projectClaims.map((claim) => claim.id) };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('派生血缘（P11-04）', () => {
  it('analyze 追加 PLAN 行（含 digest 快照）；重复 analyze → 两行（只追加，不改写）', async () => {
    const client = await newClient('lin-main');
    const { workspaceId, projectId, claimIds } = await makeProjectWithContent(client);
    await client.content.contentCore.migrate(workspaceId, projectId);
    await client.content.atoms.create(workspaceId, projectId, {
      kind: 'KEY_NUMBER',
      title: '利率维持 5.25%',
      text: '联邦基金利率维持在 5.25% 不变。',
      sourceRefs: [{ claimId: claimIds[0] as string }],
    });

    await client.packs.enable(workspaceId, 'ancs.pack.shorts-analyzer');
    await client.packs.bind(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');

    const list = await client.derivations.list(workspaceId, projectId);
    expect(list.items).toHaveLength(2);
    expect(list.items.every((item) => item.status === 'PLAN')).toBe(true);
    expect(list.items.every((item) => item.stale === false)).toBe(true);
    expect(list.items.every((item) => item.packId === 'ancs.pack.shorts-analyzer')).toBe(true);
    expect(list.items[0]?.inputsSnapshot.atomCount).toBe(1);
    expect(list.items[0]?.currentCoreInputsDigest).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('更新 Core → 旧行 stale=true（提示过期，行与状态不变）；重新 analyze 产生新 digest 行', async () => {
    const client = await newClient('lin-stale');
    const { workspaceId, projectId } = await makeProjectWithContent(client);
    await client.content.contentCore.migrate(workspaceId, projectId);
    await client.packs.enable(workspaceId, 'ancs.pack.shorts-analyzer');
    await client.packs.bind(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    const before = await client.derivations.list(workspaceId, projectId);
    expect(before.items[0]?.stale).toBe(false);

    // 更新核心：新增人工声明 → 重迁移 → digest 变化
    await client.evidence.createClaim(workspaceId, projectId, { text: '人工补充的关键判断', factuality: 'analysis', sourceIds: [] });
    await client.content.contentCore.migrate(workspaceId, projectId);

    const after = await client.derivations.list(workspaceId, projectId);
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.stale).toBe(true); // **提示过期**
    expect(after.items[0]?.status).toBe('PLAN'); // 状态不变（不覆盖）
    expect(after.items[0]?.coreInputsDigest).not.toBe(after.items[0]?.currentCoreInputsDigest);

    // 重新 analyze → 新 digest 行追加（旧行保留）
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    const refreshed = await client.derivations.list(workspaceId, projectId);
    expect(refreshed.items).toHaveLength(2);
    expect(refreshed.items[0]?.stale).toBe(false);
    expect(refreshed.items[1]?.stale).toBe(true);
  }, 120_000);

  it('批准不因过期被覆盖：approve → 更新核心（stale=true）→ 行仍 APPROVED；重复 approve 409', async () => {
    const client = await newClient('lin-approve');
    const { workspaceId, projectId } = await makeProjectWithContent(client);
    await client.content.contentCore.migrate(workspaceId, projectId);
    await client.packs.enable(workspaceId, 'ancs.pack.shorts-analyzer');
    await client.packs.bind(workspaceId, projectId, 'ancs.pack.shorts-analyzer');
    await client.packs.analyze(workspaceId, projectId, 'ancs.pack.shorts-analyzer');

    const list = await client.derivations.list(workspaceId, projectId);
    const lineageId = list.items[0]?.id ?? '';

    // 绑定不存在的项目版本 → 404（来源链不写假引用）
    await expectApiError(
      client.derivations.approve(workspaceId, projectId, lineageId, { projectVersionId: 'pver_does-not-exist' }),
      404,
      'PROJECT_VERSION_NOT_FOUND',
    );

    // 批准并绑定真实项目版本（**来源链闭合 ProjectVersion 一环**）
    const version = await client.projects.versions.create(projectId, { reason: 'MANUAL' });
    const approved = await client.derivations.approve(workspaceId, projectId, lineageId, { projectVersionId: version.id });
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedAt).not.toBeNull();
    expect(approved.projectVersionId).toBe(version.id);

    // 更新核心 → 已批准行保留 APPROVED + stale 提示（**不覆盖已批准产物**）
    await client.evidence.createClaim(workspaceId, projectId, { text: '另一条人工判断', factuality: 'analysis', sourceIds: [] });
    await client.content.contentCore.migrate(workspaceId, projectId);
    const after = await client.derivations.list(workspaceId, projectId);
    const approvedRow = after.items.find((item) => item.id === lineageId);
    expect(approvedRow?.status).toBe('APPROVED');
    expect(approvedRow?.stale).toBe(true);
    expect(approvedRow?.projectVersionId).toBe(version.id); // 核心更新不回拨绑定

    // 重复 approve → 409
    await expectApiError(client.derivations.approve(workspaceId, projectId, lineageId), 409, 'ALREADY_APPROVED');
  }, 120_000);
});
