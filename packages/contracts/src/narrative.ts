import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * NarrativePlan 契约（P04-03 / 规范 §8、§52；计划 P04-03）。
 *
 * - 结构（§8）：title/thesis/hook/chapters/narrationBlocks/keyClaims/requiredVisualFacts/
 *   ending/estimatedDuration；**不强制统一模板**（§8.1 的推荐模式只是参考）；
 * - 约束（§8.2）：不得逐字朗读文章（口语化）；锁定文字不得静默修改；事实与分析保留类型信息；
 * - 结构化输出（§52）：LLM 必须返回结构化 JSON → Schema 校验 → **有限修复**（有界；超限即明确失败），
 *   并记录 modelVersion / promptVersion。
 */

export const NARRATION_BLOCK_STATUSES = ['DRAFT', 'NEEDS_REVIEW', 'APPROVED'] as const;
export const narrationBlockStatusSchema = z.enum(NARRATION_BLOCK_STATUSES);

export const narrativeChapterSchema = z.object({
  id: opaqueIdSchema,
  title: z.string().min(1).max(200),
  /** 章节意图（可选；用于 Director 理解节奏） */
  intent: z.string().max(500).nullable().default(null),
  narrationBlockIds: z.array(opaqueIdSchema).default([]),
});

export type NarrativeChapter = z.infer<typeof narrativeChapterSchema>;

export const narrationBlockSchema = z.object({
  id: opaqueIdSchema,
  /** 顺序（派生于数组位置，持久化以便稳定引用） */
  position: z.number().int().nonnegative(),
  text: z.string().min(1).max(4000),
  chapterId: opaqueIdSchema.nullable().default(null),
  /** 引用的事实（Claim id；事实类型由 claims 表保留，Narrative 不得改写其类型） */
  claimIds: z.array(opaqueIdSchema).default([]),
  /** 估计时长（毫秒；按字数启发式，P06-03 Alignment 后修正） */
  estimatedDurationMs: z.number().int().positive(),
  /** 作者锁定（§8.2：锁定文字不得被后续生成静默修改） */
  locked: z.boolean().default(false),
  status: narrationBlockStatusSchema.default('DRAFT'),
});

export type NarrationBlock = z.infer<typeof narrationBlockSchema>;

/** 视觉事实需求（供 P04-04/P04-05：该事实需要什么视觉载体） */
export const requiredVisualFactSchema = z.object({
  claimId: opaqueIdSchema,
  /** 语义提示（P04-04 的 Visual Grammar 输入） */
  semanticHint: z.string().max(100).nullable().default(null),
  /** 已绑定数据集（若有；数值图表只能来自真实数据，P04-02） */
  datasetId: opaqueIdSchema.nullable().default(null),
});

export type RequiredVisualFact = z.infer<typeof requiredVisualFactSchema>;

export const narrativePlanSchema = z.object({
  schemaVersion: z.string().min(1),
  id: opaqueIdSchema,
  revision: z.number().int().positive(),
  title: z.string().min(1).max(300),
  thesis: z.string().min(1).max(1000),
  hook: z.string().min(1).max(2000),
  chapters: z.array(narrativeChapterSchema).min(1),
  narrationBlocks: z.array(narrationBlockSchema).min(1),
  keyClaims: z.array(opaqueIdSchema).default([]),
  requiredVisualFacts: z.array(requiredVisualFactSchema).default([]),
  ending: z.string().min(1).max(2000),
  estimatedDurationMs: z.number().int().positive(),
  /** 生成元数据（§52：prompt/model 版本 + 修复与告警记录） */
  generation: z.object({
    method: z.enum(['LLM', 'MANUAL']),
    providerId: z.string().min(1).max(100),
    modelVersion: z.string().min(1).max(200),
    promptVersion: z.string().min(1).max(50),
    /** 有限修复记录（每条说明改了什么；可审计） */
    repairs: z.array(z.string().max(200)).default([]),
    /** 生成告警（如逐字朗读嫌疑；不阻断但有记录） */
    warnings: z.array(z.string().max(200)).default([]),
  }),
});

export type NarrativePlan = z.infer<typeof narrativePlanSchema>;

/** 生成请求（服务层组装；LLM 适配器收到的是结构化输入，不是自由文本） */
export const narrativeGenerationRequestSchema = z.object({
  documentTitle: z.string().min(1).max(300),
  documentLanguage: z.string().min(2).max(20),
  /** 段落摘要（供 LLM 使用；已归一化的内容，不含原始 HTML） */
  contentDigest: z.array(z.object({ blockId: opaqueIdSchema, kind: z.string().min(1), text: z.string().max(1000) })).max(200),
  /** 可用事实（含锁定与事实类型；LLM 只能引用 id，不能改写类型） */
  claims: z.array(
    z.object({
      claimId: opaqueIdSchema,
      text: z.string().max(2000),
      factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
      locked: z.boolean(),
    }),
  ).max(200),
  /** 锁定旁白（再生成时必须逐字保留） */
  lockedNarrationBlocks: z.array(z.object({ id: opaqueIdSchema, text: z.string().max(4000) })).max(100),
  targetDurationMs: z.number().int().positive(),
  tone: z.string().max(100).nullable().default(null),
  audience: z.string().max(100).nullable().default(null),
  platform: z.string().max(100).nullable().default(null),
});

export type NarrativeGenerationRequest = z.infer<typeof narrativeGenerationRequestSchema>;

/** LLM 适配器响应（结构化输出 + 版本记录；§52） */
export const llmCompletionSchema = z.object({
  /** 原始输出文本（应为 JSON；允许 fenced code block） */
  content: z.string().min(1).max(200_000),
  modelVersion: z.string().min(1).max(200),
  promptVersion: z.string().min(1).max(50),
  /** 上游用量（可选；成本核算用） */
  usage: z.record(z.string(), z.unknown()).default({}),
});

export type LlmCompletion = z.infer<typeof llmCompletionSchema>;

/** LLM 适配器（真实 Provider 与 Mock 共用；domain 不依赖具体 SDK） */
export interface LlmAdapter {
  readonly providerId: string;
  complete(input: { request: NarrativeGenerationRequest; systemPrompt: string; userPrompt: string }): Promise<LlmCompletion>;
}

export const NARRATIVE_ERROR_REASONS = {
  /** LLM 输出无法解析为 JSON（含有限修复后仍失败） */
  INVALID_LLM_OUTPUT: 'INVALID_LLM_OUTPUT',
  /** 修复超出有界限度（结构性缺失） */
  REPAIR_LIMIT_EXCEEDED: 'REPAIR_LIMIT_EXCEEDED',
  /** 全部旁白块逐字抄袭原文（§8.2 必须口语化） */
  VERBATIM_NARRATION_REJECTED: 'VERBATIM_NARRATION_REJECTED',
  /** 引用了不存在的事实（不得虚构来源/事实） */
  UNKNOWN_CLAIM_REFERENCE: 'UNKNOWN_CLAIM_REFERENCE',
  /** 目标时长非法 */
  INVALID_TARGET_DURATION: 'INVALID_TARGET_DURATION',
} as const;

export type NarrativeErrorReason = (typeof NARRATIVE_ERROR_REASONS)[keyof typeof NARRATIVE_ERROR_REASONS];

/** 生成响应（plan + 过程透明信息） */
export const narrativeGenerationResultSchema = z.object({
  plan: narrativePlanSchema,
  meta: z.object({
    llmCalls: z.number().int().nonnegative(),
    repairs: z.array(z.string().max(200)).default([]),
    warnings: z.array(z.string().max(200)).default([]),
    /** 抽取输入规模（可解释性） */
    claimCount: z.number().int().nonnegative(),
    lockedBlockCount: z.number().int().nonnegative(),
  }),
});

export type NarrativeGenerationResult = z.infer<typeof narrativeGenerationResultSchema>;

export const updateNarrationBlockRequestSchema = z
  .object({
    text: z.string().min(1).max(4000),
    locked: z.boolean(),
    status: narrationBlockStatusSchema,
  })
  .partial()
  .strict();

export type UpdateNarrationBlockRequest = z.infer<typeof updateNarrationBlockRequestSchema>;

/** 口语化检查阈值（8-gram 字符重叠率；≥ 阈值视为逐字朗读嫌疑） */
export const VERBATIM_OVERLAP_THRESHOLD = 0.6;
export const VERBATIM_NGRAM = 8;
/** 有限修复的有界限度（超过即明确失败，不无限重试） */
export const MAX_REPAIRS = 12;
export const MAX_LLM_ATTEMPTS = 2;
