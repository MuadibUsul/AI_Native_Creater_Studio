import { z } from 'zod';
import { agentPointerSchema, agentTurnSchema } from './agent.js';
import { opaqueIdSchema } from './common/ids.js';
import { frameRegionSchema } from './frame-region.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * V6 §5.4 批注式审片（V6-4）：看片时逐处标记问题（定位 + 一句话）→ 和 AI 逐条讨论修改方案 →
 * 全部确定后一次执行（一个提案、统一局部重渲）→ 采用后成为新版本。
 *
 * - 一轮审片（round）绑定所看的工程版本；批注属于一轮。上一轮已采用后再标记 → 自动开始新一轮。
 * - 讨论与执行都是普通的 AI 轮次（同一个通用导演、同一个工具目录）：讨论轮只给方案、不改时间线；
 *   执行轮把所有已确定的批注一次做完，成为一个试改提案，由用户采用或撤回。
 * - 轮次状态由执行轮与提案派生（不另存可能失真的状态）：
 *   OPEN（可标记/讨论）→ APPLYING（AI 正在一次执行）→ READY（试改待采用）→ APPLIED（已采用）。
 */

/** 画面上的框选（与对话指向、特效区域同一形状；只用于定位说明，不是时间权威）。 */
export const reviewRegionSchema = frameRegionSchema;
export type ReviewRegion = z.infer<typeof reviewRegionSchema>;

/** 用户可设的批注状态；APPLIED 由轮次派生（批注被包含在已采用的执行里）。 */
export const REVIEW_NOTE_STATUSES = ['OPEN', 'AGREED', 'DISMISSED', 'APPLIED'] as const;
export const reviewNoteStatusSchema = z.enum(REVIEW_NOTE_STATUSES);
export type ReviewNoteStatus = z.infer<typeof reviewNoteStatusSchema>;

export const REVIEW_ROUND_STATUSES = ['OPEN', 'APPLYING', 'READY', 'APPLIED'] as const;
export const reviewRoundStatusSchema = z.enum(REVIEW_ROUND_STATUSES);
export type ReviewRoundStatus = z.infer<typeof reviewRoundStatusSchema>;

export const reviewNoteSchema = z.object({
  id: opaqueIdSchema,
  roundId: opaqueIdSchema,
  /** 标记的位置：时间范围（十进制秒文本，与 AI 指向同一形状）+ 可选的片段 */
  pointer: agentPointerSchema,
  region: reviewRegionSchema.nullable(),
  text: z.string(),
  status: reviewNoteStatusSchema,
  /** 确定的修改方案（通常是讨论里 AI 的最后一个方案；为空 = 让 AI 按批注自己决定） */
  plan: z.string().nullable(),
  /** 讨论的轮数与 AI 最近一次回应（完整讨论按批注查询轮次） */
  discussion: z.object({ turns: z.number().int().nonnegative(), lastReply: z.string().nullable(), running: z.boolean() }).strict(),
  createdBy: z.string().nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
}).strict();
export type ReviewNote = z.infer<typeof reviewNoteSchema>;

export const reviewRoundSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  /** 这一轮审看的工程版本 */
  baseRevision: z.number().int().nonnegative(),
  status: reviewRoundStatusSchema,
  /** 最近一次"全部执行"的 AI 轮次与它形成的提案 */
  applyTurnId: opaqueIdSchema.nullable(),
  proposalId: opaqueIdSchema.nullable(),
  /** 执行时包含的批注（已确定的那些） */
  appliedNoteIds: z.array(opaqueIdSchema),
  /** 采用后的工程版本 */
  appliedRevision: z.number().int().nonnegative().nullable(),
  /** 上一次执行没有成功（失败、取消、AI 没做改动或试改被撤回）时的原因 */
  applyIssue: z.object({ kind: z.enum(['FAILED', 'CANCELLED', 'NO_CHANGES', 'DISCARDED']), reply: z.string().nullable(), error: z.record(z.string(), z.unknown()).nullable() }).strict().nullable(),
  createdAt: isoDateTimeSchema,
}).strict();
export type ReviewRound = z.infer<typeof reviewRoundSchema>;

export const reviewStateSchema = z.object({
  projectRevision: z.number().int().nonnegative(),
  /** 最近一轮（没有审片过为 null） */
  round: reviewRoundSchema.nullable(),
  notes: z.array(reviewNoteSchema),
}).strict();
export type ReviewState = z.infer<typeof reviewStateSchema>;

export const createReviewNoteRequestSchema = z.object({
  sequenceId: opaqueIdSchema,
  pointer: agentPointerSchema.refine((pointer) => pointer.timeRange !== null, 'a review note needs a time range'),
  region: reviewRegionSchema.nullable().default(null),
  text: z.string().trim().min(1).max(1000),
}).strict();
export type CreateReviewNoteRequest = z.input<typeof createReviewNoteRequestSchema>;

export const updateReviewNoteRequestSchema = z.object({
  text: z.string().trim().min(1).max(1000).optional(),
  plan: z.string().trim().max(2000).nullable().optional(),
  status: z.enum(['OPEN', 'AGREED', 'DISMISSED']).optional(),
}).strict().refine((body) => body.text !== undefined || body.plan !== undefined || body.status !== undefined, 'nothing to update');
export type UpdateReviewNoteRequest = z.input<typeof updateReviewNoteRequestSchema>;

/** 全部执行：在这个 AI 会话里发起一轮（会话语言即 AI 回应的语言）。 */
export const applyReviewRequestSchema = z.object({
  sessionId: opaqueIdSchema,
}).strict();
export type ApplyReviewRequest = z.input<typeof applyReviewRequestSchema>;

export const applyReviewResponseSchema = z.object({
  round: reviewRoundSchema,
  turn: agentTurnSchema,
}).strict();
export type ApplyReviewResponse = z.infer<typeof applyReviewResponseSchema>;

export const REVIEW_ERROR_REASONS = {
  NOTE_NOT_FOUND: 'REVIEW_NOTE_NOT_FOUND',
  /** 一次执行进行中或试改待采用：批注暂时不能改（先采用或撤回） */
  ROUND_LOCKED: 'REVIEW_ROUND_LOCKED',
  NOTHING_TO_APPLY: 'REVIEW_NOTHING_TO_APPLY',
  SEQUENCE_MISMATCH: 'REVIEW_SEQUENCE_MISMATCH',
} as const;
