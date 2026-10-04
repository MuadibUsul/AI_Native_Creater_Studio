import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
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

async function newSignedInClient(): Promise<AncsClient> {
  const email = `assets-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '资产测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeWorkspace(client: AncsClient): Promise<string> {
  const workspace = await client.workspaces.create({ name: `资产工作流-${randomUUID().slice(0, 8)}` });
  return workspace.id;
}

describe('资产上传（HTTP / SDK，真实本地存储端点）', () => {
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
    const listFailure = await stranger.assets.list(workspaceId).catch((error: unknown) => error);
    expect(listFailure).toMatchObject({ status: 404 });
  });
});
