import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, generatePkcePair, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, idempotencyKeys, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * P01-05 验收：**不启动 Web，仅用 SDK 完成授权后的读写**。
 * 覆盖：Cookie 会话全流程（建租户/栏目/身份/风格）、写请求幂等（同键重放/冲突）、
 * 原生 PKCE → Bearer 会话 → 授权写入 → 撤销。
 */

const PASSWORD = 'password-1234';
const CLIENT_ID = 'ancs-desktop';
const REDIRECT_URI = 'ancs://auth/callback';

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
    secret: 'sdk-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `sdk-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: 'SDK 测试' });
  const client = createClient({ baseUrl, clientType: 'desktop', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, email };
}

describe('SDK 工作流（Cookie 会话）', () => {
  it('登录 → 建租户 → 建栏目 → 改样式（旧快照不变）→ 身份/风格读写 → 列表', async () => {
    const { client, email } = await newSignedInClient();

    const health = await client.health();
    expect(health.status).toBe('ok');

    const session = await client.auth.session();
    expect(session.method).toBe('web_session');
    expect(session.user.email).toBe(email);

    const workspace = await client.workspaces.create({ name: '独立客户端租户' });
    expect(workspace.role).toBe('OWNER');

    const channel = await client.channels.create(workspace.id, {
      name: '财经栏目',
      defaults: { aiVideoRatioMax: 0.15 },
    });
    expect(channel.currentStyleVersion).toBe(1);

    const updated = await client.channels.update(workspace.id, channel.id, { defaults: { aiVideoRatioMax: 0.05 } });
    expect(updated.currentStyleVersion).toBe(2);

    const versions = await client.channels.styleVersions(workspace.id, channel.id);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[1]?.defaults.aiVideoRatioMax).toBe(0.15); // 旧快照不变

    const identity = await client.creatorIdentities.create(workspace.id, { displayName: 'SDK 主持人' });
    const withVoice = await client.creatorIdentities.update(workspace.id, identity.id, {
      voiceIdentity: { provider: 'elevenlabs', providerVoiceId: 'vo_sdk_1', managedMode: 'BYOK' },
    });
    expect(withVoice.voiceIdentity?.managedMode).toBe('BYOK');
    expect(withVoice.voiceIdentity?.version).toBe(1);

    const speech = await client.speechProfiles.create(workspace.id, {
      name: 'SDK 风格',
      fields: { defaultSpeed: 1.1 },
    });
    expect(speech.latest.fields.defaultSpeed).toBe(1.1);
    expect(speech.latest.fields.tone).toBe('专业、克制、清晰'); // 系统默认合并

    const list = await client.workspaces.list();
    expect(list.map((w) => w.id)).toContain(workspace.id);
  });

  it('写请求幂等（§4.6）：同键同请求回放原结果；同键不同请求 409', async () => {
    const { client } = await newSignedInClient();
    const idempotencyKey = `idem_sdk_${randomUUID()}`;

    const first = await client.workspaces.create({ name: '幂等租户' }, { idempotencyKey });
    const replay = await client.workspaces.create({ name: '幂等租户' }, { idempotencyKey });
    expect(replay.id).toBe(first.id);
    expect(replay.createdAt).toBe(first.createdAt);

    const list = await client.workspaces.list();
    expect(list.filter((w) => w.id === first.id)).toHaveLength(1);

    const conflict = await client.workspaces.create({ name: '不同内容' }, { idempotencyKey }).catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(AncsApiError);
    expect(conflict).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('同键同 body 但不同资源路径：409，而不是把另一个工作区的结果回放过来（V5-M0 / 审查 P1-2）', async () => {
    const { client } = await newSignedInClient();
    const workspaceA = await client.workspaces.create({ name: '幂等 A' });
    const workspaceB = await client.workspaces.create({ name: '幂等 B' });
    const idempotencyKey = `idem_path_${randomUUID()}`;
    const channelA = await client.channels.create(workspaceA.id, { name: '同名栏目' }, { idempotencyKey });
    expect((await client.channels.list(workspaceA.id)).map((channel) => channel.id)).toContain(channelA.id);
    const reused = await client.channels.create(workspaceB.id, { name: '同名栏目' }, { idempotencyKey }).catch((e: unknown) => e);
    expect(reused).toBeInstanceOf(AncsApiError);
    expect(reused).toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
    // B 中没有出现 A 的栏目，也没有被悄悄创建
    expect(await client.channels.list(workspaceB.id)).toHaveLength(0);
  });

  it('崩溃遗留的"处理中"记录超时后可被同请求接管，而不是永久 409', async () => {
    const { client } = await newSignedInClient();
    const idempotencyKey = `idem_stale_${randomUUID()}`;
    const first = await client.workspaces.create({ name: '接管租户' }, { idempotencyKey });
    // 模拟：进程在处理中崩溃（记录停在 statusCode=null），且已超过接管阈值
    await handle.db.update(idempotencyKeys)
      .set({ statusCode: null, responseJson: null, completedAt: null, createdAt: new Date(Date.now() - 10 * 60 * 1000) })
      .where(eq(idempotencyKeys.key, idempotencyKey));
    const retried = await client.workspaces.create({ name: '接管租户' }, { idempotencyKey });
    expect(retried.name).toBe('接管租户');
    expect(retried.id).not.toBe(first.id); // 原请求结果已丢失：接管后重新执行（与 5xx 视为未发生一致）
    const replay = await client.workspaces.create({ name: '接管租户' }, { idempotencyKey });
    expect(replay.id).toBe(retried.id);
  });
});

describe('原生 PKCE → Bearer 会话', () => {
  it('授权码兑换后以 Bearer 完成授权写入；撤销后立即失效', async () => {
    const { client: cookieClient } = await newSignedInClient();

    const pkce = await generatePkcePair();
    const authorized = await cookieClient.auth.authorize({
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      codeChallenge: pkce.challenge,
      state: 'sdk_state_1',
    });
    expect(authorized.error).toBeNull();
    expect(authorized.code).toMatch(/^ancs_ac_/);

    const tokens = await cookieClient.auth.token({
      grantType: 'authorization_code',
      clientId: CLIENT_ID,
      code: authorized.code ?? '',
      codeVerifier: pkce.verifier,
    });

    const bearerClient = createClient({
      baseUrl,
      clientType: 'desktop',
      credentials: 'omit',
      getAccessToken: () => tokens.accessToken,
    });
    const bearerSession = await bearerClient.auth.session();
    expect(bearerSession.method).toBe('native_access');

    const workspace = await bearerClient.workspaces.create({ name: 'Bearer 客户端租户' });
    expect(workspace.role).toBe('OWNER');

    await bearerClient.auth.revoke({ clientId: CLIENT_ID, refreshToken: tokens.refreshToken });
    const revoked = await bearerClient.auth.session().catch((e: unknown) => e);
    expect(revoked).toBeInstanceOf(AncsApiError);
    expect(revoked).toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
  });
});
