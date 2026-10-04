import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { editOperationSchema } from './edits.js';

/**
 * AI Edit 契约（P05-06 / 规范 §37、§52、§55；计划 §8 P05-06）。
 *
 * 语义：自然语言 → **结构化编辑计划**（operation 列表 + 理由）→ 差异预览 →（用户确认）Apply。
 * 纪律：
 * - **计划不是状态**：生成计划不写数据库（未 Apply 不改任何数据）；Apply 才经编辑协议提交；
 * - 计划中的每条 operation 必须通过编辑契约校验、引用真实存在的场景；
 * - **AI 不得修改锁定场景**（§4.7）：相关操作被剔除并返回 warning，绝不自动解锁；
 * - 成本影响：AI Edit 本身**零 Provider 成本**（costImpact 明确标注）；如计划意图需要重生成素材，
 *   必须由用户走显式生成动作（P06 起）——不得由 AI Edit 隐式触发。
 */

export const EDIT_PLAN_VERSION = 'edit-plan-v1';

export const AI_EDIT_ERROR_REASONS = {
  /** LLM 输出无法解析/不符合操作契约（含有限重试后） */
  INVALID_PLAN: 'INVALID_PLAN',
  /** 计划引用了不存在的场景（不得虚构操作目标） */
  UNKNOWN_SCENE_REFERENCE: 'UNKNOWN_SCENE_REFERENCE',
  /** 计划没有任何可应用操作（空计划或被锁定约束全部剔除） */
  NO_CHANGES: 'NO_CHANGES',
  /** 请求的意图为空 */
  EMPTY_PROMPT: 'EMPTY_PROMPT',
  /** LLM 适配器不支持结构化补全 */
  LLM_UNSUPPORTED: 'LLM_UNSUPPORTED',
} as const;

export type AiEditErrorReason = (typeof AI_EDIT_ERROR_REASONS)[keyof typeof AI_EDIT_ERROR_REASONS];

/** 单条操作的展示摘要（差异预览；before 值来自当前场景，绝不由模型提供）。 */
export const editPlanOperationSchema = z.object({
  operation: editOperationSchema,
  /** 人类可读摘要（服务端按操作类型确定性生成） */
  summary: z.string().min(1).max(300),
  /** 目标场景（若操作指向场景） */
  sceneId: opaqueIdSchema.nullable().default(null),
  /** 关键字段的当前值（before；用于差异预览） */
  before: z.record(z.string(), z.unknown()).default({}),
  /** 关键字段的目标值（after；来自计划操作本身） */
  after: z.record(z.string(), z.unknown()).default({}),
});

export type EditPlanOperation = z.infer<typeof editPlanOperationSchema>;

export const editPlanImpactSchema = z.object({
  scenesAdded: z.number().int().nonnegative(),
  scenesRemoved: z.number().int().nonnegative(),
  scenesModified: z.number().int().nonnegative(),
  /** 计划后的时长变化（毫秒；负数为缩短） */
  durationDeltaMs: z.number().int(),
  /** AI Edit 的成本影响：V1 恒为 NONE（计划阶段不触发任何 Provider 调用） */
  costImpact: z.literal('NONE'),
  notes: z.array(z.string().max(200)).default([]),
});

export type EditPlanImpact = z.infer<typeof editPlanImpactSchema>;

export const editPlanSchema = z.object({
  schemaVersion: z.string().min(1),
  planVersion: z.literal(EDIT_PLAN_VERSION),
  planId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 计划基于的项目 revision（Apply 时必须仍然是该 revision，否则 409） */
  baseProjectRevision: z.number().int().nonnegative(),
  prompt: z.string().min(1).max(2000),
  /** 模型给出的理由（逐条对应操作；可审计） */
  rationale: z.array(z.string().max(300)).default([]),
  operations: z.array(editPlanOperationSchema).default([]),
  impact: editPlanImpactSchema,
  warnings: z.array(z.string().max(300)).default([]),
  generation: z.object({
    method: z.literal('LLM'),
    providerId: z.string().min(1),
    modelVersion: z.string().nullable().default(null),
    promptVersion: z.string().nullable().default(null),
    attempts: z.number().int().positive(),
  }),
});

export type EditPlan = z.infer<typeof editPlanSchema>;

export const createEditPlanRequestSchema = z.object({
  /** 自然语言意图（例如「把每个场景缩短 500ms，并在开头插入一个标题场景」） */
  prompt: z.string().min(1).max(2000),
});

export type CreateEditPlanRequest = z.infer<typeof createEditPlanRequestSchema>;
