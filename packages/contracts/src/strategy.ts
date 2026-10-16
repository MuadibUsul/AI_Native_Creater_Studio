import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * V6 §6.6 策略剪辑（可选功能）：策略包是一份可读、可改、可评测的**数据**，不含执行逻辑。
 *
 * - 选用后，策略要点作为风格参考进入 AI 上下文；AI 仍用全部通用能力规划和执行，
 *   策略与素材或用户要求冲突时以用户和素材为准并说明偏离（裁决 0018）；
 * - 策略不能缩小 AI 可用的工具范围，也不能绕过通用自检；
 * - 来源：内置预设（手写，少量）、蒸馏（V6-6，从参考视频提炼）、用户编辑。
 */

export const STRATEGY_PACK_KINDS = ['BUILT_IN', 'DISTILLED', 'USER'] as const;
export const strategyPackKindSchema = z.enum(STRATEGY_PACK_KINDS);
export type StrategyPackKind = z.infer<typeof strategyPackKindSchema>;

/** 中英双语文本（界面按语言取用）。 */
export const bilingualTextSchema = z.object({
  'zh-CN': z.string().min(1).max(2000),
  en: z.string().min(1).max(2000),
}).strict();
export type BilingualText = z.infer<typeof bilingualTextSchema>;

export const strategyKnobOptionSchema = z.object({
  value: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  label: bilingualTextSchema,
  /** 选这个值时给 AI 的要点（英文，模型侧语言中立） */
  guidance: z.string().max(400),
}).strict();

/** 给用户的少量旋钮：节奏、转场多少、色调强弱、字幕风格…… */
export const strategyKnobSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  label: bilingualTextSchema,
  options: z.array(strategyKnobOptionSchema).min(2).max(6),
  defaultValue: z.string(),
}).strict();
export type StrategyKnob = z.infer<typeof strategyKnobSchema>;

const rangeSchema = z.object({ min: z.number().nonnegative(), max: z.number().nonnegative() }).strict();

/** 可统计的剪辑手法（蒸馏器从参考视频算出；手写预设给出目标区间）。数值都是秒或 0–1 的比例。 */
export const editingDnaSchema = z.object({
  /** 镜头时长分布（秒）：常见区间与中位数 */
  shotSeconds: z.object({ typical: rangeSchema, median: z.number().positive().nullable() }).strict(),
  /** 剪点落在音乐节拍上的比例（0–1；无音乐时为空） */
  beatCutRatio: z.number().min(0).max(1).nullable(),
  /** 景别交替倾向（0 = 很少换景别，1 = 每个镜头都换） */
  shotScaleVariety: z.number().min(0).max(1).nullable(),
  /** 每分钟转场（非硬切）次数、变速次数、推拉/缩放次数 */
  transitionsPerMinute: z.number().nonnegative().nullable(),
  speedRampsPerMinute: z.number().nonnegative().nullable(),
  zoomsPerMinute: z.number().nonnegative().nullable(),
  /** 开场钩子长度（秒） */
  hookSeconds: z.number().nonnegative().nullable(),
  /** 字幕与音效习惯、调色倾向（一句话描述） */
  captionStyle: z.string().max(200).nullable(),
  soundHabits: z.string().max(200).nullable(),
  colorTendency: z.string().max(200).nullable(),
  /** 平均每分钟剪切次数（蒸馏测量；手写预设可空） */
  cutsPerMinute: z.number().nonnegative().nullable().default(null),
  /** 节奏曲线：把视频分成 10 段，每段的每分钟剪切次数（看开场是否最密、是否越剪越快） */
  pacing: z.array(z.number().nonnegative()).length(10).nullable().default(null),
  /** 测量依据：参考视频条数、分析总时长（秒）、镜头数（手写预设为空） */
  measured: z.object({ references: z.number().int().positive(), analyzedSeconds: z.number().positive(), shots: z.number().int().nonnegative() }).strict().nullable().default(null),
}).strict();
export type EditingDna = z.infer<typeof editingDnaSchema>;

export const styleRubricItemSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]{0,31}$/),
  /** 风格贴合度的评分项（英文，给评测与 AI 自检用） */
  criterion: z.string().min(1).max(300),
  weight: z.number().positive().max(10),
}).strict();

export const strategyPackSchema = z.object({
  id: z.string().regex(/^(builtin:[a-z0-9-]{1,60}|stp_[A-Za-z0-9_-]{1,80})$/),
  version: z.number().int().positive(),
  kind: strategyPackKindSchema,
  genre: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  name: bilingualTextSchema,
  /** 一段大白话说明（中英） */
  summary: bilingualTextSchema,
  knobs: z.array(strategyKnobSchema).max(6),
  editingDna: editingDnaSchema,
  /** 段落结构建议（英文） */
  structureHints: z.array(z.string().min(1).max(300)).max(12),
  /** 给 AI 的风格要点（英文提示片段；回应用户仍按会话语言） */
  agentGuidance: z.string().min(1).max(4000),
  styleRubric: z.array(styleRubricItemSchema).max(12),
  /** 蒸馏来源（参考视频资产或链接）；"品味"类特征的可信度说明 */
  source: z.object({
    referenceAssetId: opaqueIdSchema.nullable(),
    referenceUrl: z.string().url().nullable(),
    confidenceNote: z.string().max(500).nullable(),
  }).strict().nullable(),
}).strict();
export type StrategyPack = z.infer<typeof strategyPackSchema>;

/** 列表视图（界面选择用，不含给 AI 的长文本）。 */
export const strategyPackSummarySchema = strategyPackSchema.pick({ id: true, version: true, kind: true, genre: true, name: true, summary: true, knobs: true }).extend({
  createdAt: isoDateTimeSchema.nullable(),
});
export type StrategyPackSummary = z.infer<typeof strategyPackSummarySchema>;

/** 一轮对话选用的策略（可选）：包 + 旋钮取值（缺省用包的默认值）。 */
export const strategyKnobValuesSchema = z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/), z.string().max(32)).default({});
export type StrategyKnobValues = z.infer<typeof strategyKnobValuesSchema>;

export const STRATEGY_ERROR_REASONS = {
  NOT_FOUND: 'STRATEGY_PACK_NOT_FOUND',
  INVALID_KNOB: 'STRATEGY_KNOB_INVALID',
} as const;
