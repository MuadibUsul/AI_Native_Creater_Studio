import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, type EditRequest } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, editEvents, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { and, eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * P02-02 验收（HTTP + SDK）：
 * - AC-03：同幂等键重放返回原结果且**不产生重复 EditEvent**；
 * - §4.6：同 Scene 并发编辑经 HTTP 竞争恰一个成功，409 携带刷新信息。
 */

const PASSWORD = 'password-1234';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

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
    secret: 'edits-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newSignedInClient(): Promise<AncsClient> {
  const email = `edits-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '编辑测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeProjectWithScene(client: AncsClient): Promise<{ projectId: string; sceneId: string; revision: number }> {
  const workspace = await client.workspaces.create({ name: `编辑工作流-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '编辑项目', channelId: channel.id });
  const scene = await client.projects.addScene(project.id, {
    sceneType: 'HOST_FULL',
    semanticType: 'HOST_STATEMENT',
    durationMs: 5000,
  });
  return { projectId: project.id, sceneId: scene.scene.id, revision: scene.project.revision };
}

async function countEvents(projectId: string, action?: string): Promise<number> {
  const rows = await handle.db
    .select()
    .from(editEvents)
    .where(action === undefined ? eq(editEvents.projectId, projectId) : and(eq(editEvents.projectId, projectId), eq(editEvents.action, action)));
  return rows.length;
}

describe('编辑事务（HTTP / SDK）', () => {
  it('AC-03：同幂等键重放返回原结果，EditEvent 不重复', async () => {
    const client = await newSignedInClient();
    const { projectId, sceneId, revision } = await makeProjectWithScene(client);

    const before = await countEvents(projectId); // addScene 也产生 1 条 INSERT_SCENE

    const editRequest: EditRequest = {
      baseProjectRevision: revision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: '第一版旁白' } }],
      idempotencyKey: `idem_edit_api_${randomUUID()}`,
      intent: '改写开场',
    };

    const first = await client.projects.edit(projectId, editRequest);
    expect(first.project.revision).toBe(revision + 1);
    expect(first.editEvents).toHaveLength(1);

    const replay = await client.projects.edit(projectId, editRequest);
    expect(replay.project.revision).toBe(first.project.revision);
    expect(replay.editEvents).toHaveLength(1);

    // 事件数只增加一次（重放不重复落库）
    expect(await countEvents(projectId)).toBe(before + 1);
    expect(await countEvents(projectId, 'UPDATE_SCENE')).toBe(1);

    // 数据库中的旁白为第一版内容
    const graph = await client.projects.graph(projectId);
    expect(graph.scenes.find((s) => s.id === sceneId)?.narration).toBe('第一版旁白');
  });

  it('§4.6 同 Scene 并发：HTTP 竞争恰一个成功，409 携带刷新信息', async () => {
    const client = await newSignedInClient();
    const { projectId, sceneId, revision } = await makeProjectWithScene(client);

    const body = (narration: string): EditRequest => ({
      baseProjectRevision: revision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration } }],
      idempotencyKey: `idem_concurrent_${narration === '竞争者 A' ? 'a' : 'b'}`, // 不同键：并发请求，不做幂等回放
    });

    const [a, b] = await Promise.all([
      client.projects.edit(projectId, body('竞争者 A')).then(
        (value) => ({ status: 200 as const, value }),
        (error: unknown) => ({ status: 'error' as const, error }),
      ),
      client.projects.edit(projectId, body('竞争者 B')).then(
        (value) => ({ status: 200 as const, value }),
        (error: unknown) => ({ status: 'error' as const, error }),
      ),
    ]);

    const outcomes = [a, b];
    const succeeded = outcomes.filter((outcome) => outcome.status === 200);
    const conflicted = outcomes.filter((outcome) => outcome.status === 'error');
    expect(succeeded).toHaveLength(1);
    expect(conflicted).toHaveLength(1);

    const failure = (conflicted[0] as { error: unknown }).error;
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
    const details = (failure as AncsApiError).details as { currentProjectRevision?: number; sceneRevisions?: Record<string, number> };
    expect(details.currentProjectRevision).toBe(revision + 1);
    expect(details.sceneRevisions?.[sceneId]).toBe(2);
  });

  it('未排期操作 → 501 CAPABILITY_UNAVAILABLE（信封，含 plannedPhase）', async () => {
    const client = await newSignedInClient();
    const { projectId, revision } = await makeProjectWithScene(client);

    const failure = await client.projects
      .edit(projectId, {
        baseProjectRevision: revision,
        expectedSceneRevisions: {},
        operations: [{ op: 'restore_project_version', versionId: 'pv_1' }],
        idempotencyKey: `idem_unimpl_sdk_${randomUUID()}`,
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ status: 501, code: 'CAPABILITY_UNAVAILABLE' });

    // 信封形状由契约保证（错误码与 details.plannedPhase）
    const envelope = errorEnvelopeSchema.parse({
      error: {
        code: (failure as AncsApiError).code,
        message: (failure as AncsApiError).message,
        requestId: (failure as AncsApiError).requestId,
        details: (failure as AncsApiError).details,
      },
    });
    expect(envelope.error.details['plannedPhase']).toBe('P02-03（历史恢复）');
  });
});
