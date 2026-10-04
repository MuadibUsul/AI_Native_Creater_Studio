import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 任务契约（P03-01 / 计划 §5.5；规范 §35 的 Jobs 约定）。
 *
 * 权威状态在数据库（WAITING_DEPENDENCY → QUEUED → RUNNING → PROVIDER_QUEUED → SUCCEEDED /
 * FAILED_RETRYABLE / FAILED_FINAL；取消路径 CANCEL_REQUESTED → CANCELLED）；
 * 队列消息只携带任务 ID（规则见计划 §5.5）。
 */

/**
 * 生成任务类型（P06-05；API 侧"显式生成动作"与 Worker 生成处理器共用同一常量，
 * 避免跨应用复制字符串——跨包字符串漂移会导致任务永不执行）。
 */
export const GENERATE_JOB_TYPE = 'GENERATE';

/**
 * Final 合成任务类型（P07-04）：消费 Render 快照（P07-03）执行 Remotion 服务端渲染。
 * 与 GENERATE 同理：API/domain 入队与 Worker 处理器共用同一常量（跨包字符串漂移会导致任务永不执行）。
 */
export const RENDER_FINAL_JOB_TYPE = 'RENDER_FINAL';

/**
 * Custom Motion 生成任务类型（P07-02）：LLM 生成 → 四道门禁（静态分析/类型检查/沙箱评估/抽帧）
 * → 仅通过时版本化落库。与 GENERATE/RENDER_FINAL 同理：入队方与处理器共用同一常量。
 */
export const MOTION_GENERATE_JOB_TYPE = 'MOTION_GENERATE';

/**
 * Final QA 任务类型（P07-05）：渲染完成（QA 状态）后自动入队；技术/内容检查 → READY/FAILED。
 */
export const RENDER_QA_JOB_TYPE = 'RENDER_QA';

export const JOB_STATUSES = [
  'WAITING_DEPENDENCY',
  'QUEUED',
  'RUNNING',
  'PROVIDER_QUEUED',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_FINAL',
  'CANCEL_REQUESTED',
  'CANCELLED',
] as const;

export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** 终态：不再迁移（除人工 retry） */
export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = ['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED'];

export const JOB_SUBMIT_STATES = ['NOT_SUBMITTED', 'SUBMITTED', 'SUBMISSION_UNKNOWN'] as const;
export const jobSubmitStateSchema = z.enum(JOB_SUBMIT_STATES);
export type JobSubmitState = z.infer<typeof jobSubmitStateSchema>;

/** 执行阶段（不强制枚举；示例：PREPARE / SUBMIT / POLL / DOWNLOAD / FINALIZE） */
export const jobStageSchema = z.string().min(1).max(64);

export const jobSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema.nullable().default(null),
  type: z.string().min(1).max(120),
  status: jobStatusSchema,
  stage: jobStageSchema.nullable().default(null),
  submitState: jobSubmitStateSchema,
  /** 权威输入的摘要（完整输入仅在服务端；客户端只看到可见字段） */
  input: z.record(z.string(), z.unknown()).default({}),
  result: z.record(z.string(), z.unknown()).nullable().default(null),
  error: z.record(z.string(), z.unknown()).nullable().default(null),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  priority: z.number().int(),
  needsReconciliation: z.boolean().default(false),
  /** 退避：最早可再次认领时间（FAILED_RETRYABLE 时非空） */
  nextAttemptAt: isoDateTimeSchema.nullable().default(null),
  enqueuedAt: isoDateTimeSchema.nullable().default(null),
  startedAt: isoDateTimeSchema.nullable().default(null),
  completedAt: isoDateTimeSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type Job = z.infer<typeof jobSchema>;

/** 队列消息（计划 §5.5：只携带任务 ID 与必要路由信息） */
export const jobQueueMessageSchema = z.object({
  jobId: opaqueIdSchema,
  /** 路由用（队列名；Worker 按类型/优先级分组消费） */
  queue: z.string().min(1).max(64),
  /** 尝试序号（幂等投递用；不代表权威状态） */
  attempt: z.number().int().nonnegative(),
});

export type JobQueueMessage = z.infer<typeof jobQueueMessageSchema>;

/**
 * 队列适配器（V1：DB 权威轮询为默认实现；BullMQ/Redis 适配器见 packages/providers/queue-bullmq）。
 * 投递只影响"及时性"，不影响正确性：消息丢失时由回收扫描重新入队（不丢任务）。
 */
export interface JobQueueAdapter {
  readonly kind: string;
  enqueue(message: JobQueueMessage): Promise<void>;
  /** 消费拉取（可选：BullMQ 由 Worker 事件驱动；DB 轮询实现返回 null） */
  pull?(queue: string, limit: number): Promise<JobQueueMessage[]>;
  close?(): Promise<void>;
}

/** 默认队列名：按任务类型路由（如 PROJECT_MAINTENANCE → 'maintenance'） */
export const DEFAULT_QUEUE = 'default';
export const MAINTENANCE_QUEUE = 'maintenance';
