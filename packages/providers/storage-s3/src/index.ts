import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PassThrough, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCopyCommand,
  type CompletedPart,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_SIGNED_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type ComposedObject,
  type DownloadTarget,
  type ObjectProbe,
  type ObjectStorageAdapter,
  type S3StorageEnv,
  type UploadTarget,
} from '@ancs/contracts';

/**
 * S3 兼容对象存储（生产清单第 1 节第 2 项）：AWS S3 / Cloudflare R2 / 阿里云 OSS / SeaweedFS 等。
 *
 * - 浏览器经**预签名 URL 直传直下**，字节不经 API；上传签名包含 Content-Type 与**精确的 Content-Length**
 *   （领域层传入的 maxBytes 就是意图声明的大小），大小不符的请求被存储服务拒绝；URL 有效期不超过 1 小时；
 * - 服务端写入（putObject / persistFile / 分片合成 / 复制）在 S3 语义下是原子的：对象在写完之前不可见；
 * - 分片合成：除最后一片外都 ≥5 MiB 时用 UploadPartCopy 在存储服务内拼接；否则流式读出再写入（内存有界）；
 * - 校验和计算关闭"按需以外"的 SDK 自动校验（WHEN_REQUIRED）：新版 SDK 默认给预签名上传加 CRC 头，
 *   浏览器直传与多数第三方实现会因此失败；对象完整性由领域层的 SHA-256 校验保证；
 * - 不读取环境变量：配置由入口校验后注入（未给访问密钥时用 SDK 的运行环境凭据链，如云主机角色）。
 */

export const S3_MIN_PART_BYTES = 5 * 1024 * 1024;
export const S3_MAX_COPY_PART_BYTES = 5 * 1024 * 1024 * 1024;
const COPY_RANGE_BYTES = 512 * 1024 * 1024;
const UPLOAD_PART_BYTES = 16 * 1024 * 1024;
const UPLOAD_QUEUE = 4;

export interface S3StorageOptions {
  bucket: string;
  region: string;
  /** 非 AWS 的服务端点 */
  endpoint?: string;
  /** 浏览器使用的端点（预签名 URL 的主机）；缺省同 endpoint */
  publicEndpoint?: string;
  forcePathStyle?: boolean;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  /** 桶内前缀（如 prod/） */
  keyPrefix?: string;
  uploadTtlSeconds?: number;
  downloadTtlSeconds?: number;
}

/** 由已校验配置得到 S3 驱动选项（API、Worker、清理 CLI 同一规则）。 */
export function s3StorageOptionsFromEnv(env: S3StorageEnv): S3StorageOptions {
  if (env.ANCS_S3_BUCKET === undefined || env.ANCS_S3_REGION === undefined) {
    throw new Error('S3 存储缺少 ANCS_S3_BUCKET 或 ANCS_S3_REGION（应在入口配置校验时拦下）');
  }
  return {
    bucket: env.ANCS_S3_BUCKET,
    region: env.ANCS_S3_REGION,
    ...(env.ANCS_S3_ENDPOINT !== undefined ? { endpoint: env.ANCS_S3_ENDPOINT } : {}),
    ...(env.ANCS_S3_PUBLIC_ENDPOINT !== undefined ? { publicEndpoint: env.ANCS_S3_PUBLIC_ENDPOINT } : {}),
    forcePathStyle: env.ANCS_S3_FORCE_PATH_STYLE === '1',
    ...(env.ANCS_S3_ACCESS_KEY_ID !== undefined && env.ANCS_S3_SECRET_ACCESS_KEY !== undefined
      ? { credentials: { accessKeyId: env.ANCS_S3_ACCESS_KEY_ID, secretAccessKey: env.ANCS_S3_SECRET_ACCESS_KEY } }
      : {}),
    ...(env.ANCS_S3_KEY_PREFIX !== undefined ? { keyPrefix: env.ANCS_S3_KEY_PREFIX } : {}),
  };
}

/** 分片能否在存储服务内用 UploadPartCopy 拼接（S3 规则：除最后一片外每片 ≥5 MiB，每片 ≤5 GiB，最多 10000 片）。 */
export function canComposeByPartCopy(sizes: readonly number[]): boolean {
  return sizes.length > 0 && sizes.length <= 10_000
    && sizes.every((size, index) => size > 0 && size <= S3_MAX_COPY_PART_BYTES && (index === sizes.length - 1 || size >= S3_MIN_PART_BYTES));
}

/** 超过单次复制上限的对象按字节区间分片复制（闭区间，S3 CopySourceRange 语义）。 */
export function copyRanges(sizeBytes: number, rangeBytes = COPY_RANGE_BYTES): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let start = 0; start < sizeBytes; start += rangeBytes) ranges.push({ start, end: Math.min(start + rangeBytes, sizeBytes) - 1 });
  return ranges;
}

/** 桶内前缀规范化：空 → 无前缀；否则以 / 结尾。 */
export function normalizeKeyPrefix(prefix: string | undefined): string {
  if (prefix === undefined || prefix === '') return '';
  if (prefix.startsWith('/') || prefix.split('/').includes('..') || !/^[A-Za-z0-9._\-/]+$/.test(prefix)) throw new Error(`非法的桶内前缀：${prefix}`);
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

const isNotFound = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === 'NotFound' || candidate?.name === 'NoSuchKey' || candidate?.$metadata?.httpStatusCode === 404;
};
const isInvalidRange = (error: unknown): boolean => {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number } } | null;
  return candidate?.name === 'InvalidRange' || candidate?.$metadata?.httpStatusCode === 416;
};
const clampTtl = (ttl: number): number => Math.max(1, Math.min(Math.floor(ttl), MAX_SIGNED_URL_TTL_SECONDS));

export class S3ObjectStorage implements ObjectStorageAdapter {
  readonly kind = 's3';
  private readonly client: S3Client;
  private readonly presignClient: S3Client;
  private readonly bucket: string;
  private readonly prefix: string;
  private readonly uploadTtlSeconds: number;
  private readonly downloadTtlSeconds: number;

  constructor(options: S3StorageOptions) {
    const base = {
      region: options.region,
      forcePathStyle: options.forcePathStyle ?? false,
      requestChecksumCalculation: 'WHEN_REQUIRED' as const,
      responseChecksumValidation: 'WHEN_REQUIRED' as const,
      ...(options.credentials !== undefined ? { credentials: options.credentials } : {}),
    };
    this.client = new S3Client({ ...base, ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}) });
    const browserEndpoint = options.publicEndpoint ?? options.endpoint;
    this.presignClient = browserEndpoint === options.endpoint
      ? this.client
      : new S3Client({ ...base, ...(browserEndpoint !== undefined ? { endpoint: browserEndpoint } : {}) });
    this.bucket = options.bucket;
    this.prefix = normalizeKeyPrefix(options.keyPrefix);
    this.uploadTtlSeconds = options.uploadTtlSeconds ?? UPLOAD_URL_TTL_SECONDS;
    this.downloadTtlSeconds = options.downloadTtlSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
  }

  /**
   * 启动自检：桶存在且凭据可用（HeadBucket）。需要桶的 s3:ListBucket 权限——驱动本来就需要它：
   * 没有它时 S3 对不存在的对象返回 403 而不是 404，"对象是否存在"就无法判断。
   */
  async checkBucket(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  /** 存储键 → 桶内对象键（与本地驱动同样拒绝绝对路径与 ..）。 */
  objectKey(key: string): string {
    if (key.length === 0 || key.includes('\0') || key.startsWith('/') || key.startsWith('\\') || key.split('/').includes('..')) {
      throw new Error(`非法的 storage key：${key}`);
    }
    return `${this.prefix}${key}`;
  }

  private copySource(key: string): string {
    return `${this.bucket}/${this.objectKey(key).split('/').map(encodeURIComponent).join('/')}`;
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds?: number;
    scope?: { workspaceId?: string; assetId?: string; versionId?: string };
  }): Promise<UploadTarget> {
    const ttl = clampTtl(input.ttlSeconds ?? this.uploadTtlSeconds);
    const url = await getSignedUrl(
      this.presignClient,
      new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(input.key), ContentType: input.contentType, ContentLength: input.maxBytes }),
      { expiresIn: ttl, signableHeaders: new Set(['content-type', 'content-length']) },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
      maxBytes: input.maxBytes,
    };
  }

  async createDownloadUrl(input: { key: string; ttlSeconds?: number; downloadFilename?: string }): Promise<DownloadTarget> {
    const ttl = clampTtl(input.ttlSeconds ?? this.downloadTtlSeconds);
    const disposition = input.downloadFilename === undefined
      ? {}
      : { ResponseContentDisposition: `attachment; filename="${input.downloadFilename.replace(/[^A-Za-z0-9._-]/g, '_')}"` };
    const url = await getSignedUrl(this.presignClient, new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(input.key), ...disposition }), { expiresIn: ttl });
    return { url, expiresAt: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  async probeObject(key: string): Promise<ObjectProbe> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return { exists: true, sizeBytes: Number(head.ContentLength ?? 0), contentType: head.ContentType ?? null };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, sizeBytes: 0, contentType: null };
      throw error;
    }
  }

  async readObjectPrefix(key: string, maxBytes: number): Promise<Uint8Array | null> {
    if (maxBytes <= 0) return (await this.probeObject(key)).exists ? new Uint8Array() : null;
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Range: `bytes=0-${String(maxBytes - 1)}` }));
      const bytes = response.Body === undefined ? new Uint8Array() : await response.Body.transformToByteArray();
      return bytes.length > maxBytes ? bytes.subarray(0, maxBytes) : bytes;
    } catch (error) {
      if (isNotFound(error)) return null;
      if (isInvalidRange(error)) return new Uint8Array(); // 空对象：没有可读的前缀
      throw error;
    }
  }

  /** 对象的可读流；不存在返回 null。 */
  private async openStream(key: string): Promise<Readable | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return (response.Body as Readable | undefined) ?? null;
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  private async requireStream(key: string): Promise<Readable> {
    const stream = await this.openStream(key);
    if (stream === null) throw new Error(`对象不存在：${key}`);
    return stream;
  }

  async computeObjectSha256(key: string): Promise<string | null> {
    const stream = await this.openStream(key);
    if (stream === null) return null;
    const hash = createHash('sha256');
    await pipeline(stream, hash);
    return hash.digest('hex');
  }

  async materializeObject(input: { key: string; destinationPath: string }): Promise<void> {
    await mkdir(dirname(input.destinationPath), { recursive: true });
    const partial = `${input.destinationPath}.partial`;
    try {
      await pipeline(await this.requireStream(input.key), createWriteStream(partial, { flags: 'w' }));
      await rename(partial, input.destinationPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async persistFile(input: { sourcePath: string; destinationKey: string; contentType: string }): Promise<void> {
    await new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.objectKey(input.destinationKey), Body: createReadStream(input.sourcePath), ContentType: input.contentType },
      partSize: UPLOAD_PART_BYTES,
      queueSize: UPLOAD_QUEUE,
    }).done();
  }

  /** 大分片在存储内部拷贝（不经手字节），所以不返回整文件校验和，由调用方另算。 */
  async composeObjects(input: { sourceKeys: string[]; destinationKey: string }): Promise<ComposedObject> {
    if (input.sourceKeys.length === 0) throw new Error('composeObjects 至少需要一个分片');
    const probes = await Promise.all(input.sourceKeys.map((key) => this.probeObject(key)));
    const missing = input.sourceKeys.find((_, index) => !probes[index]!.exists);
    if (missing !== undefined) throw new Error(`分片不存在：${missing}`);
    const sizes = probes.map((probe) => probe.sizeBytes);
    if (canComposeByPartCopy(sizes)) {
      await this.multipartCopy(input.destinationKey, null, input.sourceKeys.map((key) => ({ sourceKey: key, range: null })));
      return { checksumSha256: null };
    }
    // 小分片：流式读出各片再写入目标（lib-storage 分段上传，内存有界；失败时中止，不留半成品对象）
    const body = new PassThrough();
    const upload = new Upload({
      client: this.client,
      params: { Bucket: this.bucket, Key: this.objectKey(input.destinationKey), Body: body, ContentType: 'application/octet-stream' },
      partSize: UPLOAD_PART_BYTES,
      queueSize: UPLOAD_QUEUE,
    });
    const done = upload.done();
    try {
      for (const key of input.sourceKeys) await pipeline(await this.requireStream(key), body, { end: false });
      body.end();
      await done;
    } catch (error) {
      body.destroy(error as Error);
      await upload.abort().catch(() => undefined);
      await done.catch(() => undefined);
      throw error;
    }
    return { checksumSha256: null };
  }

  async copyObject(input: { sourceKey: string; destinationKey: string }): Promise<void> {
    const probe = await this.probeObject(input.sourceKey);
    if (!probe.exists) throw new Error(`对象不存在：${input.sourceKey}`);
    if (probe.sizeBytes <= S3_MAX_COPY_PART_BYTES) {
      await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, Key: this.objectKey(input.destinationKey), CopySource: this.copySource(input.sourceKey) }));
      return;
    }
    await this.multipartCopy(input.destinationKey, probe.contentType, copyRanges(probe.sizeBytes).map((range) => ({ sourceKey: input.sourceKey, range })));
  }

  /** 存储服务内的分段复制（对象在 Complete 之前不可见；任何一段失败即中止整个上传）。 */
  private async multipartCopy(destinationKey: string, contentType: string | null, parts: Array<{ sourceKey: string; range: { start: number; end: number } | null }>): Promise<void> {
    const key = this.objectKey(destinationKey);
    const created = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key, ContentType: contentType ?? 'application/octet-stream' }));
    const uploadId = created.UploadId;
    if (uploadId === undefined) throw new Error('存储服务没有返回分段上传编号');
    try {
      const completed: CompletedPart[] = [];
      for (const [index, part] of parts.entries()) {
        const copied = await this.client.send(new UploadPartCopyCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: index + 1,
          CopySource: this.copySource(part.sourceKey),
          ...(part.range !== null ? { CopySourceRange: `bytes=${String(part.range.start)}-${String(part.range.end)}` } : {}),
        }));
        completed.push({ PartNumber: index + 1, ETag: copied.CopyPartResult?.ETag });
      }
      await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: completed } }));
    } catch (error) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId: uploadId })).catch(() => undefined);
      throw error;
    }
  }

  async putObject(key: string, data: Uint8Array): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key), Body: data, ContentLength: data.byteLength }));
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
      return response.Body === undefined ? new Uint8Array() : await response.Body.transformToByteArray();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key) }));
  }
}
