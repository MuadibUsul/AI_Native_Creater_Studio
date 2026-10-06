import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { sceneFormatSchema, sceneGraphSchema } from './scene-graph.js';
import { validationIssueSchema } from './extensions.js';

/**
 * Pack 产物契约（P12-01 Shorts Pack / 规范 §92.1、§93.2；计划 §8 P12）。
 *
 * 纪律（验收："短片可独立理解；来源保留；竖屏安全区正确；原长视频不被修改"）：
 * - **产物只追加**：generate 落 `pack_artifacts` 行——**不写回源项目**（原长视频 Scene Graph/revision 零改动）；
 * - **来源保留**：每个派生场景携带 provenance（Atom→Claim→Source 链），validate 强制逐场景覆盖；
 * - **竖屏安全区**：Pack 在 `scene.props.shortLayout` **自报**文本盒位，validate 对照安全区逐盒检查
 *   （越界 = error；不静默通过）；
 * - **独立可理解**：Hook 前置（首场景且 ≤3s）+ 单主题（所有溯源 Atom ∈ topic.atomIds）+ ≥1 条字幕。
 */

/** 竖屏短视频帧（1080×1920 / 30fps / 9:16） */
export const SHORT_VERTICAL_FRAME = { width: 1080, height: 1920, fps: 30, aspectRatio: '9:16' } as const;

/**
 * 竖屏安全区（1080×1920 帧内四边保留）——平台 UI 遮挡的保守值：
 * 顶部 132px（状态栏/顶部标签）、底部 300px（说明/CTA/进度条）、左右 48px。
 */
export const SHORT_VERTICAL_SAFE_AREA = { topPx: 132, bottomPx: 300, leftPx: 48, rightPx: 48 } as const;

export const shortSafeAreaSchema = z.object({
  topPx: z.number().int().nonnegative(),
  bottomPx: z.number().int().nonnegative(),
  leftPx: z.number().int().nonnegative(),
  rightPx: z.number().int().nonnegative(),
});

export type ShortSafeArea = z.infer<typeof shortSafeAreaSchema>;

export const SHORT_SCENE_ROLES = ['HOOK', 'CONTENT', 'SOURCE'] as const;
export const shortSceneRoleSchema = z.enum(SHORT_SCENE_ROLES);
export type ShortSceneRole = z.infer<typeof shortSceneRoleSchema>;

/** 场景布局声明（写入 `scene.props.shortLayout`；validate 的直接检查对象） */
export const shortSceneLayoutSchema = z.object({
  role: shortSceneRoleSchema,
  box: z.object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export type ShortSceneLayout = z.infer<typeof shortSceneLayoutSchema>;

export const SHORT_LAYOUT_PROP_KEY = 'shortLayout' as const;

/** Hook 文本来源（截断即披露，不静默）：原文为 Atom 标题 / 首句 / 截断 */
export const HOOK_TEXT_SOURCES = ['ATOM_TITLE', 'ATOM_FIRST_SENTENCE', 'TRUNCATED'] as const;

/** 派生 9:16 Scene Graph 载荷（Shorts Pack 的 generate 产物） */
export const derivedSceneGraphPayloadSchema = z.object({
  kind: z.literal('DERIVED_SCENE_GRAPH'),
  format: sceneFormatSchema,
  graph: sceneGraphSchema,
  /** 单主题：本 Short 只讲一个主题（atomIds 即该主题的 Atom 集合） */
  topic: z.object({
    title: z.string().min(1).max(120),
    atomIds: z.array(opaqueIdSchema).min(1),
    /** 覆盖披露：逐字采用/节选的句子覆盖率（节选即披露，不静默丢弃） */
    coverage: z.object({
      sentencesUsed: z.number().int().nonnegative(),
      sentencesTotal: z.number().int().nonnegative(),
    }),
  }),
  hook: z.object({
    sceneId: opaqueIdSchema,
    text: z.string().min(1).max(120),
    durationMs: z.number().int().positive(),
    source: z.enum(HOOK_TEXT_SOURCES),
  }),
  /** 来源链（Atom→Claim→Source）：每个派生场景 ≥1 条 */
  provenance: z
    .array(
      z.object({
        sceneId: opaqueIdSchema,
        atomId: opaqueIdSchema,
        claimIds: z.array(opaqueIdSchema).default([]),
        sourceIds: z.array(opaqueIdSchema).default([]),
      }),
    )
    .min(1),
  safeArea: shortSafeAreaSchema,
});

export type DerivedSceneGraphPayload = z.infer<typeof derivedSceneGraphPayloadSchema>;

/** 产物类型（当前仅 9:16 派生 Graph；P12-02 起扩展图文/信息图载荷） */
export const ARTIFACT_PAYLOAD_KINDS = ['DERIVED_SCENE_GRAPH'] as const;
export const artifactPayloadKindSchema = z.enum(ARTIFACT_PAYLOAD_KINDS);
export type ArtifactPayloadKind = z.infer<typeof artifactPayloadKindSchema>;

export const packArtifactSchema = z.object({
  artifactId: opaqueIdSchema,
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema,
  packId: z.string().min(3).max(120),
  packVersion: z.string().min(1).max(40),
  /** 生成时的血缘锚（analyze 的 PLAN 行——来源链经血缘行可回放） */
  lineageId: opaqueIdSchema,
  payloadKind: artifactPayloadKindSchema,
  title: z.string().min(1).max(200),
  payload: derivedSceneGraphPayloadSchema,
  createdAt: isoDateTimeSchema,
});

export type PackArtifact = z.infer<typeof packArtifactSchema>;

/** 最近一次校验结果（validate 追加行；null = 尚未校验） */
export const artifactValidationResultSchema = z.object({
  artifactId: opaqueIdSchema,
  ok: z.boolean(),
  issues: z.array(validationIssueSchema).default([]),
  validatedAt: isoDateTimeSchema,
});

export type ArtifactValidationResult = z.infer<typeof artifactValidationResultSchema>;

/** 产物视图 = 产物 + 最近校验（列表/生成响应） */
export const packArtifactViewSchema = packArtifactSchema.extend({
  latestValidation: artifactValidationResultSchema.nullable().default(null),
});

export type PackArtifactView = z.infer<typeof packArtifactViewSchema>;

export const packArtifactListSchema = z.object({
  items: z.array(packArtifactViewSchema),
});

export type PackArtifactList = z.infer<typeof packArtifactListSchema>;

export const PACK_ARTIFACT_ERROR_REASONS = {
  /** 尚无 analyze 血缘行（先 analyze 再 generate——来源锚必须存在） */
  ANALYZE_REQUIRED: 'ANALYZE_REQUIRED',
  ARTIFACT_NOT_FOUND: 'ARTIFACT_NOT_FOUND',
  /** 插件未实现 generate 切面（501 明确失败，不静默产出空物） */
  PLUGIN_GENERATE_NOT_IMPLEMENTED: 'PLUGIN_GENERATE_NOT_IMPLEMENTED',
  /** 插件未实现 validate 切面（501） */
  PLUGIN_VALIDATE_NOT_IMPLEMENTED: 'PLUGIN_VALIDATE_NOT_IMPLEMENTED',
} as const;

export type PackArtifactErrorReason = (typeof PACK_ARTIFACT_ERROR_REASONS)[keyof typeof PACK_ARTIFACT_ERROR_REASONS];

/** validate 检查码（问题逐条可读；error 与 warning 语义见 P12-01 验收映射） */
export const SHORT_VALIDATION_CODES = {
  FORMAT_NOT_VERTICAL: 'FORMAT_NOT_VERTICAL',
  LAYOUT_DECLARATION_MISSING: 'LAYOUT_DECLARATION_MISSING',
  SAFE_AREA_VIOLATION: 'SAFE_AREA_VIOLATION',
  PROVENANCE_MISSING: 'PROVENANCE_MISSING',
  HOOK_NOT_FIRST: 'HOOK_NOT_FIRST',
  HOOK_TOO_LONG: 'HOOK_TOO_LONG',
  MIXED_TOPIC: 'MIXED_TOPIC',
  CAPTIONS_MISSING: 'CAPTIONS_MISSING',
  SOURCE_SCENE_MISSING: 'SOURCE_SCENE_MISSING',
  PARTIAL_COVERAGE: 'PARTIAL_COVERAGE',
  DURATION_OUT_OF_RECIPE_WINDOW: 'DURATION_OUT_OF_RECIPE_WINDOW',
  RECIPE_UNAVAILABLE: 'RECIPE_UNAVAILABLE',
} as const;
