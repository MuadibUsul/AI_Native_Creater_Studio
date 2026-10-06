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

/* ---------- P12-02 Social Visual：1:1 / 4:5 / Carousel / 信息图（§3.2、§93.3） ---------- */

/** 平台帧规格（Social Visual 的两种画幅） */
export const SOCIAL_SQUARE_FRAME = { width: 1080, height: 1080, fps: 30, aspectRatio: '1:1' } as const;
export const SOCIAL_PORTRAIT_FRAME = { width: 1080, height: 1350, fps: 30, aspectRatio: '4:5' } as const;

export const SOCIAL_PLATFORM_KEYS = ['SQUARE_1X1', 'PORTRAIT_4X5'] as const;
export const socialPlatformKeySchema = z.enum(SOCIAL_PLATFORM_KEYS);
export type SocialPlatformKey = z.infer<typeof socialPlatformKeySchema>;

export const SOCIAL_PLATFORM_FRAMES = {
  SQUARE_1X1: SOCIAL_SQUARE_FRAME,
  PORTRAIT_4X5: SOCIAL_PORTRAIT_FRAME,
} as const;

/** 页内文字预算（大字排版保守值；超出必须拆页——长文本符合 Recipe 的量化口径） */
export const SOCIAL_TEXT_BUDGET = { COVER: 60, POINT: 180 } as const;

export const SOCIAL_PAGE_ROLES = ['COVER', 'POINT', 'CHART', 'INFOGRAPHIC', 'SOURCE'] as const;
export const socialPageRoleSchema = z.enum(SOCIAL_PAGE_ROLES);
export type SocialPageRole = z.infer<typeof socialPageRoleSchema>;

/** 图表数据来源（数值必须可追溯：ATOM_PAYLOAD = 来自 Atom 载荷逐字采用；不虚构） */
export const socialDataSourceSchema = z.object({
  kind: z.enum(['ATOM_PAYLOAD']),
  atomId: opaqueIdSchema,
});

/** 图文页（页序由 index 表达；页序规则在 validate 中强制） */
export const socialVisualPageSchema = z.object({
  pageId: opaqueIdSchema,
  index: z.number().int().nonnegative(),
  role: socialPageRoleSchema,
  platformKey: socialPlatformKeySchema,
  format: sceneFormatSchema,
  componentId: z.string().min(1).max(60),
  text: z.string().max(2000),
  textChars: z.number().int().nonnegative(),
  /** 图表页的数据来源（逐字取自 Atom 载荷；缺失 = 不可追溯 → validate error） */
  dataSource: socialDataSourceSchema.nullable().default(null),
  /** 署名（对外发布必须可署名；SOURCE 页必填，其余页可空） */
  attribution: z.object({ text: z.string().min(1).max(500), sourceIds: z.array(opaqueIdSchema).default([]) }).nullable().default(null),
  /** 来源链（逐页 Atom→Claim→Source） */
  provenance: z
    .array(
      z.object({
        atomId: opaqueIdSchema,
        claimIds: z.array(opaqueIdSchema).default([]),
        sourceIds: z.array(opaqueIdSchema).default([]),
      }),
    )
    .min(1),
  /** 拆页续页（长文本跨页时的显式衔接；null = 独立页） */
  continuationOf: opaqueIdSchema.nullable().default(null),
});

export type SocialVisualPage = z.infer<typeof socialVisualPageSchema>;

export const socialVisualSetPayloadSchema = z.object({
  kind: z.literal('SOCIAL_VISUAL_SET'),
  /** 单主题（同 Shorts 纪律：一个内容集讲一个主题） */
  topic: z.object({
    title: z.string().min(1).max(120),
    atomIds: z.array(opaqueIdSchema).min(1),
    coverage: z.object({
      atomsUsed: z.number().int().nonnegative(),
      atomsTotal: z.number().int().nonnegative(),
      textTruncatedPages: z.number().int().nonnegative(),
    }),
  }),
  /** 页集：1:1 单图 + 4:5 单图 + Carousel 页序 + 信息图 + 来源页（页序见 validate） */
  pages: z.array(socialVisualPageSchema).min(2),
});

export type SocialVisualSetPayload = z.infer<typeof socialVisualSetPayloadSchema>;

/** 产物类型（P12-01 9:16 派生 Graph；P12-02 图文/信息图集） */
export const ARTIFACT_PAYLOAD_KINDS = ['DERIVED_SCENE_GRAPH', 'SOCIAL_VISUAL_SET'] as const;
export const artifactPayloadKindSchema = z.enum(ARTIFACT_PAYLOAD_KINDS);
export type ArtifactPayloadKind = z.infer<typeof artifactPayloadKindSchema>;

/** 产物载荷（判别名 kind 区分 Pack 的 generate 产物形态） */
export const artifactPayloadSchema = z.discriminatedUnion('kind', [derivedSceneGraphPayloadSchema, socialVisualSetPayloadSchema]);
export type ArtifactPayload = z.infer<typeof artifactPayloadSchema>;

/** Social Visual 校验码（问题逐条可读；error/warning 语义见 P12-02 验收映射） */
export const SOCIAL_VALIDATION_CODES = {
  PLATFORM_SIZE_INVALID: 'PLATFORM_SIZE_INVALID',
  PAGE_ORDER_INVALID: 'PAGE_ORDER_INVALID',
  PAGE_COUNT_OUT_OF_RECIPE: 'PAGE_COUNT_OUT_OF_RECIPE',
  PAGE_COUNT_UNVERIFIED: 'PAGE_COUNT_UNVERIFIED',
  ATTRIBUTION_MISSING: 'ATTRIBUTION_MISSING',
  CHART_DATA_UNTRACEABLE: 'CHART_DATA_UNTRACEABLE',
  NO_CHART_PAGE: 'NO_CHART_PAGE',
  TEXT_OVERFLOW: 'TEXT_OVERFLOW',
  PROVENANCE_MISSING: 'PROVENANCE_MISSING',
  MIXED_TOPIC: 'MIXED_TOPIC',
  PAYLOAD_KIND_MISMATCH: 'PAYLOAD_KIND_MISMATCH',
} as const;

export type SocialValidationCode = (typeof SOCIAL_VALIDATION_CODES)[keyof typeof SOCIAL_VALIDATION_CODES];

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
  payload: artifactPayloadSchema,
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
