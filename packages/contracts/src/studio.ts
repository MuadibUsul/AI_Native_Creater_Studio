import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { agentLocaleSchema, agentSessionSchema, projectAgentCostSchema } from './agent.js';
import { projectArticleSchema } from './narration.js';
import { generationBudgetSchema, generationSchema } from './paid-generation.js';

/**
 * V6-1c 共看片室（Studio）：素材剪辑工程的单屏工作台。
 *
 * - 新建：一步建好素材工程（FOOTAGE_EDIT）+ 主序列（帧时基）+ AI 导演会话；
 * - 状态：一次读取工程、序列、会话、素材（上传/理解进度）与本条视频的 AI 成本，界面据此轮询；
 * - 撤销这次修改：把最近一次改动（同一版本号产生的全部事件，例如采用一个 AI 提案）作为一组撤销。
 */

export const STUDIO_ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;
export const studioAspectRatioSchema = z.enum(STUDIO_ASPECT_RATIOS);

export const createStudioProjectRequestSchema = z.object({
  title: z.string().trim().min(1).max(120),
  aspectRatio: studioAspectRatioSchema.default('16:9'),
  locale: agentLocaleSchema.default('zh-CN'),
  /**
   * V6-5 从文章开始：文章原文（可选）。有文章时建图文工程（HYBRID：允许程序化图解与字幕，不允许生成画面），
   * `narration` 为真时同时允许 AI 合成配音讲述（用户在新建时明确选择）。
   */
  article: projectArticleSchema.optional(),
  narration: z.boolean().optional(),
}).strict().refine((value) => value.narration === undefined || value.article !== undefined, { message: 'narration is chosen together with an article', path: ['narration'] });
export type CreateStudioProjectRequest = z.input<typeof createStudioProjectRequestSchema>;

export const studioProjectRefSchema = z.object({
  projectId: opaqueIdSchema,
  sequenceId: opaqueIdSchema,
  sessionId: opaqueIdSchema,
}).strict();
export type StudioProjectRef = z.infer<typeof studioProjectRefSchema>;

/** NONE = 没排队；WORKING = 排队或进行中；READY / EMPTY（分析完但没有内容）/ NOT_CONFIGURED（驱动未配置，不是分析失败）/ FAILED。 */
export const STUDIO_ANALYSIS_STATES = ['NONE', 'WORKING', 'READY', 'EMPTY', 'NOT_CONFIGURED', 'FAILED'] as const;
export const studioAnalysisStateSchema = z.enum(STUDIO_ANALYSIS_STATES);
export type StudioAnalysisState = z.infer<typeof studioAnalysisStateSchema>;

export const studioFootageSchema = z.object({
  assetId: opaqueIdSchema,
  /** 当前版本 id（AI 放片段时用的 footageId）；上传未完成时为空 */
  footageId: opaqueIdSchema.nullable(),
  name: z.string(),
  kind: z.enum(['video', 'audio', 'image', 'other']),
  status: z.enum(['UPLOADING', 'PROCESSING', 'READY', 'FAILED']),
  /** 时长（十进制秒文本，显示用） */
  duration: z.string().nullable(),
  understanding: z.object({
    index: studioAnalysisStateSchema,
    transcript: studioAnalysisStateSchema,
    visual: studioAnalysisStateSchema,
  }).strict(),
}).strict();
export type StudioFootage = z.infer<typeof studioFootageSchema>;

/** 时间线上的特效图层（V6-3）：AI 渲染出的透明图层视频；时间带据此给片段标名，不出现在素材列表里。 */
export const studioEffectSchema = z.object({
  /** 图层的资产版本 id（片段引用的 footageId） */
  footageId: opaqueIdSchema,
  name: z.string(),
  templateId: z.string().nullable(),
  source: z.enum(['TEMPLATE', 'CODE']),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
}).strict();
export type StudioEffect = z.infer<typeof studioEffectSchema>;

/** 时间线上的讲述音频（V6-5）：AI 合成的配音；时间带据此给讲述片段标名，不出现在素材列表里。 */
export const studioNarrationSchema = z.object({
  /** 讲述音频的资产版本 id（片段引用的 footageId） */
  footageId: opaqueIdSchema,
  text: z.string(),
  voice: z.string(),
  engine: z.string(),
}).strict();
export type StudioNarration = z.infer<typeof studioNarrationSchema>;

export const studioStateSchema = z.object({
  project: z.object({
    id: opaqueIdSchema,
    title: z.string(),
    aspectRatio: z.string(),
    revision: z.number().int().nonnegative(),
    /** 项目制作规则是否允许程序化特效（素材工程默认关闭，用户可显式开启） */
    allowEffects: z.boolean(),
    /** 项目制作规则是否允许 AI 合成配音讲述（V6-5） */
    allowNarration: z.boolean(),
    /** 项目制作规则是否允许付费生成画面（数字人出镜、生成镜头、选区重绘；V6-7/V6-8） */
    allowGeneratedVideo: z.boolean(),
    /** 从文章开始的工程：文章概况（原文在工程简报里） */
    article: z.object({ title: z.string(), characters: z.number().int().nonnegative(), paragraphs: z.number().int().nonnegative() }).strict().nullable(),
  }).strict(),
  sequenceId: opaqueIdSchema,
  /** 该序列最近的 AI 会话；没有时为空（只读读面不代建，界面在第一次说话前经 agent 接口建会话） */
  session: agentSessionSchema.nullable(),
  footage: z.array(studioFootageSchema),
  effects: z.array(studioEffectSchema),
  narration: z.array(studioNarrationSchema),
  /** 付费生成（报价、进行中、结果；新的在前，最多 20 条） */
  generations: z.array(generationSchema),
  /** 工作区生成预算（确认生成前展示；未设置时确认会被拒绝） */
  generationBudget: generationBudgetSchema,
  cost: projectAgentCostSchema,
}).strict();
export type StudioState = z.infer<typeof studioStateSchema>;

export const undoChangeResponseSchema = z.object({
  /** 本次撤销掉的事件数 */
  undoneEvents: z.number().int().positive(),
  projectRevision: z.number().int().nonnegative(),
}).strict();
export type UndoChangeResponse = z.infer<typeof undoChangeResponseSchema>;
