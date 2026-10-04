import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderCatalog } from '@ancs/contracts';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, providerCatalogVersions, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createCatalogVersion, type DomainDeps } from '@ancs/domain';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { buildServer } from './server.js';
import { parsePlatformCredentials } from './plugins/credentials.js';

/**
 * P03-04 安全验收（§51 多租户矩阵的**收尾项：Provider credential isolation**，REQ-51-06 4/4）：
 * - 跨 Workspace 读/写/使用 Provider 连接一律 404（抗枚举）；
 * - 任何响应与错误信封都不含 Secret / 密文 / 密钥材料（客户端永不持有 Provider Key，§75）；
 * - 平台托管凭据只在服务端登记表中存在（`has()` 可见性），不经任何端点外发。
 */

const SECRET_MARKER = 'sk-sec-ANCS-PROVIDER-KEY-7b21c9'; // secrets:check-ignore：测试专用假凭据（断言不外泄）
const VAULT_KEYS = 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // secrets:check-ignore：测试专用假密钥

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let vault: LocalCredentialVault;

const platformKeys = `llm.sec:${SECRET_MARKER}`; // secrets:check-ignore：测试专用假凭据
const deps = (): DomainDeps => ({ db: handle.db, credentials: vault, platformCredentials: parsePlatformCredentials(platformKeys) });

function entry(providerId: string, capability: string, kind: 'LLM' | 'TTS'): ProviderCatalog['entries'][number] {
  return {
    providerId,
    providerName: providerId,
    kind,
    connectionRequired: true,
    capabilities: [capability],
    models: [
      {
        modelId: `${providerId}-m`,
        displayName: providerId,
        status: 'ACTIVE',
        capabilities: [capability],
        price: { unit: 'CALL', unitPrice: { amount: '0.01', currency: 'USD' }, minimumUnits: 0, note: null },
        limits: { maxConcurrency: 2, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null },
        regions: [],
        dataRetention: 'ZERO_RETENTION',
        residency: [],
        verifiedAt: new Date(Date.now() - 3600_000).toISOString(),
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
  vault = new LocalCredentialVault({ keys: VAULT_KEYS });
  auth = createAuth({
    db: handle.db,
    secret: 'credential-security-secret-0123456789', // secrets:check-ignore：测试专用假密钥
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

async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return { client, email };
}

describe('Provider 凭据隔离（§51 / §17.3 / §75）', () => {
  it('跨 Workspace 的连接读取/测试/轮换/撤销/列表一律 404；错误信封无 Secret 材料', async () => {
    await handle.db.delete(providerCatalogVersions);
    await createCatalogVersion(deps(), { entries: [entry('tts.sec', 'speech.synthesize', 'TTS')] });

    const owner = await newClient('sec-owner');
    const attacker = await newClient('sec-attacker');
    const workspace = await owner.client.workspaces.create({ name: `隔离-${randomUUID().slice(0, 8)}` });
    const connection = await owner.client.providerConnections.create(workspace.id, {
      providerId: 'tts.sec',
      kind: 'TTS',
      label: '私有连接',
      secret: SECRET_MARKER,
    });

    const attempts = [
      () => attacker.client.providerConnections.get(workspace.id, connection.id),
      () => attacker.client.providerConnections.list(workspace.id),
      () => attacker.client.providerConnections.test(workspace.id, connection.id),
      () => attacker.client.providerConnections.rotate(workspace.id, connection.id, 'sk-attacker-new-value'),
      () => attacker.client.providerConnections.revoke(workspace.id, connection.id),
      () => attacker.client.providerSettings.list(workspace.id),
      () => attacker.client.providerSettings.set(workspace.id, 'TTS', { selectionMode: 'PLATFORM_MANAGED' }),
    ];
    for (const attempt of attempts) {
      const failure = await attempt().catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      const serialized = JSON.stringify(failure);
      expect(serialized).not.toContain(SECRET_MARKER);
      expect(serialized).not.toContain('ciphertext');
      expect(serialized).not.toContain(connection.id); // 不泄漏他人资源 id
    }

    // 攻击者仍无法使用该连接：其自身 workspace 无凭据 → 明确拒绝
    const attackerWorkspace = await attacker.client.workspaces.create({ name: `攻击者-${randomUUID().slice(0, 8)}` });
    const routeFailure = await attacker.client.providerCatalog.route(attackerWorkspace.id, 'speech.synthesize').catch((error: unknown) => error);
    expect(routeFailure).toMatchObject({ status: 501 });
    expect(JSON.stringify(routeFailure)).not.toContain(connection.id);
  });

  it('客户端永不持有 Provider Key：全端点响应无 Secret/密文；平台凭据仅服务端可见性', async () => {
    await handle.db.delete(providerCatalogVersions);
    await createCatalogVersion(deps(), { entries: [entry('llm.sec', 'text.generate', 'LLM')] });

    const owner = await newClient('sec-leak');
    const workspace = await owner.client.workspaces.create({ name: `泄漏检查-${randomUUID().slice(0, 8)}` });

    const responses = [
      JSON.stringify(await owner.client.providerCatalog.get(workspace.id)),
      JSON.stringify(await owner.client.providerCatalog.capabilities(workspace.id, 'text.generate')),
      JSON.stringify(await owner.client.providerCatalog.route(workspace.id, 'text.generate')),
      JSON.stringify(await owner.client.providerSettings.list(workspace.id)),
      JSON.stringify(await owner.client.providerConnections.list(workspace.id)),
    ];
    for (const payload of responses) {
      expect(payload).not.toContain(SECRET_MARKER);
      expect(payload).not.toContain('encryptedSecret');
      expect(payload).not.toContain('authTag');
      expect(payload).not.toContain('nonce');
      // 平台托管只体现为"选择结果"，不暴露凭据本身
      expect(payload).not.toContain('sk-');
    }

    // 平台托管的决策存在（凭据登记表 has() = true），但 Secret 只在服务端解析
    const route = await owner.client.providerCatalog.route(workspace.id, 'text.generate');
    expect(route.decision).toMatchObject({ credentialMode: 'PLATFORM_MANAGED', connectionId: null });
    expect(parsePlatformCredentials(platformKeys).resolve?.('llm.sec')).toBe(SECRET_MARKER); // 仅服务端可见
  });
});
