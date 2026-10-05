import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, plans, projectSources, projects, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, scenes, workspaces, type DbHandle } from '@ancs/db';
import { ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P10-06 验收（真实 DB + 真实存储）：
 * - **搜索**：跨 Project/Scene/Source/Asset/Component；**租户内 + 排除软删（项目 Trash / 资产软删）**；
 *   命中字段可解释；过短查询 400；
 * - **Graph 导出**：可移植 JSON（资产引用式）；**不含存储键/Secret/URL**；来源自包含；软删项目 409；
 * - **原素材 Bundle**：**缺权素材明确列出**（许可限制/渲染产物）+ 逐件签名 URL 可真实下载且 sha 一致；
 *   **响应无存储键/Secret**。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;
let storageRoot = '';
const PASSWORD = 'password-1234';
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const deps = (): DomainDeps => ({ db: handle.db, storage });

function makePng(width = 2, height = 2): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[19] = width & 0xff;
  bytes[23] = height & 0xff;
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-search-'));
  storage = new LocalObjectStorage({ rootDir: storageRoot, publicBaseUrl: 'http://127.0.0.1:0', signingSecret: 'search-integration-secret-0123456789' }); // secrets:check-ignore：测试专用假密钥
  auth = createAuth({ db: handle.db, secret: 'search-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true }).catch(() => undefined);
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

interface SeedResult {
  workspaceId: string;
  projectId: string;
  trashedProjectId: string;
  sceneId: string;
  sourceId: string;
  titledAssetId: string;
  deletedAssetId: string;
  licensedAssetId: string;
  renderAssetId: string;
  uploadedAssetId: string;
  uploadedBytes: Uint8Array;
}

async function seed(client: AncsClient, tag: string): Promise<SeedResult> {
  const workspace = await client.workspaces.create({ name: `搜索-${tag}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: `利率周报 ${tag}`, channelId: channel.id });
  const trashed = await client.projects.create(workspace.id, { title: `利率周报-废弃 ${tag}`, channelId: channel.id });
  await handle.db.update(projects).set({ deletedAt: new Date() }).where(eq(projects.id, trashed.id));

  // 来源（真实行；命中 title/publisher）
  const sourceId = `src_${randomUUID()}`;
  await handle.db.insert(projectSources).values({
    id: sourceId,
    workspaceId: workspace.id,
    projectId: project.id,
    url: `https://news.example/${randomUUID()}`,
    title: '利率决议原文',
    publisher: '示例通讯社',
    author: null,
    publishedAt: null,
    contentHash: 'a'.repeat(64),
    excerpt: '联邦基金利率维持在 5.25% 不变。',
    snapshotKind: 'live_fetch',
  });

  // 场景（真实行；命中 narration；绑定来源；绑定素材）
  const sceneId = `scn_${randomUUID()}`;
  const uploaded = await client.assets.upload(workspace.id, { assetType: 'USER_UPLOAD', filename: 'chart.png', contentType: 'image/png', data: makePng() });
  await handle.db.insert(scenes).values({
    id: sceneId,
    workspaceId: workspace.id,
    projectId: project.id,
    revision: 1,
    position: 0,
    startMs: 0,
    durationMs: 3000,
    semanticType: 'NARRATIVE',
    sceneType: 'SUMMARY',
    narration: '联邦基金利率维持不变，市场预计年内降息一次。',
    visualIntent: '利率走势数据看板',
    props: { text: '利率要点' },
    sourceBindings: [{ sourceId }],
    dataBindings: [],
    assetBindings: [{ assetId: uploaded.id, role: 'visual' }],
  });
  // 废弃项目的场景（含同关键词——搜索必须排除）
  await handle.db.insert(scenes).values({
    id: `scn_${randomUUID()}`,
    workspaceId: workspace.id,
    projectId: trashed.id,
    revision: 1,
    position: 0,
    startMs: 0,
    durationMs: 2000,
    semanticType: 'NARRATIVE',
    sceneType: 'SUMMARY',
    narration: '利率废弃场景（不应出现在结果中）',
    visualIntent: '利率',
    props: {},
    sourceBindings: [],
    dataBindings: [],
    assetBindings: [],
  });

  // 资产：带 title 的（命中）、软删的（排除）、许可受限的、渲染产物、真实上传的
  const insertAsset = async (assetType: string, origin: string, metadata: Record<string, unknown>, license: Record<string, unknown>, deleted = false): Promise<string> => {
    const assetId = `ast_${randomUUID()}`;
    const versionId = `av_${randomUUID()}`;
    const bytes = makePng();
    const storageKey = `workspaces/${workspace.id}/projects/${project.id}/library/${assetId}/v1/original.bin`;
    await storage.putObject(storageKey, bytes);
    await handle.db.insert(assets).values({
      id: assetId,
      workspaceId: workspace.id,
      projectId: project.id,
      assetType,
      origin,
      status: 'READY',
      retentionClass: 'KEEP_USER_SOURCE',
      license,
      metadata,
      currentVersionId: versionId,
      deletedAt: deleted ? new Date() : null,
    });
    await handle.db.insert(assetVersions).values({
      id: versionId,
      assetId,
      workspaceId: workspace.id,
      versionNumber: 1,
      storageKey,
      mimeType: 'image/png',
      sizeBytes: bytes.byteLength,
      checksumSha256: sha(bytes),
      status: 'READY',
    });
    return assetId;
  };

  const titledAssetId = await insertAsset('SOURCE_IMAGE', 'USER_UPLOAD', { title: '利率走势图' }, { type: 'USER_DECLARED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: '', confirmedBy: null, confirmedAt: null });
  const deletedAssetId = await insertAsset('SOURCE_IMAGE', 'USER_UPLOAD', { title: '利率走势图（已删）' }, { type: 'USER_DECLARED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: '', confirmedBy: null, confirmedAt: null }, true);
  const licensedAssetId = await insertAsset('SOURCE_IMAGE', 'LICENSED_STOCK', { title: '授权素材（受限）', stockLicense: { licenseType: 'LICENSED_STOCK', usageRestrictions: '仅限本平台成片使用' } }, { type: 'LICENSED_STOCK', holder: null, attribution: '素材：MockStock', sourceUrl: null, termsUrl: null, notes: '许可证引用：MOCK-LIC-0002', confirmedBy: null, confirmedAt: null });
  const renderAssetId = await insertAsset('DRAFT_RENDER', 'SYSTEM_RENDER', { renderId: 'rnd_x', kind: 'VIDEO' }, { type: 'SYSTEM_GENERATED', holder: null, attribution: null, sourceUrl: null, termsUrl: null, notes: 'fixture', confirmedBy: null, confirmedAt: null });

  return { workspaceId: workspace.id, projectId: project.id, trashedProjectId: trashed.id, sceneId, sourceId, titledAssetId, deletedAssetId, licensedAssetId, renderAssetId, uploadedAssetId: uploaded.id, uploadedBytes: makePng() };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('搜索与导出（P10-06）', () => {
  it('搜索：跨实体命中且**租户内 + 排除软删**（废弃项目/已删资产/他租户不出现）；Component 来自目录；过短 400', async () => {
    const client = await newClient('search-main');
    const seedA = await seed(client, 'A');
    const other = await newClient('search-other');
    await seed(other, 'OTHER');

    const result = await client.search(seedA.workspaceId, { q: '利率' });
    const byKind = (kind: string) => result.items.filter((item) => item.kind === kind);
    expect(byKind('PROJECT').map((item) => item.id)).toEqual([seedA.projectId]); // 仅存活项目；废弃与他租户排除
    expect(byKind('SCENE')).toHaveLength(1);
    expect(byKind('SCENE')[0]?.id).toBe(seedA.sceneId);
    expect(byKind('SCENE')[0]?.matchedFields).toContain('narration');
    expect(byKind('SOURCE').map((item) => item.id)).toEqual([seedA.sourceId]);
    expect(byKind('ASSET').map((item) => item.id)).toEqual([seedA.titledAssetId]); // 软删资产排除
    expect(result.items.some((item) => item.id === seedA.trashedProjectId)).toBe(false);
    expect(result.items.some((item) => item.id === seedA.deletedAssetId)).toBe(false);
    expect(result.items.some((item) => item.path?.includes('/w/' + seedA.workspaceId + '/'))).toBe(true);

    // Component 目录检索（非租户数据；无深链）
    const component = await client.search(seedA.workspaceId, { q: 'AREA_CHART' });
    const componentItem = component.items.find((item) => item.kind === 'COMPONENT');
    expect(componentItem?.id).toBe('AREA_CHART');
    expect(componentItem?.path).toBeNull();

    // 过短查询 → 400
    await expectApiError(client.search(seedA.workspaceId, { q: '利' }), 400, 'QUERY_TOO_SHORT');
  }, 120_000);

  it('Graph 导出：可移植 JSON（引用式资产）；**无存储键/Secret/URL**；来源自包含；废弃项目 409', async () => {
    const client = await newClient('search-graph');
    const seedA = await seed(client, 'G');

    const exported = await client.workspaces.graphExport(seedA.workspaceId, seedA.projectId);
    expect(exported.schemaVersion).toBe('graph-export-v1');
    expect(exported.projectTitle).toBe('利率周报 G');
    expect(exported.graph.scenes.some((scene) => scene.id === seedA.sceneId)).toBe(true);
    expect(exported.sources.map((source) => source.sourceId)).toEqual([seedA.sourceId]);
    expect(exported.sources[0]?.excerpt).toContain('5.25');

    const serialized = JSON.stringify(exported);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toMatch(/secret|apiKey|api_key|vault|password|signature|token=/i);

    await expectApiError(client.workspaces.graphExport(seedA.workspaceId, seedA.trashedProjectId), 409, 'PROJECT_TRASHED');
  }, 120_000);

  it('原素材 Bundle：缺权素材明确列出（许可限制/渲染产物）；签名 URL 真实可下载且 sha 一致；**无存储键/Secret**', async () => {
    const client = await newClient('search-bundle');
    const seedA = await seed(client, 'B');

    const bundle = await client.workspaces.assetBundle(seedA.workspaceId, seedA.projectId);
    expect(bundle.delivery).toBe('MANIFEST_WITH_SIGNED_URLS');

    const includedIds = bundle.entries.map((entry) => entry.assetId).sort();
    expect(includedIds).toEqual([seedA.titledAssetId, seedA.uploadedAssetId].sort());

    // 缺权明确列出（不静默丢弃）
    const excludedById = new Map(bundle.excluded.map((entry) => [entry.assetId, entry]));
    expect(excludedById.get(seedA.licensedAssetId)?.reason).toBe('LICENSE_RESTRICTS_REDISTRIBUTION');
    expect(excludedById.get(seedA.licensedAssetId)?.detail).toContain('仅限本平台成片使用');
    expect(excludedById.get(seedA.renderAssetId)?.reason).toBe('RENDER_OUTPUT_NOT_SOURCE_MATERIAL');
    expect(excludedById.get(seedA.deletedAssetId)).toBeUndefined(); // 软删资产不参与（既不入包也不列缺权）

    // 签名 URL 真实可下载；字节与 checksum 一致
    const titled = bundle.entries.find((entry) => entry.assetId === seedA.titledAssetId);
    expect(titled?.sha256).not.toBeNull();
    const download = await fetch(titled?.downloadUrl ?? '');
    expect(download.status).toBe(200);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(sha(bytes)).toBe(titled?.sha256);

    // 响应无存储键/Secret
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain('storageKey');
    expect(serialized).not.toContain('original.bin');
    expect(serialized).not.toMatch(/secret|apiKey|api_key|password/i);

    // 软删项目 → 409
    await expectApiError(client.workspaces.assetBundle(seedA.workspaceId, seedA.trashedProjectId), 409, 'PROJECT_TRASHED');
  }, 120_000);
});
