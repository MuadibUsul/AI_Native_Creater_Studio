import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { EDIT_OPERATION_TYPES, editOperationSchema } from './edits.js';

/**
 * N03-09 范围编辑指令的最小 AI 入口（V03-01／V03-04／V03-28／V03-29）。
 *
 * 纪律：
 * - 规划器只看**给定的源证据**（选中片段与其相邻片段、允许操作、Brief、策略）——不得虚构素材；
 * - 输出必须是**可验证的结构化编辑**：每条操作经契约校验 + 允许清单校验 + 源引用校验后才会进入可执行计划；
 * - 范围外请求（不允许的操作、不存在的源、策略禁止）**明确列入 `outOfScope` 并说明原因**，不静默丢弃也不整批失败；
 * - 计划阶段**零 Provider 媒体调用**（`providerMediaCalls` 恒为 0）；生成式意图只能由用户显式发起。
 */

export const RANGE_EDIT_PLAN_VERSION = 'range-edit-plan/1.0';

export const RANGE_EDIT_OUT_OF_SCOPE_REASONS = {
  /** 操作不在本次调用方声明的允许清单内 */
  NOT_ALLOWED_OPERATION: 'NOT_IN_ALLOWED_OPERATIONS',
  /** 引用了源证据之外的片段/资产（不虚构素材） */
  UNKNOWN_SOURCE_REFERENCE: 'UNKNOWN_SOURCE_REFERENCE',
  /** 被项目策略禁止（如原声保护下改动源时钟、禁生成时的生成式意图） */
  POLICY_FORBIDDEN: 'POLICY_FORBIDDEN',
  /** 目标被锁定（对象锁） */
  LOCKED_TARGET: 'LOCKED_TARGET',
  /** 操作本身不符合契约（服务端无法执行） */
  INVALID_OPERATION: 'INVALID_OPERATION',
} as const;

export type RangeEditOutOfScopeReason = (typeof RANGE_EDIT_OUT_OF_SCOPE_REASONS)[keyof typeof RANGE_EDIT_OUT_OF_SCOPE_REASONS];

export const RANGE_EDIT_ERROR_REASONS = {
  /** LLM 输出不可解析/不是合法计划 */
  INVALID_PLANNER_OUTPUT: 'RANGE_EDIT_INVALID_PLANNER_OUTPUT',
  /** 可执行操作为空（全部越界或被剔除） */
  NO_EXECUTABLE_OPERATIONS: 'RANGE_EDIT_NO_EXECUTABLE_OPERATIONS',
  /** 规划器适配器未实现结构化补全 → fail-closed，不静默降级 */
  PLANNER_UNAVAILABLE: 'RANGE_EDIT_PLANNER_UNAVAILABLE',
  /** 选中片段为空或不属于该序列 */
  INVALID_SELECTION: 'RANGE_EDIT_INVALID_SELECTION',
} as const;

export type RangeEditErrorReason = (typeof RANGE_EDIT_ERROR_REASONS)[keyof typeof RANGE_EDIT_ERROR_REASONS];

export const rangeEditBriefSchema = z.object({
  objective: z.string().max(500).default(''),
  audience: z.string().max(200).default(''),
  notes: z.string().max(1_000).default(''),
}).strict();

export const createRangeEditPlanRequestSchema = z.object({
  /** 用户自然语言意图（如"去掉前面废话但保留原音"） */
  prompt: z.string().min(1).max(2_000),
  sequenceId: opaqueIdSchema,
  /** 选中片段（至少一个；规划器只能引用证据里的片段） */
  selectedClipIds: z.array(opaqueIdSchema).min(1).max(200),
  /** 本次允许的操作类型（来自规范注册表；超出即记为越界） */
  allowedOperations: z.array(z.enum(EDIT_OPERATION_TYPES)).min(1),
  brief: rangeEditBriefSchema.optional(),
  languageTag: z.string().min(2).max(35).default('zh-CN'),
}).strict();

export type CreateRangeEditPlanRequest = z.infer<typeof createRangeEditPlanRequestSchema>;

export const rangeEditSourceEvidenceSchema = z.object({
  clipId: opaqueIdSchema,
  trackId: opaqueIdSchema,
  selected: z.boolean(),
  adjacent: z.boolean(),
  sequenceRangeMs: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
  sourceRangeMs: z.object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() }).strict(),
  assetVersionId: opaqueIdSchema,
  sourceHasAudio: z.boolean(),
  locked: z.boolean(),
}).strict();

export type RangeEditSourceEvidence = z.infer<typeof rangeEditSourceEvidenceSchema>;

export const rangeEditOutOfScopeSchema = z.object({
  request: z.string().max(500),
  reason: z.enum([
    RANGE_EDIT_OUT_OF_SCOPE_REASONS.NOT_ALLOWED_OPERATION,
    RANGE_EDIT_OUT_OF_SCOPE_REASONS.UNKNOWN_SOURCE_REFERENCE,
    RANGE_EDIT_OUT_OF_SCOPE_REASONS.POLICY_FORBIDDEN,
    RANGE_EDIT_OUT_OF_SCOPE_REASONS.LOCKED_TARGET,
    RANGE_EDIT_OUT_OF_SCOPE_REASONS.INVALID_OPERATION,
  ]),
  detail: z.string().max(500).default(''),
}).strict();

export type RangeEditOutOfScope = z.infer<typeof rangeEditOutOfScopeSchema>;

export const rangeEditPlanSchema = z.object({
  planVersion: z.literal(RANGE_EDIT_PLAN_VERSION),
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  documentRevision: z.number().int().nonnegative(),
  rationale: z.array(z.string().max(500)),
  /** 通过全部校验、可直接交给统一编辑协议执行的操作 */
  operations: z.array(editOperationSchema),
  /** 越界/被拒请求：明确说明原因（不静默丢弃） */
  outOfScope: z.array(rangeEditOutOfScopeSchema),
  evidence: z.array(rangeEditSourceEvidenceSchema),
  /** 原声是否被保留（无任何触碰音频源时钟的操作） */
  originalAudioPreserved: z.boolean(),
  /** 计划阶段的 Provider 媒体调用次数（恒为 0；生成式意图必须由用户显式发起） */
  providerMediaCalls: z.literal(0),
  policy: z.object({
    mode: z.string().min(1),
    preserveOriginalSpeech: z.boolean(),
    allowGeneratedMedia: z.boolean(),
  }).strict(),
}).strict();

export type RangeEditPlan = z.infer<typeof rangeEditPlanSchema>;

/** 触碰音频源时钟的操作（原声保护判据；与执行器的守卫保持同一口径）。 */
export const RANGE_EDIT_AUDIO_CLOCK_OPERATIONS = ['update_audio_region'] as const;
