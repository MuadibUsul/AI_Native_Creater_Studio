import { z } from 'zod';
import { providerCallbackSchema } from './results.js';

/**
 * 生成适配器契约（P03-07；规范 §30/§31、附录 A 的 Provider 差异由适配器吸收）。
 *
 * 真实 Provider 适配器（P06）与 **Mock Provider（本任务）** 实现同一接口——
 * CI 因此可以**确定性**重现：成功 / 慢任务 / 429 / 提交结果未知 / 重复回调 / 取消失败。
 */

export const PROVIDER_JOB_STATES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED'] as const;
export const providerJobStateSchema = z.enum(PROVIDER_JOB_STATES);
export type ProviderJobState = z.infer<typeof providerJobStateSchema>;

/** 提交请求（适配器把它翻译成 Provider 的具体 API；权威输入来自 Job.input，不来自消息体） */
export const generationSubmitRequestSchema = z.object({
  workspaceId: z.string().min(1),
  jobId: z.string().min(1),
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  operation: z.string().min(1).max(64),
  /** 生成指纹（§5.6；适配器可将其作为上游幂等键） */
  inputHash: z.string().min(1).max(128),
  /** 适配器所需的生成参数（provenance/prompt 等；不得含 Secret） */
  parameters: z.record(z.string(), z.unknown()).default({}),
});

export type GenerationSubmitRequest = z.infer<typeof generationSubmitRequestSchema>;

export interface GenerationSubmitResult {
  providerJobId: string;
  state: ProviderJobState;
}

export interface GenerationStatusResult {
  state: ProviderJobState;
  /** 终态成功时的结果描述（临时 URL；回收链路立即拉回自有存储） */
  results?: z.infer<typeof providerCallbackSchema>['results'];
  error?: Record<string, unknown> | null;
}

export interface GenerationCancelResult {
  ok: boolean;
  /** 取消失败原因（取消失败是**可重现**的故障场景：任务保持 CANCEL_REQUESTED 供人工介入） */
  reason?: string;
}

/**
 * 生成适配器（真实 Provider 与 Mock 共用）。
 * 所有方法接收 `secret`（由 P03-04 的凭据链路解析；适配器不得记录/外发）。
 */
export interface GenerationProvider {
  readonly providerId: string;
  submit(input: {
    secret: string;
    request: GenerationSubmitRequest;
  }): Promise<GenerationSubmitResult>;
  getStatus(input: { secret: string; providerJobId: string }): Promise<GenerationStatusResult>;
  cancel(input: { secret: string; providerJobId: string }): Promise<GenerationCancelResult>;
}

/** 429 / 限流错误（适配器抛出；上层据此进入退避重试而非终结失败） */
export class ProviderRateLimitedError extends Error {
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = 'ProviderRateLimitedError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 提交结果未知（网络中断/超时；上层必须标记对账，**不得**自动重复付费提交，§5.6） */
export class ProviderSubmissionUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderSubmissionUnknownError';
  }
}
