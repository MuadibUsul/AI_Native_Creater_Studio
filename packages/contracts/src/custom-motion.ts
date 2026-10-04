import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { durationMsSchema, isoDateTimeSchema } from './common/time.js';
import { themeTokensSchema } from './theme.js';

/**
 * Custom Motion 生成与验证契约（P07-02 / 规范 §11.2、§11.2 安全 MUST 10 条；计划 §8 P07-02）。
 *
 * 流程（生成 → 门禁 → 版本化）：
 *   场景上下文 + 品牌 tokens → **Motion Designer（LLM 结构化输出：代码/依赖）**
 *   → 四道门禁（静态分析 → 类型检查 → 沙箱评估 → 多帧渲染抽帧）
 *   → **仅 APPROVED 落库**（代码/依赖/输入/产物版本；失败不进入项目——拒绝只留在任务错误里）；
 *
 * 纪律（§11.2）：
 * - 生成代码**默认零依赖**（`MOTION_DEPENDENCY_WHITELIST` 为空集）：沙箱只注入白名单全局
 *   （registerMotion/React/hooks/确定性 remotion 语义），不引入任何模块加载能力；
 * - 代码在**隔离沙箱**执行（P07-01：子进程 + vm 白名单上下文 + 硬超时）；像素级成片合成
 *   （网络阻断的浏览器渲染）属部署层（P08）——见 docs/decisions/0008。
 */

export const MOTION_PROMPT_VERSION = 'motion-design-v1';
export const MOTION_VALIDATION_REPORT_VERSION = 'motion-validation-v1';

/**
 * 依赖白名单（V1 = 空集：代码只可使用沙箱注入的全局；模块加载词法一律拒绝）。
 * "只允许白名单依赖"（§11.2-3）在 V1 的落点 = 依赖集合必须 ⊆ 本白名单。
 */
export const MOTION_DEPENDENCY_WHITELIST: readonly string[] = [];

export const CUSTOM_MOTION_ERROR_REASONS = {
  /** 场景不存在/跨工作区 */
  SCENE_NOT_FOUND: 'SCENE_NOT_FOUND',
  /** 未配置 LLM（fail-closed） */
  LLM_UNAVAILABLE: 'LLM_UNAVAILABLE',
  /** LLM 输出不是合法结构化结果（有界修复后仍失败） */
  INVALID_LLM_OUTPUT: 'INVALID_LLM_OUTPUT',
  /** 声明了白名单之外的依赖 */
  DEPENDENCY_NOT_ALLOWED: 'DEPENDENCY_NOT_ALLOWED',
  /** 四道门禁任一未通过（细节在 report；不进入项目） */
  VALIDATION_REJECTED: 'VALIDATION_REJECTED',
  /** 对象存储未配置（产物版本必须落自有存储） */
  STORAGE_UNAVAILABLE: 'STORAGE_UNAVAILABLE',
} as const;

export type CustomMotionErrorReason = (typeof CUSTOM_MOTION_ERROR_REASONS)[keyof typeof CUSTOM_MOTION_ERROR_REASONS];

/** Motion Designer 的结构化输出（LLM 唯一被接受的形态） */
export const motionComponentDraftSchema = z.object({
  /** 组件名（PascalCase；进入组件标识） */
  name: z
    .string()
    .min(3)
    .max(48)
    .regex(/^[A-Z][A-Za-z0-9]*$/, '组件名必须是 PascalCase 标识符'),
  description: z.string().min(1).max(300),
  /** 组件源码（沙箱执行：不得含模块加载/网络/文件/进程/动态执行——词法门禁拒绝） */
  code: z.string().min(20).max(20_000),
  /** 依赖集合；必须 ⊆ MOTION_DEPENDENCY_WHITELIST（V1 为空集） */
  dependencies: z.array(z.string().min(1).max(80)).max(8).default([]),
});

export type MotionComponentDraft = z.infer<typeof motionComponentDraftSchema>;

/** 验证输入 fixture（确定性：帧/画幅/时长全部固定；沙箱 smoke 与抽帧用同一 fixture） */
export const motionValidationFixtureSchema = z.object({
  props: z.record(z.string(), z.unknown()).default({}),
  fps: z.number().int().positive(),
  durationInFrames: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

export type MotionValidationFixture = z.infer<typeof motionValidationFixtureSchema>;

export const MOTION_VALIDATION_STAGES = ['STATIC_ANALYSIS', 'TYPE_CHECK', 'SANDBOX_EVALUATION', 'FRAME_SAMPLES'] as const;
export const motionValidationStageSchema = z.enum(MOTION_VALIDATION_STAGES);
export type MotionValidationStage = z.infer<typeof motionValidationStageSchema>;

/** 抽帧样本（帧号 + 渲染输出的确定性摘要；markup 截断保存供人工复核） */
export const motionFrameSampleSchema = z.object({
  frame: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  markupLength: z.number().int().nonnegative(),
  markup: z.string().max(20_000).nullable().default(null),
  truncated: z.boolean().default(false),
});

export type MotionFrameSample = z.infer<typeof motionFrameSampleSchema>;

export const motionValidationReportSchema = z.object({
  schemaVersion: z.literal(MOTION_VALIDATION_REPORT_VERSION),
  verdict: z.enum(['APPROVED', 'REJECTED']),
  /** 被验证代码的 SHA-256（与落库版本一致，防"验的是 A、存的是 B"） */
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  analyzerVersion: z.string().min(1),
  stages: z.array(
    z.object({
      stage: motionValidationStageSchema,
      ok: z.boolean(),
      message: z.string().max(600).nullable().default(null),
      details: z.record(z.string(), z.unknown()).default({}),
    }),
  ),
  frames: z.array(motionFrameSampleSchema).default([]),
  renderMs: z.number().int().nonnegative().nullable().default(null),
  warnings: z.array(z.string().max(300)).default([]),
});

export type MotionValidationReport = z.infer<typeof motionValidationReportSchema>;

/**
 * 验证器接口（实现：apps/motion-worker；domain/worker 只依赖本接口——进程隔离由实现决定）。
 * 实现必须遵守 §11.2：隔离沙箱执行、无网络、零依赖、类型检查、静态分析、超时限制。
 */
export interface MotionValidator {
  readonly kind: string;
  validate(input: {
    code: string;
    name: string;
    fixture: MotionValidationFixture;
    /** 抽帧的采样帧（含 0 与末帧；由调用方保证确定性） */
    sampleFrames: number[];
  }): Promise<MotionValidationReport>;
}

/** 生成上下文（LLM 看到什么就存什么——可审计；身份/品牌引用为版本固定） */
export const motionGenerationInputSchema = z.object({
  sceneId: opaqueIdSchema,
  sceneRevision: z.number().int().positive(),
  sceneType: z.string().min(1),
  narration: z.string().max(2000).default(''),
  visualIntent: z.string().max(2000).default(''),
  durationMs: durationMsSchema,
  aspectRatio: z.enum(['16:9', '9:16', '1:1', '4:5']),
  themeTokens: themeTokensSchema.nullable().default(null),
  fixture: motionValidationFixtureSchema,
  brief: z.string().max(600).nullable().default(null),
  promptVersion: z.string().min(1),
  llmModel: z.string().min(1),
});

export type MotionGenerationInput = z.infer<typeof motionGenerationInputSchema>;

/** 组件版本（不可变；仅 APPROVED 落库——"失败不能进入项目"） */
export const customMotionComponentVersionSchema = z.object({
  id: opaqueIdSchema,
  componentId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sceneId: opaqueIdSchema,
  versionNumber: z.number().int().positive(),
  name: z.string().min(1),
  description: z.string().min(1),
  code: z.string().min(1),
  codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  dependencies: z.array(z.string()).default([]),
  input: motionGenerationInputSchema,
  validation: motionValidationReportSchema,
  /** 产物（自有存储）：源码 + 抽帧证据 */
  sourceStorageKey: z.string().min(1),
  framesStorageKey: z.string().min(1),
  createdAt: isoDateTimeSchema,
});

export type CustomMotionComponentVersion = z.infer<typeof customMotionComponentVersionSchema>;

/** 组件身份（跨版本） */
export const customMotionComponentSchema = z.object({
  id: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sceneId: opaqueIdSchema,
  name: z.string().min(1),
  latestVersionNumber: z.number().int().positive(),
  latestVersion: customMotionComponentVersionSchema.nullable().default(null),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export type CustomMotionComponent = z.infer<typeof customMotionComponentSchema>;

/** 发起生成（API 入队；成功后组件版本自动落库） */
export const startCustomMotionRequestSchema = z.object({
  brief: z.string().max(600).optional(),
  /** 幂等键（P06-05 同一约定：重复提交不重复生成） */
  idempotencyKey: z.string().min(8).max(120).optional(),
});

export type StartCustomMotionRequest = z.input<typeof startCustomMotionRequestSchema>;

export const customMotionJobInputSchema = z.object({
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  sceneId: opaqueIdSchema,
  brief: z.string().max(600).nullable().default(null),
  requestedBy: z.string().nullable().default(null),
});

export type CustomMotionJobInput = z.infer<typeof customMotionJobInputSchema>;

/** 帧采样（确定性：首帧 + 中间帧 + 末帧；去重排序） */
export const motionSampleFrames = (durationInFrames: number): number[] => {
  const last = Math.max(0, durationInFrames - 1);
  const middle = Math.max(0, Math.floor(last / 2));
  return [...new Set([0, middle, last])].sort((left, right) => left - right);
};

/** 场景类型约束：P07-02 只服务 CUSTOM_MOTION 语义的场景（不冒充标准组件） */
export const CUSTOM_MOTION_SCENE_TYPE = 'CUSTOM_MOTION';
