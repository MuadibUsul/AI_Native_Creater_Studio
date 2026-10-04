import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { claimSchema } from './content.js';
import { datasetPointSchema, datasetSeriesSchema, structuredDatasetSchema } from './datasets.js';

/**
 * 证据与数据契约（P04-02 / 规范 §7、§10.3、§85；计划 P04-02）。
 *
 * 纪律（§10.3 MUST）：
 * - 数据图表只能绑定**结构化数据**或**可追踪 Source**（图表 Scene 必须能保存 data_source_ids）；
 * - 关键数据缺失时**不得由 AI 编造图形数据**，而是降级：Source Card / Quote / textual explanation / 提示补数据；
 * - 因此这里提供 `planFactVisual`：从 Claim（及其 Citation/Dataset）推导**允许的视觉策略**——缺数据即降级。
 *
 * 可追溯链：Claim → Citation(locator=块 ID/偏移) → Source(url/contentHash)；Dataset → sourceIds → Source。
 */

export const EVIDENCE_ERROR_REASONS = {
  /** fact 类 Claim 必须至少有一个来源（否则不可追溯） */
  CLAIM_REQUIRES_SOURCE: 'CLAIM_REQUIRES_SOURCE',
  /** 数据集必须至少有一个来源 */
  DATASET_REQUIRES_SOURCE: 'DATASET_REQUIRES_SOURCE',
  /** synthetic 数据集禁止被事实图表引用（§10.3 + datasets 契约） */
  SYNTHETIC_DATASET_NOT_BINDABLE: 'SYNTHETIC_DATASET_NOT_BINDABLE',
  /** 数据集没有任何数据点（不得渲染空图表） */
  DATASET_EMPTY: 'DATASET_EMPTY',
  /** Claim 已被作者锁定（不得静默修改，§8.2） */
  CLAIM_LOCKED: 'CLAIM_LOCKED',
  /** 引用的来源不属于本项目（跨租户/错误引用一律拒绝） */
  SOURCE_NOT_IN_PROJECT: 'SOURCE_NOT_IN_PROJECT',
  /** 未找到可用的数据/来源 → 需要用户补数据 */
  DATA_MISSING: 'DATA_MISSING',
} as const;

export type EvidenceErrorReason = (typeof EVIDENCE_ERROR_REASONS)[keyof typeof EVIDENCE_ERROR_REASONS];

/** 持久化的 Claim（含溯源与抽取元数据） */
export const claimRecordSchema = claimSchema.extend({
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  documentId: opaqueIdSchema.nullable().default(null),
  /** 来源块（抽取自哪一段；人工创建为 null） */
  blockId: opaqueIdSchema.nullable().default(null),
  /** 作者锁定：锁定后不得被 AI/管线静默修改（§8.2） */
  locked: z.boolean().default(false),
  /** 抽取置信度与依据（可复核；确定性抽取为 1.0） */
  extraction: z
    .object({
      method: z.enum(['DETERMINISTIC', 'LLM', 'MANUAL']),
      confidence: z.number().min(0).max(1),
      /** 原始句子（保留原文以便复核对齐） */
      sourceText: z.string().max(4000).nullable().default(null),
    })
    .default({ method: 'MANUAL', confidence: 1, sourceText: null }),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type ClaimRecord = z.infer<typeof claimRecordSchema>;

/** Citation（可追溯定位：块 ID + 字符区间 + 引文） */
export const citationRecordSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  claimId: opaqueIdSchema,
  sourceId: opaqueIdSchema,
  /** 定位：块 ID（可含字符区间，如 blk_xxx:12-48） */
  locator: z.string().min(1).max(300),
  /** 直接引文（可选；图表 Source Card 展示用） */
  quotedText: z.string().max(1000).nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type CitationRecord = z.infer<typeof citationRecordSchema>;

/** 数值事实抽取结果（原始文本 + 归一化，供图表与复核） */
export const numericMentionSchema = z.object({
  blockId: opaqueIdSchema,
  /** 原始文本片段（如 "5.25%"、"-2.1 个百分点"） */
  raw: z.string().min(1).max(120),
  value: z.number(),
  /** 归一的比较基准（PERCENT / CURRENCY / RATIO / ABSOLUTE / YEAR） */
  canonical: z.enum(['PERCENT', 'CURRENCY', 'RATIO', 'ABSOLUTE', 'YEAR']),
  /** 归一化后的单位（如 '%'、'USD'、'倍'） */
  unit: z.string().min(1).max(40),
  /** 原始单位文本（保留，避免信息丢失） */
  rawUnit: z.string().nullable().default(null),
  /** 出现位置（块内字符偏移，供 citation locator 使用） */
  offset: z.number().int().nonnegative(),
});

export type NumericMention = z.infer<typeof numericMentionSchema>;

/** 抽取运行结果（持久化到 content_documents.extractions 的载荷） */
export const extractionResultSchema = z.object({
  documentId: opaqueIdSchema,
  method: z.enum(['DETERMINISTIC', 'LLM']),
  claims: z.array(claimRecordSchema).default([]),
  citations: z.array(citationRecordSchema).default([]),
  numericMentions: z.array(numericMentionSchema).default([]),
  /** 时间线（年份/日期提及） */
  timeline: z
    .array(z.object({ blockId: opaqueIdSchema, date: z.string().min(1), description: z.string().min(1) }))
    .default([]),
  /** 抽取摘要（UI 显示"这次抽取发生了什么"） */
  summary: z.object({
    blockCount: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
    numericCount: z.number().int().nonnegative(),
    timelineCount: z.number().int().nonnegative(),
    notes: z.array(z.string().max(200)).default([]),
  }),
});

export type ExtractionResult = z.infer<typeof extractionResultSchema>;

/**
 * 数据集创建（服务层强制：≥1 来源、≥1 数据点；此处放宽以便给出**明确原因**：
 * 空来源 → 422 DATASET_REQUIRES_SOURCE；空序列 → 422 DATASET_EMPTY）。
 */
export const createDatasetRequestSchema = structuredDatasetSchema
  .omit({ id: true })
  .extend({
    sourceIds: z.array(opaqueIdSchema).default([]),
    series: z.array(datasetSeriesSchema.extend({ points: z.array(datasetPointSchema).default([]) })).default([]),
    /** 作者确认为演示数据（允许存在，但 fact chart 一律拒绝绑定） */
    synthetic: z.boolean().default(false),
    note: z.string().max(500).optional(),
  });

export type CreateDatasetRequest = z.infer<typeof createDatasetRequestSchema>;

export const datasetRecordSchema = structuredDatasetSchema.extend({
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type DatasetRecord = z.infer<typeof datasetRecordSchema>;

/** 事实可视化策略（§10.3 降级阶梯：数据缺失时不得编造，只能降级或请求补数据） */
export const FACT_VISUAL_STRATEGIES = ['CHART', 'SOURCE_CARD', 'QUOTE', 'TEXTUAL_EXPLANATION', 'REQUEST_DATA'] as const;
export const factVisualStrategySchema = z.enum(FACT_VISUAL_STRATEGIES);
export type FactVisualStrategy = z.infer<typeof factVisualStrategySchema>;

export const factVisualDecisionSchema = z.object({
  strategy: factVisualStrategySchema,
  reason: z.string().min(1).max(300),
  /** CHART 时：可绑定的数据集 + **图表 Scene 必须保存的 data_source_ids** */
  datasetId: opaqueIdSchema.nullable().default(null),
  dataSourceIds: z.array(opaqueIdSchema).default([]),
  /** 降级时的素材引用（供 Source Card / Quote 使用） */
  quoteSourceId: opaqueIdSchema.nullable().default(null),
  quoteText: z.string().max(1000).nullable().default(null),
  /** 需要用户补数据时的提示 */
  requestHint: z.string().max(300).nullable().default(null),
});

export type FactVisualDecision = z.infer<typeof factVisualDecisionSchema>;

/** 图表的可绑定校验结果 */
export const chartBindingCheckSchema = z.object({
  bindable: z.boolean(),
  reasons: z.array(z.string().min(1)),
  dataSourceIds: z.array(opaqueIdSchema).default([]),
  pointCount: z.number().int().nonnegative().default(0),
});

export type ChartBindingCheck = z.infer<typeof chartBindingCheckSchema>;

