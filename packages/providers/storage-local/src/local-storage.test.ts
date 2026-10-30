import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalObjectStorage, deriveStorageSigningSecret, localStorageOptionsFromEnv } from './index.js';

/**
 * 本地对象存储适配器（P02-04）：真实写盘 / 探测 / 校验和 / 签名作用域（§51 Security 测试的
 * "Signed URL scope" 与"越权对象"在单元层的第一道证据；HTTP 层见 apps/api 的 security 套件）。
 */

let rootDir: string;
let storage: LocalObjectStorage;

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

beforeAll(async () => {
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-storage-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'local-storage-test-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe('本地对象存储适配器', () => {
  it('写入 → 探测 → 前缀读取 → SHA-256 → 删除（真实文件事实）', async () => {
    const key = 'workspaces/ws_1/uploads/a.png';
    expect(await storage.probeObject(key)).toMatchObject({ exists: false, sizeBytes: 0 });

    await storage.writeObject(key, PNG_BYTES);
    const probe = await storage.probeObject(key);
    expect(probe).toMatchObject({ exists: true, sizeBytes: PNG_BYTES.length });

    const prefix = await storage.readObjectPrefix(key, 16);
    expect(prefix).not.toBeNull();
    expect(Array.from((prefix ?? new Uint8Array()).subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const expectedSha = createHash('sha256').update(PNG_BYTES).digest('hex');
    expect(await storage.computeObjectSha256(key)).toBe(expectedSha);
    expect(await storage.computeObjectSha256('workspaces/ws_1/uploads/missing.png')).toBeNull();

    await storage.deleteObject(key);
    expect((await storage.probeObject(key)).exists).toBe(false);
  });

  it('上传目标：带作用域与 TTL 的签名 URL；客户端不接触存储凭据', async () => {
    const target = await storage.createUploadTarget({
      key: 'workspaces/ws_1/uploads/b.bin',
      contentType: 'application/octet-stream',
      maxBytes: 1024,
      scope: { workspaceId: 'ws_1', assetId: 'ast_1', versionId: 'av_1' },
    });
    expect(target.method).toBe('PUT');
    expect(target.maxBytes).toBe(1024);
    expect(target.url.startsWith('http://127.0.0.1:3999/api/v1/storage/upload?token=')).toBe(true);

    const token = new URL(target.url).searchParams.get('token') ?? '';
    const payload = storage.verifyToken(token, 'upload');
    expect(payload).toMatchObject({ key: 'workspaces/ws_1/uploads/b.bin', workspaceId: 'ws_1', assetId: 'ast_1', maxBytes: 1024 });
    // 用途绑定：上传 token 不能用于下载
    expect(storage.verifyToken(token, 'download')).toBeNull();
  });

  it('签名校验：篡改负载 / 篡改签名 / 过期 / 用途不符一律拒绝', async () => {
    const target = await storage.createUploadTarget({
      key: 'workspaces/ws_1/uploads/c.bin',
      contentType: 'application/octet-stream',
      maxBytes: 10,
    });
    const token = new URL(target.url).searchParams.get('token') ?? '';

    const [body, signature] = token.split('.');
    const tamperedBody = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body ?? '', 'base64url').toString('utf8')), key: 'workspaces/ws_1/uploads/other.bin' }),
      'utf8',
    ).toString('base64url');
    expect(storage.verifyToken(`${tamperedBody}.${signature ?? ''}`, 'upload')).toBeNull();
    expect(storage.verifyToken(`${body ?? ''}.AAAA`, 'upload')).toBeNull();
    expect(storage.verifyToken('not-a-token', 'upload')).toBeNull();

    const expired = new LocalObjectStorage({
      rootDir,
      publicBaseUrl: 'http://127.0.0.1:3999',
      signingSecret: 'local-storage-test-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    });
    const shortLived = await expired.createUploadTarget({
      key: 'workspaces/ws_1/uploads/d.bin',
      contentType: 'application/octet-stream',
      maxBytes: 10,
      ttlSeconds: -1,
    });
    expect(expired.verifyToken(new URL(shortLived.url).searchParams.get('token') ?? '', 'upload')).toBeNull();
  });

  it('路径防穿越：.. / 绝对路径一律拒绝', async () => {
    expect(() => storage.resolveKeyPath('../outside.txt')).toThrow();
    expect(() => storage.resolveKeyPath('workspaces/../../etc/passwd')).toThrow();
    expect(() => storage.resolveKeyPath('/etc/passwd')).toThrow();
    expect(storage.resolveKeyPath('workspaces/ws_1/uploads/ok.png').startsWith(rootDir)).toBe(true);
  });

  it('未完成的写入不会被视为完整对象（.partial 不参与探测）', async () => {
    const key = 'workspaces/ws_1/uploads/incomplete.bin';
    const partialPath = join(rootDir, `${key}.partial`);
    await mkdir(join(rootDir, 'workspaces/ws_1/uploads'), { recursive: true });
    await writeFile(partialPath, Buffer.from('half'));
    expect((await storage.probeObject(key)).exists).toBe(false);
    expect(await storage.computeObjectSha256(key)).toBeNull();
  });

  it('按顺序流式合并分片并原子暴露最终对象', async () => {
    await storage.putObject('multipart/upi_1/part-00001', new TextEncoder().encode('alpha'));
    await storage.putObject('multipart/upi_1/part-00002', new TextEncoder().encode('-beta'));
    const composed = await storage.composeObjects({
      sourceKeys: ['multipart/upi_1/part-00001', 'multipart/upi_1/part-00002'],
      destinationKey: 'workspaces/ws_1/uploads/combined.bin',
    });
    expect(new TextDecoder().decode(await storage.getObject('workspaces/ws_1/uploads/combined.bin') ?? new Uint8Array())).toBe('alpha-beta');
    expect((await storage.probeObject('workspaces/ws_1/uploads/combined.bin')).sizeBytes).toBe(10);
    // 合并途中算出的整文件校验和，与事后重读整个文件算的一致（确认上传据此省去一遍读取）
    expect(composed.checksumSha256).toBe(await storage.computeObjectSha256('workspaces/ws_1/uploads/combined.bin'));
  });

  it('合并几十个分片时校验和仍与整文件一致，且不累积流监听器', async () => {
    const keys: string[] = [];
    for (let index = 1; index <= 24; index += 1) {
      const key = `multipart/upi_many/part-${String(index).padStart(5, '0')}`;
      await storage.putObject(key, new Uint8Array(70_000).fill(index));
      keys.push(key);
    }
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => { warnings.push(warning); };
    process.on('warning', onWarning);
    try {
      const composed = await storage.composeObjects({ sourceKeys: keys, destinationKey: 'workspaces/ws_1/uploads/many.bin' });
      expect((await storage.probeObject('workspaces/ws_1/uploads/many.bin')).sizeBytes).toBe(24 * 70_000);
      expect(composed.checksumSha256).toBe(await storage.computeObjectSha256('workspaces/ws_1/uploads/many.bin'));
      await new Promise((resolve) => setImmediate(resolve));
      expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual([]);
    } finally {
      process.off('warning', onWarning);
    }
  });

  it('合并途中缺分片时失败，且不留下半成品或 .partial', async () => {
    await storage.putObject('multipart/upi_gap/part-00001', new TextEncoder().encode('first'));
    await expect(storage.composeObjects({
      sourceKeys: ['multipart/upi_gap/part-00001', 'multipart/upi_gap/part-00002'],
      destinationKey: 'workspaces/ws_1/uploads/gap.bin',
    })).rejects.toThrow();
    expect((await storage.probeObject('workspaces/ws_1/uploads/gap.bin')).exists).toBe(false);
    expect((await storage.probeObject('workspaces/ws_1/uploads/gap.bin.partial')).exists).toBe(false);
  });

  it('在存储内部原子复制对象供缺失原件恢复', async () => {
    await storage.putObject('workspaces/ws_1/relink/candidate.bin', new TextEncoder().encode('exact-original'));
    await storage.copyObject({ sourceKey: 'workspaces/ws_1/relink/candidate.bin', destinationKey: 'workspaces/ws_1/relink/original.bin' });
    expect(new TextDecoder().decode(await storage.getObject('workspaces/ws_1/relink/original.bin') ?? new Uint8Array())).toBe('exact-original');
    expect(await storage.computeObjectSha256('workspaces/ws_1/relink/original.bin')).toBe(await storage.computeObjectSha256('workspaces/ws_1/relink/candidate.bin'));
  });

  it('以流式临时文件物化对象供隔离媒体工具读取', async () => {
    const key = 'workspaces/ws_1/uploads/probe-source.bin';
    const destination = join(rootDir, 'worker-temp', 'source.bin');
    await storage.putObject(key, new TextEncoder().encode('bounded-source'));
    await storage.materializeObject({ key, destinationPath: destination });
    expect((await readFile(destination)).toString('utf8')).toBe('bounded-source');
  });

  it('将 Worker 本地结果流式原子写回对象存储', async () => {
    const sourcePath = join(rootDir, 'worker-temp', 'proxy.mp4');
    await mkdir(join(rootDir, 'worker-temp'), { recursive: true });
    await writeFile(sourcePath, Buffer.from('proxy-bytes'));
    await storage.persistFile({ sourcePath, destinationKey: 'workspaces/ws_1/renders/proxy.mp4', contentType: 'video/mp4' });
    expect(new TextDecoder().decode(await storage.getObject('workspaces/ws_1/renders/proxy.mp4') ?? new Uint8Array())).toBe('proxy-bytes');
  });
});

describe('localStorageOptionsFromEnv / deriveStorageSigningSecret（API、Worker、清理 CLI 同一规则）', () => {
  const authSecret = 'session-secret-0123456789abcdef'; // secrets:check-ignore：测试专用假密钥

  it('显式密钥优先；否则由会话密钥派生，且派生值稳定、不等于会话密钥本身', () => {
    expect(deriveStorageSigningSecret({ BETTER_AUTH_SECRET: authSecret, ANCS_STORAGE_SECRET: 'explicit-storage-secret' })).toBe('explicit-storage-secret'); // secrets:check-ignore：测试专用假值
    const derived = deriveStorageSigningSecret({ BETTER_AUTH_SECRET: authSecret });
    expect(derived).toMatch(/^[0-9a-f]{64}$/);
    expect(derived).not.toBe(authSecret);
    expect(deriveStorageSigningSecret({ BETTER_AUTH_SECRET: authSecret })).toBe(derived);
  });

  it('公开基址回退顺序：ANCS_STORAGE_PUBLIC_BASE_URL → BETTER_AUTH_URL → localhost:PORT（Worker 不再固定 localhost:3001）', () => {
    expect(localStorageOptionsFromEnv({ BETTER_AUTH_SECRET: authSecret, ANCS_STORAGE_PUBLIC_BASE_URL: 'https://cdn.example.com', BETTER_AUTH_URL: 'https://api.example.com' }).publicBaseUrl).toBe('https://cdn.example.com');
    expect(localStorageOptionsFromEnv({ BETTER_AUTH_SECRET: authSecret, BETTER_AUTH_URL: 'https://api.example.com' }).publicBaseUrl).toBe('https://api.example.com');
    expect(localStorageOptionsFromEnv({ BETTER_AUTH_SECRET: authSecret, PORT: 4000 }).publicBaseUrl).toBe('http://localhost:4000');
    expect(localStorageOptionsFromEnv({ BETTER_AUTH_SECRET: authSecret }).publicBaseUrl).toBe('http://localhost:3001');
  });
});

