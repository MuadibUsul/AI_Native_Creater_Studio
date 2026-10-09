import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sceneGraphSchema, type CreateSceneRequest } from '@ancs/contracts';
import {
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  addScene,
  assembleProjectDocument,
  assembleSceneGraph,
  createChannel,
  createProject,
  getProject,
  getProjectDetail,
  listProjects,
  requestSceneGeneration,
  updateChannel,
  type DomainDeps,
} from './index.js';

/**
 * P02-01 验收：数据库规范化状态可组装为合法 SceneGraph；跨租户引用被拒。
 * 同时兑现 P01-04 转来的项目级义务："修改 Channel 后旧项目不变、新项目继承新默认值"。
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
  await handle.db.delete(workspaces); // 级联 channels/projects/scenes
});

const createWorkspaceRow = async (): Promise<string> => {
  const id = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id, name: '项目测试租户' });
  return id;
};

const sceneDraft = (overrides: Partial<CreateSceneRequest> = {}): CreateSceneRequest => ({
  sceneType: 'HOST_FULL',
  semanticType: 'HOST_STATEMENT',
  narration: '开场。',
  visualIntent: '主持人开场',
  durationMs: 8000,
  ...overrides,
});

describe('Project 创建与 Channel 快照（P01-04 义务）', () => {
  it('验收：修改 Channel 后旧项目快照不变，新项目继承新默认值', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), {
      workspaceId,
      input: { name: '财经栏目', defaults: { aiVideoRatioMax: 0.15 } },
    });

    const projectOld = await createProject(deps(), {
      workspaceId,
      input: { title: '项目 A', channelId: channel.id },
    });
    expect(projectOld.channelSnapshot.styleVersion).toBe(1);
    expect(projectOld.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.15);

    // Channel 修改 → 产生 v2
    await updateChannel(deps(), {
      workspaceId,
      channelId: channel.id,
      input: { defaults: { aiVideoRatioMax: 0.05 } },
    });

    // 旧项目：快照仍指向 v1，内容逐字段不变
    const oldDetail = await getProjectDetail(deps(), { workspaceId, projectId: projectOld.id });
    expect(oldDetail.channelSnapshot.styleVersion).toBe(1);
    expect(oldDetail.channelSnapshot.channelStyleVersionId).toBe(projectOld.channelSnapshot.channelStyleVersionId);
    expect(oldDetail.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.15);

    // 新项目：继承 v2 的新默认值
    const projectNew = await createProject(deps(), {
      workspaceId,
      input: { title: '项目 B', channelId: channel.id },
    });
    expect(projectNew.channelSnapshot.styleVersion).toBe(2);
    expect(projectNew.channelSnapshot.defaults.aiVideoRatioMax).toBe(0.05);
  });

  it('创建 Project 校验 Channel 属于同一 Workspace（跨租户引用被拒）', async () => {
    const wsA = await createWorkspaceRow();
    const wsB = await createWorkspaceRow();
    const channelA = await createChannel(deps(), { workspaceId: wsA, input: { name: 'A 栏目' } });

    await expect(
      createProject(deps(), { workspaceId: wsB, input: { title: '越权项目', channelId: channelA.id } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listProjects(deps(), { workspaceId: wsB })).toEqual([]);
  });

  it('画幅覆盖与推导：9:16 → 1080x1920；不支持画幅被拒', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '竖屏栏目' } });

    const portrait = await createProject(deps(), {
      workspaceId,
      input: { title: '竖屏项目', channelId: channel.id, aspectRatio: '9:16' },
    });
    expect(portrait.aspectRatio).toBe('9:16');
    expect(portrait.resolution).toBe('1080x1920');

    await expect(
      createProject(deps(), { workspaceId, input: { title: '坏画幅', channelId: channel.id, aspectRatio: '21:9' } }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('Scene 追加与 SceneGraph 组装（P02-01 验收）', () => {
  it('追加 3 个场景：位置连续、时间线相接、Project revision 递增', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '栏目' } });
    const project = await createProject(deps(), { workspaceId, input: { title: '项目', channelId: channel.id } });
    expect(project.revision).toBe(1);

    const first = await addScene(deps(), {
      workspaceId,
      projectId: project.id,
      input: sceneDraft({ durationMs: 5000 }),
    });
    const second = await addScene(deps(), {
      workspaceId,
      projectId: project.id,
      input: sceneDraft({ sceneType: 'BIG_NUMBER', semanticType: 'NUMBER', durationMs: 7000 }),
    });
    const third = await addScene(deps(), {
      workspaceId,
      projectId: project.id,
      input: sceneDraft({ sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 6000 }),
    });

    expect([first.scene.position, second.scene.position, third.scene.position]).toEqual([0, 1, 2]);
    expect(first.scene.startMs).toBe(0);
    expect(second.scene.startMs).toBe(5000);
    expect(third.scene.startMs).toBe(12000);
    expect(third.project.revision).toBe(4); // 创建 1 + 三次追加

    const sceneRow = await getProject(deps(), { workspaceId, projectId: project.id });
    expect(sceneRow.status).toBe('DRAFT');
  });

  it('组装 SceneGraph：通过契约校验、时间线等于场景总和、Channel 快照正确', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '财经栏目' } });
    const project = await createProject(deps(), { workspaceId, input: { title: '金样项目', channelId: channel.id } });
    await addScene(deps(), { workspaceId, projectId: project.id, input: sceneDraft({ durationMs: 5000 }) });
    await addScene(deps(), {
      workspaceId,
      projectId: project.id,
      input: sceneDraft({ sceneType: 'SPREAD_AREA_CHART', semanticType: 'YIELD_SPREAD', durationMs: 9000 }),
    });

    const graph = await assembleSceneGraph(deps(), { workspaceId, projectId: project.id });

    // 显式二次校验（组装出口已 parse；此处作为验收证据再次锁定）
    expect(() => sceneGraphSchema.parse(graph)).not.toThrow();
    expect(graph.schemaVersion).toBe('0.1');
    expect(graph.projectRevision).toBe(3); // 创建 1 + 两次追加
    expect(graph.channelSnapshot.channelStyleVersion).toBe('1');
    expect(graph.format).toEqual({ width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' });
    expect(graph.timeline.durationMs).toBe(14000);
    expect(graph.scenes).toHaveLength(2);
    expect(graph.scenes[1]?.startMs).toBe(5000);
    expect(graph.scenes[1]?.sceneType).toBe('SPREAD_AREA_CHART');
  });

  it('跨租户：其他租户无法读取/组装该项目；追加场景被拒', async () => {
    const wsA = await createWorkspaceRow();
    const wsB = await createWorkspaceRow();
    const channelA = await createChannel(deps(), { workspaceId: wsA, input: { name: 'A 栏目' } });
    const projectA = await createProject(deps(), { workspaceId: wsA, input: { title: 'A 项目', channelId: channelA.id } });
    await addScene(deps(), { workspaceId: wsA, projectId: projectA.id, input: sceneDraft() });

    await expect(getProject(deps(), { workspaceId: wsB, projectId: projectA.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      getProjectDetail(deps(), { workspaceId: wsB, projectId: projectA.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      assembleSceneGraph(deps(), { workspaceId: wsB, projectId: projectA.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      addScene(deps(), { workspaceId: wsB, projectId: projectA.id, input: sceneDraft() }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(await listProjects(deps(), { workspaceId: wsB })).toEqual([]);
  });
});

describe('N01-02 ProjectDocument 与模式硬约束', () => {
  it('纯素材空工程无需文章、NarrativePlan 或旁白即可读取统一文档', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '素材栏目' } });
    const project = await createProject(deps(), {
      workspaceId,
      input: { title: '纯素材空工程', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
    });

    const document = await assembleProjectDocument(deps(), { workspaceId, projectId: project.id });
    expect(document.schemaVersion).toBe('1.0');
    expect(document.semanticPlan).toBeNull();
    expect(document.composition.objects).toEqual([]);
    expect(document.productionPolicy).toMatchObject({
      mode: 'FOOTAGE_EDIT',
      allowGeneratedVideo: false,
      allowScriptRewrite: false,
      preserveOriginalSpeech: true,
    });
    expect(document.compatibility.sceneGraph.projectId).toBe(project.id);
  });

  it('禁用新画面时在 Provider 路由和任务创建前拒绝生成镜头', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '保留素材栏目' } });
    const project = await createProject(deps(), {
      workspaceId,
      input: { title: '禁止新画面', channelId: channel.id, mode: 'FOOTAGE_EDIT' },
    });
    const created = await addScene(deps(), {
      workspaceId,
      projectId: project.id,
      input: sceneDraft({ sceneType: 'AI_VIDEO', semanticType: 'BROLL', narration: '', visualIntent: '生成不存在的新镜头' }),
    });

    const error = await requestSceneGeneration(deps(), {
      workspaceId,
      projectId: project.id,
      sceneId: created.scene.id,
      capability: 'video.generate',
    }).catch((cause: unknown) => cause);
    expect(error).toMatchObject({
      code: 'CAPABILITY_UNAVAILABLE',
      httpStatus: 409,
      details: {
        reason: 'PRODUCTION_POLICY_BLOCKED',
        capability: 'video.generate',
        policyField: 'allowGeneratedVideo',
        mode: 'FOOTAGE_EDIT',
      },
    });
  });

  it('旧创建调用保持生成兼容默认，并继续提供 SceneGraph 兼容投影', async () => {
    const workspaceId = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId, input: { name: '旧项目栏目' } });
    const project = await createProject(deps(), { workspaceId, input: { title: '旧调用项目', channelId: channel.id } });
    await addScene(deps(), { workspaceId, projectId: project.id, input: sceneDraft({ narration: '' }) });

    const document = await assembleProjectDocument(deps(), { workspaceId, projectId: project.id });
    expect(document.productionPolicy).toMatchObject({ mode: 'GENERATIVE', allowGeneratedVideo: true });
    expect(document.compatibility.sceneGraph.scenes).toHaveLength(1);
    expect(document.semanticPlan?.narrativePlanId).toBeNull();
  });
});
