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
 * P13-05 验收（真实 DB）：Handoff（可撤销、限时、绑定账号与 Artifact 的跨端交接）。
 * - Web 可创建/取消/查看状态；
 * - **跨租户访问失败**（404 反枚举）；**过期访问失败**（claim → 410 HANDOFF_EXPIRED）；
 * - Artifact 绑定必须真实（外项目 artifact → 422）；状态机（REVOKED 不可领取/再取消）。
 */

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
  auth = createAuth({ db: handle.db, secret: 'handoff-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
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

async function makeProjectWithAsset(client: AncsClient): Promise<{ workspaceId: string; projectId: string; assetId: string }> {
  const workspace = await client.workspaces.create({ name: `交接-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '利率周报', channelId: channel.id });
  // 直接落一个资产（Artifact 绑定目标；无需走上传全链）
  await handle.db.execute(
    (
      await import('drizzle-orm')
    ).sql`insert into assets (id, workspace_id, project_id, asset_type, origin, provider, provider_asset_id, status, retention_class, license, metadata, current_version_id)
      values (${`ast_${randomUUID()}`}, ${workspace.id}, ${project.id}, 'VIDEO', 'USER_UPLOAD', null, null, 'READY', 'KEEP_FOREVER', '{"type":"USER_OWNED","holder":null,"attribution":null,"sourceUrl":null,"termsUrl":null,"notes":null,"confirmedBy":null,"confirmedAt":null}'::jsonb, '{}'::jsonb, null)`,
  );
  const rows = await handle.db.select().from((await import('@ancs/db')).assets);
  const assetId = rows[rows.length - 1]!.id;
  return { workspaceId: workspace.id, projectId: project.id, assetId };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Handoff（P13-05）', () => {
  it('创建/领取/取消全链：Artifact 绑定校验、PENDING→CLAIMED、REVOKED 不可领取', async () => {
    const client = await newClient('hd-main');
    const { workspaceId, projectId, assetId } = await makeProjectWithAsset(client);

    // 外项目 artifact → 422（绑定必须真实）
    await expectApiError(
      client.handoffs.create(workspaceId, projectId, { artifactIds: ['ast_foreign'], targetPlatform: null }),
      422,
      'ARTIFACT_NOT_TRACEABLE',
    );

    const created = await client.handoffs.create(workspaceId, projectId, {
      artifactIds: [assetId],
      targetPlatform: 'mobile-ios',
      ttlSeconds: 3600,
    });
    expect(created.state).toBe('PENDING');
    expect(created.isExpired).toBe(false);
    expect(created.artifactIds).toEqual([assetId]);
    expect(created.createdBy).not.toBeNull();

    // 领取（模拟移动端）→ CLAIMED
    const claimed = await client.handoffs.claim(workspaceId, projectId, created.handoffId, 'device-001');
    expect(claimed.state).toBe('CLAIMED');
    expect(claimed.claimedBy).toBe('device-001');
    expect(claimed.claimedAt).not.toBeNull();

    // 已 CLAIMED 不可重复领取
    await expectApiError(client.handoffs.claim(workspaceId, projectId, created.handoffId, 'device-002'), 409, 'INVALID_STATE');

    // 取消（可撤销）→ REVOKED；REVOKED 不可领取
    const cancelled = await client.handoffs.cancel(workspaceId, projectId, created.handoffId);
    expect(cancelled.state).toBe('REVOKED');
    expect(cancelled.revokedAt).not.toBeNull();
    await expectApiError(client.handoffs.claim(workspaceId, projectId, created.handoffId, 'device-003'), 409, 'INVALID_STATE');

    // 状态查询 + 列表
    const got = await client.handoffs.get(workspaceId, projectId, created.handoffId);
    expect(got.state).toBe('REVOKED');
    const list = await client.handoffs.list(workspaceId, projectId);
    expect(list.items).toHaveLength(1);
  }, 120_000);

  it('过期访问失败：TTL 1s → isExpired=true；claim → 410 HANDOFF_EXPIRED', async () => {
    const client = await newClient('hd-expire');
    const { workspaceId, projectId, assetId } = await makeProjectWithAsset(client);
    const created = await client.handoffs.create(workspaceId, projectId, {
      artifactIds: [assetId],
      targetPlatform: null,
      ttlSeconds: 1,
    });
    // 等 TTL 过期
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const viewed = await client.handoffs.get(workspaceId, projectId, created.handoffId);
    expect(viewed.isExpired).toBe(true); // 查询可见过期（读取时计算）
    await expectApiError(client.handoffs.claim(workspaceId, projectId, created.handoffId, 'device-x'), 410, 'HANDOFF_EXPIRED');
  }, 120_000);

  it('跨租户访问失败：另一项目的 handoff → 404（反枚举）', async () => {
    const client = await newClient('hd-cross');
    const a = await makeProjectWithAsset(client);
    const created = await client.handoffs.create(a.workspaceId, a.projectId, { artifactIds: [a.assetId], targetPlatform: null });
    const b = await makeProjectWithAsset(client);
    await expectApiError(client.handoffs.get(b.workspaceId, b.projectId, created.handoffId), 404, 'NOT_FOUND');
    await expectApiError(client.handoffs.cancel(b.workspaceId, b.projectId, created.handoffId), 404, 'NOT_FOUND');
  }, 120_000);
});
