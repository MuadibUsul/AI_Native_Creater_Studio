import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { LlmAdapter } from '@ancs/contracts';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P07-02 HTTP/SDK 面（真实 DB + Mock LLM + 本地存储；**不执行任务**——生成执行链在
 * apps/worker/src/custom-motion.integration.test.ts 覆盖）：
 * - POST /projects/:projectId/scenes/:sceneId/custom-motion：入队 + 去重键（双击只提交一次）；
 * - 场景校验：非 CUSTOM_MOTION 场景 → 422；跨工作区 → 404；
 * - GET 列表/详情：跨租户 404。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storageRoot: string;

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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-motion-api-'));
  auth = createAuth({
    db: handle.db,
    secret: 'custom-motion-api-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { llm: new MockLlmAdapter() as LlmAdapter },
    storage: {
      adapter: new LocalObjectStorage({
        rootDir: storageRoot,
        publicBaseUrl: 'http://127.0.0.1:3999',
        signingSecret: 'custom-motion-api-storage-0123456789', // secrets:check-ignore：测试专用假密钥
      }),
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

async function makeScenes(client: AncsClient, sceneType: string): Promise<{ workspaceId: string; projectId: string; sceneId: string }> {
  const workspace = await client.workspaces.create({ name: `Motion 面-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: 'Motion 项目', channelId: channel.id });
  const created = await client.projects.addScene(project.id, {
    sceneType,
    semanticType: 'CONCEPT',
    narration: '高光数字动效',
    visualIntent: 'CUSTOM_MOTION 候选',
    durationMs: 6000,
    props: { headline: '5.25%' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sceneId: created.scene.id };
}

describe('Custom Motion HTTP/SDK（P07-02）', () => {
  it('发起生成 → 任务入队；同参数重复提交 → 去重复用（双击只提交一次）', async () => {
    const client = await newClient('motion-start');
    const { projectId, sceneId } = await makeScenes(client, 'CUSTOM_MOTION');

    const started = await client.customMotion.start(projectId, sceneId, { brief: '进度条' }, { idempotencyKey: `idem_motion_${randomUUID()}` });
    expect(started.reused).toBe(false);
    expect(started.job.type).toBe('MOTION_GENERATE');
    expect(started.job.status).toBe('QUEUED');

    const again = await client.customMotion.start(projectId, sceneId, { brief: '进度条' });
    expect(again.reused).toBe(true);
    expect(again.job.id).toBe(started.job.id);

    // 未执行（本文件不跑 Worker）→ 组件列表为空（仅 APPROVED 才落库）
    expect(await client.customMotion.list(projectId)).toEqual([]);
  });

  it('非 CUSTOM_MOTION 场景 → 422（不冒充标准组件）', async () => {
    const client = await newClient('motion-type');
    const { projectId, sceneId } = await makeScenes(client, 'BIG_NUMBER');
    const failed = await client.customMotion.start(projectId, sceneId, {}).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(AncsApiError);
    expect((failed as AncsApiError).status).toBe(422);
  });

  it('隔离：跨租户发起/查询 → 404', async () => {
    const client = await newClient('motion-isolation');
    const { projectId, sceneId } = await makeScenes(client, 'CUSTOM_MOTION');
    const intruder = await newClient('motion-intruder');
    const crossed = await intruder.customMotion.start(projectId, sceneId, {}).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
    const listed = await intruder.customMotion.list(projectId).catch((error: unknown) => error);
    expect(listed).toBeInstanceOf(AncsApiError);
    expect((listed as AncsApiError).status).toBe(404);
  });
});
