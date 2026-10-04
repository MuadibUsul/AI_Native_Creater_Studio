import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { updateCreatorIdentityRequestSchema, updateSpeechProfileRequestSchema } from '@ancs/contracts';
import {
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  createCreatorIdentity,
  createSpeechProfile,
  getCreatorIdentity,
  getSpeechProfile,
  listSpeechProfileVersions,
  updateCreatorIdentity,
  updateSpeechProfile,
  type DomainDeps,
} from './index.js';

/** P01-04：Creator Identity（§6.1）与 SpeechProfile（§6.4）的版本化行为。 */

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
  await handle.db.delete(workspaces); // 级联 creator_identities / speech_profiles
});

const createWorkspaceRow = async (): Promise<string> => {
  const id = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id, name: '领域测试租户' });
  return id;
};

describe('Creator Identity（规范 §6.1）', () => {
  it('子身份独立版本化：更新 voice 不影响 avatar 版本；退役保留审计字段', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createCreatorIdentity(deps(), { workspaceId, displayName: '主持人 A' });
    expect(created.avatarIdentity).toBeNull();
    expect(created.voiceIdentity).toBeNull();

    const firstInput = updateCreatorIdentityRequestSchema.parse({
      avatarIdentity: { provider: 'heygen', providerAvatarId: 'av_1' },
      voiceIdentity: { provider: 'elevenlabs', providerVoiceId: 'vo_1', managedMode: 'PLATFORM_MANAGED' },
    });
    const v1 = await updateCreatorIdentity(deps(), { workspaceId, creatorIdentityId: created.id, input: firstInput });
    expect(v1.avatarIdentity?.version).toBe(1);
    expect(v1.voiceIdentity?.version).toBe(1);
    expect(v1.voiceIdentity?.managedMode).toBe('PLATFORM_MANAGED');

    const retireInput = updateCreatorIdentityRequestSchema.parse({
      voiceIdentity: { provider: 'elevenlabs', providerVoiceId: 'vo_1', managedMode: 'PLATFORM_MANAGED', status: 'RETIRED' },
    });
    const v2 = await updateCreatorIdentity(deps(), { workspaceId, creatorIdentityId: created.id, input: retireInput });

    // voice 版本 +1 且记录退役时间；avatar 保持版本 1（互不影响）
    expect(v2.voiceIdentity?.version).toBe(2);
    expect(v2.voiceIdentity?.status).toBe('RETIRED');
    expect(v2.voiceIdentity?.retiredAt).not.toBeNull();
    expect(v2.avatarIdentity?.version).toBe(1);
    expect(v2.avatarIdentity?.retiredAt).toBeNull();
  });

  it('Brand 主题 tokens 保存（§57）', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createCreatorIdentity(deps(), { workspaceId, displayName: '主持人 B' });
    const input = updateCreatorIdentityRequestSchema.parse({
      brandIdentity: {
        name: '品牌 A',
        themeTokens: {
          font: { heading: 'HeadingFont', body: 'BodyFont' },
          color: { background: '#000000', foreground: '#ffffff', accent: '#ff0000', positive: '#00ff00', negative: '#0000ff' },
          spacing: { sm: 4, md: 8, lg: 16 },
          radius: { sm: 2, md: 4, lg: 8 },
          motion: { durationFastMs: 150, durationBaseMs: 300, easing: 'linear' },
        },
      },
    });
    const updated = await updateCreatorIdentity(deps(), { workspaceId, creatorIdentityId: created.id, input });
    expect(updated.brandIdentity?.themeTokens.color.accent).toBe('#ff0000');
    expect(updated.brandIdentity?.version).toBe(1);
  });

  it('跨租户不可见（workspace 作用域）', async () => {
    const wsA = await createWorkspaceRow();
    const wsB = await createWorkspaceRow();
    const created = await createCreatorIdentity(deps(), { workspaceId: wsA, displayName: '主持人 C' });
    await expect(
      getCreatorIdentity(deps(), { workspaceId: wsB, creatorIdentityId: created.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('SpeechProfile（规范 §6.4）', () => {
  it('创建默认合并；更新产生新版本；发音词典随版本保存（§95）', async () => {
    const workspaceId = await createWorkspaceRow();
    const created = await createSpeechProfile(deps(), { workspaceId, name: '主叙述风格', fields: { defaultSpeed: 1.1 } });
    expect(created.currentVersion).toBe(1);
    expect(created.latest.fields.defaultSpeed).toBe(1.1);
    expect(created.latest.fields.tone).toBe('专业、克制、清晰'); // 来自系统默认

    const input = updateSpeechProfileRequestSchema.parse({
      fields: {
        defaultSpeed: 1.2,
        pronunciationDictionary: [{ term: 'OAT', reading: 'O-A-T' }],
      },
    });
    const updated = await updateSpeechProfile(deps(), {
      workspaceId,
      speechProfileId: created.id,
      name: input.name,
      fields: input.fields,
    });
    expect(updated.currentVersion).toBe(2);
    expect(updated.latest.fields.pronunciationDictionary).toEqual([{ term: 'OAT', reading: 'O-A-T' }]);

    // v1 不可变（词典为空、语速仍 1.1）
    const versions = await listSpeechProfileVersions(deps(), { workspaceId, speechProfileId: created.id });
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]?.fields.defaultSpeed).toBe(1.1);
    expect(versions[1]?.fields.pronunciationDictionary).toEqual([]);
  });

  it('跨租户不可见（workspace 作用域）', async () => {
    const wsA = await createWorkspaceRow();
    const wsB = await createWorkspaceRow();
    const created = await createSpeechProfile(deps(), { workspaceId: wsA, name: 'A 风格' });
    await expect(
      getSpeechProfile(deps(), { workspaceId: wsB, speechProfileId: created.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
