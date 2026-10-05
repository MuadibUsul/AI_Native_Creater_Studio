import type { MalwareScanner, ObjectStorageAdapter } from '@ancs/contracts';

/**
 * 存储依赖注入（P02-04；P09-05 增补上传扫描 seam）。
 *
 * - 适配器接口在 contracts（domain 只依赖接口；apps/api 依赖 providers/*，计划 §3.4/R7）；
 * - 本地驱动（LocalObjectStorage）额外暴露 **端点侧方法**（签名校验/读写对象），
 *   用于 /api/v1/storage/* 的 Signed URL 端点——生产使用 S3/R2 预签名 URL，无这些端点；
 * - **上传扫描**（§43.3）：`scanner` 在写入前扫描原始字节；检出 INFECTED → 拒绝落盘（422）
 *   并经 `auditSink` 记录 `upload.malware_rejected`（审计表）。真实引擎为 seam 替换实现（BLOCKED：部署决策）。
 */

export interface LocalStorageEndpointCapability {
  verifyToken(token: string, purpose: 'upload' | 'download'): {
    key: string;
    workspaceId: string;
    assetId: string;
    versionId: string;
    exp: number;
    maxBytes?: number;
    downloadFilename?: string;
  } | null;
  writeObject(key: string, data: Uint8Array): Promise<void>;
  readObject(key: string): Promise<Uint8Array | null>;
  readonly maxLocalUploadBytes: number;
}

/** 上传被拒的审计回调（apps/api 装配注入 recordAudit；不经审计的测试可省略） */
export type UploadRejectionAuditSink = (entry: {
  action: 'upload.malware_rejected';
  workspaceId: string | null;
  key: string;
  filename: string;
  contentType: string;
  findings: { code: string; message: string }[];
  scanner: string;
}) => Promise<void>;

export interface StorageDeps {
  adapter: ObjectStorageAdapter;
  /** 仅当适配器为本地驱动时提供（/api/v1/storage/* 端点） */
  local?: LocalStorageEndpointCapability;
  /** 上传扫描器（P09-05；未配置 = 不扫描——部署须显式装配） */
  scanner?: MalwareScanner;
  /** 检出时的审计回调（P09-05） */
  auditSink?: UploadRejectionAuditSink;
}

/** 构建打包的存储依赖（apps/api 启动时调用；测试可注入临时目录与扫描器） */
export function createStorageDeps(
  adapter: ObjectStorageAdapter,
  options: { scanner?: MalwareScanner; auditSink?: UploadRejectionAuditSink } = {},
): StorageDeps {
  const candidate = adapter as unknown as Partial<LocalStorageEndpointCapability> & { kind?: string };
  const isLocal =
    candidate.kind === 'local' &&
    typeof candidate.verifyToken === 'function' &&
    typeof candidate.writeObject === 'function' &&
    typeof candidate.readObject === 'function';
  return {
    adapter,
    ...(isLocal ? { local: candidate as LocalStorageEndpointCapability } : {}),
    ...(options.scanner !== undefined ? { scanner: options.scanner } : {}),
    ...(options.auditSink !== undefined ? { auditSink: options.auditSink } : {}),
  };
}
