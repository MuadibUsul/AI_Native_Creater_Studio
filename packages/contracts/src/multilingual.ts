import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { masterNarrationSchema } from './alignment.js';

/**
 * 多语言契约（P12-04 / 规范 §5.1、§94；计划 §8 P12）。
 *
 * 纪律（验收："不复用原语言时间戳；数字、实体和引用一致"）：
 * - **术语词典 = 项目级版本化数据**：(projectId, sourceTerm, targetLanguage) 唯一；翻译与 TTS 发音共用；
 * - **翻译经 LLM seam**（Mock 同构；真实翻译 Provider BLOCKED 凭据——不冒充）；
 * - **数字一致 = 逐块数字序列多重集相等**（不等 → 422 fail-closed，整个翻译不落库）；
 * - **实体一致 = 词典命中的源词在译文中必须以词典译名出现**（缺失 → 422）；
 * - **不复用原语言时间戳**：派生 Master Narration 走完整合成链（新语言文本 → 新 cacheKey →
 *   新 TTS → 新对齐）；缓存复用按语言隔离（原语言行永不作为译文缓存源）。
 */

export const TERMINOLOGY_KINDS = ['BRAND', 'PERSON', 'TERM', 'NUMBER_UNIT'] as const;
export const terminologyKindSchema = z.enum(TERMINOLOGY_KINDS);
export type TerminologyKind = z.infer<typeof terminologyKindSchema>;

export const terminologyEntrySchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sourceTerm: z.string().min(1).max(120),
  targetLanguage: z.string().min(2).max(20),
  targetTerm: z.string().min(1).max(200),
  kind: terminologyKindSchema,
  /** 备注（如"官方中文名"/"品牌方指定译名"） */
  note: z.string().max(300).nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type TerminologyEntry = z.infer<typeof terminologyEntrySchema>;

export const upsertTerminologyRequestSchema = z.object({
  sourceTerm: z.string().min(1).max(120),
  targetLanguage: z.string().min(2).max(20),
  targetTerm: z.string().min(1).max(200),
  kind: terminologyKindSchema,
  note: z.string().max(300).nullable().optional(),
});

export type UpsertTerminologyRequest = z.infer<typeof upsertTerminologyRequestSchema>;

export const terminologyListSchema = z.object({
  items: z.array(terminologyEntrySchema),
});

export type TerminologyList = z.infer<typeof terminologyListSchema>;

/** 术语映射（词典命中记录——实体一致性的证据） */
export const termMappingSchema = z.object({
  sourceTerm: z.string().min(1).max(120),
  targetTerm: z.string().min(1).max(200),
  /** 源文本出现次数 */
  sourceCount: z.number().int().nonnegative(),
  /** 译文中以词典译名出现的次数 */
  translatedCount: z.number().int().nonnegative(),
});

export type TermMapping = z.infer<typeof termMappingSchema>;

/** 翻译单元（块级；引用链经 narrationBlockId 回到源计划块） */
export const translationUnitSchema = z.object({
  narrationBlockId: opaqueIdSchema,
  sourceText: z.string().min(1),
  translatedText: z.string().min(1),
  termMappings: z.array(termMappingSchema).default([]),
});

export type TranslationUnit = z.infer<typeof translationUnitSchema>;

/** 数字一致性核对（fail-closed：不一致根本不会落库——这里存的是通过时的证据） */
export const numbersCheckSchema = z.object({
  sourceDigitGroups: z.number().int().nonnegative(),
  translatedDigitGroups: z.number().int().nonnegative(),
  ok: z.literal(true),
});

export type NumbersCheck = z.infer<typeof numbersCheckSchema>;

/** 实体一致性核对（逐词条） */
export const entitiesCheckSchema = z.object({
  entries: z
    .array(
      z.object({
        sourceTerm: z.string().min(1).max(120),
        targetTerm: z.string().min(1).max(200),
        sourceCount: z.number().int().nonnegative(),
        translatedCount: z.number().int().nonnegative(),
        ok: z.boolean(),
      }),
    )
    .default([]),
  ok: z.literal(true),
});

export type EntitiesCheck = z.infer<typeof entitiesCheckSchema>;

export const translationJobSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  narrativePlanId: opaqueIdSchema,
  /** 源语言 Master Narration（时间戳的"不被复用"对照物） */
  sourceNarrationId: opaqueIdSchema,
  /** 派生（目标语言）Master Narration——全新合成行，时间戳来自新语言对齐 */
  derivedNarrationId: opaqueIdSchema,
  targetLanguage: z.string().min(2).max(20),
  units: z.array(translationUnitSchema).min(1),
  numbersCheck: numbersCheckSchema,
  entitiesCheck: entitiesCheckSchema,
  createdAt: isoDateTimeSchema,
});

export type TranslationJob = z.infer<typeof translationJobSchema>;

export const translationJobListSchema = z.object({
  items: z.array(translationJobSchema),
});

export type TranslationJobList = z.infer<typeof translationJobListSchema>;

/** 翻译响应 = 作业 + 派生 Master Narration（新时间戳） */
export const translationResultSchema = z.object({
  job: translationJobSchema,
  narration: masterNarrationSchema,
});

export type TranslationResult = z.infer<typeof translationResultSchema>;

export const translateNarrationRequestSchema = z.object({
  planId: opaqueIdSchema,
  targetLanguage: z.string().min(2).max(20),
});

export type TranslateNarrationRequest = z.infer<typeof translateNarrationRequestSchema>;

export const MULTILINGUAL_ERROR_REASONS = {
  /** 未配置 LLM 适配器（翻译 seam；真实 Provider BLOCKED 凭据——fail-closed 不冒充） */
  TRANSLATION_UNAVAILABLE: 'TRANSLATION_UNAVAILABLE',
  /** 源语言 Master Narration 不存在（先合成再翻译） */
  SOURCE_NARRATION_MISSING: 'SOURCE_NARRATION_MISSING',
  /** LLM 输出无法解析为翻译 JSON */
  INVALID_TRANSLATION_OUTPUT: 'INVALID_TRANSLATION_OUTPUT',
  /** 译文缺少某个旁白块的翻译 */
  TRANSLATION_INCOMPLETE: 'TRANSLATION_INCOMPLETE',
  /** 数字序列不一致（fail-closed——数字必须逐字保留） */
  NUMBERS_CHANGED: 'NUMBERS_CHANGED',
  /** 词典实体在译文中缺失（fail-closed——实体必须一致） */
  ENTITY_MISSING: 'ENTITY_MISSING',
} as const;

export type MultilingualErrorReason = (typeof MULTILINGUAL_ERROR_REASONS)[keyof typeof MULTILINGUAL_ERROR_REASONS];
