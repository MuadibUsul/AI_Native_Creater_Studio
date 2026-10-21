import type { createDb } from '@ancs/db';
import type { DomainDeps } from '@ancs/domain';
import { MAINTENANCE_DISPATCH_JOB_TYPE, MAINTENANCE_RETENTION_JOB_TYPE, NOOP_JOB_TYPE } from '@ancs/domain';
import type { WorkerEnv } from '@ancs/contracts';
import { CMS_WRITEBACK_JOB_TYPE, MEDIA_AUDIO_ANALYSIS_JOB_TYPE, MEDIA_INDEX_JOB_TYPE, MEDIA_PROBE_JOB_TYPE, MEDIA_PROXY_JOB_TYPE, MEDIA_TRANSCRIPT_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_JOB_TYPE, MOTION_GENERATE_JOB_TYPE, RENDER_FINAL_JOB_TYPE, RENDER_QA_JOB_TYPE } from '@ancs/contracts';
import { LocalObjectStorage, localStorageOptionsFromEnv } from '@ancs/providers-storage-local';
import { S3ObjectStorage, s3StorageOptionsFromEnv } from '@ancs/providers-storage-s3';
import { BullMqJobQueue } from '@ancs/providers-queue-bullmq';
import { createHttpResultFetcher } from './fetcher.js';
import { createCredentialVaultFromEnv } from '@ancs/providers-credential-vault-local';
import { createHttpCmsWritebackSender } from './cms-writeback-sender.js';

/**
 * Worker 进程（P03-01 / 计划 §5.5）。
 *
 * 循环（每次 tick）：
 *   1. 维护：租约回收（Worker 崩溃恢复）→ Outbox 派发（投递中断可恢复）；
 *   2. 认领一个 QUEUED 任务（SKIP LOCKED 原子认领，设置租约）；
 *   3. 执行 handler（执行期间按心跳周期续租）；完成/失败经**唯一状态迁移服务**落库。
 *
 * 说明：
 * - 权威输入来自数据库（消息只携带任务 ID）；Worker 崩溃后由租约回收恢复；
 * - `ANCS_QUEUE_DRIVER=bullmq`（需 REDIS_URL）时启用心跳派发到 Redis；缺省 `db` 轮询；
 * - 任务类型处理器在 `handlers.ts` 注册；未知类型 → FAILED_FINAL（明确结果，不静默吞）。
 */

export interface WorkerRunOptions {
  workerId?: string;
  once?: boolean;
  tickIntervalMs?: number;
  heartbeatIntervalMs?: number;
  leaseSeconds?: number;
  /** 单次 tick 最多执行的任务数（once 模式用于测试） */
  maxJobsPerTick?: number;
}

/**
 * 由**已校验**的 Worker 配置装配领域依赖（不再读取原始 process.env）。
 * 存储签名规则与 API、清理 CLI 共用 `localStorageOptionsFromEnv`：同一把密钥、同一公开基址；
 * 密钥过短在启动期由 env schema 拒绝，而不是静默不装配存储。
 */
export function createDomainDeps(handle: ReturnType<typeof createDb>, config: WorkerEnv): DomainDeps {
  const deps: DomainDeps = {
    db: handle.db,
    retention: {},
    resultFetcher: createHttpResultFetcher(),
    credentials: createCredentialVaultFromEnv({
      NODE_ENV: config.NODE_ENV,
      BETTER_AUTH_SECRET: config.BETTER_AUTH_SECRET,
      ANCS_CREDENTIAL_KEYS: config.ANCS_CREDENTIAL_KEYS,
    }),
    cmsWritebackSender: createHttpCmsWritebackSender(),
    // 与 API 同一个驱动与桶：s3 时物化 / 写回直接走对象存储，Worker 不需要共享磁盘卷
    storage: config.ANCS_STORAGE_DRIVER === 's3' ? new S3ObjectStorage(s3StorageOptionsFromEnv(config)) : new LocalObjectStorage(localStorageOptionsFromEnv(config)),
  };
  if (config.ANCS_QUEUE_DRIVER === 'bullmq' && config.REDIS_URL !== undefined) {
    deps.queue = new BullMqJobQueue({ redisUrl: config.REDIS_URL });
  }
  return deps;
}

export const workerHandlerTypes = [NOOP_JOB_TYPE, MAINTENANCE_RETENTION_JOB_TYPE, MAINTENANCE_DISPATCH_JOB_TYPE, RENDER_FINAL_JOB_TYPE, MOTION_GENERATE_JOB_TYPE, RENDER_QA_JOB_TYPE, MEDIA_PROBE_JOB_TYPE, MEDIA_PROXY_JOB_TYPE, MEDIA_INDEX_JOB_TYPE, MEDIA_TRANSCRIPT_JOB_TYPE, MEDIA_VISUAL_ANALYSIS_JOB_TYPE, MEDIA_AUDIO_ANALYSIS_JOB_TYPE, CMS_WRITEBACK_JOB_TYPE] as const;
