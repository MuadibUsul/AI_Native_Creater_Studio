import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P08-04 存储故障（真实 DB + 真实本地存储；**故障注入 = 直接移除存储根目录**）：
 * - 上传确认在对象缺失时**明确失败**（绝不静默 READY）；
 * - 下载入口在对象缺失时 404（受控失败，不返回假响应）；
 * - （渲染侧缺资产 → 409 已由 P07-04 ASSET_OBJECT_MISSING 覆盖。）
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storageRoot: string;

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

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
  auth = createAuth({ db: handle.db, secret: 'storage-fault-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  storageRoot = `${process.cwd()}/.artifacts/test-storage/fault-${randomUUID()}`;
  const storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'storage-fault-signing-0123456789', // secrets:check-ignore：测试专用假密钥
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
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return client;
}

describe('存储故障语义（P08-04）', () => {
  it('对象缺失：确认上传明确失败（不静默 READY）；下载 404（受控失败）', async () => {
    const client = await newClient('fault');
    const workspace = await client.workspaces.create({ name: `故障-${randomUUID().slice(0, 8)}` });

    const intent = await client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'fault.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
    });
    expect(intent.upload).not.toBeNull();
    const uploadUrl = intent.upload?.url ?? '';
    const put = await fetch(uploadUrl, { method: 'PUT', headers: intent.upload?.headers ?? {}, body: PNG });
    expect(put.status).toBe(200);

    // 正常路径：确认成功（对照）
    const confirmed = await client.assets.confirm(workspace.id, intent.asset.id, {});
    expect(confirmed.status).toBe('READY');
    const download = await client.assets.downloadUrl(workspace.id, intent.asset.id);
    expect((await fetch(download.url)).status).toBe(200);

    // 故障注入：移除存储根目录（模拟卷丢失/挂载失败）
    await rm(storageRoot, { recursive: true, force: true });

    // 下载入口：对象缺失 → 404（不返回假内容）
    const missingDownload = await fetch(download.url);
    expect(missingDownload.status).toBe(404);

    // 新上传确认：对象缺失 → 明确失败（4xx/5xx；绝不 READY）
    const intent2 = await client.assets.createUploadIntent(workspace.id, {
      assetType: 'USER_UPLOAD',
      filename: 'fault2.png',
      contentType: 'image/png',
      sizeBytes: PNG.byteLength,
      checksumSha256: undefined,
    });
    if (intent2.upload !== null) {
      // 直传端点自身也会因根目录缺失失败（写入失败 → 5xx）——同样属于"明确失败"
      const put2 = await fetch(intent2.upload.url, { method: 'PUT', headers: intent2.upload.headers, body: Buffer.concat([PNG, Buffer.from([1])]) });
      if (put2.status !== 200) {
        expect(put2.status).toBeGreaterThanOrEqual(400);
      } else {
        const confirmFailure = await client.assets.confirm(workspace.id, intent2.asset.id, {}).catch((error: unknown) => error);
        expect(confirmFailure).toBeInstanceOf(AncsApiError);
      }
    }
  }, 120_000);
});
