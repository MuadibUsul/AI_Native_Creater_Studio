import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * 输出增强包契约（P10-05 / 规范 §4.2、§84、§85、§87；计划 §8）。
 *
 * 纪律（验收："编码参数、授权署名、章节时间**与正式版本一致**"）：
 * - 输出物 = **已批准正式版本的派生物**：全部字段从**冻结快照 + 已批准 manifest** 派生并携带
 *   `manifestHash` / `projectVersionId` 绑定——不引用更新后的项目状态；
 * - **章节时间与正式成片一致**：章节取自冻结快照的章节类场景，逐条校验在 manifest 时长内且单调递增，
 *   不一致 → **明确失败**（CONSISTENCY_VIOLATION，绝不静默夹取）；
 * - **授权署名**：素材署名取自资产许可元数据（P10-03）；缺失署名时记 **warning**（不编造署名文本）；
 * - **标题/Description 可溯源**：每个建议/段落标注 derivedFrom（来源字段），不虚构卖点文案。
 */

export const RENDER_OUTPUT_ENHANCEMENTS_VERSION = 'render-outputs-v1' as const;

export const titleSuggestionSchema = z.object({
  text: z.string().min(1).max(200),
  /** 来源字段（可溯源：不凭空生成标题） */
  source: z.enum(['PROJECT_TITLE', 'SUMMARY_SCENE', 'CHAPTER_TITLE', 'NARRATIVE_HEADING']),
});

export type TitleSuggestion = z.infer<typeof titleSuggestionSchema>;

export const descriptionSchema = z.object({
  text: z.string().min(1).max(5000),
  /** 段落的组成来源（模板化派生；逐项给出） */
  derivedFrom: z.array(z.string().max(200)).min(1),
});

export const outputChapterSchema = z.object({
  index: z.number().int().nonnegative(),
  sceneId: opaqueIdSchema,
  startMs: z.number().int().nonnegative(),
  title: z.string().min(1).max(200),
});

export type OutputChapter = z.infer<typeof outputChapterSchema>;

/** 文本来源（project_sources 快照；与冻结快照的 sourceBindings 一致） */
export const outputSourceEntrySchema = z.object({
  sourceId: opaqueIdSchema,
  title: z.string().min(1).max(500),
  url: z.string().min(1).max(1000),
  publisher: z.string().min(1).max(200),
  author: z.string().max(200).nullable().default(null),
  excerpt: z.string().max(500),
  snapshotKind: z.string().min(1).max(40),
  /** 被哪些场景引用（可追溯——同一来源可能在多处被引用） */
  referencedBySceneIds: z.array(opaqueIdSchema).default([]),
});

export type OutputSourceEntry = z.infer<typeof outputSourceEntrySchema>;

/** 素材署名（许可元数据来自资产系统；attributionRequired 且缺文本 → 计入 warnings，不编造） */
export const outputAssetAttributionSchema = z.object({
  assetId: opaqueIdSchema,
  role: z.string().min(1).max(40),
  displayName: z.string().max(200).nullable().default(null),
  origin: z.string().min(1).max(40),
  licenseType: z.string().max(40).nullable().default(null),
  attributionRequired: z.boolean(),
  attributionText: z.string().max(500).nullable().default(null),
  sourceUrl: z.string().max(1000).nullable().default(null),
});

export type OutputAssetAttribution = z.infer<typeof outputAssetAttributionSchema>;

/** 封面（THUMBNAIL 产物引用；artifact 缺失 = null 字段 + warning——不假称有封面） */
export const outputThumbnailSchema = z.object({
  /** 帧位（与渲染 spec 同源选择规则；毫秒） */
  atMs: z.number().int().nonnegative(),
  frame: z.number().int().nonnegative(),
  /** manifest 中的产物事实（null = 该渲染无封面产物） */
  fileName: z.string().max(200).nullable().default(null),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).nullable().default(null),
});

export type OutputThumbnail = z.infer<typeof outputThumbnailSchema>;

export const renderOutputEnhancementsSchema = z.object({
  schemaVersion: z.literal(RENDER_OUTPUT_ENHANCEMENTS_VERSION),
  renderId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  projectVersionId: opaqueIdSchema,
  profile: z.string().min(1),
  /** 与已批准 manifest 的**同一事实**（发布物与正式版本绑定） */
  manifestHash: z.string().regex(/^[0-9a-f]{64}$/),
  approvalId: opaqueIdSchema,
  /** 编码参数（来自 manifest/正式版本——不重算、不改写） */
  format: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().int().positive() }),
  durationMs: z.number().int().positive(),
  titles: z.array(titleSuggestionSchema).min(1),
  description: descriptionSchema,
  chapters: z.array(outputChapterSchema),
  sources: z.array(outputSourceEntrySchema),
  assetAttributions: z.array(outputAssetAttributionSchema),
  thumbnail: outputThumbnailSchema,
  /** 一致性校验记录（checked = 已核验项；warnings = 需人工关注但未阻止） */
  consistency: z.object({
    checked: z.array(z.string().max(120)),
    warnings: z.array(z.string().max(300)),
  }),
  generatedAt: isoDateTimeSchema,
});

export type RenderOutputEnhancements = z.infer<typeof renderOutputEnhancementsSchema>;

export const RENDER_OUTPUTS_ERROR_REASONS = {
  RENDER_NOT_READY: 'RENDER_NOT_READY',
  NOT_APPROVED: 'NOT_APPROVED',
  APPROVAL_STALE: 'APPROVAL_STALE',
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
  MANIFEST_UNAVAILABLE: 'MANIFEST_UNAVAILABLE',
  /** 与正式版本不一致（章节越界/单调性/manifest 绑定不符等）——明确失败，不静默修正 */
  CONSISTENCY_VIOLATION: 'CONSISTENCY_VIOLATION',
} as const;

export type RenderOutputsErrorReason = (typeof RENDER_OUTPUTS_ERROR_REASONS)[keyof typeof RENDER_OUTPUTS_ERROR_REASONS];
