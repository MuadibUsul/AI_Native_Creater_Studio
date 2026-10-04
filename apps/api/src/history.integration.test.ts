import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * P02-03 验收（HTTP + SDK）：版本快照 / 整项目恢复 / Undo-Redo 的对外协议。
 * 单 Scene 重放与自动快照的深度行为见 packages/domain 的 history.integration.test.ts。
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
    secret: 'history-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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

async function newSignedInClient(): Promise<{ client: AncsClient; email: string }> {
  const email = `history-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '历史测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, email };
}

async function makeProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string; sceneId: string; revision: number }> {
  const workspace = await client.workspaces.create({ name: `历史工作流-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '历史项目', channelId: channel.id });
  const scene = await client.projects.addScene(project.id, {
    sceneType: 'HOST_FULL',
    semanticType: 'HOST_STATEMENT',
    durationMs: 5000,
  });
  return { workspaceId: workspace.id, projectId: project.id, sceneId: scene.scene.id, revision: scene.project.revision };
}

describe('历史与恢复（HTTP / SDK）', () => {
  it('版本快照：手动建立 / 列表 / 详情（含快照本体）；恢复后旧版本与旧事件不变', async () => {
    const { client } = await newSignedInClient();
    const { projectId, sceneId, revision } = await makeProject(client);

    const v1 = await client.projects.versions.create(projectId, { reason: 'MANUAL', note: '初稿' });
    expect(v1.versionNumber).toBe(1);
    expect(v1.sceneCount).toBe(1);
    expect(v1.note).toBe('初稿');

    await client.projects.edit(projectId, {
      baseProjectRevision: revision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: '第二版', durationMs: 9000 } }],
      idempotencyKey: `idem_hist_api_${randomUUID()}`,
      intent: '改旁白',
    });

    const list = await client.projects.versions.list(projectId);
    expect(list).toHaveLength(1);
    const detailBefore = await client.projects.versions.get(projectId, v1.id);
    expect(detailBefore.snapshot.graph.scenes.find((scene) => scene.id === sceneId)?.durationMs).toBe(5000);
    const snapshotBefore = JSON.stringify(detailBefore);

    // 恢复 v1
    const current = await client.projects.get(projectId);
    const restored = await client.projects.edit(projectId, {
      baseProjectRevision: current.revision,
      expectedSceneRevisions: {},
      operations: [{ op: 'restore_project_version', versionId: v1.id }],
      idempotencyKey: `idem_hist_restore_${randomUUID()}`,
      intent: '回到初稿',
    });
    expect(restored.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('');
    expect(restored.scenes.find((scene) => scene.id === sceneId)?.durationMs).toBe(5000);
    expect(restored.editEvents.map((event) => event.action)).toEqual(['RESTORE_PROJECT_VERSION']);
    expect(restored.editEvents[0]?.patch['versionId']).toBe(v1.id);

    // 恢复产生新的 RESTORE 版本；旧版本详情逐字节不变
    const listAfter = await client.projects.versions.list(projectId);
    expect(listAfter).toHaveLength(2);
    expect(listAfter[0]?.reason).toBe('RESTORE');
    expect(JSON.stringify(await client.projects.versions.get(projectId, v1.id))).toBe(snapshotBefore);
  });

  it('Undo/Redo（SDK）：补偿链路、重做栈空 409、新编辑结束重做分支', async () => {
    const { client } = await newSignedInClient();
    const { projectId, sceneId, revision } = await makeProject(client);

    await client.projects.edit(projectId, {
      baseProjectRevision: revision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: 'A1' } }],
      idempotencyKey: `idem_hist_undo_${randomUUID()}`,
    });

    const undo = await client.projects.undo(projectId);
    expect(undo.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('');
    expect(undo.editEvents.map((event) => event.action)).toEqual(['UNDO_UPDATE_SCENE']);

    const redo = await client.projects.redo(projectId);
    expect(redo.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('A1');
    expect(redo.editEvents.map((event) => event.action)).toEqual(['REDO_UPDATE_SCENE']);

    const redoEmpty = await client.projects.redo(projectId).catch((error: unknown) => error);
    expect(redoEmpty).toBeInstanceOf(AncsApiError);
    expect(redoEmpty).toMatchObject({ status: 409, code: 'PRECONDITION_FAILED' });

    // 撤销 → 新编辑 → 重做分支结束
    const undoBeforeBranch = await client.projects.undo(projectId);
    expect(undoBeforeBranch.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('');
    const sceneRevision = undoBeforeBranch.scenes.find((scene) => scene.id === sceneId)?.revision ?? 0;
    const afterUndo = await client.projects.get(projectId);
    await client.projects.edit(projectId, {
      baseProjectRevision: afterUndo.revision,
      expectedSceneRevisions: { [sceneId]: sceneRevision },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: '新分支' } }],
      idempotencyKey: `idem_hist_branch_${randomUUID()}`,
    });
    const branchEnded = await client.projects.redo(projectId).catch((error: unknown) => error);
    expect(branchEnded).toMatchObject({ status: 409, code: 'PRECONDITION_FAILED' });
  });

  it('角色边界：VIEWER 可读版本列表（200），不可建立版本/撤销（403 含 requiredCapability）', async () => {
    const { client: owner } = await newSignedInClient();
    const { client: viewer, email: viewerEmail } = await newSignedInClient();
    const { workspaceId, projectId } = await makeProject(owner);
    await owner.workspaces.members.add(workspaceId, { email: viewerEmail, role: 'VIEWER' });

    const listed = await viewer.projects.versions.list(projectId);
    expect(listed).toHaveLength(0);

    const createFailure = await viewer.projects.versions.create(projectId, { reason: 'MANUAL' }).catch((error: unknown) => error);
    expect(createFailure).toBeInstanceOf(AncsApiError);
    expect(createFailure).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((createFailure as AncsApiError).details['requiredCapability']).toBe('project:write');

    const undoFailure = await viewer.projects.undo(projectId).catch((error: unknown) => error);
    expect(undoFailure).toMatchObject({ status: 403, code: 'FORBIDDEN' });
  });

  it('非成员访问版本与撤销端点 → 404（抗枚举）', async () => {
    const { client: owner } = await newSignedInClient();
    const { client: stranger } = await newSignedInClient();
    const { projectId } = await makeProject(owner);

    const listFailure = await stranger.projects.versions.list(projectId).catch((error: unknown) => error);
    expect(listFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const undoFailure = await stranger.projects.undo(projectId).catch((error: unknown) => error);
    expect(undoFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
