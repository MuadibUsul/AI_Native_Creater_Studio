import { z } from 'zod';

/**
 * 对象存储适配器契约（P02-04 / 规范 §26、§51；计划 §3.4：providers → contracts/domain）。
 *
 * 关键约束（§75）：
 * - 数据库只存 storage_key，不把 Object URL 作为永久标识；
 * - Signed URL 一律带**作用域**（用途/对象键/工作区）与 TTL（上传 15 分钟、下载 15 分钟，上限 1 小时）；
 * - 客户端与前端不得持有 Provider/存储凭据（API 侧签发，本契约只暴露结果 URL）。
 */

export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
export const MAX_SIGNED_URL_TTL_SECONDS = 60 * 60;

export const signedUrlPurposeSchema = z.enum(['upload', 'download']);
export type SignedUrlPurpose = z.infer<typeof signedUrlPurposeSchema>;

export const uploadTargetSchema = z.object({
  url: z.string().min(1),
  method: z.literal('PUT'),
  headers: z.record(z.string(), z.string()).default({}),
  expiresAt: z.string().min(1),
  /** 客户端可上传的最大字节数（服务端也会按意图声明的 sizeBytes 校验） */
  maxBytes: z.number().int().positive(),
});

export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export const downloadTargetSchema = z.object({
  url: z.string().min(1),
  expiresAt: z.string().min(1),
});

export type DownloadTarget = z.infer<typeof downloadTargetSchema>;

export const objectProbeSchema = z.object({
  exists: z.boolean(),
  sizeBytes: z.number().int().nonnegative(),
  contentType: z.string().nullable().default(null),
});

export type ObjectProbe = z.infer<typeof objectProbeSchema>;

/**
 * 存储适配器（本地开发实现见 packages/providers/storage-local；S3/R2 实现在真实凭据阶段接入）。
 * 服务层只依赖本接口（domain 不得依赖 providers/*，计划 §3.4）。
 */
export interface ObjectStorageAdapter {
  /** 'local' | 's3' | 'r2'（本地端点仅开发/测试使用） */
  readonly kind: string;
  createUploadTarget(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    ttlSeconds?: number;
    /** 作用域信息（实现可将其编入签名负载，供端点侧审计/纵深防御） */
    scope?: { workspaceId?: string; assetId?: string; versionId?: string };
  }): Promise<UploadTarget>;
  createDownloadUrl(input: { key: string; ttlSeconds?: number; downloadFilename?: string }): Promise<DownloadTarget>;
  /** 对象是否存在与大小（HEAD 语义） */
  probeObject(key: string): Promise<ObjectProbe>;
  /** 读取对象前 N 字节（内容嗅探用） */
  readObjectPrefix(key: string, maxBytes: number): Promise<Uint8Array | null>;
  /** 对象 SHA-256（十六进制小写）；对象不存在返回 null */
  computeObjectSha256(key: string): Promise<string | null>;
  /**
   * 将对象以流式方式物化到 Worker 的临时文件。媒体探测与转码使用此 seam，避免
   * `getObject()` 把数 GiB 原件一次读入内存。实现不得暴露底层永久路径。
   */
  materializeObject?(input: { key: string; destinationPath: string }): Promise<void>;
  /**
   * 将 Worker 产生的本地文件流式写回对象存储。实现必须先写临时对象再原子发布，
   * 不得将完整代理或渲染产物一次读入内存。
   */
  persistFile?(input: { sourcePath: string; destinationKey: string; contentType: string }): Promise<void>;
  /**
   * 将同一上传意图的分片按给定顺序合成为最终对象。实现必须流式复制，不能把所有分片
   * 同时读入内存；目标写入失败时不得暴露半成品对象。
   */
  composeObjects?(input: { sourceKeys: string[]; destinationKey: string }): Promise<void>;
  /**
   * 服务端写入对象（结果回收 / 渲染产物落库；§75 第 5 条：结果必须落在自有存储）。
   * 客户端上传走 Signed URL（createUploadTarget），不使用本方法。
   */
  putObject(key: string, data: Uint8Array): Promise<void>;
  /** 读取完整对象（P06-03：分段音频复用/拼接）；不存在返回 null */
  getObject(key: string): Promise<Uint8Array | null>;
  deleteObject(key: string): Promise<void>;
}

/** 存储对象键：只允许安全字符与目录层级（防路径穿越）。 */
export const storageKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._\-/]+$/, 'storage key 仅允许字母、数字、._-/')
  .refine((key) => !key.startsWith('/') && !key.includes('..'), 'storage key 不得为绝对路径或包含 ..');
