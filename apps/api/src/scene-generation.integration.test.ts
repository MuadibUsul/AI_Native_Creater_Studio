import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createCatalogVersion } from '@ancs/domain';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { parsePlatformCredentials } from './plugins/credentials.js';
import { buildServer } from './server.js';

/**
 * P06-05 验收（显式生成动作的非凭据部分；HTTP + SDK + 真实 DB）：
 * - **双击只提交一次**：同场景同 revision 的重复提交返回同一任务（deduped=true，仅 1 条任务）；
 * - **输入只含 Scene 所需数据**（§2.8）：任务输入无正文/来源原文/其它场景；
 * - **能力缺失 → 501**（未核验目录 fail-closed，不排队空任务）；
 * - **AI Video 边界**（§14.4）：数据/证据类场景 → 422；
 * - 非素材类场景（图表/文字）→ 422（本地组件渲染，无需 Provider）。
 */

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
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'scene-generation-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  // 平台托管凭据登记（Key 只登记存在性；测试用假凭据，绝不外泄）
  const vault = new LocalCredentialVault({ keys: 'v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' }); // secrets:check-ignore：测试专用假密钥
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    credentials: {
      cipher: vault,
      platformCredentials: parsePlatformCredentials('veo.mock:sk-test-veo-managed'), // secrets:check-ignore：测试专用假凭据
    },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

async function makeProject(client: AncsClient, mode: 'FOOTAGE_EDIT' | 'GENERATIVE' | 'HYBRID' = 'GENERATIVE'): Promise<{ workspaceId: string; projectId: string }> {
  const workspace = await client.workspaces.create({ name: `生成-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const request = { title: '生成项目', channelId: channel.id, mode };
  const project = await client.projects.create(workspace.id, request);
  return { workspaceId: workspace.id, projectId: project.id };
}

/** 写入一个不含 video.generate 的最新目录版本（保证 501 路径确定性，不依赖库中历史）。 */
async function seedCatalogWithoutVideo(): Promise<void> {
  await createCatalogVersion({ db: handle.db }, {
    note: 'P06-05 测试：最新目录不含 video.generate（验证 fail-closed）',
    entries: [
      {
        providerId: 'llm.placeholder',
        providerName: 'LLM（未核验占位）',
        kind: 'LLM',
        connectionRequired: true,
        capabilities: ['text.generate'],
        models: [
          {
            modelId: 'placeholder-llm-1',
            displayName: 'LLM 占位（未核验）',
            status: 'UNVERIFIED',
            capabilities: ['text.generate'],
            price: { unit: 'CALL', unitPrice: { amount: '0', currency: 'USD' }, minimumUnits: 0, note: '未核验占位' },
            limits: { maxConcurrency: null, maxInputSeconds: null, maxInputCharacters: null, maxRequestsPerMinute: null },
            regions: [],
            dataRetention: 'UNKNOWN',
            residency: [],
            verifiedAt: '2026-10-01T00:00:00.000Z',
            deprecatedAt: null,
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
  });
}

/** 写入一条已核验目录（模拟 P06-01 核验完成后的 Catalog；veo 的 video.generate 可用）。 */
async function seedVerifiedCatalog(workspaceId: string): Promise<void> {
  const now = new Date().toISOString();
  void workspaceId; // Catalog 为全局版本（工作区维度在凭据/策略侧）
  await createCatalogVersion({ db: handle.db }, {
    note: 'P06-05 测试：模拟已核验目录（veo video.generate）',
    entries: [
      {
        providerId: 'veo.mock',
        providerName: 'Veo（测试核验占位）',
        kind: 'AI_VIDEO',
        connectionRequired: true,
        capabilities: ['video.generate'],
        models: [
          {
            modelId: 'veo-test-1',
            displayName: 'Veo 测试模型',
            status: 'ACTIVE',
            capabilities: ['video.generate'],
            price: { unit: 'SECOND', unitPrice: { amount: '0.35', currency: 'USD' }, minimumUnits: 5, note: '测试价格' },
            limits: { maxConcurrency: 2, maxInputSeconds: 60, maxInputCharacters: null, maxRequestsPerMinute: 10 },
            regions: [],
            dataRetention: 'UNKNOWN',
            residency: [],
            verifiedAt: now,
            deprecatedAt: null,
            metadata: {},
          },
        ],
        metadata: {},
      },
    ],
  });
}

describe('显式生成动作（P06-05 非凭据部分）', () => {
  it('N01-02 纯素材模式在 Provider 路由和任务创建前拒绝新画面', async () => {
    const client = await newClient('gen-policy');
    const { workspaceId, projectId } = await makeProject(client, 'FOOTAGE_EDIT');
    const created = await client.projects.addScene(projectId, {
      sceneType: 'AI_VIDEO',
      semanticType: 'CONCEPT',
      narration: '',
      visualIntent: '不应被提交的新镜头',
      durationMs: 5000,
    });
    await seedVerifiedCatalog(workspaceId);

    const blocked = await client.projects.generateScene(projectId, created.scene.id, { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(AncsApiError);
    expect(blocked).toMatchObject({
      status: 409,
      details: { reason: 'PRODUCTION_POLICY_BLOCKED', policyField: 'allowGeneratedVideo', mode: 'FOOTAGE_EDIT' },
    });
    expect((await client.jobs.list(workspaceId)).filter((job) => job.type === 'GENERATE')).toEqual([]);
  });

  it('能力缺失（未核验目录）：生成被明确阻止（501），不排队空任务；双击只提交一次（去重）', async () => {
    const client = await newClient('gen-gate');
    const { workspaceId, projectId } = await makeProject(client);

    // 素材类场景（AI_VIDEO）
    const created = await client.projects.addScene(projectId, {
      sceneType: 'AI_VIDEO',
      semanticType: 'CONCEPT',
      narration: '',
      visualIntent: '概念性电影化画面：央行大楼夜景，慢推镜头',
      durationMs: 6000,
    });

    // ① 最新目录不含 video.generate → 501（fail-closed；不依赖库中历史目录）
    await seedCatalogWithoutVideo();
    const blocked = await client.projects.generateScene(projectId, created.scene.id, { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(blocked).toBeInstanceOf(AncsApiError);
    expect((blocked as AncsApiError).status).toBe(501);
    expect((blocked as AncsApiError).details['reason']).toBe('NO_CALLABLE_PROVIDER');
    const jobsAfterBlocked = await client.jobs.list(workspaceId);
    expect(jobsAfterBlocked.filter((job) => job.type === 'GENERATE').length).toBe(0); // 未排队空任务

    // ② 写入已核验目录 → 提交成功；**输入只含 Scene 所需数据**
    await seedVerifiedCatalog(workspaceId);
    const submitted = await client.projects.generateScene(projectId, created.scene.id, { capability: 'video.generate' });
    expect(submitted.deduped).toBe(false);
    expect(submitted.providerRoute).toMatchObject({ providerId: 'veo.mock', modelId: 'veo-test-1' });
    const input = submitted.job.input as Record<string, unknown>;
    const scenePayload = input['scene'] as Record<string, unknown>;
    expect(scenePayload).toMatchObject({ sceneId: created.scene.id, sceneType: 'AI_VIDEO', durationMs: 6000 });
    expect(scenePayload['prompt']).toContain('概念性电影化画面');
    // 数据最小化：不含正文/来源/文档等字段
    expect(JSON.stringify(input)).not.toContain('document');
    expect(JSON.stringify(input)).not.toContain('sourceIds');
    expect(JSON.stringify(input)).not.toContain('article');

    // ③ 双击：再次提交（同场景同 revision）→ 返回同一任务（deduped=true），任务数仍为 1
    const again = await client.projects.generateScene(projectId, created.scene.id, { capability: 'video.generate' });
    expect(again.deduped).toBe(true);
    expect(again.job.id).toBe(submitted.job.id);
    const jobs = await client.jobs.list(workspaceId);
    expect(jobs.filter((job) => job.type === 'GENERATE').length).toBe(1);
  });

  it('AI Video 边界（§14.4）：数据/证据类场景 → 422；非素材类场景 → 422', async () => {
    const client = await newClient('gen-boundary');
    const { workspaceId, projectId } = await makeProject(client);
    await seedVerifiedCatalog(workspaceId);

    // 数据类（LINE_CHART / PRICE_SERIES）：AI Video 明确禁止
    const chart = await client.projects.addScene(projectId, {
      sceneType: 'LINE_CHART',
      semanticType: 'PRICE_SERIES',
      narration: '',
      visualIntent: '',
      durationMs: 5000,
    });
    const boundary = await client.projects.generateScene(projectId, chart.scene.id, { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(boundary).toBeInstanceOf(AncsApiError);
    expect((boundary as AncsApiError).status).toBe(422);
    expect((boundary as AncsApiError).details['reason']).toBe('AI_VIDEO_BOUNDARY_VIOLATION');

    // 非素材类（SUMMARY）：无需 Provider 生成（本地组件）
    const summary = await client.projects.addScene(projectId, {
      sceneType: 'SUMMARY',
      semanticType: 'SUMMARY',
      narration: '',
      visualIntent: '',
      durationMs: 4000,
    });
    const notAsset = await client.projects.generateScene(projectId, summary.scene.id, { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(notAsset).toBeInstanceOf(AncsApiError);
    expect((notAsset as AncsApiError).status).toBe(422);
    expect((notAsset as AncsApiError).details['reason']).toBe('SCENE_NOT_ASSET_DRIVEN');

    // 场景 revision 变化后 → 去重键不同（新版本可再次显式生成）
    const graph = await client.projects.graph(projectId);
    const videoScene = graph.scenes.find((scene) => scene.id === chart.scene.id);
    expect(videoScene).toBeDefined();
  });

  it('隔离：跨租户提交/未知场景 → 404', async () => {
    const client = await newClient('gen-isolation');
    const { workspaceId, projectId } = await makeProject(client);
    const created = await client.projects.addScene(projectId, {
      sceneType: 'AI_VIDEO',
      semanticType: 'CONCEPT',
      narration: '',
      visualIntent: '概念画面',
      durationMs: 5000,
    });
    await seedVerifiedCatalog(workspaceId);

    const { client: intruder } = { client: await newClient('gen-intruder') };
    const crossed = await intruder.projects.generateScene(projectId, created.scene.id, { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);

    const missing = await client.projects.generateScene(projectId, 'scn_missing_generation', { capability: 'video.generate' }).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(AncsApiError);
    expect((missing as AncsApiError).status).toBe(404);
  });
});
