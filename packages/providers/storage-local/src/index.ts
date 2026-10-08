import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { finished, pipeline } from 'node:stream/promises';
import {
  DOWNLOAD_URL_TTL_SECONDS,
  UPLOAD_URL_TTL_SECONDS,
  type DownloadTarget,
  type ObjectProbe,
  type ObjectStorageAdapter,
  type UploadTarget,
} from '@ancs/contracts';

/**
 * 本地文件系统对象存储（P02-04）。
 *
 * 用途：开发与测试环境的**真实**存储适配器（真实写盘、真实探测、真实校验和），
 * 使上传/确认/去重/授权作用域可在无云凭据下完成端到端验证（计划 §13.5 第 8 条）。
 *
 * 说明（诚实记录）：
 * - 生产使用 S3/R2 预签名 URL 让客户端**直传**；本地端点会经 API 进程转发字节，
 *   因此本地模式限制单文件大小（maxBytes），不用于大文件（§26.1 的约束由云适配器满足）；
 * - Signed URL 以 HMAC 签名，负载含 purpose/key/workspaceId/assetId/versionId/exp，
 *   由 API 端点校验（作用域 + TTL）——客户端永不持有存储凭据（§75）。
 */

const TOKEN_VERSION = 1;

export interface LocalStorageOptions {
  /** 文件根目录（自动创建） */
  rootDir: string;
  /** 本服务对外基址（生成上传/下载 URL；如 http://127.0.0.1:3000） */
  publicBaseUrl: string;
  /** HMAC 密钥（服务端持有；长度 ≥16） */
  signingSecret: string;
  uploadTtlSeconds?: number;
  downloadTtlSeconds?: number;
  /** 本地端点允许的单次上传上限（默认 64 MiB） */
  maxLocalUploadBytes?: number;
}

export interface LocalSignedToken {
  v: number;
  purpose: 'upload' | 'download';
  key: string;
  workspaceId: string;
  assetId: string;
  versionId: string;
  /** epoch 秒 */
  exp: number;
  maxBytes?: number;
  downloadFilename?: string;
}

export const DEFAULT_MAX_LOCAL_UPLOAD_BYTES = 64 * 1024 * 1024;

const base64url = (input: Buffer | string): string =>
  (typeof input === 'string' ? Buffer.from(input, 'utf8') : input).toString('base64url');

export class LocalObjectStorage implements ObjectStorageAdapter {
  readonly kind = 'local';
  private readonly rootDir: string;
  /** 对外基址（生成 Signed URL；集成测试在 listen 后回填实际端口） */
  publicBaseUrl: string;
  private readonly signingSecret: string;
  private readonly uploadTtlSeconds: number;
  private readonly downloadTtlSeconds: number;
  readonly maxLocalUploadBytes: number;

  constructor(options: LocalStorageOptions) {
    if (options.signingSecret.length < 16) {
      throw new Error('本地存储签名密钥过短（≥16）');
    }
    this.rootDir = resolve(options.rootDir);
    this.publicBaseUrl = options.publicBaseUrl.replace(/\/+$/, '');
    this.signingSecret = options.signingSecret;
    this.uploadTtlSeconds = options.uploadTtlSeconds ?? UPLOAD_URL_TTL_SECONDS;
    this.downloadTtlSeconds = options.downloadTtlSeconds ?? DOWNLOAD_URL_TTL_SECONDS;
    this.maxLocalUploadBytes = options.maxLocalUploadBytes ?? DEFAULT_MAX_LOCAL_UPLOAD_BYTES;
  }

  /** 对象键 → 绝对路径（防路径穿越，双保险）。 */
  resolveKeyPath(key: string): string {
    if (key.includes('\0')) throw new Error('storage key 含非法字符');
    if (key.startsWith('/') || key.startsWith('\\')) throw new Error(`storage key 不得为绝对路径：${key}`);
    if (key.split('/').includes('..')) throw new Error(`storage key 不得包含 ..：${key}`);
    const absolute = resolve(join(this.rootDir, key));
    if (absolute !== this.rootDir && !absolute.startsWith(this.rootDir + sep)) {
      throw new Error(`storage key 越界：${key}`);
    }
    return absolute;
  }

  private sign(payload: LocalSignedToken): string {
    const body = base64url(JSON.stringify(payload));
    const signature = base64url(createHmac('sha256', this.signingSecret).update(body).digest());
    return `${body}.${signature}`;
  }

  /** 校验签名 / 用途 / 有效期；任何不满足返回 null（路由层统一 403/410）。 */
  verifyToken(token: string, purpose: 'upload' | 'download'): LocalSignedToken | null {
    const separator = token.lastIndexOf('.');
    if (separator <= 0) return null;
    const body = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    const expected = base64url(createHmac('sha256', this.signingSecret).update(body).digest());
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) return null;
    let payload: LocalSignedToken;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LocalSignedToken;
    } catch {
      return null;
    }
    if (payload.v !== TOKEN_VERSION) return null;
    if (payload.purpose !== purpose) return null;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    if (typeof payload.key !== 'string' || payload.key.length === 0) return null;
    return payload;
  }

  private signToken(payload: Omit<LocalSignedToken, 'v' | 'exp'>, ttlSeconds: number): { token: string; expiresAt: Date } {
    const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
    const token = this.sign({ v: TOKEN_VERSION, ...payload, exp });
    return { token, expiresAt: new Date(exp * 1000) };
  }

  async createUploadTarget(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds?: number;
    scope?: { workspaceId?: string; assetId?: string; versionId?: string };
  }): Promise<UploadTarget> {
    const ttl = input.ttlSeconds ?? this.uploadTtlSeconds;
    const { token, expiresAt } = this.signToken(
      {
        purpose: 'upload',
        key: input.key,
        workspaceId: input.scope?.workspaceId ?? '',
        assetId: input.scope?.assetId ?? '',
        versionId: input.scope?.versionId ?? '',
        maxBytes: input.maxBytes,
      },
      ttl,
    );
    return {
      url: `${this.publicBaseUrl}/api/v1/storage/upload?token=${token}`,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: expiresAt.toISOString(),
      maxBytes: input.maxBytes,
    };
  }

  async createDownloadUrl(input: { key: string; ttlSeconds?: number; downloadFilename?: string }): Promise<DownloadTarget> {
    const ttl = input.ttlSeconds ?? this.downloadTtlSeconds;
    const { token, expiresAt } = this.signToken(
      {
        purpose: 'download',
        key: input.key,
        workspaceId: '',
        assetId: '',
        versionId: '',
        downloadFilename: input.downloadFilename,
      },
      ttl,
    );
    return {
      url: `${this.publicBaseUrl}/api/v1/storage/download?token=${token}`,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async probeObject(key: string): Promise<ObjectProbe> {
    try {
      const info = await stat(this.resolveKeyPath(key));
      if (!info.isFile()) return { exists: false, sizeBytes: 0, contentType: null };
      return { exists: true, sizeBytes: info.size, contentType: null };
    } catch {
      return { exists: false, sizeBytes: 0, contentType: null };
    }
  }

  async readObjectPrefix(key: string, maxBytes: number): Promise<Uint8Array | null> {
    let handle;
    try {
      handle = await open(this.resolveKeyPath(key), 'r');
      const buffer = Buffer.alloc(maxBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async computeObjectSha256(key: string): Promise<string | null> {
    const path = this.resolveKeyPath(key);
    try {
      await stat(path);
    } catch {
      return null;
    }
    const hash = createHash('sha256');
    await pipeline(createReadStream(path), hash);
    return hash.digest('hex');
  }

  async materializeObject(input: { key: string; destinationPath: string }): Promise<void> {
    await mkdir(dirname(input.destinationPath), { recursive: true });
    const partial = `${input.destinationPath}.partial`;
    try {
      await pipeline(createReadStream(this.resolveKeyPath(input.key)), createWriteStream(partial, { flags: 'w' }));
      await rename(partial, input.destinationPath);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async persistFile(input: { sourcePath: string; destinationKey: string; contentType: string }): Promise<void> {
    const destination = this.resolveKeyPath(input.destinationKey);
    await mkdir(dirname(destination), { recursive: true });
    const partial = `${destination}.partial`;
    try {
      await pipeline(createReadStream(input.sourcePath), createWriteStream(partial, { flags: 'w' }));
      await rename(partial, destination);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }

  async composeObjects(input: { sourceKeys: string[]; destinationKey: string }): Promise<void> {
    if (input.sourceKeys.length === 0) throw new Error('composeObjects 至少需要一个分片');
    const destination = this.resolveKeyPath(input.destinationKey);
    const partial = `${destination}.partial`;
    await mkdir(dirname(destination), { recursive: true });
    const output = createWriteStream(partial, { flags: 'w' });
    try {
      for (const key of input.sourceKeys) {
        await pipeline(createReadStream(this.resolveKeyPath(key)), output, { end: false });
      }
      output.end();
      await finished(output);
      await rename(partial, destination);
    } catch (error) {
      output.destroy();
      await rm(partial, { force: true });
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await rm(this.resolveKeyPath(key), { force: true });
  }

  /** 服务端写入（先写 .partial 再原子改名：未完成的写入不会被探测为完整对象）。 */
  async putObject(key: string, data: Uint8Array): Promise<void> {
    const path = this.resolveKeyPath(key);
    await mkdir(dirname(path), { recursive: true });
    const partialPath = `${path}.partial`;
    await writeFile(partialPath, data);
    await rename(partialPath, path);
  }

  /** 端点写入别名（路由层使用；语义同 putObject） */
  async writeObject(key: string, data: Uint8Array): Promise<void> {
    await this.putObject(key, data);
  }

  /** 契约方法（P06-03）：读取完整对象；不存在返回 null */
  async getObject(key: string): Promise<Uint8Array | null> {
    return this.readObject(key);
  }

  async readObject(key: string): Promise<Uint8Array | null> {
    try {
      const handle = await open(this.resolveKeyPath(key), 'r');
      try {
        const info = await handle.stat();
        const buffer = Buffer.alloc(Number(info.size));
        await handle.read(buffer, 0, buffer.length, 0);
        return new Uint8Array(buffer);
      } finally {
        await handle.close().catch(() => undefined);
      }
    } catch {
      return null;
    }
  }
}
