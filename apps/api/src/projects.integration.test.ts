import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sceneGraphSchema } from '@ancs/contracts';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * P02-01 验收（HTTP + SDK）：数据库状态经 API 组装为合法 SceneGraph；
 * 项目级"修改 Channel 后旧项目不变、新项目继承新默认值"（P01-04 义务在项目维度闭环）。
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
    secret: 'projects-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `proj-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '项目测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

describe('Project / Scene 工作流（SDK 驱动）', () => {
  it('创建 Channel → Project（快照 v1）→ 追加场景 → 组装合法 Graph；改 Channel 后旧项目不变', async () => {
    const client = await newSignedInClient();
    const workspace = await client.workspaces.create({ name: '项目工作流租户' });

    const channel = await client.channels.create(workspace.id, {
      name: '财经栏目',
      defaults: { aiVideoRatioMax: 0.15 },
    });

    const project = await client.projects.create(workspace.id, { title: '法国国债专题', channelId: channel.id });
    expect(project.channelSnapshot.styleVersion).toBe(1);
    expect(project.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.15);
    expect(project.revision).toBe(1);

    const first = await client.projects.addScene(project.id, {
      sceneType: 'HOST_FULL',
      semanticType: 'HOST_STATEMENT',
      narration: '两周之内，一条曲线把法国推回了市场的聚光灯下。',
      durationMs: 5000,
    });
    expect(first.scene.position).toBe(0);
    expect(first.project.revision).toBe(2);

    const second = await client.projects.addScene(project.id, {
      sceneType: 'SPREAD_AREA_CHART',
      semanticType: 'YIELD_SPREAD',
      durationMs: 9000,
    });
    expect(second.scene.startMs).toBe(5000);

    const graph = await client.projects.graph(project.id);
    expect(() => sceneGraphSchema.parse(graph)).not.toThrow();
    expect(graph.projectRevision).toBe(3);
    expect(graph.timeline.durationMs).toBe(14000);
    expect(graph.channelSnapshot.channelStyleVersion).toBe('1');
    expect(graph.format).toEqual({ width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' });
    expect(graph.scenes.map((s) => s.sceneType)).toEqual(['HOST_FULL', 'SPREAD_AREA_CHART']);

    // Channel 修改 → 新项目继承新默认；旧项目快照不变（项目级义务闭环）
    await client.channels.update(workspace.id, channel.id, { defaults: { aiVideoRatioMax: 0.05 } });

    const oldDetail = await client.projects.get(project.id);
    expect(oldDetail.channelSnapshot.styleVersion).toBe(1);
    expect(oldDetail.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.15);

    const newProject = await client.projects.create(workspace.id, { title: '后续专题', channelId: channel.id });
    expect(newProject.channelSnapshot.styleVersion).toBe(2);
    expect(newProject.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.05);

    const list = await client.projects.list(workspace.id);
    expect(list.map((p) => p.id)).toEqual(expect.arrayContaining([project.id, newProject.id]));
  });

  it('创建 Project 校验 Channel 存在且同租户（非法 channelId → 404）', async () => {
    const client = await newSignedInClient();
    const workspace = await client.workspaces.create({ name: '校验租户' });
    await expect(
      client.projects.create(workspace.id, { title: '坏项目', channelId: 'chn_不存在' }),
    ).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
