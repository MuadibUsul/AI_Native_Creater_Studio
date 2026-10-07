import type { DomainDeps } from '@ancs/domain';
import {
  MAINTENANCE_DISPATCH_JOB_TYPE,
  MAINTENANCE_RETENTION_JOB_TYPE,
  NOOP_JOB_TYPE,
  runNotificationDispatch,
  runRetentionSweep,
} from '@ancs/domain';
import type { MotionValidator, RenderExecutor, RenderMediaProbe } from '@ancs/contracts';
import { createRenderExecutionHandler } from './render-handler.js';
import { createMotionGenerationHandler } from './motion-handler.js';
import { createRenderQaHandler } from './qa-handler.js';
import { cmsWritebackHandler } from './cms-writeback-handler.js';

/**
 * 任务处理器注册表（P03-01）。
 *
 * V1 已注册的处理器：
 * - NOOP：调度/恢复骨架的验证任务（测试与冒烟用，无副作用）；
 * - MAINTENANCE_RETENTION_SWEEP：保留清理（P02-05 的 runRetentionSweep，可重入）；
 * - MAINTENANCE_NOTIFICATION_DISPATCH：Outbox 通知派发（P02-06，可重入）；
 * - RENDER_FINAL：Final 合成（P07-04；执行器注入——生产 = 进程隔离 CLI，见 render-executor-process.ts）；
 * - MOTION_GENERATE：Custom Motion 生成（P07-02；验证器注入——生产 = 进程隔离 CLI，见 motion-validator-process.ts）；
 * - RENDER_QA：Final QA（P07-05；媒体探测注入——生产 = 进程隔离 CLI，见 media-probe-process.ts）。
 *
 * Provider 生成类任务（TTS/Avatar/AI Video 等）随 P03-06/P06 注册——**不在本任务触发真实 Provider 调用**。
 */

export interface JobHandlerContext {
  jobId: string;
  workspaceId: string;
  heartbeat: () => Promise<void>;
}

export interface JobHandler {
  type: string;
  description: string;
  /** 执行任务；返回值写入 job.result。抛错 → failJob（可重试性由错误类型决定）。 */
  handle(deps: DomainDeps, input: Record<string, unknown>, context: JobHandlerContext): Promise<Record<string, unknown>>;
  /**
   * 取消钩子（P03-02 协作式取消 / P03-07 取消失败场景）：
   * 返回 ok=false 时任务**保持 CANCEL_REQUESTED**（不假装已取消），由人工/对账介入。
   */
  onCancel?(deps: DomainDeps, input: Record<string, unknown>, context: JobHandlerContext): Promise<{ ok: boolean; reason?: string }>;
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

export interface DefaultRegistryOptions {
  /**
   * Final 合成执行器（P07-04）。生产装配传入进程隔离 CLI 执行器；
   * 不提供时 RENDER_FINAL 任务落入"未知类型 → FAILED_FINAL"（明确失败，不静默吞）。
   */
  renderExecutor?: RenderExecutor;
  /**
   * Custom Motion 验证器（P07-02）。生产装配传入进程隔离 CLI 验证器；
   * 不提供时 MOTION_GENERATE 任务落入"未知类型 → FAILED_FINAL"（明确失败，不静默吞）。
   */
  motionValidator?: MotionValidator;
  /**
   * 媒体探测（P07-05 QA）。生产装配传入进程隔离 CLI 探测；不提供时 RENDER_QA 任务落入
   * "未知类型 → FAILED_FINAL"（明确失败，不静默吞）。
   */
  mediaProbe?: RenderMediaProbe;
}

export function createDefaultRegistry(options: DefaultRegistryOptions = {}): JobHandlerRegistry {
  const handlers = [noopHandler, retentionSweepHandler, notificationDispatchHandler, cmsWritebackHandler];
  if (options.renderExecutor !== undefined) {
    handlers.push(createRenderExecutionHandler({ executor: options.renderExecutor }));
  }
  if (options.motionValidator !== undefined) {
    handlers.push(createMotionGenerationHandler({ validator: options.motionValidator }));
  }
  if (options.mediaProbe !== undefined) {
    handlers.push(createRenderQaHandler({ probe: options.mediaProbe }));
  }
  return new JobHandlerRegistry(handlers);
}
