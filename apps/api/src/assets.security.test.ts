import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { errorEnvelopeSchema } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P02-04 安全验收（§51 多租户矩阵中与资产相关的三项）：
 * - Cross-workspace read/write denied；
 * - **Signed URL scope**（用途/对象键/有效期绑定，客户端不可改写键，不可复用用途）；
 * - **Provider credential isolation**（响应/错误不泄漏签名材料；客户端永不持有存储凭据）。
 */

const PASSWORD = 'password-1234';
const SIGNING_SECRET = 'assets-security-signing-secret-0123456789'; // secrets:check-ignore：测试专用假密钥

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;
let rootDir: string;

function makePng(): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0x00, 0x00, 0x02, 0x80], 16);
  bytes.set([0x00, 0x00, 0x01, 0x68], 20);
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

  rootDir = await mkdtemp(join(tmpdir(), 'ancs-assets-sec-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:0',
    signingSecret: SIGNING_SECRET,
  });

  auth = createAuth({
    db: handle.db,
    secret: 'assets-security-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
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
  await rm(rootDir, { recursive: true, force: true });
});

async function newUser(): Promise<{ client: AncsClient; email: string }> {
  const email = `assets-sec-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '资产安全' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, email };
}

async function collectFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath ?? dir, entry.name));
}

describe('资产安全（§51：cross-workspace / Signed URL scope / credential isolation）', () => {
  it('跨租户：非成员全 404；VIEWER 可读不可写（403 含 requiredCapability=asset:manage）', async () => {
    const owner = await newUser();
    const stranger = await newUser();
    const viewer = await newUser();
    const workspace = await owner.client.workspaces.create({ name: `资产安全-${randomUUID().slice(0, 8)}` });
    const asset = await owner.client.assets.upload(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'secret.png',
      contentType: 'image/png',
      data: makePng(),
    });

    // 非成员（未加入 workspace）：读/写/下载一律 404（抗枚举）
    for (const action of [
      () => stranger.client.assets.list(workspace.id),
      () => stranger.client.assets.get(workspace.id, asset.id),
      () => stranger.client.assets.downloadUrl(workspace.id, asset.id),
      () => stranger.client.assets.confirm(workspace.id, asset.id, {}),
    ]) {
      const failure = await action().catch((error: unknown) => error);
      expect(failure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    }

    // VIEWER：可读（列表/详情/下载链接），不可写（上传意图/确认 → 403 + requiredCapability）
    await owner.client.workspaces.members.add(workspace.id, { email: viewer.email, role: 'VIEWER' });
    expect((await viewer.client.assets.list(workspace.id)).map((row) => row.id)).toContain(asset.id);
    expect((await viewer.client.assets.get(workspace.id, asset.id)).id).toBe(asset.id);
    const url = await viewer.client.assets.downloadUrl(workspace.id, asset.id);
    expect(url.url).toContain('/api/v1/storage/download?token=');

    const intentFailure = await viewer.client.assets
      .createUploadIntent(workspace.id, { assetType: 'USER_UPLOAD', filename: 'x.png', contentType: 'image/png', sizeBytes: 33 })
      .catch((error: unknown) => error);
    expect(intentFailure).toBeInstanceOf(AncsApiError);
    expect(intentFailure).toMatchObject({ status: 403, code: 'FORBIDDEN' });
    expect((intentFailure as AncsApiError).details['requiredCapability']).toBe('asset:manage');
    const confirmFailure = await viewer.client.assets.confirm(workspace.id, asset.id, {}).catch((error: unknown) => error);
    expect(confirmFailure).toMatchObject({ status: 403 });
  });

  it('跨租户删除/恢复：他人 Trash 操作一律 404（抗枚举，不泄漏存在性）', async () => {
    const owner = await newUser();
    const attacker = await newUser();
    const workspace = await owner.client.workspaces.create({ name: `trash-sec-${randomUUID().slice(0, 8)}` });
    const asset = await owner.client.assets.upload(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'guarded.png',
      contentType: 'image/png',
      data: makePng(),
    });

    const deleteFailure = await attacker.client.assets.delete(workspace.id, asset.id).catch((error: unknown) => error);
    expect(deleteFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const restoreFailure = await attacker.client.assets.restore(workspace.id, asset.id).catch((error: unknown) => error);
    expect(restoreFailure).toMatchObject({ status: 404 });
    // 资产未被越权删除
    expect((await owner.client.assets.get(workspace.id, asset.id)).id).toBe(asset.id);
  });

  it('Signed URL scope：键由服务端签发（无客户端可控参数）；篡改/过期/用途不符一律拒绝', async () => {
    const owner = await newUser();
    const workspace = await owner.client.workspaces.create({ name: `scope-${randomUUID().slice(0, 8)}` });
    const intent = await owner.client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'scope.png',
      contentType: 'image/png',
      sizeBytes: 33,
    });
    const url = new URL(intent.upload?.url ?? '');
    const token = url.searchParams.get('token') ?? '';

    // 上传端点不接受键参数：键只能来自 token（无法写入其他对象）
    expect([...url.searchParams.keys()]).toEqual(['token']);
    const forged = await fetch(`${baseUrl}/api/v1/storage/upload?token=${token}&key=workspaces/other/victim.png`, {
      method: 'PUT',
      body: makePng(),
    });
    expect(forged.status).toBe(200); // 额外参数被忽略
    const files = await collectFiles(rootDir);
    expect(files.some((file) => file.includes('workspaces/other/victim.png'))).toBe(false);

    // 过期 token（构造 -1s TTL 的签名）
    const expiredStorage = new LocalObjectStorage({
      rootDir,
      publicBaseUrl: baseUrl,
      signingSecret: SIGNING_SECRET,
      uploadTtlSeconds: -1,
    });
    const expiredTarget = await expiredStorage.createUploadTarget({ key: 'workspaces/x/uploads/exp.png', contentType: 'image/png', maxBytes: 33 });
    const expiredResponse = await fetch(expiredTarget.url, { method: 'PUT', body: makePng() });
    expect(expiredResponse.status).toBe(403);

    // 用途不符：上传 token 用于下载端点
    const wrongPurpose = await fetch(`${baseUrl}/api/v1/storage/download?token=${token}`);
    expect(wrongPurpose.status).toBe(403);

    // 错误信封不泄漏 token/密钥材料
    const envelope = errorEnvelopeSchema.parse(await wrongPurpose.json());
    expect(JSON.stringify(envelope)).not.toContain(SIGNING_SECRET);
    expect(JSON.stringify(envelope)).not.toContain(token);
  });

  it('Provider credential isolation：所有资产响应与错误信封不含签名材料或对象 URL', async () => {
    const owner = await newUser();
    const workspace = await owner.client.workspaces.create({ name: `cred-${randomUUID().slice(0, 8)}` });
    const asset = await owner.client.assets.upload(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'cred.png',
      contentType: 'image/png',
      data: makePng(),
    });
    const download = await owner.client.assets.downloadUrl(workspace.id, asset.id);

    const payloads = [
      JSON.stringify(asset),
      JSON.stringify(await owner.client.assets.get(workspace.id, asset.id)),
      JSON.stringify(await owner.client.assets.list(workspace.id)),
      JSON.stringify(download),
    ];
    for (const payload of payloads) {
      expect(payload).not.toContain(SIGNING_SECRET);
      expect(payload).not.toContain('signingSecret');
      // 资产 DTO 不携带对象 URL（只存 storage_key，§26）；下载 URL 只出现在专门的 download-url 响应
      if (payload !== JSON.stringify(download)) expect(payload).not.toContain('http://');
    }
    expect(download.url.startsWith(`${baseUrl}/api/v1/storage/download?token=`)).toBe(true);

    // 客户端（SDK）不含任何存储配置项：只有服务端签发的 URL
    expect(Object.keys(owner.client)).not.toContain('storage');
  });
});
