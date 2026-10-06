import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { mixPlanSchema } from './mixdown.js';
import { validationResultSchema } from './extensions.js';

/**
 * Podcast 契约（P12-05 / §4.2、§59；计划 §8 P12）。
 *
 * 纪律（验收："去除依赖'看屏幕'的表达；音频元数据、章节和授权完整"）：
 * - **视觉指涉 = 确定性词表移除并逐句披露**（removedSentences 逐块列出——不静默、不改写）；
 *   纯视觉块整块跳过（子集聚合——全空 → 422 NO_AUDIO_CONTENT）；
 * - **章节 = 派生 Master 的真实 cue**（时间戳来自新合成音频的 Alignment——与 P10-05 同纪律：
 *   章节时间必须与实际音频一致，篡改即 error）；
 * - **变体隔离**：Podcast Master（variant='PODCAST'）不进入视频主链（getCurrentMasterNarration 只认
 *   variant='MASTER'）——纯音频派生不得冒充视频母带；
 * - **授权完整**：attribution（来源署名）+ metadata（标题/语言/explicit=false——不编造成人内容标记）；
 *   混音计划（旁白基准轨 + ducking 结构；V1 未绑定 BGM → 显式披露，绑定后重算）。
 */

export const PODCAST_VARIANTS = ['MASTER', 'PODCAST'] as const;
export const podcastVariantSchema = z.enum(PODCAST_VARIANTS);
export type PodcastVariant = z.infer<typeof podcastVariantSchema>;

/** 视觉指涉词表（确定性；命中句 = 依赖"看屏幕"——移除并披露） */
export const VISUAL_REFERENCE_LEXICON = [
  '如图所示',
  '如图',
  '图中',
  '看这里',
  '这一列',
  '这一行',
  '屏幕上',
  '画面中',
  '箭头',
  '横轴',
  '纵轴',
  '表格中',
  '见下图',
  '见上图',
  '下图',
  '上图',
  '看这张图',
  '红色部分',
  '高亮',
] as const;

/** 纯音频改写单元（视觉指涉句移除后逐字保留其余句子；removed 逐句披露） */
export const podcastScriptUnitSchema = z.object({
  narrationBlockId: opaqueIdSchema,
  sourceText: z.string().min(1),
  /** 移除视觉指涉句后的旁白文本（逐字保留；空串 = 整块纯视觉 → 跳过） */
  adaptedText: z.string(),
  removedSentences: z.array(z.string().min(1)).default([]),
});

export type PodcastScriptUnit = z.infer<typeof podcastScriptUnitSchema>;

export const podcastChapterSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
  startMs: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
});

export type PodcastChapter = z.infer<typeof podcastChapterSchema>;

export const podcastEpisodeSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdIdCompat(),
  planId: opaqueIdSchema,
  /** 源（视频）Master Narration——时间戳对照物 */
  sourceNarrationId: opaqueIdSchema,
  /** 纯音频 Master（variant='PODCAST'；全新合成——章节时间来自它的真实 cue） */
  masterNarrationId: opaqueIdSchema,
  language: z.string().min(2).max(20),
  title: z.string().min(1).max(300),
  units: z.array(podcastScriptUnitSchema).min(1),
  /** 被整块跳过的纯视觉块（显式披露） */
  skippedBlockIds: z.array(opaqueIdSchema).default([]),
  coverage: z.object({
    sentencesAdapted: z.number().int().nonnegative(),
    sentencesRemoved: z.number().int().nonnegative(),
    sentencesTotal: z.number().int().nonnegative(),
  }),
  chapters: z.array(podcastChapterSchema).min(1),
  /** 混音计划（旁白基准轨 + ducking 结构；BGM 未绑定显式披露） */
  mixPlan: mixPlanSchema,
  mixNote: z.string().min(1).max(300),
  metadata: z.object({
    /** 播客元数据（标题/语言/内容标记——不编造） */
    title: z.string().min(1).max(300),
    language: z.string().min(2).max(20),
    explicit: z.literal(false),
    /** BGM/片头/片尾素材绑定状态（V1 = 未绑定明示） */
    bgmBound: z.literal(false),
  }),
  /** 授权/署名（来源元数据生成；无来源 → 明示"未收录"） */
  attribution: z.object({
    text: z.string().min(1).max(500),
    sourceIds: z.array(opaqueIdSchema).default([]),
  }),
  createdAt: isoDateTimeSchema,
});

export type PodcastEpisode = z.infer<typeof podcastEpisodeSchema>;

/** 兼容包装（避免与 opaqueIdSchema 命名冲突的内部 helper） */
function opaqueIdIdCompat() {
  return opaqueIdSchema;
}

export const podcastEpisodeListSchema = z.object({
  items: z.array(podcastEpisodeSchema),
});

export type PodcastEpisodeList = z.infer<typeof podcastEpisodeListSchema>;

export const generatePodcastRequestSchema = z.object({
  planId: opaqueIdSchema,
});

export type GeneratePodcastRequest = z.infer<typeof generatePodcastRequestSchema>;

/** 校验结果复用 AI/人工 QA 的 issue 形状（error 阻止 / warning 披露） */
export const podcastValidationResultSchema = z.object({
  episodeId: opaqueIdSchema,
  result: validationResultSchema,
  validatedAt: isoDateTimeSchema,
});

export type PodcastValidationResult = z.infer<typeof podcastValidationResultSchema>;

export const PODCAST_ERROR_REASONS = {
  /** 尚无源（视频）Master Narration */
  PODCAST_SOURCE_MISSING: 'PODCAST_SOURCE_MISSING',
  /** 全部旁白块都是纯视觉指涉（移除后无音频内容） */
  NO_AUDIO_CONTENT: 'NO_AUDIO_CONTENT',
  EPISODE_NOT_FOUND: 'EPISODE_NOT_FOUND',
} as const;

export type PodcastErrorReason = (typeof PODCAST_ERROR_REASONS)[keyof typeof PODCAST_ERROR_REASONS];

export const PODCAST_VALIDATION_CODES = {
  /** 改写脚本仍含视觉指涉词（error——"去除看屏幕表达"未达成） */
  VISUAL_REFERENCE_PRESENT: 'VISUAL_REFERENCE_PRESENT',
  /** 章节与派生 Master 的真实 cue 不一致（error——章节时间必须来自实际音频） */
  CHAPTERS_MISMATCH: 'CHAPTERS_MISMATCH',
  /** 元数据不完整（error——标题/语言/explicit 缺失） */
  METADATA_INCOMPLETE: 'METADATA_INCOMPLETE',
  /** 授权/署名缺失（来源存在但无署名 → error；项目无来源 → warning） */
  ATTRIBUTION_MISSING: 'ATTRIBUTION_MISSING',
  /** 混音计划缺失（error） */
  MIX_PLAN_MISSING: 'MIX_PLAN_MISSING',
  /** 空集（error——无任何可用旁白单元） */
  NO_UNITS: 'NO_UNITS',
  /** 全句披露（warning——移除比例提示） */
  HEAVY_REMOVAL: 'HEAVY_REMOVAL',
} as const;

export type PodcastValidationCode = (typeof PODCAST_VALIDATION_CODES)[keyof typeof PODCAST_VALIDATION_CODES];
