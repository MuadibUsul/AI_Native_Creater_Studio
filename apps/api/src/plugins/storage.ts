import type { ObjectStorageAdapter } from '@ancs/contracts';

/**
 * 存储依赖注入（P02-04）。
 *
 * - 适配器接口在 contracts（domain 只依赖接口；apps/api 依赖 providers/*，计划 §3.4/R7）；
 * - 本地驱动（LocalObjectStorage）额外暴露 **端点侧方法**（签名校验/读写对象），
 *   用于 /api/v1/storage/* 的 Signed URL 端点——生产使用 S3/R2 预签名 URL，无这些端点。
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

export interface StorageDeps {
  adapter: ObjectStorageAdapter;
  /** 仅当适配器为本地驱动时提供（/api/v1/storage/* 端点） */
  local?: LocalStorageEndpointCapability;
}

/** 构建打包的存储依赖（apps/api 启动时调用；测试可注入临时目录） */
export function createStorageDeps(adapter: ObjectStorageAdapter): StorageDeps {
  const candidate = adapter as unknown as Partial<LocalStorageEndpointCapability> & { kind?: string };
  const isLocal =
    candidate.kind === 'local' &&
    typeof candidate.verifyToken === 'function' &&
    typeof candidate.writeObject === 'function' &&
    typeof candidate.readObject === 'function';
  return {
    adapter,
    ...(isLocal ? { local: candidate as LocalStorageEndpointCapability } : {}),
  };
}
