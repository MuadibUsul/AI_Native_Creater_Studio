import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';

/**
 * Content Atom / Channel Recipe / Channel Fit 契约（P11-02 / 规范 §93.2—93.4；计划 §8）。
 *
 * 纪律（验收）：
 * - **Atom 可独立追溯来源**：创建必须携带 ≥1 条来源引用（claimId 或 sourceId），且引用必须在项目内
 *   真实存在（否则 422）——Atom 永远不是凭空单元；
 * - **Recipe 是版本化数据**（同 Plan 范式：channelKey+version 唯一，需求为数据而非硬编码）；
 * - **Fit 是规则化评估**： verdict ∈ RECOMMENDED / OPTIONAL / NOT_RECOMMENDED + 逐条原因——
 *   **NOT_RECOMMENDED 是正常结果（200）而非错误**（"不得默认一篇文章自动制造所有平台垃圾内容"）。
 */

export const ATOM_KINDS = ['KEY_NUMBER', 'CONCLUSION', 'CAUSAL_RELATION', 'QUESTION_ANSWER', 'TIMELINE_SPAN', 'IMPACT', 'SUB_TOPIC'] as const;
export const atomKindSchema = z.enum(ATOM_KINDS);
export type AtomKind = z.infer<typeof atomKindSchema>;

/** 来源引用（二选一或并存：声明级 / 来源级——"独立追溯"的载体） */
export const atomSourceRefSchema = z.object({
  claimId: opaqueIdSchema.nullable().default(null),
  sourceId: opaqueIdSchema.nullable().default(null),
});

export type AtomSourceRef = z.infer<typeof atomSourceRefSchema>;

export const contentAtomSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  kind: atomKindSchema,
  title: z.string().min(1).max(200),
  /** 独立传播正文（逐字取自来源或作者显式输入；不由迁移/AI 编造） */
  text: z.string().min(1).max(2000),
  /** 来源引用（≥1；可追溯到具体声明或来源快照） */
  sourceRefs: z.array(atomSourceRefSchema).min(1),
  /** 种类相关载荷（KEY_NUMBER: {value,unit}；CAUSAL_RELATION: {cause,effect}；QUESTION_ANSWER: {question,answer}…） */
  payload: z.record(z.string(), z.unknown()).default({}),
  createdBy: opaqueIdSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
});

export type ContentAtom = z.infer<typeof contentAtomSchema>;

export const createAtomRequestSchema = z.object({
  kind: atomKindSchema,
  title: z.string().min(1).max(200),
  text: z.string().min(1).max(2000),
  sourceRefs: z.array(atomSourceRefSchema).min(1),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type CreateAtomRequest = z.infer<typeof createAtomRequestSchema>;

export const ATOM_ERROR_REASONS = {
  /** 来源引用为空或不存在于项目内（claims/sources 均无此 id）——Atom 必须可追溯 */
  SOURCE_REF_NOT_TRACEABLE: 'SOURCE_REF_NOT_TRACEABLE',
} as const;

/* ---------- Channel Recipe（版本化数据） ---------- */

export const CHANNEL_FIT_VERDICTS = ['RECOMMENDED', 'OPTIONAL', 'NOT_RECOMMENDED'] as const;
export const channelFitVerdictSchema = z.enum(CHANNEL_FIT_VERDICTS);
export type ChannelFitVerdict = z.infer<typeof channelFitVerdictSchema>;

/** 渠道需求（**数据**；评估引擎只消费这些字段——新增渠道不改代码） */
export const channelRequirementsSchema = z.object({
  /** 成片时长窗口（null = 不限） */
  durationMinMs: z.number().int().nonnegative().nullable().default(null),
  durationMaxMs: z.number().int().nonnegative().nullable().default(null),
  /** 已核实事实下限（不足 → NOT_RECOMMENDED） */
  minFacts: z.number().int().nonnegative().default(0),
  /** 关键数字 Atom 下限（不足 → NOT_RECOMMENDED） */
  minNumberAtoms: z.number().int().nonnegative().default(0),
  /** Atom 总数下限（不足 → OPTIONAL：素材偏薄） */
  minAtoms: z.number().int().nonnegative().default(0),
  /** 需要时间线素材（缺失 → OPTIONAL） */
  requiresTimeline: z.boolean().default(false),
  /** 页数窗口（图文/Carousel 类渠道的形态约束；null = 不限） */
  pageCountMin: z.number().int().positive().nullable().default(null),
  pageCountMax: z.number().int().positive().nullable().default(null),
  /** 文本长度限制（文字类渠道；null = 未定义——validate 明示未核验，不猜） */
  postMaxChars: z.number().int().positive().nullable().default(null),
  threadMaxPosts: z.number().int().positive().nullable().default(null),
  threadPostMaxChars: z.number().int().positive().nullable().default(null),
  newsletterMaxChars: z.number().int().positive().nullable().default(null),
});

export type ChannelRequirements = z.infer<typeof channelRequirementsSchema>;

export const channelRecipeSchema = z.object({
  id: opaqueIdSchema,
  channelKey: z.string().min(1).max(60),
  version: z.number().int().positive(),
  name: z.string().min(1).max(120),
  description: z.string().min(1).max(500),
  requirements: channelRequirementsSchema,
  status: z.enum(['ACTIVE', 'RETIRED']).default('ACTIVE'),
  createdAt: isoDateTimeSchema,
});

export type ChannelRecipe = z.infer<typeof channelRecipeSchema>;

/* ---------- Channel Fit（评估结果；NOT_RECOMMENDED = 200 正常结果） ---------- */

export const channelFitReasonSchema = z.object({
  code: z.string().min(1).max(60),
  message: z.string().min(1).max(300),
  /** blocking 原因存在 → NOT_RECOMMENDED；否则建议性 */
  severity: z.enum(['BLOCKING', 'ADVISORY', 'SATISFIED']),
});

export type ChannelFitReason = z.infer<typeof channelFitReasonSchema>;

export const channelFitSchema = z.object({
  projectId: opaqueIdSchema,
  channelKey: z.string().min(1).max(60),
  recipeId: opaqueIdSchema,
  recipeVersion: z.number().int().positive(),
  verdict: channelFitVerdictSchema,
  reasons: z.array(channelFitReasonSchema).min(1),
  /** 评估输入快照（核心计数 + Atom 计数——可复核） */
  inputs: z.object({
    factCount: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
    atomCount: z.number().int().nonnegative(),
    numberAtomCount: z.number().int().nonnegative(),
    timelineAtomCount: z.number().int().nonnegative(),
    /** 内容核心的输入摘要（P11-01；核心未迁移时为 null → 评估基于原始侧实时计数） */
    coreInputsDigest: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
  }),
  evaluatedAt: isoDateTimeSchema,
});

export type ChannelFit = z.infer<typeof channelFitSchema>;

export const CHANNEL_FIT_ERROR_REASONS = {
  /** 渠道 Key 无 ACTIVE Recipe */
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
} as const;
