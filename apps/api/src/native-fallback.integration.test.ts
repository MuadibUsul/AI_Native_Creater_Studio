import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { recordProviderGeneration } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P06-07 验收（HTTP + SDK，真实 DB + 本地存储）：
 * - 展示 Provider **任务引用**（external-results；含是否已回绑）；
 * - 外部处理后的文件上传（资产链路）→ **回绑**：成为新 AssetVersion 引用（不原地覆盖），
 *   来源/授权随资产保留（license/origin 由上传链路写入）；
 * - 场景绑定走编辑协议 replace_asset（**编辑历史可追溯**：EditEvent 可见）；
 * - 跨工作区资产/任务 → 404；未 READY 资产 → 409。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;

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
    secret: 'native-fallback-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  storage = new LocalObjectStorage({
    rootDir: `${process.cwd()}/.artifacts/test-storage/native-fallback-${randomUUID()}`,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'native-fallback-storage-secret', // secrets:check-ignore：测试专用假密钥
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { llm: new MockLlmAdapter() },
    storage: { adapter: storage },
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

/** 直接记录一条 Provider 任务引用（模拟"平台外完成"的任务记录）。 */
async function seedGeneration(workspaceId: string): Promise<string> {
  const generation = await recordProviderGeneration(
    { db: handle.db },
    {
      workspaceId,
      input: {
        jobId: null,
        providerId: 'veo.mock',
        modelId: 'veo-mock-1',
        operation: 'video.generate',
        credentialMode: 'BYOK',
        inputHash: `hash_${randomUUID()}`,
        providerJobId: `pj_${randomUUID()}`,
        attempt: 1,
        estimatedCost: null,
        estimatedCredits: null,
      },
    },
  );
  return generation.id;
}

/** 意图 → 直传（测试中由存储适配器服务器侧写入模拟 PUT）→ 确认（真实探测） */
async function uploadViaStorage(
  client: AncsClient,
  workspaceId: string,
  input: { filename: string; contentType: string; bytes: Uint8Array; projectId?: string; license?: Record<string, unknown> },
): Promise<Awaited<ReturnType<AncsClient['assets']['confirm']>>> {
  const intent = await client.assets.createUploadIntent(workspaceId, {
    assetType: 'USER_UPLOAD',
    filename: input.filename,
    contentType: input.contentType,
    sizeBytes: input.bytes.byteLength,
    ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    ...(input.license !== undefined ? { license: input.license as never } : {}),
  });
  if (intent.upload === null) throw new Error('unexpected dedupe');
  const payload = storage.verifyToken(new URL(intent.upload.url).searchParams.get('token') ?? '', 'upload');
  if (payload === null) throw new Error('token 校验失败');
  await storage.writeObject(payload.key, input.bytes);
  // 服务器自行探测大小/摘要（客户端不声明不可信值）
  return client.assets.confirm(workspaceId, intent.asset.id, {});
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01,
  0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('Native Fallback（P06-07）', () => {
  it('任务引用可见 → 外部产物上传（READY，资产保留来源/授权）→ 回绑 → 列出已回绑状态', async () => {
    const client = await newClient('nf-rebind');
    const workspace = await client.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    const channel = await client.channels.create(workspace.id, { name: '栏目' });
    const project = await client.projects.create(workspace.id, { title: '外部处理项目', channelId: channel.id });
    const generationId = await seedGeneration(workspace.id);

    // ① 任务引用可见（未回绑）
    const pending = await client.billing.externalResults(workspace.id, { onlyUnfulfilled: true });
    const reference = pending.find((item) => item.id === generationId);
    expect(reference).toBeDefined();
    expect(reference).toMatchObject({ providerId: 'veo.mock', providerJobId: expect.stringMatching(/^pj_/), resultAssetId: null });

    // ② 外部处理产物：经资产链路上传（真实探测；license 记为外部来源）
    // 外部产物以 USER_UPLOAD 上传（生成类资产由 Provider 回收链路创建；此处是**用户提供的文件**）
    const asset = await uploadViaStorage(client, workspace.id, {
      filename: 'external-result.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
      projectId: project.id,
      license: {
        type: 'USER_OWNED',
        holder: '外部处理者',
        notes: '人工在 Provider 后台处理后上传（Native Fallback）',
      },
    });
    expect(asset.status).toBe('READY');
    expect(asset.license.type).toBe('USER_OWNED');

    // ③ 回绑：任务引用记录结果资产 + 版本 + 时间（资产内容不改动）
    const rebound = await client.billing.rebindExternalResult(workspace.id, generationId, { assetId: asset.id, note: '平台外完成' });
    expect(rebound.resultAssetId).toBe(asset.id);
    expect(rebound.resultAssetVersionId).toBe(asset.currentVersionId);
    expect(rebound.rebindSource).toBe('EXTERNAL_UPLOAD');
    expect(rebound.reboundAt).not.toBeNull();

    // 列出：onlyUnfulfilled 不再包含它；全量列表可见回绑信息
    const stillPending = await client.billing.externalResults(workspace.id, { onlyUnfulfilled: true });
    expect(stillPending.some((item) => item.id === generationId)).toBe(false);
    const all = await client.billing.externalResults(workspace.id);
    expect(all.find((item) => item.id === generationId)?.resultAssetId).toBe(asset.id);

    // ④ 场景绑定（编辑历史可追溯）：插入场景 + replace_asset → EditEvent 记录两次操作
    const created = await client.projects.addScene(project.id, {
      sceneType: 'REAL_BROLL',
      semanticType: 'VIDEO_EVIDENCE',
      narration: '',
      visualIntent: '',
      durationMs: 4000,
    });
    const graph = await client.projects.graph(project.id);
    const scene = graph.scenes.find((candidate) => candidate.id === created.scene.id);
    expect(scene).toBeDefined();
    const edited = await client.projects.edit(project.id, {
      baseProjectRevision: graph.projectRevision,
      expectedSceneRevisions: { [scene?.id ?? '']: scene?.revision ?? 1 },
      operations: [{ op: 'replace_asset', sceneId: scene?.id ?? '', role: 'visual', newAssetId: asset.id }],
      idempotencyKey: `idem_nf_${randomUUID()}`,
      intent: 'Native Fallback：绑定外部处理产物',
    });
    const reboundScene = edited.scenes.find((candidate) => candidate.id === scene?.id);
    expect(reboundScene?.assetBindings.some((binding) => binding.assetId === asset.id)).toBe(true);
    expect(edited.editEvents.some((event) => event.action === 'REPLACE_ASSET')).toBe(true);
  });

  it('拒绝路径：跨工作区资产 → 404；未 READY 资产 → 409；跨租户任务引用 → 404', async () => {
    const client = await newClient('nf-reject');
    const workspace = await client.workspaces.create({ name: `拒绝-${randomUUID().slice(0, 8)}` });
    const generationId = await seedGeneration(workspace.id);

    // 跨工作区资产：另一工作区上传的资产不能回绑
    const otherWorkspace = await client.workspaces.create({ name: `其他-${randomUUID().slice(0, 8)}` });
    const foreignAsset = await uploadViaStorage(client, otherWorkspace.id, {
      filename: 'foreign.png',
      contentType: 'image/png',
      bytes: PNG_BYTES,
    });
    const crossAsset = await client.billing
      .rebindExternalResult(workspace.id, generationId, { assetId: foreignAsset.id })
      .catch((error: unknown) => error);
    expect(crossAsset).toBeInstanceOf(AncsApiError);
    expect((crossAsset as AncsApiError).status).toBe(404);

    // 未 READY 资产（仅创建上传意图，不确认）→ 409
    const intent = await client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'pending.png',
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
    });
    const notReady = await client.billing
      .rebindExternalResult(workspace.id, generationId, { assetId: intent.asset.id })
      .catch((error: unknown) => error);
    expect(notReady).toBeInstanceOf(AncsApiError);
    expect((notReady as AncsApiError).status).toBe(409);

    // 跨租户：其他用户对该工作区任务执行回绑 → 404（反枚举）
    const { client: intruder } = { client: await newClient('nf-intruder') };
    const crossed = await intruder.billing
      .rebindExternalResult(workspace.id, generationId, { assetId: foreignAsset.id })
      .catch((error: unknown) => error);
    expect(crossed).toBeInstanceOf(AncsApiError);
    expect((crossed as AncsApiError).status).toBe(404);
  });
});
