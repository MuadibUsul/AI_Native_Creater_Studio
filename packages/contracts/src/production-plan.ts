import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isDecimalSecondsText } from './common/media-time.js';

/**
 * 导演蓝图与场景契约（裁决 0020 第 4 条，Proposal 0.1 §5.2 / AP-04；含 Proposal 0.2 A0 剪辑意图）。
 *
 * - **规划视图，不是第二套真相**：时间线只由 ProjectDocument + 编辑操作 + 版本日志决定；规划记录是可重建、带版本的
 *   附属记录，引用制定时的工程版本号；过期时如实标注，不阻塞编辑；
 * - 蓝图（慢变量）：作品一句话主旨、受众、开场承诺、结构、情绪弧线、节奏、风格、必须保留与避免；
 * - 场景契约（可重排）：每段的叙事功能、大致时间窗、用到的素材区间、需要的制作、验收要点，以及"为什么这样剪"的剪辑意图；
 * - 剪辑意图（0.2 A0）：固定枚举 + 目标感受 + 理由 + 被放弃的备选（让"开头不够抓人"这类反馈能定位到要改的意图）。
 * 时间一律是十进制秒文本（时间线上的位置；素材区间是素材内的位置）。
 */

export const EDIT_INTENT_TYPES = ['HOOK', 'SETUP', 'EMPHASIS', 'RHYTHM', 'COVER_JUMP', 'BREATHE', 'PAYOFF', 'TRANSITION', 'INFORM'] as const;
export const editIntentTypeSchema = z.enum(EDIT_INTENT_TYPES);
export type EditIntentType = z.infer<typeof editIntentTypeSchema>;

const secondsTextSchema = z.string().max(20).refine(isDecimalSecondsText, 'seconds must be a decimal string such as "12.5"');
const planIdSchema = z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_.-]+$/, 'ids use letters, digits, _ . -');

export const planTimeRangeSchema = z.object({ start: secondsTextSchema, end: secondsTextSchema }).strict()
  .refine((value) => Number(value.end) > Number(value.start), { message: 'end must be after start', path: ['end'] });

export const editIntentSchema = z.object({
  id: planIdSchema,
  type: editIntentTypeSchema,
  /** 想让观众有的感受（如"先给出最美的画面作为开场承诺"） */
  targetFeeling: z.string().trim().min(1).max(300),
  /** 为什么这样剪（依据什么素材、什么判断） */
  reason: z.string().trim().min(1).max(500),
  timeRange: planTimeRangeSchema.nullable().default(null),
  /** 证据：素材区间或分析记录的引用（如 "av_123@12.0-15.5"） */
  evidence: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  rejectedAlternatives: z.array(z.object({ description: z.string().trim().min(1).max(200), reason: z.string().trim().min(1).max(300) }).strict()).max(5).default([]),
}).strict();
export type EditIntent = z.infer<typeof editIntentSchema>;

export const sceneSourceSchema = z.object({
  footageId: opaqueIdSchema,
  from: secondsTextSchema,
  to: secondsTextSchema,
}).strict().refine((value) => Number(value.to) > Number(value.from), { message: '"to" must be after "from"', path: ['to'] });

export const sceneContractSchema = z.object({
  id: planIdSchema,
  title: z.string().trim().min(1).max(80),
  /** 这一段的叙事功能（如"解释转折原因并保留原话"） */
  goal: z.string().trim().min(1).max(300),
  /** 在成片里的大致位置（时间线秒） */
  window: planTimeRangeSchema.nullable().default(null),
  sources: z.array(sceneSourceSchema).max(30).default([]),
  /** 需要的制作（如 CAPTIONS、TITLE_CARD、B_ROLL、MUSIC、NARRATION），自由短词 */
  needs: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  /** 验收要点（如"不丢原话""音画同步"） */
  acceptance: z.array(z.string().trim().min(1).max(120)).max(6).default([]),
  intents: z.array(editIntentSchema).max(12).default([]),
}).strict();
export type SceneContract = z.infer<typeof sceneContractSchema>;

export const narrativeBlueprintSchema = z.object({
  /** 一句话主旨 */
  logline: z.string().trim().min(1).max(300),
  audience: z.string().trim().max(200).default(''),
  /** 开场承诺：开头几秒让观众留下来的理由 */
  openingPromise: z.string().trim().max(300).default(''),
  /** 叙事结构（如"钩子 → 出发 → 冰川 → 回望"） */
  structure: z.string().trim().min(1).max(500),
  emotionArc: z.string().trim().max(300).default(''),
  pacing: z.string().trim().max(300).default(''),
  styleNotes: z.string().trim().max(500).default(''),
  targetDurationSeconds: z.number().positive().max(4 * 3600).nullable().default(null),
  mustKeep: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
  avoid: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
}).strict();
export type NarrativeBlueprint = z.infer<typeof narrativeBlueprintSchema>;

/** 导演工具 plan_production 的输入（也是规划记录的内容）：场景 id 与意图 id 在同一份计划里不得重复。 */
export const productionPlanInputSchema = z.object({
  blueprint: narrativeBlueprintSchema,
  scenes: z.array(sceneContractSchema).min(1).max(40),
}).strict().superRefine((value, context) => {
  const sceneIds = new Set<string>();
  const intentIds = new Set<string>();
  value.scenes.forEach((scene, sceneIndex) => {
    if (sceneIds.has(scene.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'id'], message: `duplicate scene id ${scene.id}` });
    sceneIds.add(scene.id);
    scene.intents.forEach((intent, intentIndex) => {
      if (intentIds.has(intent.id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['scenes', sceneIndex, 'intents', intentIndex, 'id'], message: `duplicate intent id ${intent.id}` });
      intentIds.add(intent.id);
    });
  });
});
export type ProductionPlanInput = z.input<typeof productionPlanInputSchema>;

export const productionPlanSchema = z.object({
  id: opaqueIdSchema,
  projectId: opaqueIdSchema,
  /** 这条视频的第几版计划（从 1 起） */
  version: z.number().int().positive(),
  /** 制定计划时的工程版本号 */
  baseRevision: z.number().int().nonnegative(),
  /** 工程当前版本号（读取时填写；与 baseRevision 不同说明计划之后作品又改过） */
  currentRevision: z.number().int().nonnegative(),
  turnId: opaqueIdSchema.nullable(),
  blueprint: narrativeBlueprintSchema,
  scenes: z.array(sceneContractSchema),
  createdAt: z.string().datetime(),
}).strict();
export type ProductionPlan = z.infer<typeof productionPlanSchema>;
