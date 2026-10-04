import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  createChannel,
  getChannel,
  getChannelStyleVersion,
  listChannelStyleVersions,
  listChannels,
  updateChannel,
  type DomainDeps,
} from './index.js';

/**
 * P01-04 验收：Channel 默认值快照语义 ——
 * "修改 Channel 后旧项目不变；新项目继承新默认值" 由不可变样式版本保证。
 * （项目级用例（P02-01 创建 Project 时快照版本）在 Project 落地后按同一模式补充。）
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
  await handle.db.delete(workspaces); // 级联 channels / style versions
});

const createWorkspaceRow = async (): Promise<string> => {
  const id = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id, name: '领域测试租户' });
  return id;
};

describe('Channel 样式版本与快照语义', () => {
  it('验收：修改 Channel 后旧快照不变，新读取继承新默认值', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createChannel(deps(), {
      workspaceId,
      input: { name: '财经栏目', defaults: { aiVideoRatioMax: 0.15 } },
    });
    expect(created.currentStyleVersion).toBe(1);
    expect(created.styleVersion.defaults.aiVideoRatioMax).toBe(0.15);

    // 模拟 P02-01：创建 Project 时快照其使用的样式版本（旧项目持有序号 1）
    const projectSnapshotVersion = created.styleVersion.version;

    const updated = await updateChannel(deps(), {
      workspaceId,
      channelId: created.id,
      input: { defaults: { aiVideoRatioMax: 0.05, hostRatioRange: { min: 0.2, max: 0.35 } } },
    });
    expect(updated.currentStyleVersion).toBe(2);

    // 旧项目解析其快照版本：内容不变
    const resolvedOld = await getChannelStyleVersion(deps(), {
      workspaceId,
      channelId: created.id,
      version: projectSnapshotVersion,
    });
    expect(resolvedOld.defaults).toEqual(created.styleVersion.defaults);
    expect(resolvedOld.defaults.aiVideoRatioMax).toBe(0.15);

    // 新项目（新读取）继承新默认值；未覆盖字段来自上一版本的合并基础
    const fresh = await getChannel(deps(), { workspaceId, channelId: created.id });
    expect(fresh.currentStyleVersion).toBe(2);
    expect(fresh.styleVersion.defaults.aiVideoRatioMax).toBe(0.05);
    expect(fresh.styleVersion.defaults.hostRatioRange).toEqual({ min: 0.2, max: 0.35 });
    expect(fresh.styleVersion.defaults.hookStyle).toBe(created.styleVersion.defaults.hookStyle);
  });

  it('仅改名不产生新样式版本', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createChannel(deps(), { workspaceId, input: { name: '旧名' } });
    const renamed = await updateChannel(deps(), { workspaceId, channelId: created.id, input: { name: '新名' } });
    expect(renamed.name).toBe('新名');
    expect(renamed.currentStyleVersion).toBe(1);
    expect(await listChannelStyleVersions(deps(), { workspaceId, channelId: created.id })).toHaveLength(1);
  });

  it('样式版本历史不可变且可列出（版本号降序）', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createChannel(deps(), { workspaceId, input: { name: '历史栏目', defaults: { aiVideoRatioMax: 0.2 } } });
    await updateChannel(deps(), { workspaceId, channelId: created.id, input: { defaults: { aiVideoRatioMax: 0.1 } } });
    await updateChannel(deps(), { workspaceId, channelId: created.id, input: { defaults: { aiVideoRatioMax: 0.0 } } });

    const versions = await listChannelStyleVersions(deps(), { workspaceId, channelId: created.id });
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    // v1 不可变
    expect(versions[2]?.defaults.aiVideoRatioMax).toBe(0.2);
  });

  it('并发更新产生唯一连续版本号（行锁串行化）', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createChannel(deps(), { workspaceId, input: { name: '并发栏目' } });

    const results = await Promise.allSettled([
      updateChannel(deps(), { workspaceId, channelId: created.id, input: { defaults: { aiVideoRatioMax: 0.11 } } }),
      updateChannel(deps(), { workspaceId, channelId: created.id, input: { defaults: { aiVideoRatioMax: 0.12 } } }),
    ]);
    expect(results.every((r) => r.status === 'fulfilled'), '并发更新应串行成功').toBe(true);

    const versions = await listChannelStyleVersions(deps(), { workspaceId, channelId: created.id });
    expect(versions.map((v) => v.version)).toEqual([3, 2, 1]);
    const final = await getChannel(deps(), { workspaceId, channelId: created.id });
    expect(final.currentStyleVersion).toBe(3);
  });

  it('服务查询强制 workspace 作用域（跨租户不可见）', async () => {
    const wsA = await createWorkspaceRow();
    const wsB = await createWorkspaceRow();
    const channel = await createChannel(deps(), { workspaceId: wsA, input: { name: 'A 栏目' } });

    await expect(getChannel(deps(), { workspaceId: wsB, channelId: channel.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      updateChannel(deps(), { workspaceId: wsB, channelId: channel.id, input: { name: '篡改' } }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await listChannels(deps(), { workspaceId: wsB })).toEqual([]);
  });
});
