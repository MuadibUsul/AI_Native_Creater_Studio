import { randomUUID } from 'node:crypto';
import type { Job } from '@ancs/contracts';
import type { DomainDeps } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { jobs, outboxEvents } from '@ancs/db';
import { completeJob, failJob, heartbeatJob, transitionJob } from '@ancs/domain';
import type { JobHandlerRegistry } from './handlers.js';

/**
 * 任务执行器（P03-01/P03-02）：认领后的任务 → handler → 唯一状态迁移服务。
 *
 * - 未知任务类型 → FAILED_FINAL（明确结果，不静默吞）；
 * - handler 异常 → failJob（可重试性按尝试次数；退避与抖动由 failJob 计算）；
 * - 执行期间按心跳周期续租；续租失败（租约被回收）→ 不再上报结果（避免覆盖他人执行）；
 * - **取消协作**（P03-02）：心跳返回 CANCEL_REQUESTED 或完成前发现取消请求 → 收敛为 CANCELLED；
 * - **故障注入**（P03-02）：`onPhase` 钩子在关键阶段触发（CLI 通过 ANCS_WORKER_CRASH_AT 退出进程，
 *   测试注入抛错）——用于验证"各关键点杀 Worker 后可继续"。
 */

export type JobPhase = 'after-claim' | 'mid-handler' | 'before-complete';

export interface ExecuteOptions {
  workerId: string;
  leaseSeconds: number;
  heartbeatIntervalMs: number;
  /** 阶段钩子（故障注入）；抛错等价于 Worker 崩溃（不写终态，由租约回收恢复） */
  onPhase?: (phase: JobPhase) => void | Promise<void>;
}

class CancellationRequested extends Error {
  constructor() {
    super('CANCEL_REQUESTED');
    this.name = 'CancellationRequested';
  }
}

export async function executeJob(
  deps: DomainDeps,
  registry: JobHandlerRegistry,
  options: ExecuteOptions,
  job: Pick<Job, 'id' | 'workspaceId' | 'type' | 'input'>,
): Promise<'succeeded' | 'failed' | 'cancelled' | 'cancel_failed'> {
  const handler = registry.get(job.type);
  if (handler === undefined) {
    await failJob(deps, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      error: { reason: 'UNKNOWN_JOB_TYPE', type: job.type, registered: registry.types() },
      retryable: false,
    });
    return 'failed';
  }

  // 故障注入抛错 = 进程被杀（不得被 catch 吞掉、不得写终态）
  let crashing = false;
  const crash = async (phase: JobPhase): Promise<void> => {
    crashing = true;
    await options.onPhase?.(phase);
    crashing = false;
  };

  await crash('after-claim');

  let leaseLost: Error | null = null;
  let cancelRequested = false;
  const heartbeatTimer = setInterval(() => {
    void heartbeatJob(deps, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      workerId: options.workerId,
      leaseSeconds: options.leaseSeconds,
    })
      .then((beat) => {
        if (beat.status === 'CANCEL_REQUESTED') cancelRequested = true;
      })
      .catch((error: unknown) => {
        leaseLost = error instanceof Error ? error : new Error('lease lost');
      });
  }, options.heartbeatIntervalMs);

  try {
    const result = await handler.handle(deps, job.input, {
      jobId: job.id,
      workspaceId: job.workspaceId,
      heartbeat: async () => {
        const beat = await heartbeatJob(deps, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: options.workerId,
          leaseSeconds: options.leaseSeconds,
        });
        if (beat.status === 'CANCEL_REQUESTED') throw new CancellationRequested();
      },
    });
    await crash('mid-handler');
    if (cancelRequested) throw new CancellationRequested();
    if (leaseLost !== null) throw leaseLost;

    await crash('before-complete');
    // 复核：处理器可能已自行迁移（如"提交结果未知"→ FAILED_RETRYABLE + 对账标记）；
    // 仅在任务仍为 RUNNING 时执行完成迁移，避免覆盖处理器的权威结论。
    const fresh = await deps.db.select({ status: jobs.status }).from(jobs).where(eq(jobs.id, job.id)).limit(1);
    if (fresh[0]?.status === 'RUNNING') {
      await completeJob(deps, { workspaceId: job.workspaceId, jobId: job.id, result });
    }
    return 'succeeded';
  } catch (error) {
    if (crashing) throw error; // 注入的"崩溃"直接穿透（不写终态）
    if (error instanceof CancellationRequested) {
      // Provider 侧联动（若处理器支持）：取消失败 → 保持 CANCEL_REQUESTED 供人工介入（P03-07）
      if (handler.onCancel !== undefined) {
        const cancelResult = await handler
          .onCancel(deps, job.input, { jobId: job.id, workspaceId: job.workspaceId, heartbeat: async () => undefined })
          .catch((cancelError: unknown) => ({ ok: false, reason: cancelError instanceof Error ? cancelError.message : 'CANCEL_ERROR' }));
        if (!cancelResult.ok) {
          await deps.db
            .insert(outboxEvents)
            .values({
              id: `obx_${randomUUID()}`,
              workspaceId: job.workspaceId,
              type: 'job.cancel_failed',
              payload: { jobId: job.id, reason: cancelResult.reason ?? 'CANCEL_REJECTED', actorType: 'SYSTEM', actorId: null },
            })
            .catch(() => undefined);
          return 'cancel_failed'; // 任务保持 CANCEL_REQUESTED
        }
      }
      await transitionJob(deps, {
        workspaceId: job.workspaceId,
        jobId: job.id,
        to: 'CANCELLED',
        reason: 'WORKER_HONORED_CANCEL',
      }).catch(() => undefined);
      return 'cancelled';
    }
    const message = error instanceof Error ? error.message : String(error);
    await failJob(deps, { workspaceId: job.workspaceId, jobId: job.id, error: { reason: 'HANDLER_ERROR', message } }).catch(() => undefined);
    return 'failed';
  } finally {
    clearInterval(heartbeatTimer);
  }
}
