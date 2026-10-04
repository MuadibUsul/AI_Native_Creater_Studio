import type { Job } from '@ancs/contracts';
import type { DomainDeps } from '@ancs/domain';
import { completeJob, failJob, heartbeatJob } from '@ancs/domain';
import type { JobHandlerRegistry } from './handlers.js';

/**
 * 任务执行器（P03-01）：认领后的任务 → handler → 唯一状态迁移服务。
 * 未知任务类型 → FAILED_FINAL（明确结果，不静默吞）；handler 异常 → failJob（可重试性按尝试次数）。
 * 执行期间按心跳周期续租；续租失败（租约被回收）视为执行失败，不再上报结果（避免覆盖他人执行）。
 */
export async function executeJob(
  deps: DomainDeps,
  registry: JobHandlerRegistry,
  options: { workerId: string; leaseSeconds: number; heartbeatIntervalMs: number },
  job: Pick<Job, 'id' | 'workspaceId' | 'type' | 'input'>,
): Promise<'succeeded' | 'failed'> {
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

  let leaseLost: Error | null = null;
  const heartbeatTimer = setInterval(() => {
    void heartbeatJob(deps, {
      workspaceId: job.workspaceId,
      jobId: job.id,
      workerId: options.workerId,
      leaseSeconds: options.leaseSeconds,
    }).catch((error: unknown) => {
      leaseLost = error instanceof Error ? error : new Error('lease lost');
    });
  }, options.heartbeatIntervalMs);

  try {
    const result = await handler.handle(deps, job.input, {
      jobId: job.id,
      heartbeat: async () => {
        await heartbeatJob(deps, {
          workspaceId: job.workspaceId,
          jobId: job.id,
          workerId: options.workerId,
          leaseSeconds: options.leaseSeconds,
        });
      },
    });
    if (leaseLost !== null) throw leaseLost;
    await completeJob(deps, { workspaceId: job.workspaceId, jobId: job.id, result });
    return 'succeeded';
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await failJob(deps, { workspaceId: job.workspaceId, jobId: job.id, error: { reason: 'HANDLER_ERROR', message } }).catch(() => undefined);
    return 'failed';
  } finally {
    clearInterval(heartbeatTimer);
  }
}
