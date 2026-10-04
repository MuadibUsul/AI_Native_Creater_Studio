import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';

/**
 * SpeechPlan 契约（P04-06 / 规范 §94 Speech Director、§6.4 SpeechProfile、§95）。
 *
 * 原则：
 * - **供应商无关**：SpeechPlan 只表达"怎么念"的语义控制（语速/能量/语气指令/停顿/强调/发音覆盖），
 *   **不出现任何 Provider 私有参数**（provider voice id、模型 id 等）——映射层在合成 Adapter（§94 末款）；
 * - 身份引用只带 `voiceIdentityId + version`（不含 provider/providerVoiceId 字段——那些留在身份资产与
 *   凭据系统，绝不进入计划/图表数据）；
 * - 不支持的风格参数必须**可解释降级**（clamp + 记录 requested/applied），不得静默丢弃；
 * - Audio-First（§5.1）：本计划的 expectedDuration 只是估计，真实 timing 由 Master Narration 的
 *   逐段对齐（P06-03）决定。
 */

export const SPEECH_PLAN_VERSION = 'speech-plan-v1';

/** 场景角色（§94 默认规则：Hook / 解释 / 关键数字 / 引用 / 结论） */
export const SPEECH_SCENE_ROLES = ['HOOK', 'BODY', 'EXPLANATION', 'NUMBER', 'QUOTE', 'CONCLUSION'] as const;
export const speechSceneRoleSchema = z.enum(SPEECH_SCENE_ROLES);
export type SpeechSceneRole = z.infer<typeof speechSceneRoleSchema>;

export const SPEECH_WARNING_CODES = {
  /** 无可用 TTS Provider：风格参数支持情况未核验（合成时按 Adapter 能力映射/降级） */
  STYLE_SUPPORT_UNVERIFIED: 'STYLE_SUPPORT_UNVERIFIED',
  /** 语速超出支持范围被钳制（可解释降级） */
  SPEED_CLAMPED: 'SPEED_CLAMPED',
  /** 能量超出 [0,1] 被钳制 */
  ENERGY_CLAMPED: 'ENERGY_CLAMPED',
  /** 未绑定声音身份：计划可用，但合成前必须绑定（否则生成会被阻止） */
  NO_VOICE_IDENTITY: 'NO_VOICE_IDENTITY',
  /** 预计时长与目标时长偏差较大（真实时长由对齐决定） */
  TARGET_DURATION_DEVIATION: 'TARGET_DURATION_DEVIATION',
  /** 锁定旁白逐字使用（INFO） */
  LOCKED_PRESERVED: 'LOCKED_PRESERVED',
} as const;

export type SpeechWarningCode = (typeof SPEECH_WARNING_CODES)[keyof typeof SPEECH_WARNING_CODES];

export const speechWarningSchema = z.object({
  code: z.string().min(1).max(80),
  severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
  message: z.string().min(1).max(400),
  segmentId: z.string().min(1).nullable().default(null),
});

export type SpeechWarning = z.infer<typeof speechWarningSchema>;

/** 停顿（afterCharIndex=0 表示段首） */
export const speechPauseSchema = z.object({
  afterCharIndex: z.number().int().nonnegative(),
  durationMs: z.number().int().positive(),
  reason: z.string().min(1).max(80),
});

export type SpeechPause = z.infer<typeof speechPauseSchema>;

/** 强调区间（关键数字/引用；字符下标 [startChar, endChar)） */
export const speechEmphasisSpanSchema = z.object({
  startChar: z.number().int().nonnegative(),
  endChar: z.number().int().nonnegative(),
  reason: z.string().min(1).max(80),
});

export type SpeechEmphasisSpan = z.infer<typeof speechEmphasisSpanSchema>;

export const speechSegmentSchema = z.object({
  /** 段落稳定 ID（`spk_<planPrefix>_<n>`） */
  segmentId: z.string().min(1).max(120),
  narrationBlockId: opaqueIdSchema.nullable().default(null),
  /** Director 场景引用（若已规划；Director 还未运行时为 null） */
  sceneId: z.string().min(1).nullable().default(null),
  text: z.string().default(''),
  charCount: z.number().int().nonnegative(),
  sceneRole: speechSceneRoleSchema,
  /** 有效语速（profile 默认 × 角色修正，已按 [0.5, 2] 钳制） */
  speed: z.number().min(0.5).max(2),
  /** 有效能量（0—1，已钳制） */
  energy: z.number().min(0).max(1),
  /** 语气指令（供应商无关文本；映射到真实参数由 Adapter 负责） */
  toneInstruction: z.string().max(300),
  styleInstruction: z.string().max(300),
  pauses: z.array(speechPauseSchema).default([]),
  emphasisSpans: z.array(speechEmphasisSpanSchema).default([]),
  pronunciationOverrides: z.array(z.object({ term: z.string().min(1).max(80), reading: z.string().min(1).max(120) })).default([]),
  /** 估计时长（基准 220 字/分钟 ÷ 有效语速；真实时长由对齐决定） */
  expectedDurationMs: z.number().int().positive(),
  locked: z.boolean().default(false),
  /** 段级可解释降级（requested → applied） */
  degradations: z
    .array(z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(300) }))
    .default([]),
});

export type SpeechSegment = z.infer<typeof speechSegmentSchema>;

export const speechPlanSchema = z.object({
  schemaVersion: z.string().min(1),
  speechPlanVersion: z.literal(SPEECH_PLAN_VERSION),
  projectId: opaqueIdSchema,
  narrativePlanId: opaqueIdSchema,
  narrativePlanRevision: z.number().int().positive(),
  /** 身份引用（**不含 provider/providerVoiceId**；Provider 私有参数由合成 Adapter 映射，§94） */
  voice: z.object({
    voiceIdentityId: opaqueIdSchema.nullable().default(null),
    voiceIdentityVersion: z.number().int().positive().nullable().default(null),
  }),
  speechProfile: z.object({
    id: opaqueIdSchema.nullable().default(null),
    version: z.number().int().positive().nullable().default(null),
    source: z.enum(['REQUEST', 'CHANNEL', 'IDENTITY', 'DEFAULT']),
  }),
  targetDurationMs: z.number().int().positive().nullable().default(null),
  expectedDurationMs: z.number().int().nonnegative(),
  segments: z.array(speechSegmentSchema).default([]),
  warnings: z.array(speechWarningSchema).default([]),
  decisionSummary: z.string().min(1).max(1000),
  generation: z.object({
    method: z.literal('DETERMINISTIC'),
    modelVersion: z.string().nullable().default(null),
    promptVersion: z.string().nullable().default(null),
  }),
});

export type SpeechPlan = z.infer<typeof speechPlanSchema>;

/**
 * 角色修正（§94 默认规则的数值化；V1 常量，可被请求覆盖——不是硬编码业务规则）。
 * speedMultiplier 作用于 profile.defaultSpeed；energyDelta 作用于 profile.energy。
 */
export const speechStyleRuleSchema = z.object({
  speedMultiplier: z.number().positive().max(2),
  energyDelta: z.number().min(-1).max(1),
});
export type SpeechStyleRule = z.infer<typeof speechStyleRuleSchema>;

export const SPEECH_ROLE_STYLE_DEFAULTS: Record<SpeechSceneRole, SpeechStyleRule> = {
  HOOK: { speedMultiplier: 1.05, energyDelta: 0.15 },
  BODY: { speedMultiplier: 1, energyDelta: 0 },
  EXPLANATION: { speedMultiplier: 0.95, energyDelta: 0 },
  NUMBER: { speedMultiplier: 0.95, energyDelta: 0.05 },
  QUOTE: { speedMultiplier: 1, energyDelta: -0.05 },
  CONCLUSION: { speedMultiplier: 0.98, energyDelta: -0.05 },
};

export const speechStyleOverridesSchema = z
  .object({
    HOOK: speechStyleRuleSchema.partial().optional(),
    BODY: speechStyleRuleSchema.partial().optional(),
    EXPLANATION: speechStyleRuleSchema.partial().optional(),
    NUMBER: speechStyleRuleSchema.partial().optional(),
    QUOTE: speechStyleRuleSchema.partial().optional(),
    CONCLUSION: speechStyleRuleSchema.partial().optional(),
  })
  .optional();

export type SpeechStyleOverrides = z.infer<typeof speechStyleOverridesSchema>;
