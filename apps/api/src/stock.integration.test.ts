import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { eq } from 'drizzle-orm';
import { assets, createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockAssetSearchProvider, RunwayGenerationAdapter, RUNWAY_NOT_IMPLEMENTED_MESSAGE } from '@ancs/providers-mock-provider';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P10-03 验收（真实 DB + 真实存储 + Mock 搜索 Provider 同构）：
 * - **搜索素材有许可状态**：结果携带 license 与 usable/unusableReason（无许可/缺署名 明确不可用——不自称已授权）；
 * - **获取前服务端复核**：不可用 → 422 LICENSE_REQUIRED（不信任客户端）；可用 → 入库固化 origin/许可/**自动署名**；
 * - **生成图不冒充证据**：QA `EVIDENCE_ASSET_ORIGIN`（qa.test.ts 覆盖）；
 * - **Runway**：fail-closed 骨架（任何调用明确失败并说明 BLOCKED 原因——不冒充接入）；
 * - 未装配搜索 Provider → 501。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let rootDir: string;
let storage: LocalObjectStorage;
const PASSWORD = 'password-1234';

const deps = (): DomainDeps => ({ db: handle.db, storage });

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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-stock-'));
  storage = new LocalObjectStorage({ rootDir, publicBaseUrl: 'http://127.0.0.1:0', signingSecret: 'stock-integration-secret-0123456789' }); // secrets:check-ignore：测试专用假密钥
  auth = createAuth({ db: handle.db, secret: 'stock-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
    media: { stockSearch: new MockAssetSearchProvider() },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('素材搜索/获取（P10-03）', () => {
  it('搜索：许可状态随结果返回（可用/无许可/缺署名三类；usableOnly 过滤）', async () => {
    const client = await newClient('stock-search');
    const workspace = await client.workspaces.create({ name: `素材-${randomUUID().slice(0, 8)}` });

    const results = await client.stock.search(workspace.id, { kind: 'IMAGE' });
    expect(results.providerId).toBe('mock-stock');
    expect(results.items).toHaveLength(3);
    const byId = new Map(results.items.map((item) => [item.providerAssetId, item]));
    expect(byId.get('mockimg_licensed_a')?.usable).toBe(true);
    expect(byId.get('mockimg_licensed_a')?.license.attributionText).toContain('MOCK-LIC-0001');
    expect(byId.get('mockimg_no_license_b')?.usable).toBe(false);
    expect(byId.get('mockimg_no_license_b')?.unusableReason).toBe('NO_LICENSE');
    expect(byId.get('mockimg_cc_c')?.usable).toBe(false);
    expect(byId.get('mockimg_cc_c')?.unusableReason).toBe('ATTRIBUTION_TEXT_MISSING');

    const usableOnly = await client.stock.search(workspace.id, { kind: 'IMAGE', usableOnly: true });
    expect(usableOnly.items.map((item) => item.providerAssetId)).toEqual(['mockimg_licensed_a']);
  }, 120_000);

  it('获取：不可用素材 → 422 LICENSE_REQUIRED（不冒充已授权）；可用素材 → 入库固化 origin/许可/自动署名', async () => {
    const client = await newClient('stock-acquire');
    const workspace = await client.workspaces.create({ name: `获取-${randomUUID().slice(0, 8)}` });

    // 无许可 → 422（服务端 lookup 复核，不信任客户端）
    await expectApiError(client.stock.acquire(workspace.id, { providerAssetId: 'mockimg_no_license_b' }), 422, 'LICENSE_REQUIRED');
    // 需署名但缺署名文本 → 422
    await expectApiError(client.stock.acquire(workspace.id, { providerAssetId: 'mockimg_cc_c' }), 422, 'LICENSE_REQUIRED');
    // 不存在 → 404
    await expectApiError(client.stock.acquire(workspace.id, { providerAssetId: 'mockimg_missing' }), 404, 'RESULT_NOT_FOUND');

    // 可用 → 入库
    const acquired = await client.stock.acquire(workspace.id, { providerAssetId: 'mockimg_licensed_a' });
    expect(acquired.origin).toBe('LICENSED_STOCK');
    expect(acquired.assetType).toBe('SOURCE_IMAGE');
    expect(acquired.attributionText).toContain('MockStock');
    expect(acquired.license.licenseReference).toBe('MOCK-LIC-0001');

    // 资产行：origin/许可字段/元数据独立落库
    const rows = await handle.db.select().from(assets).where(eq(assets.id, acquired.assetId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.origin).toBe('LICENSED_STOCK');
    const license = rows[0]?.license as { type: string; attribution: string; notes: string };
    expect(license.type).toBe('LICENSED_STOCK');
    expect(license.attribution).toContain('MockStock');
    expect(license.notes).toContain('MOCK-LIC-0001');
    // 字节落到自有存储（可读回）
    const version = await storage.readObject(`workspaces/${workspace.id}/library/stock/mock-stock/${acquired.assetId}/v1/original.bin`).catch(() => null);
    expect(version).not.toBeNull();
    expect(version?.byteLength).toBeGreaterThan(0);
  }, 120_000);

  it('未装配搜索 Provider → 501 fail-closed；Runway 骨架：任何调用明确失败（不冒充接入）', async () => {
    const bare = await createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    const email = `stock-bare-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email, password: PASSWORD, name: 'bare' });
    await bare.auth.signIn({ email, password: PASSWORD });
    const bareApp = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } }, storage: createStorageDeps(storage) });
    await bareApp.listen({ port: 0, host: '127.0.0.1' });
    const bareUrl = `http://127.0.0.1:${String((bareApp.server.address() as AddressInfo).port)}`;
    const bareClient = createClient({ baseUrl: bareUrl, clientType: 'web', clientVersion: '0.1.0' });
    await bareClient.auth.signIn({ email, password: PASSWORD });
    const workspace = await bareClient.workspaces.create({ name: `无搜索-${randomUUID().slice(0, 8)}` });
    await expectApiError(bareClient.stock.search(workspace.id, { kind: 'IMAGE' }), 501, 'SEARCH_PROVIDER_UNAVAILABLE');
    await expectApiError(bareClient.stock.acquire(workspace.id, { providerAssetId: 'mockimg_licensed_a' }), 501, 'SEARCH_PROVIDER_UNAVAILABLE');
    await bareApp.close();

    // Runway：fail-closed 骨架
    const runway = new RunwayGenerationAdapter({ apiKey: 'runway-key-not-verified-0123' }); // secrets:check-ignore：测试专用假密钥
    await expect(runway.submit({ secret: 'x', request: { workspaceId: 'ws', jobId: 'job', providerId: 'runway', modelId: 'gen4', operation: 'video.generate', inputHash: 'h', parameters: {} } })).rejects.toThrow(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
    await expect(runway.getStatus({ secret: 'x', providerJobId: 'p' })).rejects.toThrow(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
    await expect(runway.cancel({ secret: 'x', providerJobId: 'p' })).rejects.toThrow(RUNWAY_NOT_IMPLEMENTED_MESSAGE);
  }, 120_000);
});

