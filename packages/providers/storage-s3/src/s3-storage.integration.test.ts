import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3_MIN_PART_BYTES, S3ObjectStorage, type S3StorageOptions } from './index.js';

/**
 * S3 驱动对真实 S3 兼容服务的验收（本地与 CI 用 SeaweedFS：会校验 SigV4 签名，包括预签名 URL）。
 * 端点与测试密钥：ANCS_TEST_S3_ENDPOINT / ANCS_TEST_S3_ACCESS_KEY_ID / ANCS_TEST_S3_SECRET_ACCESS_KEY / ANCS_TEST_S3_BUCKET；
 * 本地启动方式见 docs/ops/deployment-runbook.md §10.3。每次运行使用独立前缀，互不干扰。
 */

const endpoint = process.env['ANCS_TEST_S3_ENDPOINT'] ?? 'http://127.0.0.1:58333';
const credentials = {
  accessKeyId: process.env['ANCS_TEST_S3_ACCESS_KEY_ID'] ?? 'ancs-test',
  secretAccessKey: process.env['ANCS_TEST_S3_SECRET_ACCESS_KEY'] ?? 'ancs-test-secret-0000', // secrets:check-ignore：测试专用假密钥
};
const bucket = process.env['ANCS_TEST_S3_BUCKET'] ?? 'ancs-test';
const base: S3StorageOptions = { bucket, region: 'us-east-1', endpoint, forcePathStyle: true, credentials, keyPrefix: `run-${randomUUID()}` };

let storage: S3ObjectStorage;
let workDir: string;
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

beforeAll(async () => {
  const admin = new S3Client({ region: 'us-east-1', endpoint, forcePathStyle: true, credentials });
  try {
    await admin.send(new CreateBucketCommand({ Bucket: bucket }));
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw new Error(`无法连接测试 S3 服务 ${endpoint}（${String(name)}）。请按部署手册 §10.3 启动 SeaweedFS，或设置 ANCS_TEST_S3_ENDPOINT。`, { cause: error });
    }
  } finally {
    admin.destroy();
  }
  storage = new S3ObjectStorage(base);
  workDir = await mkdtemp(join(tmpdir(), 'ancs-s3-'));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('S3 驱动（真实 S3 兼容服务）', () => {
  it('服务端写入 / 读取 / 探测 / 前缀读取 / SHA-256 / 删除；不存在的对象如实返回', async () => {
    const data = new TextEncoder().encode('hello object storage');
    await storage.putObject('objects/a.txt', data);
    expect(await storage.probeObject('objects/a.txt')).toMatchObject({ exists: true, sizeBytes: data.length });
    expect(new TextDecoder().decode((await storage.getObject('objects/a.txt'))!)).toBe('hello object storage');
    expect(new TextDecoder().decode((await storage.readObjectPrefix('objects/a.txt', 5))!)).toBe('hello');
    expect(await storage.readObjectPrefix('objects/a.txt', 1000)).toHaveLength(data.length);
    expect(await storage.computeObjectSha256('objects/a.txt')).toBe(sha256(data));
    await storage.deleteObject('objects/a.txt');
    expect(await storage.probeObject('objects/a.txt')).toEqual({ exists: false, sizeBytes: 0, contentType: null });
    expect(await storage.getObject('objects/a.txt')).toBeNull();
    expect(await storage.readObjectPrefix('objects/a.txt', 5)).toBeNull();
    expect(await storage.computeObjectSha256('objects/a.txt')).toBeNull();
    await storage.deleteObject('objects/never-existed.txt');
  });

  it('预签名直传：类型与精确长度都被签进 URL，不符即被存储服务拒绝；符合则写入', async () => {
    const body = randomBytes(4096);
    const target = await storage.createUploadTarget({ key: 'uploads/clip.mp4', contentType: 'video/mp4', maxBytes: body.length, ttlSeconds: 300 });
    expect(target.method).toBe('PUT');
    expect(Date.parse(target.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);

    const shorter = await fetch(target.url, { method: 'PUT', headers: target.headers, body: body.subarray(0, 1000) });
    expect(shorter.ok).toBe(false);
    const wrongType = await fetch(target.url, { method: 'PUT', headers: { 'content-type': 'text/html' }, body });
    expect(wrongType.ok).toBe(false);
    expect((await storage.probeObject('uploads/clip.mp4')).exists).toBe(false);

    const accepted = await fetch(target.url, { method: 'PUT', headers: target.headers, body });
    expect(accepted.status).toBe(200);
    expect(await storage.probeObject('uploads/clip.mp4')).toMatchObject({ exists: true, sizeBytes: body.length, contentType: 'video/mp4' });

    const tampered = new URL(target.url);
    tampered.pathname = tampered.pathname.replace('clip.mp4', 'other.mp4');
    expect((await fetch(tampered, { method: 'PUT', headers: target.headers, body })).ok).toBe(false);
  });

  it('预签名下载：字节一致、支持 Range（视频拖动）、可带下载文件名；签名被改即拒绝', async () => {
    const data = randomBytes(2048);
    await storage.putObject('downloads/x.bin', data);
    const plain = await storage.createDownloadUrl({ key: 'downloads/x.bin' });
    expect(Buffer.from(await (await fetch(plain.url)).arrayBuffer()).equals(data)).toBe(true);
    const ranged = await fetch(plain.url, { headers: { range: 'bytes=100-199' } });
    expect(ranged.status).toBe(206);
    expect(Buffer.from(await ranged.arrayBuffer()).equals(data.subarray(100, 200))).toBe(true);
    const named = await storage.createDownloadUrl({ key: 'downloads/x.bin', downloadFilename: '成片 final.mp4' });
    expect((await fetch(named.url)).headers.get('content-disposition')).toContain('attachment; filename="');
    const forged = plain.url.replace(/X-Amz-Signature=[0-9a-f]{8}/, 'X-Amz-Signature=00000000');
    expect((await fetch(forged)).ok).toBe(false);
  });

  it('Worker 物化与写回：20 MiB 文件流式写回（分段上传）后物化，内容一致；物化不存在的对象失败且不留半成品', async () => {
    const source = join(workDir, 'render.mp4');
    const data = randomBytes(20 * 1024 * 1024);
    await writeFile(source, data);
    await storage.persistFile({ sourcePath: source, destinationKey: 'renders/r1.mp4', contentType: 'video/mp4' });
    expect(await storage.probeObject('renders/r1.mp4')).toMatchObject({ exists: true, sizeBytes: data.length, contentType: 'video/mp4' });
    const destination = join(workDir, 'out', 'r1.mp4');
    await storage.materializeObject({ key: 'renders/r1.mp4', destinationPath: destination });
    expect(sha256(await readFile(destination))).toBe(sha256(data));
    await expect(storage.materializeObject({ key: 'renders/missing.mp4', destinationPath: join(workDir, 'out', 'missing.mp4') })).rejects.toThrow();
    await expect(readFile(join(workDir, 'out', 'missing.mp4.partial'))).rejects.toThrow();
  });

  it('分片合成：小分片走流式拼接，≥5 MiB 的分片在存储服务内拼接；两条路径结果都与原文件逐字节一致', async () => {
    const small = [randomBytes(300 * 1024), randomBytes(300 * 1024), randomBytes(1234)];
    for (const [index, part] of small.entries()) await storage.putObject(`parts/s${String(index)}`, part);
    await storage.composeObjects({ sourceKeys: ['parts/s0', 'parts/s1', 'parts/s2'], destinationKey: 'composed/small.bin' });
    expect(await storage.computeObjectSha256('composed/small.bin')).toBe(sha256(Buffer.concat(small)));

    const large = [randomBytes(S3_MIN_PART_BYTES), randomBytes(S3_MIN_PART_BYTES), randomBytes(4321)];
    for (const [index, part] of large.entries()) await storage.putObject(`parts/l${String(index)}`, part);
    await storage.composeObjects({ sourceKeys: ['parts/l0', 'parts/l1', 'parts/l2'], destinationKey: 'composed/large.bin' });
    expect(await storage.probeObject('composed/large.bin')).toMatchObject({ exists: true, sizeBytes: S3_MIN_PART_BYTES * 2 + 4321 });
    expect(await storage.computeObjectSha256('composed/large.bin')).toBe(sha256(Buffer.concat(large)));

    await expect(storage.composeObjects({ sourceKeys: ['parts/s0', 'parts/missing'], destinationKey: 'composed/broken.bin' })).rejects.toThrow('分片不存在');
    expect((await storage.probeObject('composed/broken.bin')).exists).toBe(false);
  });

  it('对象复制保留内容与类型；源不存在时失败', async () => {
    const data = randomBytes(1024);
    await storage.persistFile({ sourcePath: await writeTemp('copy-src.mp4', data), destinationKey: 'copy/src.mp4', contentType: 'video/mp4' });
    await storage.copyObject({ sourceKey: 'copy/src.mp4', destinationKey: 'copy/dst.mp4' });
    expect(await storage.probeObject('copy/dst.mp4')).toMatchObject({ exists: true, sizeBytes: 1024, contentType: 'video/mp4' });
    expect(await storage.computeObjectSha256('copy/dst.mp4')).toBe(sha256(data));
    await expect(storage.copyObject({ sourceKey: 'copy/missing.mp4', destinationKey: 'copy/x.mp4' })).rejects.toThrow('对象不存在');
  });

  it('启动自检：桶存在且凭据正确才通过；桶不存在或密钥错误都失败', async () => {
    await storage.checkBucket();
    await expect(new S3ObjectStorage({ ...base, bucket: `missing-${randomUUID().slice(0, 8)}` }).checkBucket()).rejects.toThrow();
    await expect(new S3ObjectStorage({ ...base, credentials: { accessKeyId: credentials.accessKeyId, secretAccessKey: 'wrong-secret-value-0000' } }).checkBucket()).rejects.toThrow(); // secrets:check-ignore：错误密钥夹具
  });

  it('桶内前缀隔离：不同前缀的驱动互相看不到对象', async () => {
    const other = new S3ObjectStorage({ ...base, keyPrefix: `run-${randomUUID()}` });
    await storage.putObject('isolation/a.txt', new Uint8Array([1, 2, 3]));
    expect((await other.probeObject('isolation/a.txt')).exists).toBe(false);
    expect((await storage.probeObject('isolation/a.txt')).exists).toBe(true);
  });
});

async function writeTemp(name: string, data: Uint8Array): Promise<string> {
  const path = join(workDir, name);
  await writeFile(path, data);
  return path;
}
