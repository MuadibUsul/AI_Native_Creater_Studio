import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { agentLocaleSchema } from './agent.js';

/**
 * V6 §6.7 蒸馏器（V6-6，可选功能）：参考视频 → 剪辑 DNA → 策略包。
 *
 * - 输入：1–5 条参考视频（同一博主的几条视频合成一个风格，统计更稳）；上传文件，或粘贴链接由服务端抓取。
 *   版权由项目所有者负责；系统只记录来源，不内置审查。平台链接需要部署方配置下载命令；没配置时明确提示改为上传文件。
 * - 分析：确定性测量（FFmpeg：剪点、镜头时长、黑场过渡、画面活跃度、色彩、响度、静音、节拍；有转写层时加语速）。
 *   测量值只来自真实计算，不由模型填写（不得虚构数值）。
 * - 撰写：配置了导演模型时，由模型根据测量与抽帧写风格说明（可信度如实标注）；没配置时按统计规则生成，并在说明里标注。
 * - 输出：一份 DISTILLED 策略包（§6.6），可以先编辑再用；选用后只作为风格参考进入 AI 上下文（裁决 0018）。
 */

export const REFERENCE_DISTILL_WORKFLOW = 'REFERENCE_DISTILL';
export const REFERENCE_DISTILL_WORKFLOW_VERSION = 1;

/** 一次蒸馏最多几条参考视频；每条分析的最长时长（秒，超出部分不分析并在说明里标注） */
export const MAX_DISTILL_REFERENCES = 5;
export const MAX_REFERENCE_ANALYSIS_SECONDS = 15 * 60;

const seconds = z.number().nonnegative().max(24 * 3600);
const ratio = z.number().min(0).max(1);

/** 一条参考视频的测量结果（秒与 0–1 比例；分析统计，不是时间线权威）。 */
export const referenceMeasurementSchema = z.object({
  /** 文件名或链接（显示用） */
  label: z.string().min(1).max(300),
  /** 视频总时长与实际分析的时长 */
  durationSeconds: z.number().positive(),
  analyzedSeconds: z.number().positive(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  frameRate: z.number().positive().nullable(),
  hasAudio: z.boolean(),
  /** 硬切的时刻（秒，不含 0） */
  cuts: z.array(seconds).max(20_000),
  /** 黑场过渡（淡入淡出到黑） */
  blackDips: z.array(z.object({ start: seconds, end: seconds }).strict()).max(2_000),
  /** 画面活跃度：非剪点帧的平均帧间变化（0–1，越大越"动"） */
  sceneActivity: ratio.nullable(),
  /** 色彩：平均亮度、饱和度、对比度（0–1）与冷暖（-1 冷 … 1 暖） */
  color: z.object({ luma: ratio, saturation: ratio, contrast: ratio, warmth: z.number().min(-1).max(1) }).strict().nullable(),
  audio: z.object({
    integratedLufs: z.number().min(-100).max(10).nullable(),
    loudnessRange: z.number().min(0).max(100).nullable(),
    silenceRatio: ratio,
  }).strict().nullable(),
  /** 音乐节拍（规律节拍置信度低时为空） */
  beats: z.object({ bpm: z.number().positive().max(400), confidence: ratio, times: z.array(seconds).max(50_000) }).strict().nullable(),
  /** 说话：有转写层时才有（语速 = 每分钟词数；中文按字计） */
  speech: z.object({ ratio, wordsPerMinute: z.number().nonnegative().nullable(), firstSentenceEnd: seconds.nullable() }).strict().nullable(),
}).strict();
export type ReferenceMeasurement = z.infer<typeof referenceMeasurementSchema>;

/** 参考视频分析端口（Worker：FFmpeg 子进程实现）。 */
export interface ReferenceAnalyzer {
  readonly kind: string;
  analyze(input: { filePath: string; label: string; maxSeconds: number }): Promise<ReferenceMeasurement>;
}

export const REFERENCE_FETCH_FAILURES = ['NOT_CONFIGURED', 'BLOCKED', 'TOO_LARGE', 'NOT_VIDEO', 'FAILED'] as const;
export type ReferenceFetchFailure = (typeof REFERENCE_FETCH_FAILURES)[number];

export class ReferenceFetchError extends Error {
  readonly failure: ReferenceFetchFailure;
  constructor(failure: ReferenceFetchFailure, message: string) {
    super(message);
    this.name = 'ReferenceFetchError';
    this.failure = failure;
  }
}

/**
 * 参考链接抓取端口（Worker）：直接媒体链接走受限 HTTP 下载；平台页面（YouTube、B 站……）走部署方配置的下载命令。
 * 失败以 `ReferenceFetchError` 分类（未配置 / 被拦截 / 太大 / 不是视频 / 失败），界面据此提示改为上传文件。
 */
export interface ReferenceFetcher {
  readonly implementation: 'REAL' | 'SCRIPTED';
  fetch(input: { url: string; workDir: string; maxBytes: number }): Promise<{ filePath: string; contentType: string; title: string | null; finalUrl: string }>;
}

export const distillReferenceInputSchema = z.union([
  z.object({ assetId: opaqueIdSchema }).strict(),
  z.object({ url: z.string().url().max(2000).refine((value) => /^https?:\/\//i.test(value), 'only http(s) links') }).strict(),
]);
export type DistillReferenceInput = z.infer<typeof distillReferenceInputSchema>;

export const startDistillRequestSchema = z.object({
  references: z.array(distillReferenceInputSchema).min(1).max(MAX_DISTILL_REFERENCES),
  /** 风格名（可选；缺省按来源起名） */
  name: z.string().trim().min(1).max(60).nullable().default(null),
  locale: agentLocaleSchema.default('zh-CN'),
}).strict();
export type StartDistillRequest = z.input<typeof startDistillRequestSchema>;

export const DISTILL_STEPS = ['fetch', 'analyze', 'compose', 'save'] as const;
export const distillStepSchema = z.enum(DISTILL_STEPS);

export const DISTILL_ERROR_REASONS = {
  FETCH_NOT_CONFIGURED: 'REFERENCE_FETCH_NOT_CONFIGURED',
  FETCH_BLOCKED: 'REFERENCE_FETCH_BLOCKED',
  FETCH_FAILED: 'REFERENCE_FETCH_FAILED',
  TOO_LARGE: 'REFERENCE_TOO_LARGE',
  NOT_VIDEO: 'REFERENCE_NOT_VIDEO',
  ASSET_NOT_READY: 'REFERENCE_ASSET_NOT_READY',
  ANALYZER_UNAVAILABLE: 'REFERENCE_ANALYZER_UNAVAILABLE',
  ANALYSIS_FAILED: 'REFERENCE_ANALYSIS_FAILED',
  COMPOSE_FAILED: 'STRATEGY_COMPOSE_FAILED',
  PACK_NOT_EDITABLE: 'STRATEGY_PACK_NOT_EDITABLE',
} as const;

/** 一次蒸馏（工作流运行的读视图）。 */
export const distillRunSchema = z.object({
  runId: opaqueIdSchema,
  status: z.enum(['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED']),
  /** 正在进行（或最后停在）的步骤 */
  step: distillStepSchema.nullable(),
  references: z.array(z.object({ label: z.string(), url: z.string().nullable(), assetId: z.string().nullable() }).strict()),
  packId: z.string().nullable(),
  /** 风格说明的撰写方式：模型（看了测量与抽帧）或统计规则 */
  composer: z.enum(['MODEL', 'RULES']).nullable(),
  error: z.object({ reason: z.string(), message: z.string() }).strict().nullable(),
  createdAt: isoDateTimeSchema,
}).strict();
export type DistillRun = z.infer<typeof distillRunSchema>;

/** 编辑策略包（蒸馏 / 用户的包；内置预设不可改）：只改可读文字，测量出的剪辑 DNA 不可手改。 */
export const updateStrategyPackRequestSchema = z.object({
  name: z.object({ 'zh-CN': z.string().trim().min(1).max(60), en: z.string().trim().min(1).max(60) }).strict().optional(),
  summary: z.object({ 'zh-CN': z.string().trim().min(1).max(2000), en: z.string().trim().min(1).max(2000) }).strict().optional(),
  agentGuidance: z.string().trim().min(1).max(4000).optional(),
  structureHints: z.array(z.string().trim().min(1).max(300)).max(12).optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'nothing to update');
export type UpdateStrategyPackRequest = z.infer<typeof updateStrategyPackRequestSchema>;
