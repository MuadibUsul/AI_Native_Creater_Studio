import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@ancs/contracts';
import {
  createAuth,
  createInternalUser,
  DEFAULT_NATIVE_TOKEN_CONFIG,
  type AuthInstance,
} from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * P01-03 安全套件（HTTP 级，对应计划 §11.2 AC-01）：跨租户访问一律拒绝。
 *
 * 现存资源为 Workspace/成员；Project/Asset/Job/SSE 落地后（P02 起）
 * 必须在同一套件中以相同模式扩充用例——统一授权入口是唯一放行点。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error(
      `无法连接测试数据库 ${redactDatabaseUrl(url)}。请先运行：` +
        'docker compose -f infra/docker-compose.dev.yml up -d，或设置 ANCS_TEST_DATABASE_URL。',
      { cause: error },
    );
  }
  await runMigrations(handle);

  auth = createAuth({
    db: handle.db,
    secret: 'isolation-test-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
  });
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newUser(): Promise<{ id: string; email: string; cookie: string }> {
  const created = await createInternalUser(auth, {
    email: `iso-${randomUUID()}@test.local`,
    password: PASSWORD,
    name: '隔离测试',
  });
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    payload: { email: created.email, password: PASSWORD },
  });
  expect(response.statusCode).toBe(200);
  const setCookies = response.headers['set-cookie'];
  const list = Array.isArray(setCookies) ? setCookies : [setCookies ?? ''];
  const cookie = list.map((entry) => entry.split(';')[0] ?? '').join('; ');
  return { id: created.id, email: created.email, cookie };
}

async function createWorkspaceFor(cookie: string, name: string): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/v1/workspaces', payload: { name }, headers: { cookie } });
  expect(response.statusCode).toBe(201);
  return (response.json() as { id: string }).id;
}

describe('租户隔离（AC-01：跨租户一律拒绝）', () => {
  it('未认证访问 workspace 端点 → 401（含列表/详情/成员/写操作）', async () => {
    const cases: Array<{
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
      url: string;
      payload: unknown;
    }> = [
      { method: 'GET', url: '/api/v1/workspaces', payload: undefined },
      { method: 'GET', url: '/api/v1/workspaces/ws_any', payload: undefined },
      { method: 'PATCH', url: '/api/v1/workspaces/ws_any', payload: { name: 'x' } },
      { method: 'GET', url: '/api/v1/workspaces/ws_any/members', payload: undefined },
      { method: 'POST', url: '/api/v1/workspaces/ws_any/members', payload: { email: 'probe@test.local', role: 'VIEWER' } },
      { method: 'PATCH', url: '/api/v1/workspaces/ws_any/members/u_any', payload: { role: 'VIEWER' } },
      { method: 'DELETE', url: '/api/v1/workspaces/ws_any/members/u_any', payload: undefined },
    ];
    for (const c of cases) {
      const response = await app.inject({ method: c.method, url: c.url, payload: c.payload as object | undefined });
      expect(response.statusCode, `${c.method} ${c.url}`).toBe(401);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('UNAUTHENTICATED');
    }

    // 已固化的次序约定：请求体校验先于认证（400 不涉及任何数据访问）；
    // 认证先于授权（401 先于 403/404）
    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/workspaces/ws_any/members',
      payload: {},
    });
    expect(malformed.statusCode).toBe(400);
    expect(errorEnvelopeSchema.parse(malformed.json()).error.code).toBe('VALIDATION_FAILED');
  });

  it('A 不能读写 B 的 Workspace：全部 404（与不存在不可区分）', async () => {
    const a = await newUser();
    const b = await newUser();
    const workspaceB = await createWorkspaceFor(b.cookie, 'B 的研究组');

    const attempts = [
      { method: 'GET' as const, url: `/api/v1/workspaces/${workspaceB}`, payload: undefined },
      { method: 'PATCH' as const, url: `/api/v1/workspaces/${workspaceB}`, payload: { name: '篡改' } },
      { method: 'GET' as const, url: `/api/v1/workspaces/${workspaceB}/members`, payload: undefined },
      { method: 'POST' as const, url: `/api/v1/workspaces/${workspaceB}/members`, payload: { email: a.email, role: 'OWNER' } },
      { method: 'DELETE' as const, url: `/api/v1/workspaces/${workspaceB}/members/${b.id}`, payload: undefined },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method,
        url: attempt.url,
        payload: attempt.payload,
        headers: { cookie: a.cookie },
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }

    // B 的 Workspace 未被篡改
    const verify = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceB}`, headers: { cookie: b.cookie } });
    expect((verify.json() as { name: string }).name).toBe('B 的研究组');
  });

  it('列表隔离：只看到自己参与的 Workspace', async () => {
    const a = await newUser();
    const b = await newUser();
    const workspaceA = await createWorkspaceFor(a.cookie, 'A 的研究组');
    await createWorkspaceFor(b.cookie, 'B 的研究组');

    const listA = await app.inject({ method: 'GET', url: '/api/v1/workspaces', headers: { cookie: a.cookie } });
    const idsA = (listA.json() as { items: Array<{ id: string }> }).items.map((w) => w.id);
    expect(idsA).toContain(workspaceA);
    expect(idsA).toHaveLength(1);
  });

  it('角色边界：VIEWER 可读不可写（403 含 requiredCapability），撤销后立即 404', async () => {
    const a = await newUser();
    const b = await newUser();
    const workspaceA = await createWorkspaceFor(a.cookie, 'A 的研究组');

    const add = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/members`,
      payload: { email: b.email, role: 'VIEWER' },
      headers: { cookie: a.cookie },
    });
    expect(add.statusCode).toBe(201);

    const read = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}`, headers: { cookie: b.cookie } });
    expect(read.statusCode).toBe(200);

    const write = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspaceA}`,
      payload: { name: '越权改名' },
      headers: { cookie: b.cookie },
    });
    expect(write.statusCode).toBe(403);
    const envelope = errorEnvelopeSchema.parse(write.json());
    expect(envelope.error.code).toBe('FORBIDDEN');
    expect(envelope.error.details['requiredCapability']).toBe('workspace:update');

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/v1/workspaces/${workspaceA}/members/${b.id}`,
      headers: { cookie: a.cookie },
    });
    expect(remove.statusCode).toBe(204);

    const afterRevoke = await app.inject({ method: 'GET', url: `/api/v1/workspaces/${workspaceA}`, headers: { cookie: b.cookie } });
    expect(afterRevoke.statusCode).toBe(404);
  });

  it('业务资源同样受租户隔离：Channel / CreatorIdentity / SpeechProfile 跨租户全 404', async () => {
    const a = await newUser();
    const b = await newUser();
    const workspaceA = await createWorkspaceFor(a.cookie, 'A 的业务租户');

    // A 建立业务资源
    const channel = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/channels`,
      payload: { name: 'A 的栏目' },
      headers: { cookie: a.cookie },
    });
    expect(channel.statusCode).toBe(201);
    const channelId = (channel.json() as { id: string }).id;

    const identity = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/creator-identities`,
      payload: { displayName: 'A 的主持人' },
      headers: { cookie: a.cookie },
    });
    expect(identity.statusCode).toBe(201);
    const identityId = (identity.json() as { id: string }).id;

    const speech = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/speech-profiles`,
      payload: { name: 'A 的风格' },
      headers: { cookie: a.cookie },
    });
    expect(speech.statusCode).toBe(201);
    const speechId = (speech.json() as { id: string }).id;

    // B 以自己身份访问 A 的资源：全部 404（与不存在不可区分）
    const attempts: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/channels` },
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/channels/${channelId}` },
      { method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/channels/${channelId}`, payload: { name: '篡改' } },
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/channels/${channelId}/style-versions` },
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/creator-identities/${identityId}` },
      { method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/creator-identities/${identityId}`, payload: { displayName: '篡改' } },
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/speech-profiles/${speechId}` },
      { method: 'PATCH', url: `/api/v1/workspaces/${workspaceA}/speech-profiles/${speechId}`, payload: { name: '篡改' } },
    ];
    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method,
        url: attempt.url,
        payload: attempt.payload as object | undefined,
        headers: { cookie: b.cookie },
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }

    // 资源未被篡改
    const verify = await app.inject({
      method: 'GET',
      url: `/api/v1/workspaces/${workspaceA}/channels/${channelId}`,
      headers: { cookie: a.cookie },
    });
    expect((verify.json() as { name: string }).name).toBe('A 的栏目');
  });

  it('Project / Scene 跨租户全拒绝（AC-01 资源维度扩充）', async () => {
    const a = await newUser();
    const b = await newUser();
    const workspaceA = await createWorkspaceFor(a.cookie, 'A 的项目租户');

    // A 建立 Channel → Project → Scene
    const channel = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/channels`,
      payload: { name: 'A 的栏目' },
      headers: { cookie: a.cookie },
    });
    expect(channel.statusCode).toBe(201);
    const channelId = (channel.json() as { id: string }).id;

    const project = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspaceA}/projects`,
      payload: { title: 'A 的项目', channelId },
      headers: { cookie: a.cookie },
    });
    expect(project.statusCode).toBe(201);
    const projectId = (project.json() as { id: string }).id;

    const scene = await app.inject({
      method: 'POST',
      url: `/api/v1/projects/${projectId}/scenes`,
      payload: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 },
      headers: { cookie: a.cookie },
    });
    expect(scene.statusCode).toBe(201);

    // B 以自己身份访问 A 的项目资源：全部 404（与不存在不可区分）
    const attempts: Array<{ method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; payload?: unknown }> = [
      { method: 'GET', url: `/api/v1/workspaces/${workspaceA}/projects` },
      { method: 'POST', url: `/api/v1/workspaces/${workspaceA}/projects`, payload: { title: '越权', channelId } },
      { method: 'GET', url: `/api/v1/projects/${projectId}` },
      { method: 'GET', url: `/api/v1/projects/${projectId}/graph` },
      {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/scenes`,
        payload: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 5000 },
      },
      {
        method: 'POST',
        url: `/api/v1/projects/${projectId}/edits`,
        payload: {
          baseProjectRevision: 1,
          expectedSceneRevisions: {},
          operations: [{ op: 'update_project', changes: { title: '越权改名' } }],
          idempotencyKey: 'idem_sec_probe_01',
        },
      },
    ];
    for (const attempt of attempts) {
      const response = await app.inject({
        method: attempt.method,
        url: attempt.url,
        payload: attempt.payload as object | undefined,
        headers: { cookie: b.cookie },
      });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(404);
      expect(errorEnvelopeSchema.parse(response.json()).error.code).toBe('NOT_FOUND');
    }

    // A 的项目未被篡改且可正常组装
    const graph = await app.inject({
      method: 'GET',
      url: `/api/v1/projects/${projectId}/graph`,
      headers: { cookie: a.cookie },
    });
    expect(graph.statusCode).toBe(200);
    expect((graph.json() as { scenes: unknown[] }).scenes).toHaveLength(1);
  });

  it('成员管理规则（HTTP）：重复添加 409；最后 OWNER 降级 409；ADMIN 不能授予 OWNER 403', async () => {
    const owner = await newUser();
    const admin = await newUser();
    const third = await newUser();
    const workspace = await createWorkspaceFor(owner.cookie, '规则测试组');

    const addAdmin = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace}/members`,
      payload: { email: admin.email, role: 'ADMIN' },
      headers: { cookie: owner.cookie },
    });
    expect(addAdmin.statusCode).toBe(201);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace}/members`,
      payload: { email: admin.email, role: 'VIEWER' },
      headers: { cookie: owner.cookie },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(duplicate.json()).error.code).toBe('ALREADY_EXISTS');

    const demoteLastOwner = await app.inject({
      method: 'PATCH',
      url: `/api/v1/workspaces/${workspace}/members/${owner.id}`,
      payload: { role: 'ADMIN' },
      headers: { cookie: owner.cookie },
    });
    expect(demoteLastOwner.statusCode).toBe(409);
    expect(errorEnvelopeSchema.parse(demoteLastOwner.json()).error.code).toBe('PRECONDITION_FAILED');

    const adminGrantsOwner = await app.inject({
      method: 'POST',
      url: `/api/v1/workspaces/${workspace}/members`,
      payload: { email: third.email, role: 'OWNER' },
      headers: { cookie: admin.cookie },
    });
    expect(adminGrantsOwner.statusCode).toBe(403);
  });
});
