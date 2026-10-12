import type { DomainDeps, WorkflowRegistry } from '@ancs/domain';
import {
  MAINTENANCE_DISPATCH_JOB_TYPE,
  MAINTENANCE_RETENTION_JOB_TYPE,
  NOOP_JOB_TYPE,
  runNotificationDispatch,
  runRetentionSweep,
} from '@ancs/domain';
import type { MediaAudioAnalysisAdapter, MediaVisualAnalysisAdapter, MotionValidator, RenderExecutor, RenderMediaProbe, RenderPlanExecutor, SourceMediaIndexer, SourceMediaProbe, SourceMediaTranscoder, SpeechRecognitionAdapter } from '@ancs/contracts';
import { createRenderExecutionHandler } from './render-handler.js';
import { createMotionGenerationHandler } from './motion-handler.js';
import { createRenderQaHandler } from './qa-handler.js';
import { cmsWritebackHandler } from './cms-writeback-handler.js';
import { createAssetMediaProbeHandler } from './media-probe-handler.js';
import { createMediaProxyHandler } from './media-proxy-handler.js';
import { createMediaIndexHandler } from './media-index-handler.js';
import { createMediaTranscriptHandler } from './media-transcript-handler.js';
import { createMediaVisualAnalysisHandler } from './media-visual-analysis-handler.js';
import { createMediaAudioAnalysisHandler } from './media-audio-analysis-handler.js';
import { createWorkflowAdvanceHandler } from './workflow-handler.js';
import { createPreviewRenderHandler } from './preview-render-handler.js';

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
  /** 源素材能力探测（N02-02）；与 Final QA probe 分离，结果写回 AssetVersion。 */
  sourceMediaProbe?: SourceMediaProbe;
  /** 标准编辑代理转码（N02-03）；真实实现使用隔离 ffmpeg/ffprobe 子进程。 */
  sourceMediaTranscoder?: SourceMediaTranscoder;
  /** 源时间媒体索引（N02-04）；真实实现使用隔离 ffmpeg 子进程。 */
  sourceMediaIndexer?: SourceMediaIndexer;
  /** ASR 转写适配器；未配置时仍注册处理器并形成可见失败状态。 */
  speechRecognitionAdapter?: SpeechRecognitionAdapter;
  /** 源视频视觉分析适配器；未配置时仍形成可见失败，不编造检测结果。 */
  mediaVisualAnalysisAdapter?: MediaVisualAnalysisAdapter;
  /** 源音频事件与节拍分析适配器；未配置时形成可见失败且不修改原音。 */
  mediaAudioAnalysisAdapter?: MediaAudioAnalysisAdapter;
  /** 工作流定义（V5-M4）；提供时注册 WORKFLOW_ADVANCE 推进处理器。未提供则推进任务落入"未知类型"（明确失败）。 */
  workflowRegistry?: WorkflowRegistry;
  /** 低清预览（V6-1d）：与终渲染同一个 RenderPlan 后端；未提供则预览任务落入"未知类型"（明确失败）。 */
  previewExecutor?: { executor: RenderPlanExecutor; ffmpegPath?: string };
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
  if (options.sourceMediaProbe !== undefined) {
    handlers.push(createAssetMediaProbeHandler({ probe: options.sourceMediaProbe }));
  }
  if (options.sourceMediaTranscoder !== undefined) {
    handlers.push(createMediaProxyHandler({ transcoder: options.sourceMediaTranscoder }));
  }
  if (options.sourceMediaIndexer !== undefined) handlers.push(createMediaIndexHandler({ indexer: options.sourceMediaIndexer }));
  handlers.push(createMediaTranscriptHandler({ adapter: options.speechRecognitionAdapter }));
  handlers.push(createMediaVisualAnalysisHandler({ adapter: options.mediaVisualAnalysisAdapter }));
  handlers.push(createMediaAudioAnalysisHandler({ adapter: options.mediaAudioAnalysisAdapter }));
  if (options.workflowRegistry !== undefined) handlers.push(createWorkflowAdvanceHandler({ registry: options.workflowRegistry }));
  if (options.previewExecutor !== undefined) handlers.push(createPreviewRenderHandler(options.previewExecutor));
  return new JobHandlerRegistry(handlers);
}
