import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * Visual Grammar 契约（P04-04 / 规范 §10；计划 P04-04）。
 *
 * 原则（§10 开头："Director 先识别语义，再选择视觉表达"）：
 * - **优先确定性视觉**：语义识别用规则/词典 + 数据形状（数据集序列特征）判定，**不依赖 LLM**；
 * - **允许类型集合**（而非唯一答案）：每个语义类型给出一组允许的场景类型；"对固定语义输入得到允许类型"
 *   指识别结果落在允许集合内（可测试且不把创作自由度钉死）；
 * - **受控降级**：数据不足时按 §10.3 的阶梯降级（CHART→QUOTE→SOURCE_CARD→TEXTUAL_EXPLANATION→REQUEST_DATA，
 *   与 P04-02 的 planFactVisual 同一事实来源），绝不编造图形数据；
 * - 映射表与 V1 的 20 个标准组件对齐（DEC-04），数据驱动、可版本化（后续可由 Channel/Policy 覆盖）。
 */

/** §10.1 语义类型（基础 23 + 财经扩展 11 = 34） */
export const SEMANTIC_TYPES = [
  // 基础
  'NUMBER',
  'KPI_SET',
  'TREND',
  'COMPARISON',
  'RANKING',
  'TIMELINE',
  'CAUSE_EFFECT',
  'FEEDBACK_LOOP',
  'FLOW',
  'GEOGRAPHY',
  'NETWORK',
  'PROCESS',
  'QUOTE',
  'SOURCE',
  'PERSON',
  'COMPANY',
  'DOCUMENT',
  'IMAGE_EVIDENCE',
  'VIDEO_EVIDENCE',
  'CONCEPT',
  'TRANSITION',
  'SUMMARY',
  'HOST_STATEMENT',
  // 财经扩展
  'YIELD_SPREAD',
  'YIELD_CURVE',
  'PRICE_SERIES',
  'CANDLE_SERIES',
  'PERCENT_CHANGE',
  'BALANCE_SHEET',
  'SUPPLY_DEMAND',
  'TRADE_FLOW',
  'CAPITAL_FLOW',
  'POLICY_PATH',
  'SCENARIO_COMPARE',
] as const;

export const semanticTypeSchema = z.enum(SEMANTIC_TYPES);
export type SemanticType = z.infer<typeof semanticTypeSchema>;

/** 识别方法（确定性优先；LLM/MANUAL 为兜底与人工覆盖） */
export const RECOGNITION_METHODS = ['DETERMINISTIC', 'LLM', 'MANUAL'] as const;
export const recognitionMethodSchema = z.enum(RECOGNITION_METHODS);
export type RecognitionMethod = z.infer<typeof recognitionMethodSchema>;

/**
 * 语义 → 允许场景类型的映射规则（数据驱动；`requiresData` 表示"事实图表"类，
 * 绑定数据集前必须过 P04-02 的 checkChartBinding）。
 */
export const visualGrammarRuleSchema = z.object({
  semanticType: semanticTypeSchema,
  /** 允许的场景类型（V1 标准 20 类为主；未在该集合中的类型属后续阶段） */
  allowedSceneTypes: z.array(z.string().min(1)).min(1),
  /** 优先顺序（前端/编辑器默认选择；必须 ⊆ allowedSceneTypes） */
  preferredSceneTypes: z.array(z.string().min(1)).default([]),
  /** 是否要求真实结构化数据（事实图表） */
  requiresData: z.boolean().default(false),
  /** 是否要求可追溯来源（Source Card/Quote 类） */
  requiresSource: z.boolean().default(false),
  /** 数据不足时的降级顺序（默认为 §10.3 阶梯） */
  fallbackOrder: z.array(z.enum(['CHART', 'SOURCE_CARD', 'QUOTE', 'TEXTUAL_EXPLANATION', 'REQUEST_DATA'])).default([
    'CHART',
    'SOURCE_CARD',
    'QUOTE',
    'TEXTUAL_EXPLANATION',
    'REQUEST_DATA',
  ]),
});

export type VisualGrammarRule = z.infer<typeof visualGrammarRuleSchema>;

export const VISUAL_GRAMMAR_VERSION = 'visual-grammar-v1';

/** 识别证据（可审计：为什么判定为该语义） */
export const recognitionEvidenceSchema = z.object({
  method: recognitionMethodSchema,
  confidence: z.number().min(0).max(1),
  /** 触发规则（如 'dataset_trend'、'keyword_cause_effect'） */
  rule: z.string().min(1).max(80),
  reasons: z.array(z.string().max(200)).default([]),
});

export type RecognitionEvidence = z.infer<typeof recognitionEvidenceSchema>;

/** 单个事实/旁白块的视觉计划条目 */
export const visualPlanItemSchema = z.object({
  /** 关联的叙事旁白块（来自 NarrativePlan；人工/无叙事时为 null） */
  narrationBlockId: opaqueIdSchema.nullable().default(null),
  claimIds: z.array(opaqueIdSchema).default([]),
  semanticType: semanticTypeSchema,
  recognition: recognitionEvidenceSchema,
  allowedSceneTypes: z.array(z.string().min(1)).min(1),
  /** 建议选择（允许集合的优先项） */
  suggestedSceneType: z.string().min(1),
  /** 事实图表的数据绑定（已过 P04-02 门控；null = 无） */
  datasetId: opaqueIdSchema.nullable().default(null),
  /** 必须写入 Scene 的 data_source_ids（§10.3） */
  dataSourceIds: z.array(opaqueIdSchema).default([]),
  /** 降级决策（数据不足时；CHART 且已绑定时为 null） */
  fallbackStrategy: z.enum(['CHART', 'SOURCE_CARD', 'QUOTE', 'TEXTUAL_EXPLANATION', 'REQUEST_DATA']).nullable().default(null),
  warnings: z.array(z.string().max(200)).default([]),
});

export type VisualPlanItem = z.infer<typeof visualPlanItemSchema>;

export const visualPlanSchema = z.object({
  schemaVersion: z.string().min(1),
  grammarVersion: z.string().min(1),
  planId: opaqueIdSchema,
  items: z.array(visualPlanItemSchema).default([]),
  summary: z.object({
    total: z.number().int().nonnegative(),
    chartItems: z.number().int().nonnegative(),
    degradedItems: z.number().int().nonnegative(),
    /** 语义分布（可审计） */
    bySemanticType: z.record(z.string(), z.number().int().nonnegative()).default({}),
  }),
});

export type VisualPlan = z.infer<typeof visualPlanSchema>;

export const VISUAL_GRAMMAR_ERROR_REASONS = {
  /** 无匹配语义（已降级为 HOST_STATEMENT；不是错误，但记录原因） */
  SEMANTIC_TYPE_UNKNOWN: 'SEMANTIC_TYPE_UNKNOWN',
  /** 允许集合为空（映射表缺陷；应显式失败） */
  NO_ALLOWED_SCENE_TYPE: 'NO_ALLOWED_SCENE_TYPE',
} as const;

export type VisualGrammarErrorReason = (typeof VISUAL_GRAMMAR_ERROR_REASONS)[keyof typeof VISUAL_GRAMMAR_ERROR_REASONS];

export const visualGrammarId = opaqueIdSchema;
