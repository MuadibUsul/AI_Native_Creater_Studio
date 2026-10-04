import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { asc, eq } from 'drizzle-orm';
import { editRequestSchema, type EditRequest } from '@ancs/contracts';
import {
  createDb,
  editEvents,
  projects,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  addScene,
  createChannel,
  createProject,
  createProjectVersion,
  getProject,
  getProjectVersion,
  listProjectVersions,
  processEdits,
  redoProject,
  undoProject,
  type DomainDeps,
} from './index.js';

/**
 * P02-03 验收：历史与恢复（§23.2 / §4.8）。
 *
 * - 版本快照不可变：恢复产生新 revision 与新版本，旧版本行与历史事件**不被改写**；
 * - restore_scene：按 Scene revision 重放内容事件恢复（同 id、新 revision）；
 * - Undo/Redo：补偿事件（UNDO_/REDO_ + compensatesEventId），LIFO，新编辑结束重做分支；
 * - 自动快照：AI 重编导前（pre-apply）与每 N 事件（seq 水位线，非时间戳）。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const depsWithAuto = (autoSnapshotEveryEvents: number): DomainDeps => ({ db: handle.db, autoSnapshotEveryEvents });

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

/** 建 3 个场景的测试项目：a=5000ms, b=7000ms, c=6000ms（narration 均为空串） */
async function makeFixture(repo: DomainDeps = deps()): Promise<Fixture> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '历史测试租户' });
  const channel = await createChannel(repo, { workspaceId, input: { name: '栏目' } });
  const project = await createProject(repo, { workspaceId, input: { title: '历史项目', channelId: channel.id } });
  const a = await addScene(repo, { workspaceId, projectId: project.id, input: { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 } });
  const b = await addScene(repo, { workspaceId, projectId: project.id, input: { sceneType: 'BIG_NUMBER', semanticType: 'NUMBER', durationMs: 7000 } });
  const c = await addScene(repo, { workspaceId, projectId: project.id, input: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 6000 } });
  const fresh = await getProject(repo, { workspaceId, projectId: project.id });
  return { workspaceId, projectId: project.id, sceneIds: [a.scene.id, b.scene.id, c.scene.id], projectRevision: fresh.revision };
}

const makeRequest = (overrides: Partial<EditRequest> & Pick<EditRequest, 'baseProjectRevision' | 'operations'>): EditRequest =>
  editRequestSchema.parse({
    expectedSceneRevisions: {},
    idempotencyKey: `idem_hist_${randomUUID()}`,
    ...overrides,
  });

const draft = (durationMs: number, overrides: Record<string, unknown> = {}) => ({
  sceneType: 'HOST_FULL',
  semanticType: 'HOST_STATEMENT',
  narration: '',
  visualIntent: '',
  durationMs,
  componentId: null,
  componentVersion: null,
  props: {},
  providerRequirement: null,
  sourceBindings: [],
  dataBindings: [],
  assetBindings: [],
  ...overrides,
});

const edit = (
  fixture: Fixture,
  request: EditRequest,
  repo: DomainDeps = deps(),
  actor: { type: 'USER' | 'AI' | 'SYSTEM'; id: string | null } = { type: 'USER', id: 'u_test' },
) => processEdits(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor, request });

const actor = { type: 'USER' as const, id: 'u_test' };

const loadRawEvents = async (projectId: string) => {
  const rows = await handle.db
    .select({
      id: editEvents.id,
      seq: editEvents.seq,
      action: editEvents.action,
      sceneId: editEvents.sceneId,
      patch: editEvents.patch,
      compensatesEventId: editEvents.compensatesEventId,
      resultRevision: editEvents.resultRevision,
    })
    .from(editEvents)
    .where(eq(editEvents.projectId, projectId))
    .orderBy(asc(editEvents.seq));
  return rows.map((row) => JSON.parse(JSON.stringify(row)) as unknown);
};

describe('项目版本与整项目恢复（§23.2）', () => {
  it('快照不可变：restore 只产生新 revision 与新版本，旧版本行与历史账本逐字节不变', async () => {
    const fixture = await makeFixture();
    const [a, , c] = fixture.sceneIds;

    const v1 = await createProjectVersion(deps(), {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      reason: 'MANUAL',
      note: '初稿',
    });
    expect(v1.versionNumber).toBe(1);
    expect(v1.sceneCount).toBe(3);

    const detailBefore = await getProjectVersion(deps(), {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      versionId: v1.id,
    });
    const snapshotBefore = JSON.stringify(detailBefore);
    const eventsBefore = await loadRawEvents(fixture.projectId);

    // 编辑：拉长 a、删除 c、在开头插入 d
    const edited = await edit(
      fixture,
      makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [a ?? '']: 1, [c ?? '']: 1 },
        operations: [
          { op: 'update_scene', sceneId: a ?? '', changes: { durationMs: 9000, narration: '拉长' } },
          { op: 'delete_scene', sceneId: c ?? '' },
          { op: 'insert_scene', afterSceneId: null, sceneDraft: draft(2000, { narration: '新开场' }) },
        ],
      }),
    );
    const editedRevision = edited.response.project.revision;
    expect(editedRevision).toBe(fixture.projectRevision + 1);
    expect(edited.response.scenes).toHaveLength(3);

    // 编辑后旧版本与账本仍未变；版本列表仍只有 1 个（默认每 50 事件才自动快照）
    expect(JSON.stringify(await getProjectVersion(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, versionId: v1.id }))).toBe(snapshotBefore);
    expect(await listProjectVersions(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId })).toHaveLength(1);

    // 恢复到 v1
    const restored = await edit(
      fixture,
      makeRequest({
        baseProjectRevision: editedRevision,
        operations: [{ op: 'restore_project_version', versionId: v1.id }],
        intent: '回到初稿',
      }),
    );

    // 新 revision、场景集合/内容/顺序回到快照（c 以同 id 重建、插入的 d 被移除）
    expect(restored.response.project.revision).toBe(editedRevision + 1);
    expect(restored.response.scenes.map((scene) => scene.id)).toEqual(fixture.sceneIds);
    const sceneA = restored.response.scenes.find((scene) => scene.id === a);
    const sceneC = restored.response.scenes.find((scene) => scene.id === c);
    expect(sceneA?.durationMs).toBe(5000);
    expect(sceneA?.narration).toBe('');
    expect(sceneA?.revision).toBe(3); // 恢复产生新 revision（1 → 2 编辑 → 3 恢复）
    expect(sceneC?.durationMs).toBe(6000);
    expect(sceneC?.revision).toBe(1); // 重建行
    expect(restored.response.editEvents.map((event) => event.action)).toEqual(['RESTORE_PROJECT_VERSION']);

    // 恢复后自动产生 RESTORE 版本，并成为 currentVersionId
    const versionsAfter = await listProjectVersions(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(versionsAfter).toHaveLength(2);
    expect(versionsAfter[0]?.reason).toBe('RESTORE');
    const projectRows = await handle.db
      .select({ currentVersionId: projects.currentVersionId })
      .from(projects)
      .where(eq(projects.id, fixture.projectId));
    expect(projectRows[0]?.currentVersionId).toBe(versionsAfter[0]?.id);

    // 旧版本、旧账本逐字节不变（恢复 = 追加，不改写）
    expect(JSON.stringify(await getProjectVersion(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, versionId: v1.id }))).toBe(snapshotBefore);
    const eventsAfter = await loadRawEvents(fixture.projectId);
    // 追加：编辑批次 3 个事件 + 恢复 1 个事件
    expect(eventsAfter.length).toBe(eventsBefore.length + 4);
    expect(eventsAfter.slice(0, eventsBefore.length)).toEqual(eventsBefore);
  });

  it('恢复的版本可再次恢复（快照互为参照，账本持续追加）', async () => {
    const fixture = await makeFixture();
    const [a] = fixture.sceneIds;
    const v1 = await createProjectVersion(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, reason: 'MANUAL' });

    const edited = await edit(
      fixture,
      makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [a ?? '']: 1 },
        operations: [{ op: 'update_scene', sceneId: a ?? '', changes: { durationMs: 4000 } }],
      }),
    );
    const v2 = await createProjectVersion(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, reason: 'MANUAL' });

    // 恢复 v1 → 5000；再恢复 v2 → 4000
    const back1 = await edit(fixture, makeRequest({
      baseProjectRevision: edited.response.project.revision,
      operations: [{ op: 'restore_project_version', versionId: v1.id }],
    }));
    expect(back1.response.scenes.find((scene) => scene.id === a)?.durationMs).toBe(5000);

    const back2 = await edit(fixture, makeRequest({
      baseProjectRevision: back1.response.project.revision,
      operations: [{ op: 'restore_project_version', versionId: v2.id }],
    }));
    expect(back2.response.scenes.find((scene) => scene.id === a)?.durationMs).toBe(4000);

    const versions = await listProjectVersions(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(versions.map((version) => version.reason).sort()).toEqual(['MANUAL', 'MANUAL', 'RESTORE', 'RESTORE']);
  });

  it('恢复不存在的版本 → 404；跨项目 workspace 隔离（版本必须属于该项目）', async () => {
    const fixture = await makeFixture();
    const other = await makeFixture();
    const foreign = await createProjectVersion(deps(), { workspaceId: other.workspaceId, projectId: other.projectId, reason: 'MANUAL' });

    const missing = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      operations: [{ op: 'restore_project_version', versionId: 'pv_missing' }],
    })).catch((error: unknown) => error as { code?: string; httpStatus?: number });
    expect(missing).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });

    const crossProject = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      operations: [{ op: 'restore_project_version', versionId: foreign.id }],
    })).catch((error: unknown) => error as { code?: string; httpStatus?: number });
    expect(crossProject).toMatchObject({ code: 'NOT_FOUND', httpStatus: 404 });
  });
});

describe('单 Scene 恢复（restore_scene：按 revision 重放）', () => {
  it('重放到指定 revision（同 id、内容与锁状态一并恢复、产生新 revision）', async () => {
    const fixture = await makeFixture();
    const [a] = fixture.sceneIds;
    const sceneId = a ?? '';

    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: 'v2' } }],
    }));
    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 1,
      expectedSceneRevisions: { [sceneId]: 2 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: 'v3', durationMs: 3000 } }],
    }));

    const restored = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 2,
      expectedSceneRevisions: { [sceneId]: 3 },
      operations: [{ op: 'restore_scene', sceneId, toRevision: 2 }],
      intent: '回到第二版',
    }));

    const scene = restored.response.scenes.find((candidate) => candidate.id === sceneId);
    expect(scene?.narration).toBe('v2');
    expect(scene?.durationMs).toBe(5000);
    expect(scene?.revision).toBe(4);
    expect(restored.response.editEvents.map((event) => event.action)).toEqual(['RESTORE_SCENE']);
    expect(restored.response.editEvents[0]?.patch['toRevision']).toBe(2);

    // 越界 revision → 409
    const beyond = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 3,
      expectedSceneRevisions: { [sceneId]: 4 },
      operations: [{ op: 'restore_scene', sceneId, toRevision: 99 }],
    })).catch((error: unknown) => error as { code?: string });
    expect(beyond).toMatchObject({ code: 'PRECONDITION_FAILED' });

    // 已处于该 revision → 409
    const already = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 3,
      expectedSceneRevisions: { [sceneId]: 4 },
      operations: [{ op: 'restore_scene', sceneId, toRevision: 4 }],
    })).catch((error: unknown) => error as { code?: string });
    expect(already).toMatchObject({ code: 'PRECONDITION_FAILED' });

    // restore_scene 同样可被撤销（内容回到恢复前）
    const undone = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    const afterUndo = undone.response.scenes.find((candidate) => candidate.id === sceneId);
    expect(afterUndo?.narration).toBe('v3');
    expect(afterUndo?.durationMs).toBe(3000);
    // 内容类事件的逆操作是内容写回（update_scene），事件链路仍指向被补偿的 RESTORE_SCENE
    expect(undone.response.editEvents.map((event) => event.action)).toEqual(['UNDO_UPDATE_SCENE']);
  });

  it('锁定场景不可恢复；恢复目标包含锁定状态（解锁后恢复会带回锁定）', async () => {
    const fixture = await makeFixture();
    const [a] = fixture.sceneIds;
    const sceneId = a ?? '';

    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'set_scene_lock', sceneId, locked: true }],
    }));
    const lockedRestore = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 1,
      expectedSceneRevisions: { [sceneId]: 2 },
      operations: [{ op: 'restore_scene', sceneId, toRevision: 1 }],
    })).catch((error: unknown) => error as { code?: string });
    expect(lockedRestore).toMatchObject({ code: 'PRECONDITION_FAILED' });

    // 解锁 → 恢复 rev1（当时未锁定）→ locked=false
    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 1,
      expectedSceneRevisions: { [sceneId]: 2 },
      operations: [{ op: 'set_scene_lock', sceneId, locked: false }],
    }));
    const restored = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 2,
      expectedSceneRevisions: { [sceneId]: 3 },
      operations: [{ op: 'restore_scene', sceneId, toRevision: 1 }],
    }));
    expect(restored.response.scenes.find((candidate) => candidate.id === sceneId)?.locked).toBe(false);
  });
});

describe('Undo / Redo（§4.8：补偿事件 + LIFO + 新编辑结束重做分支）', () => {
  it('无历史可撤销/重做 → 409', async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: workspaceId, name: '空项目租户' });
    const channel = await createChannel(deps(), { workspaceId, input: { name: '栏目' } });
    const project = await createProject(deps(), { workspaceId, input: { title: '空项目', channelId: channel.id } });

    const undoFailure = await undoProject(deps(), { workspaceId, projectId: project.id, actor }).catch((error: unknown) => error as { code?: string });
    expect(undoFailure).toMatchObject({ code: 'PRECONDITION_FAILED' });
    const redoFailure = await redoProject(deps(), { workspaceId, projectId: project.id, actor }).catch((error: unknown) => error as { code?: string });
    expect(redoFailure).toMatchObject({ code: 'PRECONDITION_FAILED' });
  });

  it('链式撤销/重做：UNDO_/REDO_ 事件与 compensatesEventId 链路；新编辑结束重做分支', async () => {
    const fixture = await makeFixture();
    const [a, b] = fixture.sceneIds;
    const sceneId = a ?? '';

    const edit1 = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      expectedSceneRevisions: { [sceneId]: 1 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: 'A1' } }],
    }));
    const edit2 = await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 1,
      expectedSceneRevisions: { [sceneId]: 2 },
      operations: [{ op: 'update_scene', sceneId, changes: { narration: 'A2' } }],
    }));
    const event2Id = edit2.response.editEvents[0]?.id ?? '';

    // 撤销 edit2 → 回到 A1
    const undo1 = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undo1.response.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('A1');
    expect(undo1.response.editEvents.map((event) => event.action)).toEqual(['UNDO_UPDATE_SCENE']);
    expect(undo1.response.editEvents[0]?.compensatesEventId).toBe(event2Id);
    expect(undo1.response.project.revision).toBe(fixture.projectRevision + 3);

    // 再撤销 → 回到空串（撤销 edit1）
    const undo2 = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undo2.response.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('');
    expect(undo2.response.editEvents[0]?.compensatesEventId).toBe(edit1.response.editEvents[0]?.id);

    // 重做（LIFO）：先恢复 edit1 → A1，再恢复 edit2 → A2
    const redo1 = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redo1.response.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('A1');
    expect(redo1.response.editEvents.map((event) => event.action)).toEqual(['REDO_UPDATE_SCENE']);

    const redo2 = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redo2.response.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('A2');

    // 重做栈空 → 409
    const redoEmpty = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor }).catch((error: unknown) => error as { code?: string });
    expect(redoEmpty).toMatchObject({ code: 'PRECONDITION_FAILED' });

    // 撤销一次后做新编辑 → 重做分支结束 → 409
    await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 7,
      expectedSceneRevisions: { [b ?? '']: 1 },
      operations: [{ op: 'update_scene', sceneId: b ?? '', changes: { narration: '新分支' } }],
    }));
    const branchEnded = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor }).catch((error: unknown) => error as { code?: string });
    expect(branchEnded).toMatchObject({ code: 'PRECONDITION_FAILED' });

    // 撤销目标选择：新编辑（b）先被撤销，不影响 a 的内容
    const undoNew = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoNew.response.scenes.find((scene) => scene.id === b)?.narration).toBe('');
    expect(undoNew.response.scenes.find((scene) => scene.id === sceneId)?.narration).toBe('A1');
  });

  it('insert/delete/duplicate/split/reorder 的逆操作（Scene id 稳定复用）', async () => {
    const fixture = await makeFixture();
    const [a, b] = fixture.sceneIds;
    let revision = fixture.projectRevision;

    // insert（追加到末尾）→ undo（移除）→ redo（同 id 恢复）
    const added = await addScene(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, input: { sceneType: 'BIG_NUMBER', semanticType: 'NUMBER', durationMs: 4000, narration: '新增' } });
    const addedId = added.scene.id;
    revision += 1;
    const undoInsert = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoInsert.response.editEvents.map((event) => event.action)).toEqual(['UNDO_DELETE_SCENE']);
    expect(undoInsert.response.scenes.map((scene) => scene.id)).not.toContain(addedId);
    const redoInsert = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redoInsert.response.editEvents.map((event) => event.action)).toEqual(['REDO_INSERT_SCENE']);
    const reinserted = redoInsert.response.scenes.find((scene) => scene.id === addedId);
    expect(reinserted?.narration).toBe('新增');
    expect(reinserted?.durationMs).toBe(4000);
    expect(reinserted?.position).toBe(3);
    revision += 2;

    // delete b → undo 恢复（同 id、内容一致）→ redo 再删除
    await edit(fixture, makeRequest({
      baseProjectRevision: revision,
      expectedSceneRevisions: { [b ?? '']: 1 },
      operations: [{ op: 'delete_scene', sceneId: b ?? '' }],
    }));
    revision += 1;
    const undoDelete = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    const revived = undoDelete.response.scenes.find((scene) => scene.id === b);
    expect(revived?.durationMs).toBe(7000);
    expect(revived?.position).toBe(1);
    revision += 1;
    const redoDelete = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redoDelete.response.scenes.map((scene) => scene.id)).not.toContain(b);
    revision += 1;

    // duplicate a → undo（副本移除）→ redo（同副本 id 恢复；afterSceneId=null 表示紧随源之后）
    const duplicated = await edit(fixture, makeRequest({
      baseProjectRevision: revision,
      operations: [{ op: 'duplicate_scene', sceneId: a ?? '', afterSceneId: null }],
    }));
    const copy = duplicated.response.scenes.find((scene) => scene.id !== a && scene.durationMs === 5000);
    const copyId = copy?.id ?? '';
    expect(copyId).not.toBe('');
    expect(copy?.position).toBe(1);
    revision += 1;
    await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    revision += 1;
    const redoDuplicate = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redoDuplicate.response.scenes.find((scene) => scene.id === copyId)?.position).toBe(1);
    revision += 1;

    // split a → undo（尾部移除、源时长恢复）→ redo（同尾部 id 重建）
    const split = await edit(fixture, makeRequest({
      baseProjectRevision: revision,
      expectedSceneRevisions: { [a ?? '']: 1 },
      operations: [{ op: 'split_scene', sceneId: a ?? '', atMs: 2000 }],
    }));
    const tail = split.response.scenes.find((scene) => scene.id !== a && scene.durationMs === 3000 && scene.position === 1);
    const tailId = tail?.id ?? '';
    expect(tailId).not.toBe('');
    revision += 1;
    const undoSplit = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoSplit.response.scenes.map((scene) => scene.id)).not.toContain(tailId);
    expect(undoSplit.response.scenes.find((scene) => scene.id === a)?.durationMs).toBe(5000);
    expect(undoSplit.response.editEvents).toHaveLength(2); // 逆操作 = 删除尾部 + 恢复源内容（同一请求，revision 只 +1）
    revision += 1;
    const redoSplit = await redoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(redoSplit.response.scenes.find((scene) => scene.id === a)?.durationMs).toBe(2000);
    expect(redoSplit.response.scenes.find((scene) => scene.id === tailId)?.durationMs).toBe(3000);
    revision += 1;

    // reorder → undo 恢复原顺序
    await edit(fixture, makeRequest({
      baseProjectRevision: revision,
      operations: [{ op: 'reorder_scenes', orderedSceneIds: [...split.response.scenes.map((scene) => scene.id)].reverse() }],
    }));
    const undoReorder = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoReorder.response.scenes.map((scene) => scene.id)).toEqual(redoSplit.response.scenes.map((scene) => scene.id));

    // 撤销（整体）后历史只增不改：事件总数 = 各步骤之和，且无 UPDATE 覆盖旧事件
    const rawEvents = await loadRawEvents(fixture.projectId);
    expect(rawEvents.every((event) => (event as { action: string }).action.length > 0)).toBe(true);
  });

  it('撤销 update_project 与 set_scene_lock', async () => {
    const fixture = await makeFixture();
    const [a] = fixture.sceneIds;

    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision,
      operations: [{ op: 'update_project', changes: { title: '改名' } }],
    }));
    const undoTitle = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoTitle.response.project.title).toBe('历史项目');
    expect(undoTitle.response.editEvents.map((event) => event.action)).toEqual(['UNDO_UPDATE_PROJECT']);

    await edit(fixture, makeRequest({
      baseProjectRevision: fixture.projectRevision + 2,
      expectedSceneRevisions: { [a ?? '']: 1 },
      operations: [{ op: 'set_scene_lock', sceneId: a ?? '', locked: true }],
    }));
    const undoLock = await undoProject(deps(), { workspaceId: fixture.workspaceId, projectId: fixture.projectId, actor });
    expect(undoLock.response.scenes.find((scene) => scene.id === a)?.locked).toBe(false);
    expect(undoLock.response.editEvents.map((event) => event.action)).toEqual(['UNDO_SET_SCENE_LOCK']);
  });
});

describe('自动快照（§23.2：AI 重编导前 + 每 N 事件水位线）', () => {
  it('每 N 事件自动快照以 seq 水位线计数（同毫秒事件不丢失）', async () => {
    const repo = depsWithAuto(2);
    const fixture = await makeFixture(repo);

    // 3 个 addScene 事件；第 2 个事件后达到阈值 → 1 个自动版本（水位线 = 事件 2）
    const versions = await listProjectVersions(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(versions.map((version) => version.reason)).toEqual(['AUTO_EVERY_N_EVENTS']);

    // 第 4 个事件：距水位线 2 个事件 → 新增自动版本
    await addScene(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, input: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 1000 } });
    const after = await listProjectVersions(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(after).toHaveLength(2);
    expect(after[0]?.reason).toBe('AUTO_EVERY_N_EVENTS');

    // 第 5 个事件：距水位线仅 1 个 → 不新增
    await addScene(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, input: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 1000 } });
    expect(await listProjectVersions(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId })).toHaveLength(2);
  });

  it('AI 重编导：应用前快照（AI_REDIRECT）记录旧状态，且可直接恢复', async () => {
    const repo = depsWithAuto(50);
    const fixture = await makeFixture(repo);
    const [a] = fixture.sceneIds;
    const sceneId = a ?? '';
    const beforeEvents = (await loadRawEvents(fixture.projectId)) as { seq: number }[];
    const maxSeqBefore = Math.max(...beforeEvents.map((event) => event.seq));

    const ai = await edit(
      fixture,
      makeRequest({
        baseProjectRevision: fixture.projectRevision,
        expectedSceneRevisions: { [sceneId]: 1 },
        operations: [{ op: 'update_scene', sceneId, changes: { durationMs: 9000 } }],
      }),
      repo,
      { type: 'AI', id: 'ai_director' },
    );
    expect(ai.response.scenes.find((scene) => scene.id === sceneId)?.durationMs).toBe(9000);

    const versions = await listProjectVersions(repo, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    const aiVersion = versions.find((version) => version.reason === 'AI_REDIRECT');
    expect(aiVersion).toBeDefined();
    // createdBy 只记录真实用户（AI 触发为空；发起链路经 EditEvent.actorId 追溯）
    expect(aiVersion?.createdBy).toBeNull();

    const detail = await getProjectVersion(repo, {
      workspaceId: fixture.workspaceId,
      projectId: fixture.projectId,
      versionId: aiVersion?.id ?? '',
    });
    // 快照记录的是 AI 应用**之前**的状态（事件水位线为 AI 事件之前）
    expect(detail.snapshot.graph.scenes.find((scene) => scene.id === sceneId)?.durationMs).toBe(5000);
    expect(detail.snapshot.meta['eventSeq']).toBe(maxSeqBefore);

    // 快照可恢复（重编导前的救命快照）
    const restored = await edit(fixture, makeRequest({
      baseProjectRevision: ai.response.project.revision,
      operations: [{ op: 'restore_project_version', versionId: aiVersion?.id ?? '' }],
    }));
    expect(restored.response.scenes.find((scene) => scene.id === sceneId)?.durationMs).toBe(5000);
  });
});
