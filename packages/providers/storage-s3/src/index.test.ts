import { describe, expect, it } from 'vitest';
import { canComposeByPartCopy, copyRanges, normalizeKeyPrefix, S3_MIN_PART_BYTES, S3ObjectStorage, s3StorageOptionsFromEnv } from './index.js';

/** S3 驱动的纯规则：分片拼接策略、超大对象的复制区间、桶内前缀与对象键校验、配置映射。 */
describe('S3 存储驱动规则', () => {
  it('分片能否在存储服务内拼接：除最后一片外都 ≥5 MiB、每片 >0 且 ≤5 GiB', () => {
    expect(canComposeByPartCopy([S3_MIN_PART_BYTES, S3_MIN_PART_BYTES, 10])).toBe(true);
    expect(canComposeByPartCopy([S3_MIN_PART_BYTES])).toBe(true);
    expect(canComposeByPartCopy([10])).toBe(true);
    expect(canComposeByPartCopy([256 * 1024, 256 * 1024])).toBe(false);
    expect(canComposeByPartCopy([S3_MIN_PART_BYTES, 0])).toBe(false);
    expect(canComposeByPartCopy([])).toBe(false);
  });

  it('超大对象的复制区间连续、闭区间、覆盖全部字节', () => {
    expect(copyRanges(10, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }, { start: 8, end: 9 }]);
    expect(copyRanges(8, 4)).toEqual([{ start: 0, end: 3 }, { start: 4, end: 7 }]);
    expect(copyRanges(0, 4)).toEqual([]);
  });

  it('桶内前缀：补齐结尾斜杠，拒绝绝对路径、.. 与非法字符', () => {
    expect(normalizeKeyPrefix(undefined)).toBe('');
    expect(normalizeKeyPrefix('prod')).toBe('prod/');
    expect(normalizeKeyPrefix('prod/media/')).toBe('prod/media/');
    expect(() => normalizeKeyPrefix('/prod')).toThrow();
    expect(() => normalizeKeyPrefix('a/../b')).toThrow();
    expect(() => normalizeKeyPrefix('a b')).toThrow();
  });

  it('对象键加前缀；拒绝绝对路径与 ..（与本地驱动同一底线）', () => {
    const storage = new S3ObjectStorage({ bucket: 'b', region: 'us-east-1', keyPrefix: 'prod', credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
    expect(storage.objectKey('assets/a.mp4')).toBe('prod/assets/a.mp4');
    expect(() => storage.objectKey('/etc/passwd')).toThrow();
    expect(() => storage.objectKey('assets/../../x')).toThrow();
    expect(() => storage.objectKey('')).toThrow();
  });

  it('预签名直传：类型与长度签进签名、主机是浏览器端点、有效期不超过 1 小时；不带 SDK 自动校验和参数（浏览器直传会因此失败）', async () => {
    const storage = new S3ObjectStorage({ bucket: 'media', region: 'us-east-1', endpoint: 'http://s3.internal:8333', publicEndpoint: 'https://files.example.com', forcePathStyle: true, credentials: { accessKeyId: 'k', secretAccessKey: 's' } });
    const target = await storage.createUploadTarget({ key: 'a/b.mp4', contentType: 'video/mp4', maxBytes: 123, ttlSeconds: 99_999 });
    const url = new URL(target.url);
    expect(url.origin).toBe('https://files.example.com');
    expect(url.pathname).toBe('/media/a/b.mp4');
    expect(url.searchParams.get('X-Amz-SignedHeaders')?.split(';').sort()).toEqual(['content-length', 'content-type', 'host']);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('3600');
    expect([...url.searchParams.keys()].filter((key) => /checksum/i.test(key))).toEqual([]);
    expect(target.headers).toEqual({ 'content-type': 'video/mp4' });
    const download = new URL((await storage.createDownloadUrl({ key: 'a/b.mp4', downloadFilename: '成片 1.mp4' })).url);
    expect(download.searchParams.get('response-content-disposition')).toBe('attachment; filename="___1.mp4"');
  });

  it('配置映射：路径风格、浏览器端点、密钥成对才使用；缺桶或区域直接报错', () => {
    expect(s3StorageOptionsFromEnv({ ANCS_S3_BUCKET: 'media', ANCS_S3_REGION: 'auto', ANCS_S3_ENDPOINT: 'https://r2.example', ANCS_S3_PUBLIC_ENDPOINT: 'https://cdn.example', ANCS_S3_FORCE_PATH_STYLE: '1', ANCS_S3_ACCESS_KEY_ID: 'id', ANCS_S3_SECRET_ACCESS_KEY: 'secret' })).toEqual({
      bucket: 'media', region: 'auto', endpoint: 'https://r2.example', publicEndpoint: 'https://cdn.example', forcePathStyle: true, credentials: { accessKeyId: 'id', secretAccessKey: 'secret' },
    });
    expect(s3StorageOptionsFromEnv({ ANCS_S3_BUCKET: 'media', ANCS_S3_REGION: 'us-east-1', ANCS_S3_ACCESS_KEY_ID: 'id' })).toEqual({ bucket: 'media', region: 'us-east-1', forcePathStyle: false });
    expect(() => s3StorageOptionsFromEnv({ ANCS_S3_BUCKET: 'media' })).toThrow();
  });
});
