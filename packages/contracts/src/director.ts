import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { moneySchema } from './common/money.js';
import { priceUnitSchema } from './providers.js';
import { assetTypeSchema, assetRoleSchema } from './assets.js';
import { durationMsSchema } from './common/time.js';
import { idempotencyKeySchema } from './common/http.js';

/**
 * Director 契约（P04-05 / 规范 §9；计划 §8 P04-05）。
 *
 * Director 的输出（§9.2）：Scene Graph 草稿 + 资产计划 + Provider 任务计划 + 成本估算 + 风险/告警 +
 * 简短决策摘要。纪律：
 * - 输出**必须先通过 Schema、来源、Lock、预算规则验证**才能应用（计划 P04-05 验收）；
 * - 视觉策略（§9.4）是**可配置默认值**（Channel Profile / Director Policy），不是硬编码业务规则；
 * - 不硬编码模型名与价格（REQ-16-03）：成本估算全部来自 Provider Catalog 的价格档案；
 * - 不产生付费调用：任务计划只描述"将要发生什么"，应用阶段也不提交 Provider 任务。
 */

export const DIRECTOR_PLAN_VERSION = 'director-v1';

/**
 * Director 视觉策略（§9.4 的"初始建议值"作为默认，可被请求覆盖；Channel/Director Policy 存储随后续任务接入）。
 */
export const directorPolicySchema = z.object({
  /** Avatar 总占比下限（默认 0.15） */
  avatarRatioMin: z.number().min(0).max(1).default(0.15),
  /** Avatar 总占比上限（默认 0.30） */
  avatarRatioMax: z.number().min(0).max(1).default(0.3),
  /** 单段连续 Avatar 上限（默认 22s，§9.4 "< 20～25 秒" 的中值） */
  maxContinuousAvatarMs: z.number().int().positive().default(22_000),
  /** 期望的视觉变化间隔（默认 8s，§9.4 "每 4～12 秒至少有明显视觉变化" 的中值） */
  visualChangeIntervalMs: z.number().int().positive().default(8_000),
  /** AI Video 占时长比例上限（默认 0.15，§9.4 "低于 10%～20%" 的中值） */
  maxAiVideoRatio: z.number().min(0).max(1).default(0.15),
  /** 章节标题场景时长（结构常量，默认 2.5s；可配置） */
  titleSceneMs: z.number().int().positive().default(2_500),
});

export type DirectorPolicy = z.infer<typeof directorPolicySchema>;
export type DirectorPolicyInput = z.input<typeof directorPolicySchema>;

export const directorWarningSchema = z.object({
  code: z.string().min(1).max(80),
  severity: z.enum(['INFO', 'WARNING', 'BLOCKER']),
  message: z.string().min(1).max(400),
  sceneIds: z.array(opaqueIdSchema).default([]),
});

export type DirectorWarning = z.infer<typeof directorWarningSchema>;

export const DIRECTOR_WARNING_CODES = {
  /** 视觉计划已按 §10.3 降级（数据/来源不足） */
  DATA_DEGRADED: 'DATA_DEGRADED',
  /** 需要数据的场景没有可绑定数据集 */
  MISSING_DATA: 'MISSING_DATA',
  /** 能力缺少可用 Provider（应用不阻塞；生成时会被明确阻止） */
  NO_CALLABLE_PROVIDER: 'NO_CALLABLE_PROVIDER',
  /** 缺少价格档案 → 成本不可知 */
  COST_UNKNOWN: 'COST_UNKNOWN',
  /** 未设置预算（= 不限制；仅提示） */
  BUDGET_UNSET: 'BUDGET_UNSET',
  /** 预算已耗尽（应用被阻止） */
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  /** Avatar 占比低于策略下限 */
  AVATAR_RATIO_BELOW_MIN: 'AVATAR_RATIO_BELOW_MIN',
  /** Avatar 占比高于策略上限 */
  AVATAR_RATIO_ABOVE_MAX: 'AVATAR_RATIO_ABOVE_MAX',
  /** 单段连续 Avatar 超过策略上限 */
  AVATAR_CONTINUOUS_TOO_LONG: 'AVATAR_CONTINUOUS_TOO_LONG',
  /** 视觉变化间隔超过策略（场景类型长时间不变） */
  VISUAL_CHANGE_TOO_SPARSE: 'VISUAL_CHANGE_TOO_SPARSE',
  /** AI Video 占比超过策略上限 */
  AI_VIDEO_RATIO_ABOVE_MAX: 'AI_VIDEO_RATIO_ABOVE_MAX',
  /** 锁定旁白块已逐字保留并锁定（INFO） */
  LOCKED_PRESERVED: 'LOCKED_PRESERVED',
  /** 无旁白块（空计划） */
  EMPTY_PLAN: 'EMPTY_PLAN',
} as const;

export type DirectorWarningCode = (typeof DIRECTOR_WARNING_CODES)[keyof typeof DIRECTOR_WARNING_CODES];

/** 场景的资产需求（资产计划的来源；应用时不自动获取资产，只登记需求） */
export const directorAssetRequirementSchema = z.object({
  role: assetRoleSchema,
  assetType: assetTypeSchema,
  required: z.boolean(),
  reason: z.string().min(1).max(300),
});

export type DirectorAssetRequirement = z.infer<typeof directorAssetRequirementSchema>;

/** Director 规划的场景（应用时映射为 insert_scene 编辑操作） */
export const directorSceneSchema = z.object({
  /** 规划期稳定 ID（`dsc_<planPrefix>_<n>`；应用于 Scene id 由服务器另行生成） */
  sceneId: z.string().min(1).max(120),
  position: z.number().int().nonnegative(),
  chapterId: opaqueIdSchema.nullable().default(null),
  /** 对应旁白块（逻辑 ID；结构场景如章节标题为空） */
  narrationBlockIds: z.array(opaqueIdSchema).default([]),
  narration: z.string().default(''),
  semanticType: z.string().min(1),
  sceneType: z.string().min(1),
  durationMs: durationMsSchema,
  /** 锁定旁白 → 锁定场景（AI 不得静默修改；§4.7） */
  locked: z.boolean().default(false),
  claimIds: z.array(opaqueIdSchema).default([]),
  /** 事实图表绑定（已过 P04-02 门控；非图表为 null） */
  datasetId: opaqueIdSchema.nullable().default(null),
  /** 必须写入 Scene 的 data_source_ids（§10.3；图表场景非空） */
  dataSourceIds: z.array(opaqueIdSchema).default([]),
  /** 已按 §10.3 降级（fallbackStrategy ≠ CHART） */
  degraded: z.boolean().default(false),
  visualIntent: z.string().max(400).default(''),
  /** 需要的能力（表达能力需求，不保存供应商请求字段；§4.5） */
  capabilities: z.array(z.string().min(1)).default([]),
  assetRequirements: z.array(directorAssetRequirementSchema).default([]),
  warnings: z.array(z.string().max(300)).default([]),
});

export type DirectorScene = z.infer<typeof directorSceneSchema>;

/** 资产计划条目（按资产类型/角色聚合，跨场景去重） */
export const directorAssetPlanItemSchema = z.object({
  key: z.string().min(1).max(120),
  role: assetRoleSchema,
  assetType: assetTypeSchema,
  required: z.boolean(),
  /** 获取策略：已有工具链（上传/导入/系统渲染/生成） */
  strategy: z.enum(['USER_UPLOAD', 'SOURCE_IMPORT', 'PROVIDER_GENERATE', 'SYSTEM_RENDER']),
  /** PROVIDER_GENERATE 时的能力标识（如 image.generate） */
  capability: z.string().min(1).nullable().default(null),
  sceneIds: z.array(z.string().min(1)).default([]),
  reason: z.string().min(1).max(300),
});

export type DirectorAssetPlanItem = z.infer<typeof directorAssetPlanItemSchema>;

/** Provider 任务计划条目（不提交调用；仅描述意图 + 成本估算） */
export const directorProviderJobPlanSchema = z.object({
  capability: z.string().min(1).max(120),
  /** 计划中的任务数（如逐场景语音合成） */
  jobCount: z.number().int().nonnegative(),
  sceneIds: z.array(z.string().min(1)).default([]),
  /** 计费单位与数量（如 CHARACTER × 字符数） */
  unit: priceUnitSchema.nullable().default(null),
  units: z.number().nonnegative().nullable().default(null),
  /** 选中的模型（Catalog 中**可真实调用**的条目；未核验目录 → null + blocked） */
  modelRef: z.object({ providerId: z.string().min(1), modelId: z.string().min(1) }).nullable().default(null),
  estimatedCost: moneySchema.nullable().default(null),
  /** 无可用模型 → 任务被明确阻止（fail-closed，不静默） */
  blocked: z.boolean().default(false),
  blockedReason: z.string().max(300).nullable().default(null),
});

export type DirectorProviderJobPlan = z.infer<typeof directorProviderJobPlanSchema>;

export const directorPlanSchema = z.object({
  schemaVersion: z.string().min(1),
  directorVersion: z.literal(DIRECTOR_PLAN_VERSION),
  projectId: opaqueIdSchema,
  narrativePlanId: opaqueIdSchema,
  narrativePlanRevision: z.number().int().positive(),
  visualGrammarVersion: z.string().min(1),
  /** 本次解析后的视觉策略（可审计：是默认值还是请求覆盖） */
  policy: directorPolicySchema,
  policyOverridden: z.boolean().default(false),
  scenes: z.array(directorSceneSchema).default([]),
  assetPlan: z.array(directorAssetPlanItemSchema).default([]),
  providerJobs: z.array(directorProviderJobPlanSchema).default([]),
  estimatedDurationMs: z.number().int().nonnegative(),
  estimatedCost: z.object({
    /** KNOWN = 全部可估；PARTIAL = 部分可估；UNKNOWN = 全部不可估（无可用模型/价格） */
    certainty: z.enum(['KNOWN', 'PARTIAL', 'UNKNOWN']),
    total: moneySchema.nullable().default(null),
    note: z.string().max(300).nullable().default(null),
  }),
  warnings: z.array(directorWarningSchema).default([]),
  /** 应用被阻止（如预算耗尽）；阻止原因可审计 */
  blocked: z.boolean().default(false),
  blockedReasons: z.array(z.string().min(1).max(120)).default([]),
  /** 简短决策摘要（§9.2；一句话说明"为什么这样安排"） */
  decisionSummary: z.string().min(1).max(1000),
  generation: z.object({
    method: z.literal('DETERMINISTIC'),
    /** 未来：LLM 参与规划时的模型与提示词版本（§52/§53） */
    modelVersion: z.string().nullable().default(null),
    promptVersion: z.string().nullable().default(null),
  }),
});

export type DirectorPlan = z.infer<typeof directorPlanSchema>;

export const directorApplyRequestSchema = z.object({
  /** 视觉策略覆盖（不提供则用默认值） */
  policy: directorPolicySchema.partial().optional(),
  /** 自然语言意图（写入 EditEvent，供 History 展示） */
  intent: z.string().max(500).optional(),
  /** 幂等键（编辑协议 §4.6 信封字段） */
  idempotencyKey: idempotencyKeySchema,
});

export type DirectorApplyRequest = z.input<typeof directorApplyRequestSchema>;

export const DIRECTOR_APPLY_ERROR_REASONS = {
  /** 项目已有场景（Director 应用要求空项目；先编辑的项目应使用编辑协议） */
  SCENES_EXIST: 'SCENES_EXIST',
  /** 来源规则验证失败（图表场景缺少 data_source_ids） */
  SOURCE_VALIDATION_FAILED: 'SOURCE_VALIDATION_FAILED',
  /** Lock 规则验证失败（锁定旁白未被锁定保留） */
  LOCK_VALIDATION_FAILED: 'LOCK_VALIDATION_FAILED',
  /** 预算规则验证失败（预算耗尽） */
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED',
  /** 空计划（无场景可应用） */
  EMPTY_PLAN: 'EMPTY_PLAN',
} as const;

export type DirectorApplyErrorReason = (typeof DIRECTOR_APPLY_ERROR_REASONS)[keyof typeof DIRECTOR_APPLY_ERROR_REASONS];
