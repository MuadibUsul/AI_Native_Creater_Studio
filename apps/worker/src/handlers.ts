import type { DomainDeps } from '@ancs/domain';
import {
  MAINTENANCE_DISPATCH_JOB_TYPE,
  MAINTENANCE_RETENTION_JOB_TYPE,
  NOOP_JOB_TYPE,
  runNotificationDispatch,
  runRetentionSweep,
} from '@ancs/domain';

/**
 * 任务处理器注册表（P03-01）。
 *
 * V1 已注册的处理器：
 * - NOOP：调度/恢复骨架的验证任务（测试与冒烟用，无副作用）；
 * - MAINTENANCE_RETENTION_SWEEP：保留清理（P02-05 的 runRetentionSweep，可重入）；
 * - MAINTENANCE_NOTIFICATION_DISPATCH：Outbox 通知派发（P02-06，可重入）。
 *
 * Provider 生成类任务（TTS/Avatar/AI Video 等）随 P03-06/P06 注册——**不在本任务触发真实 Provider 调用**。
 */

export interface JobHandler {
  type: string;
  description: string;
  /** 执行任务；返回值写入 job.result。抛错 → failJob（可重试性由错误类型决定）。 */
  handle(deps: DomainDeps, input: Record<string, unknown>, context: { jobId: string; heartbeat: () => Promise<void> }): Promise<Record<string, unknown>>;
}

export class JobHandlerRegistry {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(handlers: JobHandler[] = []) {
    for (const handler of handlers) this.register(handler);
  }

  register(handler: JobHandler): void {
    if (this.handlers.has(handler.type)) throw new Error(`任务类型重复注册：${handler.type}`);
    this.handlers.set(handler.type, handler);
  }

  get(type: string): JobHandler | undefined {
    return this.handlers.get(type);
  }

  types(): string[] {
    return [...this.handlers.keys()];
  }
}

export const noopHandler: JobHandler = {
  type: NOOP_JOB_TYPE,
  description: '空操作任务（调度/恢复验证；无副作用）',
  async handle(_deps, input, context) {
    await context.heartbeat();
    return { ok: true, echo: input['echo'] ?? null };
  },
};

export const retentionSweepHandler: JobHandler = {
  type: MAINTENANCE_RETENTION_JOB_TYPE,
  description: '保留清理（Trash/TTL/过期意图/幂等键；可重入）',
  async handle(deps, _input, context) {
    await context.heartbeat();
    const report = await runRetentionSweep(deps, { limit: 100 });
    return { ...report };
  },
};

export const notificationDispatchHandler: JobHandler = {
  type: MAINTENANCE_DISPATCH_JOB_TYPE,
  description: 'Outbox 通知派发（可重入）',
  async handle(deps, _input, context) {
    await context.heartbeat();
    const report = await runNotificationDispatch(deps, { limit: 100 });
    return { ...report };
  },
};

export function createDefaultRegistry(): JobHandlerRegistry {
  return new JobHandlerRegistry([noopHandler, retentionSweepHandler, notificationDispatchHandler]);
}
