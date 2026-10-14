import { z } from 'zod';
import type { SourceMediaProbeResult } from './assets.js';
import { opaqueIdSchema } from './common/ids.js';
import { mediaTimeSchema, rationalSchema } from './common/media-time.js';
import { frameRegionSchema, type FrameRegion } from './frame-region.js';
import { MAX_NARRATION_CHARS } from './narration.js';

/**
 * V6-7 / V6-8 付费生成（V6 §4.3、§7.3、§10、§11）：数字人出镜片段、生成镜头、选区重绘共用一条流程。
 *
 * 1. **报价**：AI 用 `quote_generation` 只建一份报价（供应商、模型、时长、费用区间、有效期），不花钱；
 * 2. **确认**：只有用户在界面上明确确认才开始（API 校验确认的金额与报价一致；AI 不能代为确认）；
 * 3. **预算预留**：按报价上限在工作区预算里原子预留（未设预算 → 拒绝，fail-closed）；
 * 4. **生成**：调用一次，不自动重试；调用后结果不明（超时、进程崩溃）→ 待对账，绝不再次调用；
 * 5. **拉回**：产物写入自有存储并探测（供应商链接不当永久文件）；
 * 6. **放进试改**：作为确认这一轮的提案（在当前试改上继续），和其他修改一样采用/撤回/撤销；
 * 7. **结算**：按供应商报告的实际费用结算；没报告时按报价上限结算并标明；失败且未扣费 → 释放预留。
 *
 * 选区重绘生成后测量圈外画面的变化并如实记录；合成时只取圈内（裁切），圈外画面保证不变。
 */

export const GENERATION_KINDS = ['AVATAR_CLIP', 'VIDEO_SHOT', 'VIDEO_REGION'] as const;
export const generationKindSchema = z.enum(GENERATION_KINDS);
export type GenerationKind = z.infer<typeof generationKindSchema>;

/** 存储状态（EXPIRED 是读出时由 QUOTED + 过期时间推出的显示状态） */
export const GENERATION_STATUSES = ['QUOTED', 'EXPIRED', 'DECLINED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'NEEDS_RECONCILIATION'] as const;
export const generationStatusSchema = z.enum(GENERATION_STATUSES);
export type GenerationStatus = z.infer<typeof generationStatusSchema>;

export const PAID_GENERATION_WORKFLOW = 'PAID_GENERATION';
export const PAID_GENERATION_WORKFLOW_VERSION = 1;

/** 1 Credit 对应的金额（微美元）。规划假设：1 Credit = US$0.01；定价是业务决定，改这里即可。 */
export const MICROS_PER_CREDIT = 10_000;
/** 报价有效期（分钟）：过期后需要重新报价（价格与工程状态都可能变了） */
export const GENERATION_QUOTE_TTL_MINUTES = 30;
/** 单次生成时长硬上限（秒）；供应商声明的上限只能更小 */
export const MAX_GENERATION_SECONDS = 30;
export const MAX_GENERATION_PROMPT_CHARS = 1_000;
/** 生成画面轨名前缀（视频轨） */
export const GENERATION_TRACK_PREFIX = 'GEN';
/** 数字人出镜的人声轨名前缀（音频轨） */
export const AVATAR_VOICE_TRACK_PREFIX = 'AV';
/** 选区重绘：圈外平均像素差（0–255）超过这个值就如实标出"圈外也被改动了"（合成只取圈内，不影响成片） */
export const OUTSIDE_REGION_CHANGE_THRESHOLD = 4;

export const AVATAR_FRAMINGS = ['FULL', 'CORNER'] as const;

/** 生成请求（存储与展示用；时间一律是序列时基上的 MediaTime） */
export const avatarClipRequestSchema = z.object({
  kind: z.literal('AVATAR_CLIP'),
  identityId: opaqueIdSchema,
  script: z.string().trim().min(1).max(MAX_NARRATION_CHARS),
  /** 讲稿语言（BCP 47 主标签）；供应商的声音必须能说 */
  language: z.string().regex(/^[a-z]{2,3}$/),
  at: mediaTimeSchema,
  framing: z.enum(AVATAR_FRAMINGS),
}).strict();

export const videoShotRequestSchema = z.object({
  kind: z.literal('VIDEO_SHOT'),
  prompt: z.string().trim().min(1).max(MAX_GENERATION_PROMPT_CHARS),
  at: mediaTimeSchema,
  duration: mediaTimeSchema,
}).strict();

export const videoRegionRequestSchema = z.object({
  kind: z.literal('VIDEO_REGION'),
  prompt: z.string().trim().min(1).max(MAX_GENERATION_PROMPT_CHARS),
  /** 被重绘的画面片段（时间线上的片段 id） */
  clipId: opaqueIdSchema,
  start: mediaTimeSchema,
  end: mediaTimeSchema,
  region: frameRegionSchema,
}).strict();

export const generationRequestSchema = z.discriminatedUnion('kind', [avatarClipRequestSchema, videoShotRequestSchema, videoRegionRequestSchema]);
export type GenerationRequest = z.infer<typeof generationRequestSchema>;

/** 供应商为某类生成提供的报价依据（Worker 装配时声明；价格为每秒微美元区间） */
export const generationOfferSchema = z.object({
  kind: generationKindSchema,
  providerId: z.string().regex(/^[a-z0-9][a-z0-9:_.-]{0,79}$/),
  /** REAL = 部署方接入的真实供应商；SCRIPTED = 测试替身（只用于测试与演示，不会出现在生产装配里） */
  implementation: z.enum(['REAL', 'SCRIPTED']),
  model: z.string().min(1).max(120),
  perSecondMicros: z.object({ min: z.number().int().nonnegative(), max: z.number().int().positive() }).strict()
    .refine((price) => price.min <= price.max, 'perSecondMicros.min must not exceed max'),
  maxSeconds: z.number().int().min(1).max(MAX_GENERATION_SECONDS),
  /** 数字人：供应商能说的语言（BCP 47 主标签）；其他类型为空 */
  languages: z.array(z.string().regex(/^[a-z]{2,3}$/)).max(40).default([]),
}).strict();
export type GenerationOffer = z.infer<typeof generationOfferSchema>;

export const generationCostSourceSchema = z.enum(['PROVIDER', 'QUOTE_MAX']);

export const generationSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sessionId: opaqueIdSchema.nullable(),
  kind: generationKindSchema,
  status: generationStatusSchema,
  request: generationRequestSchema,
  /** AI 写的一句话说明（会话语言）：要生成什么、放在哪 */
  summary: z.string().max(300),
  providerId: z.string(),
  implementation: z.enum(['REAL', 'SCRIPTED']),
  model: z.string(),
  /** 预计时长（秒，显示用文本） */
  estimatedSeconds: z.string(),
  estimate: z.object({ minMicros: z.number().int().nonnegative(), maxMicros: z.number().int().nonnegative() }).strict(),
  /** 确认时预留的 Credits（= 报价上限换算） */
  reserveCredits: z.number().int().nonnegative(),
  expiresAt: z.string(),
  createdAt: z.string(),
  acceptedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  /** 实际计费（微美元）；失败未扣费为 0；待对账为 null */
  chargedMicros: z.number().int().nonnegative().nullable(),
  costSource: generationCostSourceSchema.nullable(),
  /** 报价所在的 AI 轮次、执行生成的那一轮 */
  quoteTurnId: opaqueIdSchema.nullable(),
  turnId: opaqueIdSchema.nullable(),
  proposalId: opaqueIdSchema.nullable(),
  /** 生成产物（素材版本 id） */
  footageId: opaqueIdSchema.nullable(),
  /** 选区重绘：圈外平均像素差（0–255）；其他类型为空 */
  outsideRegionChange: z.number().nonnegative().nullable(),
  error: z.object({ reason: z.string(), message: z.string() }).strict().nullable(),
}).strict();
export type Generation = z.infer<typeof generationSchema>;

/** 确认生成：带上界面展示的报价上限（与报价不一致 → 409，防止确认的不是看到的价格） */
export const acceptGenerationRequestSchema = z.object({
  expectedMaxMicros: z.number().int().nonnegative(),
}).strict();
export type AcceptGenerationRequest = z.infer<typeof acceptGenerationRequestSchema>;

/** 工作区生成预算概况（共看片室展示用；单位微美元） */
export const generationBudgetSchema = z.object({
  configured: z.boolean(),
  period: z.enum(['DAILY', 'MONTHLY']).nullable(),
  limitMicros: z.number().int().nonnegative().nullable(),
  spentMicros: z.number().int().nonnegative(),
  reservedMicros: z.number().int().nonnegative(),
}).strict();
export type GenerationBudget = z.infer<typeof generationBudgetSchema>;

export const GENERATION_ERROR_REASONS = {
  /** 本部署没有为这类生成配置供应商 */
  UNAVAILABLE: 'GENERATION_UNAVAILABLE',
  TOO_LONG: 'GENERATION_TOO_LONG',
  INVALID_REQUEST: 'GENERATION_INVALID_REQUEST',
  IDENTITY_NOT_FOUND: 'GENERATION_IDENTITY_NOT_FOUND',
  /** 形象或声音没有有效授权（未授权或已撤回） */
  CONSENT_REQUIRED: 'GENERATION_CONSENT_REQUIRED',
  /** 身份档案缺参考照片或声音样本 */
  REFERENCE_REQUIRED: 'GENERATION_REFERENCE_REQUIRED',
  LANGUAGE_UNSUPPORTED: 'GENERATION_LANGUAGE_UNSUPPORTED',
  CLIP_NOT_FOUND: 'GENERATION_CLIP_NOT_FOUND',
  NOT_FOUND: 'GENERATION_NOT_FOUND',
  QUOTE_NOT_PENDING: 'GENERATION_QUOTE_NOT_PENDING',
  QUOTE_EXPIRED: 'GENERATION_QUOTE_EXPIRED',
  ESTIMATE_CHANGED: 'GENERATION_ESTIMATE_CHANGED',
  /** 工作区没有设置生成预算（付费生成 fail-closed） */
  BUDGET_NOT_SET: 'GENERATION_BUDGET_NOT_SET',
  PROVIDER_FAILED: 'GENERATION_PROVIDER_FAILED',
  /** 调用后结果不明（超时、进程崩溃、工作进程中断）：不再调用，等待对账 */
  OUTCOME_UNKNOWN: 'GENERATION_OUTCOME_UNKNOWN',
  OUTPUT_INVALID: 'GENERATION_OUTPUT_INVALID',
  PLACEMENT_FAILED: 'GENERATION_PLACEMENT_FAILED',
  CANCELLED: 'GENERATION_CANCELLED',
} as const;

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 导演工具用到的报价端口（Worker 装配）：只读供应商的报价依据，不能触发生成。 */
export interface AgentGenerationPorts {
  offers(): readonly GenerationOffer[];
}

/** Worker 执行一次生成需要的全部输入（参考素材以存储键给出，由执行器取到本地临时文件）。 */
export interface PaidGenerationJob {
  generationId: string;
  kind: GenerationKind;
  providerId: string;
  prompt: string | null;
  script: string | null;
  language: string | null;
  /** 目标时长（秒，供应商参考；数字人以讲稿实际时长为准） */
  seconds: number;
  /** 产物时长上限（秒）：报价按它计算上限，供应商不得超过 */
  maxSeconds: number;
  width: number;
  height: number;
  frameRate: z.infer<typeof rationalSchema>;
  likeness: { storageKey: string; mimeType: string } | null;
  voice: { storageKey: string; mimeType: string } | null;
  /** 选区重绘：被重绘片段的源素材与源时间范围（秒，十进制文本），以及画面区域 */
  source: { storageKey: string; mimeType: string; startSeconds: string; endSeconds: string } | null;
  region: FrameRegion | null;
}

export interface PaidGenerationProduct {
  video: Uint8Array;
  mimeType: string;
  probe: SourceMediaProbeResult;
  durationMs: number;
  hasAudio: boolean;
  providerJobId: string | null;
  /** 供应商报告的实际费用（微美元）；没报告为 null（按报价上限结算并标明） */
  costMicros: number | null;
  model: string;
  /** 选区重绘：圈外平均像素差（0–255）；其他类型为 null */
  outsideRegionChange: number | null;
}

/**
 * 生成失败：`NOT_CHARGED` = 供应商明确表示没有扣费（释放预留）；`CHARGED` = 失败但已扣费（按 costMicros 结算）；
 * `UNKNOWN` = 结果不明（待对账，预留保持，不再调用）。
 */
export class PaidGenerationFailure extends Error {
  constructor(
    message: string,
    readonly outcome: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN',
    readonly costMicros: number | null = null,
    readonly providerJobId: string | null = null,
  ) {
    super(message);
    this.name = 'PaidGenerationFailure';
  }
}

/** Worker 装配的生成执行器：准备参考素材 → 调用供应商一次 → 读回产物并探测（选区重绘同时测圈外变化）。 */
export interface PaidGenerationExecutor {
  offers(): readonly GenerationOffer[];
  /** `beforeProviderCall` 在真正调用供应商之前执行（记下"已调用"，之后中断即待对账） */
  execute(job: PaidGenerationJob, hooks: { beforeProviderCall(): Promise<void> }): Promise<PaidGenerationProduct>;
}
