import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProviderCatalog } from '@ancs/contracts';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, providerCatalogVersions, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import {
  buildSeedCatalogEntries,
  createCatalogVersion,
  evaluateModelAvailability,
  getCurrentCatalog,
  requireCallableModel,
  selectByCapability,
  type DomainDeps,
} from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * P03-03 验收：
 * - Catalog 版本化（不可变；当前版本 = MAX(version)；能力/模型/价格/限额/地区/保留/核验时间）；
 * - Router 按能力筛选（能力 + 状态 + **核验时效** + 地区；默认只返回可真实调用者）；
 * - **无有效配置时明确阻止真实调用**（缺失 / 未核验 / 已弃用 / 核验过期 / 地区不允许 → 501 带原因）；
 * - 种子目录为 UNVERIFIED（fail-closed）：真实调用在核验前一律被阻止（诚实状态）。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

const deps = (): DomainDeps => ({ db: handle.db });

const HOUR = 60 * 60 * 1000;

function freshCatalogEntry(overrides: Partial<ProviderCatalog['entries'][number]> = {}): ProviderCatalog['entries'][number] {
  const verifiedAt = new Date(Date.now() - HOUR).toISOString(); // 1 小时前核验 → 新鲜
  return {
    providerId: 'tts.fast',
    providerName: 'TTS Fast',
    kind: 'TTS',
    connectionRequired: true,
    capabilities: ['speech.synthesize'],
    models: [
      {
        modelId: 'tts-fast-v1',
        displayName: 'TTS Fast v1',
        status: 'ACTIVE',
        capabilities: ['speech.synthesize'],
        price: { unit: 'CHARACTER', unitPrice: { amount: '0.000015', currency: 'USD' }, minimumUnits: 0, note: null },
        limits: { maxConcurrency: 8, maxInputSeconds: 600, maxInputCharacters: 5000, maxRequestsPerMinute: 120 },
        regions: ['US', 'EU'],
        dataRetention: 'ZERO_RETENTION',
        residency: ['US'],
        verifiedAt,
        deprecatedAt: null,
        metadata: { source: 'docs' },
      },
      {
        modelId: 'tts-legacy-v0',
        displayName: 'TTS Legacy v0（已弃用）',
        status: 'DEPRECATED',
        capabilities: ['speech.synthesize'],
        price: { unit: 'CHARACTER', unitPrice: { amount: '0.00002', currency: 'USD' }, minimumUnits: 0, note: null },
        limits: { maxConcurrency: null, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null },
        regions: [],
        dataRetention: 'STANDARD',
        residency: [],
        verifiedAt,
        deprecatedAt: new Date(Date.now() - HOUR).toISOString(),
        metadata: {},
      },
    ],
    metadata: {},
    ...overrides,
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
  auth = createAuth({
    db: handle.db,
    secret: 'catalog-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥
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

describe('Provider Catalog（P03-03）', () => {
  it('版本化：每次变更产生新版本（不可变）；当前版本 = MAX(version)', async () => {
    await handle.db.delete(providerCatalogVersions);
    const before = await getCurrentCatalog(deps());
    expect(before.exists).toBe(false);
    expect(before.catalog).toBeNull();

    const v1 = await createCatalogVersion(deps(), { entries: buildSeedCatalogEntries(), note: '种子目录（未核验）' });
    expect(v1.version).toBe(1);
    const v2 = await createCatalogVersion(deps(), { entries: [freshCatalogEntry()], note: '核验后替换' });
    expect(v2.version).toBe(2);

    const current = await getCurrentCatalog(deps());
    expect(current.exists).toBe(true);
    expect(current.catalog?.version).toBe(2);
    expect(current.catalog?.entries[0]?.providerId).toBe('tts.fast');
    // 旧版本仍完整保留（不可变）
    const rows = await handle.db.select().from(providerCatalogVersions);
    expect(rows).toHaveLength(2);
    expect((rows.find((row) => row.version === 1)?.catalog as { entries: unknown[] }).entries).toHaveLength(2);
  });

  it('Router 按能力筛选：能力 + 状态 + 核验时效 + 地区（默认只返回可调用者）', async () => {
    await handle.db.delete(providerCatalogVersions);
    await createCatalogVersion(deps(), { entries: [freshCatalogEntry()] });

    const callable = await selectByCapability(deps(), { capability: 'speech.synthesize' });
    expect(callable.candidates).toHaveLength(1); // 弃用模型被排除
    expect(callable.candidates[0]).toMatchObject({ providerId: 'tts.fast', modelId: 'tts-fast-v1', callable: true });

    const all = await selectByCapability(deps(), { capability: 'speech.synthesize', callableOnly: false });
    expect(all.candidates).toHaveLength(2);
    expect(all.candidates.find((candidate) => candidate.modelId === 'tts-legacy-v0')?.reasons).toContain('STATUS_DEPRECATED');

    // 能力不匹配 → 无候选
    expect((await selectByCapability(deps(), { capability: 'video.generate' })).candidates).toHaveLength(0);

    // 地区：EU 允许、CN 不允许
    expect((await selectByCapability(deps(), { capability: 'speech.synthesize', region: 'EU' })).candidates).toHaveLength(1);
    const cn = await selectByCapability(deps(), { capability: 'speech.synthesize', region: 'CN', callableOnly: false });
    expect(cn.candidates.find((candidate) => candidate.modelId === 'tts-fast-v1')?.reasons).toContain('REGION_NOT_ALLOWED');

    // 核验时效（纯函数）：31 天前核验 → STALE_VERIFICATION
    const stale = evaluateModelAvailability('tts.fast', {
      modelId: 'm',
      displayName: 'm',
      status: 'ACTIVE',
      capabilities: ['speech.synthesize'],
      price: { unit: 'CALL', unitPrice: { amount: '0', currency: 'USD' }, minimumUnits: 0, note: null },
      limits: { maxConcurrency: null, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null },
      regions: [],
      dataRetention: 'STANDARD',
      residency: [],
      verifiedAt: new Date(Date.now() - 31 * 24 * HOUR).toISOString(),
      deprecatedAt: null,
      metadata: {},
    }, { capability: 'speech.synthesize' });
    expect(stale.callable).toBe(false);
    expect(stale.reasons).toContain('STALE_VERIFICATION');
    expect(stale.verificationAgeDays).toBeGreaterThanOrEqual(30);
  });

  it('无有效配置时明确阻止真实调用（缺失/未核验/已弃用/过期/地区）', async () => {
    await handle.db.delete(providerCatalogVersions);

    // 缺失：Catalog 不存在
    const missing = await requireCallableModel(deps(), { providerId: 'tts.fast', modelId: 'tts-fast-v1', capability: 'speech.synthesize' }).catch((error: unknown) => error);
    expect(missing).toMatchObject({ httpStatus: 501, code: 'CAPABILITY_UNAVAILABLE' });
    expect((missing as { details: Record<string, unknown> }).details['reason']).toBe('CATALOG_MISSING');

    // 种子目录：全部 UNVERIFIED → 真实调用被阻止（fail-closed 的诚实状态）
    await createCatalogVersion(deps(), { entries: buildSeedCatalogEntries(), note: '种子（未核验）' });
    const unverified = await requireCallableModel(deps(), {
      providerId: 'tts.primary',
      modelId: 'placeholder-tts-1',
      capability: 'speech.synthesize',
    }).catch((error: unknown) => error);
    expect((unverified as { details: Record<string, unknown> }).details['reason']).toBe('MODEL_NOT_CALLABLE');
    expect((unverified as { details: { availability: { reasons: string[] } } }).details.availability.reasons).toContain('STATUS_UNVERIFIED');

    // 核验后的目录：可调用；模型不存在 → MODEL_NOT_FOUND
    await createCatalogVersion(deps(), { entries: [freshCatalogEntry()] });
    const callable = await requireCallableModel(deps(), { providerId: 'tts.fast', modelId: 'tts-fast-v1', capability: 'speech.synthesize' });
    expect(callable.model.modelId).toBe('tts-fast-v1');

    const notFound = await requireCallableModel(deps(), { providerId: 'tts.fast', modelId: 'no-such-model', capability: 'speech.synthesize' }).catch((error: unknown) => error);
    expect((notFound as { details: Record<string, unknown> }).details['reason']).toBe('MODEL_NOT_FOUND');

    const wrongCapability = await requireCallableModel(deps(), { providerId: 'tts.fast', modelId: 'tts-fast-v1', capability: 'video.generate' }).catch((error: unknown) => error);
    expect((wrongCapability as { details: { availability: { reasons: string[] } } }).details.availability.reasons).toContain('CAPABILITY_NOT_SUPPORTED');
  });

  it('HTTP/SDK：目录读取与能力筛选（workspace:read）；跨租户 404', async () => {
    await handle.db.delete(providerCatalogVersions);
    await createCatalogVersion(deps(), { entries: [freshCatalogEntry()], note: 'HTTP 用例' });

    const email = `catalog-${randomUUID()}@test.local`;
    const strangerEmail = `catalog-stranger-${randomUUID()}@test.local`;
    await createInternalUser(auth, { email, password: 'password-1234', name: '目录测试' });
    await createInternalUser(auth, { email: strangerEmail, password: 'password-1234', name: '外部用户' });
    const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    await client.auth.signIn({ email, password: 'password-1234' });
    const stranger: AncsClient = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
    await stranger.auth.signIn({ email: strangerEmail, password: 'password-1234' });

    const workspace = await client.workspaces.create({ name: `目录-${randomUUID().slice(0, 8)}` });

    const catalog = await client.providerCatalog.get(workspace.id);
    expect(catalog.exists).toBe(true);
    expect(catalog.catalog?.entries[0]?.providerId).toBe('tts.fast');
    expect(catalog.catalog?.entries[0]?.models[0]?.price.unitPrice.amount).toBe('0.000015');

    const selection = await client.providerCatalog.capabilities(workspace.id, 'speech.synthesize');
    expect(selection.candidates.map((candidate) => candidate.modelId)).toEqual(['tts-fast-v1']);

    const strangerFailure = await stranger.providerCatalog.get(workspace.id).catch((error: unknown) => error);
    expect(strangerFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
