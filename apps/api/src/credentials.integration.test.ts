import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encryptedSecretSchema, type ProviderCatalog } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, providerCatalogVersions, providerConnections, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import {
  createCatalogVersion,
  createConnection,
  resolveProviderRoute,
  rotateConnection,
  revokeConnection,
  testConnection,
  upsertWorkspaceProviderSetting,
  type DomainDeps,
} from '@ancs/domain';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { buildServer } from './server.js';
import { parsePlatformCredentials } from './plugins/credentials.js';

/**
 * P03-04 验收：
 * - KMS/envelope encryption：密文落库（AES-256-GCM 封套），明文绝不落库/外发；
 * - **密钥不进入前端及日志**：所有响应与错误信封都不含 Secret/密文/密钥材料；
 * - **跨租户连接不可使用**：他人连接读取/测试/轮换/撤销一律 404；
 * - Managed/BYOK 选择（§17.2）：AUTOMATIC 优先 BYOK 否则平台托管；显式 BYOK 无连接 → 拒绝（不静默回落）；
 *   撤销后 Router 立即不再选用；轮换后可继续使用；
 * - 连接测试：离线校验 + 注入钩子的真实测试；失败 → INVALID 且信息不含 Secret。
 */

const SECRET_MARKER = 'sk-live-ANCS-SECRET-MARKER-9f3a1b'; // secrets:check-ignore：测试专用假凭据（断言不外泄）
const SECRET_MARKER_2 = 'sk-live-ANCS-ROTATED-MARKER-2c8d4e'; // secrets:check-ignore：测试专用假凭据

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let vault: LocalCredentialVault;

const platformKeys = `llm.managed:${SECRET_MARKER}`; // secrets:check-ignore：测试专用假凭据

const deps = (): DomainDeps => ({
  db: handle.db,
  credentials: vault,
  platformCredentials: parsePlatformCredentials(platformKeys),
});

function freshEntry(providerId: string, capability: string, kind: 'LLM' | 'TTS'): ProviderCatalog['entries'][number] {
  return {
    providerId,
    providerName: providerId,
    kind,
    connectionRequired: true,
    capabilities: [capability],
    models: [
      {
        modelId: `${providerId}-model`,
        displayName: providerId,
        status: 'ACTIVE',
        capabilities: [capability],
        price: { unit: 'CALL', unitPrice: { amount: '0.01', currency: 'USD' }, minimumUnits: 0, note: null },
        limits: { maxConcurrency: 4, maxInputSeconds: 600, maxInputCharacters: 5000, maxRequestsPerMinute: 60 },
        regions: [],
        dataRetention: 'STANDARD',
        residency: [],
        verifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        deprecatedAt: null,
        metadata: {},
      },
    ],
    metadata: {},
  };
}

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
  vault = new LocalCredentialVault({ keys: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=,v2:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=' });
  auth = createAuth({
    db: handle.db,
    secret: 'credentials-workflow-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    credentials: { cipher: vault, platformCredentials: parsePlatformCredentials(platformKeys) },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function freshWorkspace(): Promise<string> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '凭据测试租户' });
  return workspaceId;
}

async function resetCatalog(): Promise<void> {
  await handle.db.delete(providerCatalogVersions);
  await createCatalogVersion(deps(), { entries: [freshEntry('tts.byok', 'speech.synthesize', 'TTS'), freshEntry('llm.managed', 'text.generate', 'LLM')] });
}

describe('凭据保险库与连接管理（P03-04）', () => {
  it('加密落库：数据库中只有 AES-256-GCM 封套，无明文；DTO 只含掩码', async () => {
    await resetCatalog();
    const workspaceId = await freshWorkspace();

    const connection = await createConnection(deps(), {
      workspaceId,
      userId: null,
      input: { providerId: 'tts.byok', kind: 'TTS', label: '我的 TTS', secret: SECRET_MARKER },
    });
    expect(connection.maskedToken).toBe(`••••${SECRET_MARKER.slice(-4)}`);
    expect(JSON.stringify(connection)).not.toContain(SECRET_MARKER);
    expect(connection.keyVersion).toBe('v2'); // 当前写入使用最新密钥版本

    const rows = await handle.db.select().from(providerConnections).where(eq(providerConnections.id, connection.id));
    const row = rows[0];
    expect(row).toBeDefined();
    const envelope = encryptedSecretSchema.parse(row?.encryptedSecret);
    expect(envelope.algorithm).toBe('AES-256-GCM');
    expect(envelope.keyVersion).toBe('v2');
    expect(row?.encryptedSecret as unknown as Record<string, unknown>).not.toHaveProperty('plaintext');
    expect(JSON.stringify(row?.encryptedSecret)).not.toContain(SECRET_MARKER);
    // 密文可解密回明文（仅服务端）
    expect(await vault.decrypt(envelope)).toBe(SECRET_MARKER);
  });

  it('轮换与撤销：轮换换密钥版本并保留可用性；撤销后立即从路由消失；测试记录不含 Secret', async () => {
    await resetCatalog();
    const workspaceId = await freshWorkspace();
    const connection = await createConnection(deps(), {
      workspaceId,
      userId: null,
      input: { providerId: 'tts.byok', kind: 'TTS', label: '主 TTS', secret: SECRET_MARKER },
    });

    // 连接测试：离线校验通过（无钩子）
    const offline = await testConnection(deps(), { workspaceId, connectionId: connection.id });
    expect(offline.test).toMatchObject({ ok: true, mode: 'OFFLINE_VALIDATION' });
    expect(offline.test.message).not.toContain(SECRET_MARKER);
    expect(JSON.stringify(offline)).not.toContain(SECRET_MARKER);

    // 注入"真实"测试钩子（模拟 Provider 侧校验；P03-07 的 Mock 将提供同接口）
    const live = await testConnection(deps(), {
      workspaceId,
      connectionId: connection.id,
      testHooks: [
        {
          providerId: 'tts.byok',
          test: async (secret) => ({ ok: secret === SECRET_MARKER, message: '模拟 Provider 校验（消息不含 Secret）' }),
        },
      ],
    });
    expect(live.test).toMatchObject({ ok: true, mode: 'LIVE' });

    // 轮换 → v1/v2 均可解密（历史密钥保留）
    const rotated = await rotateConnection(deps(), { workspaceId, connectionId: connection.id, newSecret: SECRET_MARKER_2 });
    expect(rotated.rotatedAt).not.toBeNull();
    expect(rotated.maskedToken).toBe(`••••${SECRET_MARKER_2.slice(-4)}`);
    const rows = await handle.db.select().from(providerConnections).where(eq(providerConnections.id, connection.id));
    expect(await vault.decrypt(encryptedSecretSchema.parse(rows[0]?.encryptedSecret))).toBe(SECRET_MARKER_2);

    // 撤销 → 不可再测试；路由回落到平台/拒绝
    const revoked = await revokeConnection(deps(), { workspaceId, connectionId: connection.id });
    expect(revoked.status).toBe('REVOKED');
    await expect(testConnection(deps(), { workspaceId, connectionId: connection.id })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('Managed/BYOK 选择（§17.2）：AUTOMATIC 优先 BYOK；显式 BYOK 缺连接 → 拒绝；平台托管可用时回落', async () => {
    await resetCatalog();
    const workspaceId = await freshWorkspace();

    // 无 BYOK、无平台凭据 → 拒绝（fail-closed）
    const none = await resolveProviderRoute(deps(), { workspaceId, capability: 'speech.synthesize' }).catch((error: unknown) => error);
    expect(none).toMatchObject({ httpStatus: 501 });
    expect((none as { details: { rejected: { credentialReason: string }[] } }).details.rejected[0]?.credentialReason).toBe(
      'NO_BYOK_AND_NO_PLATFORM_CREDENTIAL',
    );

    // 建立 BYOK → AUTOMATIC 选 BYOK
    const connection = await createConnection(deps(), {
      workspaceId,
      userId: null,
      input: { providerId: 'tts.byok', kind: 'TTS', label: 'BYOK', secret: SECRET_MARKER },
    });
    const byok = await resolveProviderRoute(deps(), { workspaceId, capability: 'speech.synthesize' });
    expect(byok.decision).toMatchObject({ providerId: 'tts.byok', credentialMode: 'BYOK', connectionId: connection.id, reason: 'BYOK_PREFERRED_AUTOMATIC' });
    expect(JSON.stringify(byok)).not.toContain(SECRET_MARKER);

    // 平台托管：llm.managed 在平台凭据登记表中 → AUTOMATIC 回落 PLATFORM_MANAGED
    const managed = await resolveProviderRoute(deps(), { workspaceId, capability: 'text.generate' });
    expect(managed.decision).toMatchObject({ providerId: 'llm.managed', credentialMode: 'PLATFORM_MANAGED', connectionId: null, reason: 'PLATFORM_FALLBACK_AUTOMATIC' });

    // 显式 BYOK 设置但撤销连接 → 明确拒绝（不静默回落）
    await revokeConnection(deps(), { workspaceId, connectionId: connection.id });
    await upsertWorkspaceProviderSetting(deps(), { workspaceId, kind: 'TTS', selectionMode: 'BYOK' });
    const rejected = await resolveProviderRoute(deps(), { workspaceId, capability: 'speech.synthesize' }).catch((error: unknown) => error);
    expect((rejected as { details: { rejected: { credentialReason: string }[] } }).details.rejected[0]?.credentialReason).toBe(
      'BYOK_SELECTED_BUT_CONNECTION_MISSING',
    );

    // 显式 PLATFORM_MANAGED 设置：平台可用 → 通过；平台不可用（tts.byok 无平台凭据）→ 拒绝
    await upsertWorkspaceProviderSetting(deps(), { workspaceId, kind: 'LLM', selectionMode: 'PLATFORM_MANAGED' });
    expect((await resolveProviderRoute(deps(), { workspaceId, capability: 'text.generate' })).decision?.credentialMode).toBe('PLATFORM_MANAGED');
    await upsertWorkspaceProviderSetting(deps(), { workspaceId, kind: 'TTS', selectionMode: 'PLATFORM_MANAGED' });
    const ttsManaged = await resolveProviderRoute(deps(), { workspaceId, capability: 'speech.synthesize' }).catch((error: unknown) => error);
    expect((ttsManaged as { details: { rejected: { credentialReason: string }[] } }).details.rejected[0]?.credentialReason).toBe('PLATFORM_CREDENTIAL_MISSING');
  });
});

describe('HTTP/SDK：密钥不外泄与跨租户隔离（REQ-51-06 收尾）', () => {
  async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
    const email = `${tag}-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email, password: 'password-1234', name: tag });
    const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    await client.auth.signIn({ email, password: 'password-1234' });
    return { client, email };
  }

  it('创建/读取/轮换/测试/撤销：响应均无 Secret；能力不足（VIEWER）403；跨租户 404 且无法使用', async () => {
    await resetCatalog();
    const owner = await newClient('cred-owner');
    const viewer = await newClient('cred-viewer');
    const stranger = await newClient('cred-stranger');
    const workspace = await owner.client.workspaces.create({ name: `凭据-${randomUUID().slice(0, 8)}` });
    await owner.client.workspaces.members.add(workspace.id, { email: viewer.email, role: 'VIEWER' });

    const created = await owner.client.providerConnections.create(workspace.id, {
      providerId: 'tts.byok',
      kind: 'TTS',
      label: 'BYOK 连接',
      secret: SECRET_MARKER,
    });
    expect(JSON.stringify(created)).not.toContain(SECRET_MARKER);
    expect(created.maskedToken).toBe(`••••${SECRET_MARKER.slice(-4)}`);

    const fetched = await owner.client.providerConnections.get(workspace.id, created.id);
    const tested = await owner.client.providerConnections.test(workspace.id, created.id);
    const rotated = await owner.client.providerConnections.rotate(workspace.id, created.id, SECRET_MARKER_2);
    const route = await owner.client.providerCatalog.route(workspace.id, 'speech.synthesize');
    const listed = await owner.client.providerConnections.list(workspace.id);
    const payloads = [JSON.stringify(fetched), JSON.stringify(tested), JSON.stringify(rotated), JSON.stringify(route), JSON.stringify(listed)];
    for (const payload of payloads) {
      expect(payload).not.toContain(SECRET_MARKER);
      expect(payload).not.toContain(SECRET_MARKER_2);
      expect(payload).not.toContain('ciphertext');
      expect(payload).not.toContain('authTag');
      expect(payload).not.toContain('encryptedSecret');
    }
    expect(route.decision?.credentialMode).toBe('BYOK');

    // VIEWER：无 provider:manage → 403（连接列表也不可见）
    const viewerCreate = await viewer.client.providerConnections
      .create(workspace.id, { providerId: 'tts.byok', kind: 'TTS', label: 'x', secret: SECRET_MARKER })
      .catch((error: unknown) => error);
    expect(viewerCreate).toBeInstanceOf(AncsApiError);
    expect(viewerCreate).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((viewerCreate as AncsApiError).details['requiredCapability']).toBe('provider:manage');
    const viewerList = await viewer.client.providerConnections.list(workspace.id).catch((error: unknown) => error);
    expect(viewerList).toMatchObject({ status: 403 });

    // 跨租户：陌生人读取/测试/轮换/撤销一律 404（抗枚举），错误信封不含任何 Secret 材料
    for (const action of [
      () => stranger.client.providerConnections.get(workspace.id, created.id),
      () => stranger.client.providerConnections.test(workspace.id, created.id),
      () => stranger.client.providerConnections.rotate(workspace.id, created.id, SECRET_MARKER),
      () => stranger.client.providerConnections.revoke(workspace.id, created.id),
      () => stranger.client.providerConnections.list(workspace.id),
    ]) {
      const failure = await action().catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      expect(JSON.stringify(failure)).not.toContain(SECRET_MARKER);
      expect(JSON.stringify(failure)).not.toContain('ciphertext');
    }

    // 跨租户"不可使用"：他人的路由决策不会选中/引用他人连接（陌生人 workspace 无连接 → 501）
    const strangerWorkspace = await stranger.client.workspaces.create({ name: `陌生人-${randomUUID().slice(0, 8)}` });
    const strangerRoute = await stranger.client.providerCatalog.route(strangerWorkspace.id, 'speech.synthesize').catch((error: unknown) => error);
    expect(strangerRoute).toMatchObject({ status: 501 });
    if (strangerRoute instanceof AncsApiError) {
      expect(JSON.stringify(strangerRoute.details)).not.toContain(created.id); // 不泄漏他人连接 id
    }

    // 撤销后：决策明确拒绝（连接不再可用）
    await owner.client.providerConnections.revoke(workspace.id, created.id);
    const afterRevoke = await owner.client.providerCatalog.route(workspace.id, 'speech.synthesize').catch((error: unknown) => error);
    expect(afterRevoke).toMatchObject({ status: 501 });
  });

  it('创建连接必须对应现行 Catalog（拼写错误 → 501，不产生死配置）', async () => {
    await resetCatalog();
    const owner = await newClient('cred-catalog');
    const workspace = await owner.client.workspaces.create({ name: `目录校验-${randomUUID().slice(0, 8)}` });
    const failure = await owner.client.providerConnections
      .create(workspace.id, { providerId: 'not-in-catalog', kind: 'TTS', label: 'x', secret: SECRET_MARKER })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 501, code: 'CAPABILITY_UNAVAILABLE' });
  });
});
