import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';
import type { createDb } from '@ancs/db';
import type { DomainDeps } from '@ancs/domain';
import { MAINTENANCE_DISPATCH_JOB_TYPE, MAINTENANCE_RETENTION_JOB_TYPE, NOOP_JOB_TYPE } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { BullMqJobQueue } from '@ancs/providers-queue-bullmq';
import { createHttpResultFetcher } from './fetcher.js';

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

export function createDomainDeps(handle: ReturnType<typeof createDb>): DomainDeps {
  const storageSecret =
    process.env['ANCS_STORAGE_SECRET'] ??
    (process.env['BETTER_AUTH_SECRET'] !== undefined
      ? createHmac('sha256', process.env['BETTER_AUTH_SECRET']).update('storage-local-v1').digest('hex')
      : undefined);
  const deps: DomainDeps = { db: handle.db, retention: {}, resultFetcher: createHttpResultFetcher() };
  if (storageSecret !== undefined && storageSecret.length >= 16) {
    deps.storage = new LocalObjectStorage({
      rootDir: resolve(process.env['ANCS_STORAGE_LOCAL_DIR'] ?? '.storage'),
      publicBaseUrl: process.env['ANCS_STORAGE_PUBLIC_BASE_URL'] ?? 'http://localhost:3001',
      signingSecret: storageSecret,
    });
  }
  if (process.env['ANCS_QUEUE_DRIVER'] === 'bullmq') {
    const redisUrl = process.env['REDIS_URL'] ?? '';
    deps.queue = new BullMqJobQueue({ redisUrl });
  }
  return deps;
}

export const workerHandlerTypes = [NOOP_JOB_TYPE, MAINTENANCE_RETENTION_JOB_TYPE, MAINTENANCE_DISPATCH_JOB_TYPE] as const;
