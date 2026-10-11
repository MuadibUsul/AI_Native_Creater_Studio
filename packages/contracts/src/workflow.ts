import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { finalRenderProfileSchema } from './render-plan.js';

/**
 * V5-M4（§11.1）：工作流引擎契约。
 *
 * 一次长流程 = 一个 `workflow_run`；每个步骤的每次尝试 = 一行 `workflow_step`（可审计、可恢复）。
 * 执行载体是既有任务表（任务类型 `WORKFLOW_ADVANCE`，租约/心跳/退避沿用）；同一运行任一时刻只有一个推进任务有效。
 * 步骤失败按错误分类处理：可重试 → 退避后新尝试；不可重试 → 运行失败并按逆序补偿已成功步骤；需人工 → 等待人工门。
 */

export const WORKFLOW_ADVANCE_JOB_TYPE = 'WORKFLOW_ADVANCE';

export const WORKFLOW_RUN_STATUSES = ['RUNNING', 'WAITING_HUMAN', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED'] as const;
export const workflowRunStatusSchema = z.enum(WORKFLOW_RUN_STATUSES);
export type WorkflowRunStatus = z.infer<typeof workflowRunStatusSchema>;
export const WORKFLOW_TERMINAL_STATUSES: readonly WorkflowRunStatus[] = ['SUCCEEDED', 'FAILED', 'CANCELLED'];

export const WORKFLOW_STEP_STATUSES = ['RUNNING', 'SUCCEEDED', 'FAILED', 'WAITING_HUMAN'] as const;
export const workflowStepStatusSchema = z.enum(WORKFLOW_STEP_STATUSES);

/** RETRYABLE/NON_RETRYABLE/NEEDS_HUMAN 由步骤声明；LEASE_LOST = 推进任务丢失租约时遗留的运行中尝试；CANCELLED = 取消中断。 */
export const WORKFLOW_ERROR_CLASSES = ['RETRYABLE', 'NON_RETRYABLE', 'NEEDS_HUMAN', 'LEASE_LOST', 'CANCELLED'] as const;
export const workflowErrorClassSchema = z.enum(WORKFLOW_ERROR_CLASSES);
export type WorkflowErrorClass = z.infer<typeof workflowErrorClassSchema>;

export const workflowStepRecordSchema = z.object({
  stepKey: z.string().min(1).max(64),
  attempt: z.number().int().positive(),
  status: workflowStepStatusSchema,
  errorClass: workflowErrorClassSchema.nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  compensationStatus: z.enum(['COMPENSATED', 'COMPENSATION_FAILED']).nullable(),
  startedAt: isoDateTimeSchema,
  finishedAt: isoDateTimeSchema.nullable(),
}).strict();
export type WorkflowStepRecord = z.infer<typeof workflowStepRecordSchema>;

export const workflowRunSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema.nullable(),
  type: z.string().min(1).max(64),
  version: z.number().int().positive(),
  subjectRef: z.string().min(1).max(200),
  status: workflowRunStatusSchema,
  currentStep: z.string().nullable(),
  /** 各步骤已提交的输出（按步骤键；只读投影，不含凭据） */
  outputs: z.record(z.string(), z.unknown()),
  error: z.record(z.string(), z.unknown()).nullable(),
  steps: z.array(workflowStepRecordSchema),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
  completedAt: isoDateTimeSchema.nullable(),
}).strict();
export type WorkflowRun = z.infer<typeof workflowRunSchema>;

export const WORKFLOW_ERROR_REASONS = {
  RUN_NOT_FOUND: 'WORKFLOW_RUN_NOT_FOUND',
  NOT_CANCELLABLE: 'WORKFLOW_NOT_CANCELLABLE',
  GATE_NOT_WAITING: 'WORKFLOW_GATE_NOT_WAITING',
  UNKNOWN_DEFINITION: 'WORKFLOW_UNKNOWN_DEFINITION',
} as const;

// ── 素材工程终渲染工作流 ───────────────────────────────────

export const COMPOSITION_FINAL_RENDER_WORKFLOW = 'COMPOSITION_FINAL_RENDER';
export const COMPOSITION_FINAL_RENDER_WORKFLOW_VERSION = 1;
export const COMPOSITION_FINAL_RENDER_STEPS = ['freeze', 'render', 'qa'] as const;

export const startCompositionFinalRenderRequestSchema = z.object({
  profile: finalRenderProfileSchema,
  /** 发起时看到的工程 revision；冻结时不一致 → 409（避免导出用户没看过的版本） */
  expectedRevision: z.number().int().nonnegative().optional(),
}).strict();
export type StartCompositionFinalRenderRequest = z.infer<typeof startCompositionFinalRenderRequestSchema>;

export const COMPOSITION_FINAL_RENDER_ERROR_REASONS = {
  REVISION_CHANGED: 'FINAL_RENDER_REVISION_CHANGED',
  SOURCE_CHANGED: 'FINAL_RENDER_SOURCE_CHANGED',
  SOURCE_INTEGRITY_FAILED: 'FINAL_RENDER_SOURCE_INTEGRITY_FAILED',
  STORAGE_UNAVAILABLE: 'FINAL_RENDER_STORAGE_UNAVAILABLE',
  QA_FAILED: 'FINAL_RENDER_QA_FAILED',
} as const;
