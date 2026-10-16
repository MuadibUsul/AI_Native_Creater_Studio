import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { configureDeploymentPolicy } from '@ancs/domain';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P02-04 验收（HTTP + SDK）：上传意图 → 直传（真实 Signed URL 端点）→ 确认 → 下载；
 * 伪造 MIME、不完整上传、越权 token 的作用域约束在 HTTP 层的行为。
 */

const PASSWORD = 'password-1234';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;
let rootDir: string;

function makePng(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes[16] = (width >> 24) & 0xff;
  bytes[17] = (width >> 16) & 0xff;
  bytes[18] = (width >> 8) & 0xff;
  bytes[19] = width & 0xff;
  bytes[20] = (height >> 24) & 0xff;
  bytes[21] = (height >> 16) & 0xff;
  bytes[22] = (height >> 8) & 0xff;
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

  rootDir = await mkdtemp(join(tmpdir(), 'ancs-assets-http-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:0', // listen 后回填
    signingSecret: 'assets-http-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });

  auth = createAuth({
    db: handle.db,
    secret: 'assets-http-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl; // 生成与实际监听端口一致的 Signed URL
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

async function newSignedInIdentity(fetchImpl?: typeof fetch): Promise<{ client: AncsClient; email: string }> {
  const email = `assets-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '资产测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0', fetchImpl });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, email };
}

async function newSignedInClient(fetchImpl?: typeof fetch): Promise<AncsClient> {
  return (await newSignedInIdentity(fetchImpl)).client;
}

async function makeWorkspace(client: AncsClient): Promise<string> {
  const workspace = await client.workspaces.create({ name: `资产工作流-${randomUUID().slice(0, 8)}` });
  return workspace.id;
}

describe('资产上传（HTTP / SDK，真实本地存储端点）', () => {
  it('分片断点续传：跳过服务端已确认分片，流式合并后字节与校验和一致', async () => {
    const putParts: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/v1/storage/upload') && init?.method === 'PUT') putParts.push(url);
      return fetch(input, init);
    };
    const client = await newSignedInClient(recordingFetch);
    const workspaceId = await makeWorkspace(client);
    const bytes = new Uint8Array(600_000);
    bytes.set(makePng(1920, 1080));
    const intent = await client.assets.createUploadIntent(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'resume.png',
      contentType: 'image/png',
      sizeBytes: bytes.byteLength,
      uploadMode: 'MULTIPART',
      partSizeBytes: 256 * 1024,
    });
    expect(intent.upload).toBeNull();
    expect(intent.partCount).toBe(3);
    const firstTarget = await client.assets.createUploadPartTarget(workspaceId, intent.intentId!, 1);
    const first = bytes.subarray(0, 256 * 1024);
    expect((await fetch(firstTarget.upload!.url, { method: 'PUT', headers: firstTarget.upload!.headers, body: first })).status).toBe(200);
    await client.assets.completeUploadPart(workspaceId, intent.intentId!, 1, {
      checksumSha256: createHash('sha256').update(first).digest('hex'),
    });
    putParts.length = 0;

    const result = await client.assets.uploadResumable(
      workspaceId,
      {
        assetType: 'USER_UPLOAD',
        filename: 'resume.png',
        contentType: 'image/png',
        data: new Blob([bytes]),
        resumeIntentId: intent.intentId!,
      },
      { partSizeBytes: 256 * 1024, concurrency: 2 },
    );
    expect(result.status).toBe('READY');
    expect(result.versions[0]?.checksumSha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(putParts).toHaveLength(2);
  });

  it('错误分片 checksum、跨租户 complete 与超过套餐存储额度均被拒绝', async () => {
    const owner = await newSignedInClient();
    const stranger = await newSignedInClient();
    const workspaceId = await makeWorkspace(owner);
    const bytes = makePng(10, 10);
    const intent = await owner.assets.createUploadIntent(workspaceId, {
      assetType: 'USER_UPLOAD', filename: 'bad-checksum.png', contentType: 'image/png', sizeBytes: bytes.byteLength,
      uploadMode: 'MULTIPART', partSizeBytes: 256 * 1024,
    });
    const target = await owner.assets.createUploadPartTarget(workspaceId, intent.intentId!, 1);
    await fetch(target.upload!.url, { method: 'PUT', headers: target.upload!.headers, body: bytes });
    const badChecksum = await owner.assets.completeUploadPart(workspaceId, intent.intentId!, 1, { checksumSha256: '0'.repeat(64) }).catch((error: unknown) => error);
    expect(badChecksum).toMatchObject({ status: 409, details: { reason: 'PART_CHECKSUM_MISMATCH' } });
    const hidden = await stranger.assets.completeUploadPart(workspaceId, intent.intentId!, 1, { checksumSha256: '0'.repeat(64) }).catch((error: unknown) => error);
    expect(hidden).toMatchObject({ status: 404 });
    const cancelled = await owner.assets.cancelUpload(workspaceId, intent.intentId!);
    expect(cancelled.status).toBe('CANCELLED');
    const afterCancel = await owner.assets.createUploadPartTarget(workspaceId, intent.intentId!, 1).catch((error: unknown) => error);
    expect(afterCancel).toMatchObject({ status: 409, details: { reason: 'INTENT_CANCELLED' } });
    configureDeploymentPolicy({ defaultPlan: 'FREE' });
    try {
      const quota = await owner.assets.createUploadIntent(workspaceId, {
        assetType: 'USER_UPLOAD', filename: 'too-large.mp4', contentType: 'video/mp4', sizeBytes: 3 * 1024 * 1024 * 1024,
        uploadMode: 'MULTIPART',
      }).catch((error: unknown) => error);
      expect(quota).toMatchObject({ status: 422, details: { reason: 'STORAGE_QUOTA_EXCEEDED' } });
    } finally {
      configureDeploymentPolicy({});
    }
  });

  it('SDK 一体化上传：意图 → 直传 → 确认（真实探测）→ 下载 Signed URL 可取回原始字节', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const bytes = makePng(1280, 720);

    const asset = await client.assets.upload(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'hero.png',
      contentType: 'image/png',
      data: bytes,
    });
    expect(asset.status).toBe('READY');
    expect(asset.versions).toHaveLength(1);
    expect(asset.versions[0]?.width).toBe(1280);
    expect(asset.versions[0]?.height).toBe(720);
    expect(asset.versions[0]?.sizeBytes).toBe(bytes.byteLength);
    expect(asset.versions[0]?.checksumSha256).toMatch(/^[a-f0-9]{64}$/);

    // 列表/详情（只含 storage_key，不含任何对象 URL 或凭据）
    const listed = await client.assets.list(workspaceId);
    expect(listed.map((row) => row.id)).toContain(asset.id);
    const detail = await client.assets.get(workspaceId, asset.id);
    // 详情只含 storage_key（§26：不得把 Object URL 作为永久标识）；不泄漏任何签名材料
    expect(JSON.stringify(detail)).not.toContain('http://');
    expect(JSON.stringify(detail)).not.toContain('signingSecret');
    expect(detail.versions[0]?.storageKey.startsWith(`workspaces/${workspaceId}/`)).toBe(true);

    // 下载 URL → 取回原始字节
    const download = await client.assets.downloadUrl(workspaceId, asset.id);
    const response = await fetch(download.url);
    expect(response.status).toBe(200);
    const downloaded = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(downloaded)).toEqual(Array.from(bytes));
  });

  it('转写 HTTP / SDK 读取按 workspace 隔离且无转写时返回明确空状态', async () => {
    const owner = await newSignedInClient();
    const stranger = await newSignedInClient();
    const workspaceId = await makeWorkspace(owner);
    const asset = await owner.assets.upload(workspaceId, { assetType: 'SOURCE_IMAGE', filename: 'still.png', contentType: 'image/png', data: makePng(24, 24) });
    expect(await owner.assets.transcript(workspaceId, asset.id)).toMatchObject({ runId: null, sourceAssetVersionId: asset.currentVersionId, status: null, currentVersion: null });
    const hidden = await stranger.assets.transcript(workspaceId, asset.id).catch((error: unknown) => error);
    expect(hidden).toMatchObject({ status: 404 });
  });

  it('片段标签与搜索通过 SDK 往返，并在 HTTP 层保持 workspace 隔离', async () => {
    const owner = await newSignedInClient();
    const stranger = await newSignedInClient();
    const workspaceId = await makeWorkspace(owner);
    const asset = await owner.assets.upload(workspaceId, { assetType: 'SOURCE_IMAGE', filename: 'product.png', contentType: 'image/png', data: makePng(64, 64) });
    const tag = await owner.assets.createRangeTag(workspaceId, asset.id, { label: '产品近景', sourceStartPts: '0', sourceEndPts: '1000', timeBase: { numerator: 1, denominator: 1000 } });
    expect(await owner.assets.listRangeTags(workspaceId, asset.id)).toEqual({ items: [tag] });
    const unified = await owner.assets.mediaIndexRecords(workspaceId, asset.id, { kind: 'USER_MARKER', sourceStartPts: '0', sourceEndPts: '1000', timeBaseNumerator: 1, timeBaseDenominator: 1000 });
    expect(unified).toMatchObject({ sourceAssetVersionId: asset.currentVersionId, items: [{ id: tag.id, kind: 'USER_MARKER', basis: 'USER_SUPPLIED', payload: { label: '产品近景' } }] });
    expect(unified.capabilities).toHaveLength(17);
    const analysis = await owner.assets.analysisStages(workspaceId, asset.id);
    expect(analysis).toMatchObject({ assetId: asset.id, sourceAssetVersionId: asset.currentVersionId, playable: true, stages: expect.arrayContaining([expect.objectContaining({ stage: 'VISION', status: 'NOT_REQUESTED' }), expect.objectContaining({ stage: 'OCR', status: 'DISABLED' })]) });
    expect(analysis.stages).toHaveLength(11);
    expect(await owner.assets.searchSegments(workspaceId, { q: '产品近景' })).toMatchObject({ items: [{ assetId: asset.id, sourceAssetVersionId: asset.currentVersionId, evidence: 'USER_ASSERTED', contentTreatment: 'REFERENCE_DATA_ONLY' }] });
    const hiddenList = await stranger.assets.listRangeTags(workspaceId, asset.id).catch((error: unknown) => error);
    expect(hiddenList).toMatchObject({ status: 404 });
    const hiddenSearch = await stranger.assets.searchSegments(workspaceId, { q: '产品近景' }).catch((error: unknown) => error);
    expect(hiddenSearch).toMatchObject({ status: 404 });
    const hiddenUnified = await stranger.assets.mediaIndexRecords(workspaceId, asset.id).catch((error: unknown) => error);
    expect(hiddenUnified).toMatchObject({ status: 404 });
    const hiddenAnalysis = await stranger.assets.analysisStages(workspaceId, asset.id).catch((error: unknown) => error);
    expect(hiddenAnalysis).toMatchObject({ status: 404 });
    await owner.assets.deleteRangeTag(workspaceId, asset.id, tag.id);
    expect(await owner.assets.listRangeTags(workspaceId, asset.id)).toEqual({ items: [] });
  });

  it('workspace 内去重（SDK）：相同字节第二次上传直接命中既有资产', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const bytes = makePng(64, 64);

    const first = await client.assets.upload(workspaceId, { assetType: 'USER_UPLOAD', filename: 'a.png', contentType: 'image/png', data: bytes });
    const second = await client.assets.upload(workspaceId, { assetType: 'USER_UPLOAD', filename: 'b.png', contentType: 'image/png', data: bytes });
    expect(second.id).toBe(first.id);
    expect(await client.assets.list(workspaceId)).toHaveLength(1);
  });

  it('伪造 MIME（HTTP）：声明 PNG 上传文本 → 415，资产 FAILED', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const failure = await client.assets
      .upload(workspaceId, {
        assetType: 'USER_UPLOAD',
        filename: 'fake.png',
        contentType: 'image/png',
        data: new TextEncoder().encode('I am definitely not a PNG'),
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    expect(failure).toMatchObject({ status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' });

    const assets = await client.assets.list(workspaceId);
    expect(assets).toHaveLength(1);
    expect(assets[0]?.status).toBe('FAILED');
  });

  it('不完整上传（HTTP）：直传字节少于声明 → 确认 409 SIZE_MISMATCH；补传后确认成功', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const bytes = makePng(32, 32);

    const intent = await client.assets.createUploadIntent(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'retry.png',
      contentType: 'image/png',
      sizeBytes: bytes.byteLength,
    });
    expect(intent.upload).not.toBeNull();
    const uploadUrl = intent.upload?.url ?? '';

    // 只上传一半（模拟网络中断的"不完整上传"）
    const partial = await fetch(uploadUrl, { method: 'PUT', body: bytes.subarray(0, 10) });
    expect(partial.status).toBe(200); // 端点接受；完整性由确认阶段判定

    const failure = await client.assets.confirm(workspaceId, intent.asset.id, {}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 409, code: 'PRECONDITION_FAILED' });
    expect((failure as AncsApiError).details['reason']).toBe('SIZE_MISMATCH');

    // 补传完整内容 → 确认成功
    const full = await fetch(uploadUrl, { method: 'PUT', body: bytes });
    expect(full.status).toBe(200);
    const confirmed = await client.assets.confirm(workspaceId, intent.asset.id, {});
    expect(confirmed.status).toBe('READY');
  });

  it('越权 token：篡改签名 / 用途不符 / 无 token 一律 403', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const intent = await client.assets.createUploadIntent(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'scope.png',
      contentType: 'image/png',
      sizeBytes: 33,
    });
    const uploadUrl = intent.upload?.url ?? '';
    const token = new URL(uploadUrl).searchParams.get('token') ?? '';

    // 篡改签名
    const tampered = await fetch(`${baseUrl}/api/v1/storage/upload?token=${token.slice(0, -4)}AAAA`, { method: 'PUT', body: makePng(1, 1) });
    expect(tampered.status).toBe(403);

    // 上传 token 用于下载端点（用途绑定）
    const wrongPurpose = await fetch(`${baseUrl}/api/v1/storage/download?token=${token}`);
    expect(wrongPurpose.status).toBe(403);

    // 无 token
    const noToken = await fetch(`${baseUrl}/api/v1/storage/upload`, { method: 'PUT', body: makePng(1, 1) });
    expect(noToken.status).toBe(403);

    // 未确认资产在清单中仍为 PENDING_UPLOAD（越权 token 未产生 Ready 副作用）
    const listed = await client.assets.list(workspaceId);
    expect(listed[0]?.status).toBe('PENDING_UPLOAD');
  });

  it('Trash：软删 → trashed 视图可见 → 下载 404 → 恢复；项目软删/恢复同理', async () => {
    const client = await newSignedInClient();
    const workspaceId = await makeWorkspace(client);
    const asset = await client.assets.upload(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'trash-me.png',
      contentType: 'image/png',
      data: makePng(24, 24),
    });

    const deleted = await client.assets.delete(workspaceId, asset.id);
    expect(deleted.id).toBe(asset.id);
    expect(await client.assets.list(workspaceId)).toHaveLength(0);
    expect((await client.assets.list(workspaceId, { trashed: true })).map((row) => row.id)).toEqual([asset.id]);
    const gone = await client.assets.get(workspaceId, asset.id).catch((error: unknown) => error);
    expect(gone).toMatchObject({ status: 404 });

    const restored = await client.assets.restore(workspaceId, asset.id);
    expect(restored.id).toBe(asset.id);
    expect(await client.assets.list(workspaceId)).toHaveLength(1);

    // 项目：软删 → trashed 视图 → 读写 404 → 恢复
    const project = await client.projects.create(workspaceId, { title: 'Trash 项目', channelId: (await client.channels.create(workspaceId, { name: '栏目' })).id });
    await client.projects.delete(project.id);
    expect(await client.projects.list(workspaceId)).toHaveLength(0);
    expect((await client.projects.list(workspaceId, { trashed: true })).map((row) => row.id)).toEqual([project.id]);
    const projectGone = await client.projects.get(project.id).catch((error: unknown) => error);
    expect(projectGone).toMatchObject({ status: 404 });
    const projectRestored = await client.projects.restore(project.id);
    expect(projectRestored.id).toBe(project.id);
    expect(await client.projects.list(workspaceId)).toHaveLength(1);
  });

  it('跨租户：他人 workspace 的资产不可确认/查看/取下载链接（404 抗枚举）', async () => {
    const owner = await newSignedInClient();
    const stranger = await newSignedInClient();
    const workspaceId = await makeWorkspace(owner);
    const asset = await owner.assets.upload(workspaceId, {
      assetType: 'USER_UPLOAD',
      filename: 'private.png',
      contentType: 'image/png',
      data: makePng(16, 16),
    });

    const confirmFailure = await stranger.assets.confirm(workspaceId, asset.id, {}).catch((error: unknown) => error);
    expect(confirmFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const getFailure = await stranger.assets.get(workspaceId, asset.id).catch((error: unknown) => error);
    expect(getFailure).toMatchObject({ status: 404 });
    const downloadFailure = await stranger.assets.downloadUrl(workspaceId, asset.id).catch((error: unknown) => error);
    expect(downloadFailure).toMatchObject({ status: 404 });
    const playbackFailure = await stranger.assets.playbackUrl(workspaceId, asset.id).catch((error: unknown) => error);
    expect(playbackFailure).toMatchObject({ status: 404 });
    const rebuildFailure = await stranger.assets.rebuildProxy(workspaceId, asset.id).catch((error: unknown) => error);
    expect(rebuildFailure).toMatchObject({ status: 404 });
    const listFailure = await stranger.assets.list(workspaceId).catch((error: unknown) => error);
    expect(listFailure).toMatchObject({ status: 404 });
  });

  it('撤销成员后旧索引 cursor 立即失效，响应禁止共享缓存，同内容不跨租户复用', async () => {
    const owner = await newSignedInClient();
    const cacheHeaders: string[] = [];
    const memberIdentity = await newSignedInIdentity(async (input, init) => {
      const response = await fetch(input, init);
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/media-index-records')) cacheHeaders.push(response.headers.get('cache-control') ?? '');
      return response;
    });
    const workspaceId = await makeWorkspace(owner);
    const bytes = makePng(40, 40);
    const ownerAsset = await owner.assets.upload(workspaceId, {
      assetType: 'USER_UPLOAD', filename: 'same-content.png', contentType: 'image/png', data: bytes,
    });
    const member = await owner.workspaces.members.add(workspaceId, { email: memberIdentity.email, role: 'EDITOR' });
    const firstPage = await memberIdentity.client.assets.mediaIndexRecords(workspaceId, ownerAsset.id, { cursor: 0, limit: 1 });
    expect(firstPage.sourceAssetVersionId).toBe(ownerAsset.currentVersionId);
    expect(cacheHeaders).toContain('private, no-store');

    const memberWorkspaceId = await makeWorkspace(memberIdentity.client);
    const memberAsset = await memberIdentity.client.assets.upload(memberWorkspaceId, {
      assetType: 'USER_UPLOAD', filename: 'same-content.png', contentType: 'image/png', data: bytes,
    });
    expect(memberAsset.id).not.toBe(ownerAsset.id);
    expect(memberAsset.currentVersionId).not.toBe(ownerAsset.currentVersionId);
    await owner.workspaces.members.remove(workspaceId, member.userId);
    const revokedCursor = await memberIdentity.client.assets.mediaIndexRecords(workspaceId, ownerAsset.id, { cursor: 0, limit: 1 }).catch((error: unknown) => error);
    expect(revokedCursor).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const crossTenant = await owner.assets.mediaIndexRecords(memberWorkspaceId, memberAsset.id, { cursor: 0, limit: 1 }).catch((error: unknown) => error);
    expect(crossTenant).toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });

  it('按服务端成员上下文复用范围证据并记录命中，跨租户无法读取缓存', async () => {
    const owner = await newSignedInClient();
    const workspaceId = await makeWorkspace(owner);
    const uploaded = await owner.assets.upload(workspaceId, { assetType: 'USER_UPLOAD', filename: 'evidence.png', contentType: 'image/png', data: makePng(48, 48) });
    const query = { consumer: 'SELECTION' as const, analysisConfigHash: 'e'.repeat(64), sourceStartPts: '0', sourceEndPts: '1000', timeBaseNumerator: 1, timeBaseDenominator: 1000 };
    const first = await owner.assets.mediaEvidence(workspaceId, uploaded.id, query);
    const second = await owner.assets.mediaEvidence(workspaceId, uploaded.id, query);
    expect(first).toMatchObject({ cacheStatus: 'MISS', sourceAssetVersionId: uploaded.currentVersionId, usage: { hitCount: 0, analysisReadCount: 1, rangeReadCount: 1 } });
    expect(second).toMatchObject({ cacheStatus: 'HIT', cacheKey: first.cacheKey, usage: { hitCount: 1, analysisReadCount: 1, rangeReadCount: 1 } });
    const stranger = await newSignedInClient();
    await expect(stranger.assets.mediaEvidence(workspaceId, uploaded.id, query)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
