import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { approvalTierSchema } from './autonomy.js';

/**
 * 自主制作运行（裁决 0020，Proposal 0.1 §2.1 A / AP-05）：用户一次交代需求、签好授权，AI 自己完成
 * 等素材理解 → 制作计划 → 粗剪 → 自检修复 → 按档位采用 → 交付报告；之后可进共看片室精修同一个工程。
 *
 * - 运行经工作流 AUTONOMOUS_PRODUCTION 执行（外部 / 付费调用只经工作流）；同一工程同一时刻只有一个进行中的运行；
 * - V6-9 的自主制作不调用付费生成；导演模型的花费计入签署的总预算（硬上限）；
 * - 交付报告如实写出：用了哪些原片、哪些是生成内容、自检发现、节奏偏差、没满足的约束、实际花费（含未定价的调用）。
 */

export const AUTONOMOUS_PRODUCTION_WORKFLOW = 'AUTONOMOUS_PRODUCTION';
export const AUTONOMOUS_PRODUCTION_WORKFLOW_VERSION = 1;

export const AUTONOMOUS_RUN_STATUSES = ['WAITING_FOR_FOOTAGE', 'DIRECTING', 'CHECKING', 'DELIVERED', 'NEEDS_REVIEW', 'FAILED', 'CANCELLED'] as const;
export const autonomousRunStatusSchema = z.enum(AUTONOMOUS_RUN_STATUSES);
export type AutonomousRunStatus = z.infer<typeof autonomousRunStatusSchema>;
export const AUTONOMOUS_RUN_ACTIVE_STATUSES = ['WAITING_FOR_FOOTAGE', 'DIRECTING', 'CHECKING'] as const satisfies readonly AutonomousRunStatus[];

export const startAutonomousRunRequestSchema = z.object({
  /** 一句话需求（成片目标、受众、平台、风格……） */
  goal: z.string().trim().min(1).max(2000),
  /** 目标成片时长（秒）；null = 由导演按素材决定 */
  targetDurationSeconds: z.number().int().min(5).max(3600).nullable().default(null),
  /** 可选风格（策略包）与旋钮 */
  strategyPackId: opaqueIdSchema.nullable().default(null),
  strategyKnobs: z.record(z.string().max(60), z.string().max(60)).default({}),
  /** AI 回应与交付说明的语言（界面语言） */
  locale: z.enum(['zh-CN', 'en']).default('zh-CN'),
}).strict();
export type StartAutonomousRunRequest = z.input<typeof startAutonomousRunRequestSchema>;

const secondsPairSchema = z.tuple([z.string().max(20), z.string().max(20)]);

/**
 * 交付报告里"没满足 / 要留意"的代码：
 * TARGET_DURATION 成片时长与目标相差超过 20%（detail "目标秒数/实际秒数"）；NO_FOOTAGE_USED 成片里没有用到原片；
 * BUDGET_REACHED 模型花费到了本次上限；ITERATION_LIMIT 步骤用完；UNPRICED_MODEL 导演模型没有价格表、花费无法核算。
 */
export const AUTONOMOUS_UNMET_CODES = ['TARGET_DURATION', 'NO_FOOTAGE_USED', 'BUDGET_REACHED', 'MONTHLY_AI_LIMIT', 'ITERATION_LIMIT', 'UNPRICED_MODEL'] as const;

export const autonomousReportSchema = z.object({
  /** ADOPTED 已采用为作品当前版本；TRIAL 保留为试改等你看；NO_CHANGES 没有改动；FAILED 没能完成 */
  outcome: z.enum(['ADOPTED', 'TRIAL', 'NO_CHANGES', 'FAILED']),
  /** 导演的交付说明（原话） */
  note: z.string().max(4000).nullable(),
  /** 为什么没有自动采用（ASK_EACH 档位、自检没过、授权在运行中被改动或撤回……）；采用了为 null */
  notAdoptedReason: z.enum(['APPROVAL_ASK_EACH', 'REVIEW_GATE', 'AUTHORIZATION_CHANGED', 'PROJECT_CHANGED', 'NO_CHANGES', 'TURN_FAILED']).nullable(),
  /** 成片长度（秒）、画面片段数（素材与生成镜头，不含随画面带入的声音片段与特效图层）、字幕条数 */
  timeline: z.object({ lengthSeconds: z.string().max(20), clips: z.number().int().nonnegative(), captions: z.number().int().nonnegative() }).strict(),
  sources: z.object({
    /** 画面里来自你的素材的部分（秒） */
    footage: z.array(z.object({ footageId: opaqueIdSchema, name: z.string().max(200), seconds: z.string().max(20) }).strict()).max(200),
    /** 生成内容（特效图层、合成讲述、付费生成）：类型与秒数 */
    generated: z.array(z.object({ kind: z.enum(['EFFECT', 'NARRATION', 'GENERATED_VIDEO']), name: z.string().max(200), seconds: z.string().max(20) }).strict()).max(200),
    /** 画面时长里原片所占比例（0–1） */
    originalShare: z.number().min(0).max(1).nullable(),
  }).strict(),
  review: z.object({
    warnings: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative(),
    findings: z.array(z.object({ kind: z.string().max(40), severity: z.enum(['warning', 'info']), at: secondsPairSchema, message: z.string().max(500) }).strict()).max(40),
    notChecked: z.array(z.string().max(200)).max(20),
  }).strict(),
  pace: z.object({
    cutsPerMinute: z.number().nonnegative(),
    wordsPerSecond: z.number().nonnegative().nullable(),
    target: z.object({ cutsPerMinute: z.number().nullable(), wordsPerSecond: z.number().nullable() }).strict().nullable(),
    deviations: z.array(z.object({ at: secondsPairSchema, component: z.enum(['cutDensity', 'speechRate']), measured: z.number(), target: z.number(), direction: z.enum(['FASTER', 'SLOWER']) }).strict()).max(60),
  }).strict().nullable(),
  plan: z.object({ version: z.number().int().positive(), logline: z.string().max(300), scenes: z.number().int().nonnegative(), intents: z.number().int().nonnegative() }).strict().nullable(),
  /** 没能满足的约束或要留意的情况（界面按代码翻译；detail 是数值或原文） */
  unmet: z.array(z.object({ code: z.enum(AUTONOMOUS_UNMET_CODES), detail: z.string().max(300) }).strict()).max(20),
  cost: z.object({ spentMicros: z.number().int().nonnegative(), budgetMicros: z.number().int().nonnegative().nullable(), unpricedCalls: z.number().int().nonnegative() }).strict(),
}).strict();
export type AutonomousReport = z.infer<typeof autonomousReportSchema>;

export const autonomousRunSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  status: autonomousRunStatusSchema,
  goal: z.string(),
  targetDurationSeconds: z.number().int().nullable(),
  strategyPackId: opaqueIdSchema.nullable(),
  approval: approvalTierSchema,
  /** 运行开始时签署的授权版本（运行中授权被改动或撤回 → 不自动采用） */
  policyVersion: z.number().int().positive(),
  budgetMicros: z.number().int().nonnegative(),
  /** 这次运行给导演模型的花费上限（总预算减去之前已花的，再留出一次调用的余量）；开始导演前为 null */
  modelCapMicros: z.number().int().nonnegative().nullable(),
  locale: z.enum(['zh-CN', 'en']),
  turnId: opaqueIdSchema.nullable(),
  workflowRunId: opaqueIdSchema.nullable(),
  proposalId: opaqueIdSchema.nullable(),
  adoptedRevision: z.number().int().nonnegative().nullable(),
  /** 进行中：AI 已做的步骤数与最近一步的摘要（来自轮次的工具记录） */
  progress: z.object({ steps: z.number().int().nonnegative(), lastStep: z.string().max(500).nullable(), lastTool: z.string().max(80).nullable() }).strict(),
  report: autonomousReportSchema.nullable(),
  error: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
}).strict();
export type AutonomousRun = z.infer<typeof autonomousRunSchema>;

export const AUTONOMOUS_RUN_ERROR_REASONS = {
  RUN_IN_PROGRESS: 'AUTONOMOUS_RUN_IN_PROGRESS',
  RUN_NOT_FOUND: 'AUTONOMOUS_RUN_NOT_FOUND',
  NOT_CANCELLABLE: 'AUTONOMOUS_RUN_NOT_CANCELLABLE',
  /** 等了太久素材还没准备好，或工程里一直没有素材 */
  FOOTAGE_TIMEOUT: 'AUTONOMOUS_FOOTAGE_TIMEOUT',
  NO_FOOTAGE: 'AUTONOMOUS_NO_FOOTAGE',
  /** 用户正在和 AI 说话，等了太久这一轮还没结束 */
  SESSION_BUSY: 'AUTONOMOUS_SESSION_BUSY',
} as const;
