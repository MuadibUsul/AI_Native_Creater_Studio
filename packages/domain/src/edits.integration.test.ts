import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { editRequestSchema, type EditRequest } from '@ancs/contracts';
import {
  createDb,
  editEvents,
  outboxEvents,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { eq } from 'drizzle-orm';
import {
  addScene,
  assembleSceneGraph,
  createChannel,
  createProject,
  getProject,
  processEdits,
  type DomainDeps,
} from './index.js';

/**
 * P02-02 验收：编辑事务（§4.6 并发规则；AC-04 同 Scene 竞争恰一成功；AC-03 幂等在 API 层另行测试）。
 * EditEvent 与状态变更、Outbox 必须同事务落库。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });

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
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

interface Fixture {
  workspaceId: string;
  projectId: string;
  sceneIds: string[];
  projectRevision: number;
}

/** 建 3 个场景的测试项目：a=5000ms, b=7000ms, c=6000ms */
async function makeFixture(): Promise<Fixture> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '编辑测试租户' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '编辑项目', channelId: channel.id } });
  const a = await addScene(deps(), { workspaceId, projectId: project.id, input: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 } });
  const b = await addScene(deps(), { workspaceId, projectId: project.id, input: { sceneType: 'BIG_NUMBER', semanticType: 'NUMBER', durationMs: 7000 } });
  const c = await addScene(deps(), { workspaceId, projectId: project.id, input: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 6000 } });
  const fresh = await getProject(deps(), { workspaceId, projectId: project.id });
  return { workspaceId, projectId: project.id, sceneIds: [a.scene.id, b.scene.id, c.scene.id], projectRevision: fresh.revision };
}

const makeRequest = (overrides: Partial<EditRequest> & Pick<EditRequest, 'baseProjectRevision' | 'operations'>): EditRequest =>
  editRequestSchema.parse({
    expectedSceneRevisions: {},
    idempotencyKey: `idem_test_${randomUUID()}`,
    ...overrides,
  });

const edit = (fixture: Fixture, request: EditRequest, actor: { type: 'USER' | 'AI' | 'SYSTEM'; id: string | null } = { type: 'USER', id: 'u_test' }) =>
  processEdits(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor, request });

describe('编辑事务（§4.6）', () => {
  it('update_scene：条件更新成功、双层 revision 递增、EditEvent 与 Outbox 同事务落库', async () => {
    const fixture = await makeFixture();
    const sceneId = fixture.sceneIds[0] ?? '';

    const result = await edit(
      fixture,
      makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'update_scene', sceneId, changes: { durationMs: 9000, narration: '改写后的旁白' } }],
        intent: '把开场拉长',
      }),
    );

    expect(result.response.project.revision).toBe(fixture.projectRevision + 1);
    const updated = result.response.scenes.find((scene) => scene.id === sceneId);
    expect(updated?.revision).toBe(2);
    expect(updated?.durationMs).toBe(9000);
    expect(updated?.narration).toBe('改写后的旁白');

    // EditEvent
    expect(result.response.editEvents).toHaveLength(1);
    const event = result.response.editEvents[0];
    expect(event?.action).toBe('UPDATE_SCENE');
    expect(event?.sceneId).toBe(sceneId);
    expect(event?.intentText).toBe('把开场拉长');
    expect(event?.baseRevision).toBe(fixture.projectRevision);
    expect(event?.resultRevision).toBe(fixture.projectRevision + 1);
    // patch 记录完整操作对象（非任意数据库补丁）
    expect(event?.patch['op']).toBe('update_scene');

    // 数据库侧：事件与 Outbox 均存在（同事务）
    // addScene（包装 insert_scene）×3 亦各留 1 条 EditEvent；本批次最后 1 条为 UPDATE_SCENE
    const eventRows = await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId));
    expect(eventRows).toHaveLength(4);
    expect(eventRows.filter((row) => row.action === 'UPDATE_SCENE')).toHaveLength(1);
    // Outbox：fixture 的 3 次 addScene（各自 1 条）+ 本次编辑 1 条 = 4 条，且均未发布
    const outboxRows = await handle.db.select().from(outboxEvents).where(eq(outboxEvents.workspaceId, fixture.workspaceId));
    expect(outboxRows).toHaveLength(4);
    expect(outboxRows.every((row) => row.publishedAt === null)).toBe(true);
  });

  it('AC-04 同 Scene 并发：恰一个成功，冲突返回 409 + 刷新信息', async () => {
    const fixture = await makeFixture();
    const sceneId = fixture.sceneIds[0] ?? '';

    const concurrent = await Promise.allSettled([
      edit(fixture, makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'update_scene', sceneId, changes: { narration: 'A' } }],
      })),
      edit(fixture, makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'update_scene', sceneId, changes: { narration: 'B' } }],
      })),
    ]);

    const fulfilled = concurrent.filter((r) => r.status === 'fulfilled');
    const rejected = concurrent.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as {
      code?: string;
      httpStatus?: number;
      details?: { currentProjectRevision?: number; sceneRevisions?: Record<string, number> };
    };
    expect(reason.code).toBe('VERSION_CONFLICT');
    expect(reason.httpStatus).toBe(409);
    expect(reason.details?.sceneRevisions?.[sceneId]).toBe(2);
  });

  it('不同 Scene 并发：均可成功且无丢失更新（Project revision 递增两次）', async () => {
    const fixture = await makeFixture();
    const [a, b] = fixture.sceneIds;

    const concurrent = await Promise.allSettled([
      edit(fixture, makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [a ?? '']: 1 },
        operations: [{ op: 'update_scene', sceneId: a ?? '', changes: { narration: 'A 改' } }],
      })),
      edit(fixture, makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [b ?? '']: 1 },
        operations: [{ op: 'update_scene', sceneId: b ?? '', changes: { narration: 'B 改' } }],
      })),
    ]);
    expect(concurrent.every((r) => r.status === 'fulfilled'), '不同 Scene 的独立修改应合并成功').toBe(true);

    const fresh = await getProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(fresh.revision).toBe(fixture.projectRevision + 2);

    const graph = await assembleSceneGraph(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(graph.scenes.map((s) => s.narration)).toEqual(['A 改', 'B 改', '']);
  });

  it('结构性操作要求 baseProjectRevision 精确匹配；过期 base → 409', async () => {
    const fixture = await makeFixture();
    const [a, b, c] = fixture.sceneIds;

    // 先做一次编辑使项目 revision 前进
    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [a ?? '']: 1 },
      operations: [{ op: 'update_scene', sceneId: a ?? '', changes: { narration: 'x' } }],
    }));

    const stale = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision, // 已过期
      operations: [{ op: 'reorder_scenes', orderedSceneIds: [c ?? '', b ?? '', a ?? ''] }],
    })).catch((error: unknown) => error as { code?: string; details?: { currentProjectRevision?: number } });

    expect(stale).toMatchObject({ code: 'VERSION_CONFLICT' });
    const staleDetails = (stale as { details?: { currentProjectRevision?: number } }).details;
    expect(staleDetails?.currentProjectRevision).toBe(fixture.projectRevision + 1);
  });

  it('Lock：锁定后不可 update/delete/split；显式解锁后可编辑', async () => {
    const fixture = await makeFixture();
    const sceneId = fixture.sceneIds[0] ?? '';

    const locked = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'set_scene_lock', sceneId, locked: true }],
    }));
    const lockedRevision = locked.response.scenes.find((s) => s.id === sceneId)?.revision ?? 0;
    expect(lockedRevision).toBe(2);

    const blocked = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: lockedRevision },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: '越权' } }],
    })).catch((error: unknown) => error as { code?: string });
    expect(blocked).toMatchObject({ code: 'PRECONDITION_FAILED' });

    const unlocked = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: lockedRevision },
      operations: [{ op: 'set_scene_lock', sceneId, locked: false }],
    }));
    const unlockedRevision = unlocked.response.scenes.find((s) => s.id === sceneId)?.revision ?? 0;

    const afterUnlock = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: unlockedRevision },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: '合法修改' } }],
    }));
    expect(afterUnlock.response.scenes.find((s) => s.id === sceneId)?.narration).toBe('合法修改');
  });

  it('缺失 expectedSceneRevisions → 400；同一请求重复操作同一 Scene → 400', async () => {
    const fixture = await makeFixture();
    const [a] = fixture.sceneIds;

    const missing = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      operations: [{ op: 'update_scene', sceneId: a ?? '', changes: { narration: 'x' } }],
    })).catch((error: unknown) => error as { code?: string });
    expect(missing).toMatchObject({ code: 'VALIDATION_FAILED' });

    const duplicated = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [a ?? '']: 1 },
      operations: [
        { op: 'update_scene', sceneId: a ?? '', changes: { narration: 'x' } },
        { op: 'update_scene', sceneId: a ?? '', changes: { narration: 'y' } },
      ],
    })).catch((error: unknown) => error as { code?: string; message?: string });
    expect(duplicated).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('结构性操作重算时间线：reorder + split + duplicate + delete 后仍连续相接', async () => {
    const fixture = await makeFixture();
    const [a, b, c] = fixture.sceneIds;

    const result = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [a ?? '']: 1, [c ?? '']: 1 },
      operations: [
        { op: 'reorder_scenes', orderedSceneIds: [c ?? '', a ?? '', b ?? ''] },
        { op: 'split_scene', sceneId: a ?? '', atMs: 2000 },
        { op: 'duplicate_scene', sceneId: b ?? '', afterSceneId: null },
        { op: 'delete_scene', sceneId: c ?? '' },
      ],
    }));

    const scenes = result.response.scenes;
    scenes.forEach((scene, index) => expect(scene.position).toBe(index));
    for (let i = 1; i < scenes.length; i += 1) {
      const prev = scenes[i - 1];
      const current = scenes[i];
      expect(current?.startMs).toBe((prev?.startMs ?? 0) + (prev?.durationMs ?? 0));
    }

    const graph = await assembleSceneGraph(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    const total = graph.scenes.reduce((sum, scene) => sum + scene.durationMs, 0);
    expect(graph.timeline.durationMs).toBe(total);
    expect(result.response.editEvents.map((e) => e.action)).toEqual([
      'REORDER_SCENES',
      'SPLIT_SCENE',
      'DUPLICATE_SCENE',
      'DELETE_SCENE',
    ]);
  });

  it('未排期操作 → 501 CAPABILITY_UNAVAILABLE 并注明计划阶段；批内任一失败则整批不提交', async () => {
    const fixture = await makeFixture();

    const failure = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [fixture.sceneIds[0] ?? '']: 1 },
      operations: [
        { op: 'update_scene', sceneId: fixture.sceneIds[0] ?? '', changes: { narration: '不应生效' } },
        { op: 'restore_project_version', versionId: 'pv_1' },
      ],
    })).catch((error: unknown) => error as { code?: string; httpStatus?: number; details?: { plannedPhase?: string } });

    expect(failure).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', httpStatus: 501 });
    const failureDetails = (failure as { details?: { plannedPhase?: string } }).details;
    expect(failureDetails?.plannedPhase).toBe('P02-03（历史恢复）');

    // 整批不提交：项目 revision 未变、目标 Scene 未改
    const fresh = await getProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(fresh.revision).toBe(fixture.projectRevision);
    const graph = await assembleSceneGraph(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(graph.scenes[0]?.narration).toBe('');
  });

  it('update_project：标题变更 + EditEvent（sceneId 为 null）', async () => {
    const fixture = await makeFixture();

    const result = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      operations: [{ op: 'update_project', changes: { title: '新标题' } }],
      intent: '换标题',
    }));

    expect(result.response.project.title).toBe('新标题');
    expect(result.response.editEvents[0]?.sceneId).toBeNull();
    expect(result.response.editEvents[0]?.action).toBe('UPDATE_PROJECT');
  });
});
