import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { distributionProviderRegistrationSchema } from './publishing.js';

/**
 * 扩展架构契约（规范 §92 / P01-06）：
 * Core + Packs + Marketplace 的稳定 Extension Points。
 *
 * V1 边界（§92.3）：只定义契约与注册表，不实现 Marketplace 运行时；
 * Core 中禁止出现 outputType 硬编码分支（§92.1）。
 * 本文件不依赖任何 Web/框架——契约层必须可在 Node/桌面/移动端复用。
 */

/** 插件能力词汇表（规范 §92.2 原文；能力标识符保持规范字面，不转 camelCase） */
export const PLUGIN_CAPABILITIES = [
  'read_content_core',
  'read_project_assets',
  'create_assets',
  'create_scene_graph',
  'provider_access',
  'distribution_access',
  'analytics_access',
  'network_access',
] as const;

export const pluginCapabilitySchema = z.enum(PLUGIN_CAPABILITIES);
export type PluginCapability = z.infer<typeof pluginCapabilitySchema>;

/** Pack 清单（§92.2：版本、签名、能力声明；资源配额为预留字段） */
export const packManifestSchema = z.object({
  /** 清单格式版本（便于未来清单结构演进） */
  manifestVersion: z.string().min(1),
  /** 反向域名式稳定标识，例如 "ancs.pack.shorts" */
  packId: z
    .string()
    .min(3)
    .max(120)
    .regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, 'packId 必须为反向域名式标识（如 ancs.pack.shorts）'),
  name: z.string().min(1).max(80),
  /** 语义化版本 */
  version: z.string().min(1).max(40),
  description: z.string().max(500).optional(),
  capabilities: z.array(pluginCapabilitySchema).default([]),
  compatibility: z.object({
    /** 兼容的 Core 版本范围（语义化范围表达式） */
    coreRange: z.string().min(1),
    sceneGraphSchemaVersion: z.string().nullable().default(null),
  }),
  /** 插件声明的默认评估渠道（Fit 输入；null = 不评估） */
  defaultChannelKey: z.string().max(60).nullable().default(null),
  /** 该 Pack 提供的输出格式标识（例如 "shorts_9x16"、"carousel"） */
  outputFormats: z.array(z.string().min(1).max(64)).default([]),
  /** 资源配额（运行时执行限制；第三方插件强制，P16-02） */
  quota: z
    .object({
      maxJobMs: z.number().int().positive().nullable().default(null),
      maxArtifacts: z.number().int().positive().nullable().default(null),
    })
    .nullable()
    .default(null),
  /** 签名（第三方发行时强制，P16-01；V1 内置 Pack 可为 null） */
  signature: z.object({ algorithm: z.string().min(1), value: z.string().min(1) }).nullable().default(null),
});

export type PackManifest = z.infer<typeof packManifestSchema>;

/** V1 的 ContentCore 引用（§93 预留：P11 起替换为完整 ContentCore 契约；此处保留最小可演进形态） */
export const contentCoreRefSchema = z.object({
  contentDocumentId: opaqueIdSchema,
  atomIds: z.array(opaqueIdSchema).default([]),
  recipeId: z.string().nullable().default(null),
});

export type ContentCoreRef = z.infer<typeof contentCoreRefSchema>;

/** 插件运行上下文（不携带 Provider Secret；权限以注册时的能力声明为准） */
export const pluginContextSchema = z.object({
  workspaceId: opaqueIdSchema,
  projectId: opaqueIdSchema.nullable().default(null),
  grantedCapabilities: z.array(pluginCapabilitySchema).default([]),
  limits: z
    .object({
      maxRuntimeMs: z.number().int().positive().nullable().default(null),
      maxArtifacts: z.number().int().positive().nullable().default(null),
    })
    .nullable()
    .default(null),
});

export type PluginContext = z.infer<typeof pluginContextSchema>;

/** 输出计划（analyze 的产出，供用户预览/批准） */
export const outputPlanItemSchema = z.object({
  id: opaqueIdSchema,
  kind: z.enum(['generate', 'transform', 'package']),
  description: z.string().min(1),
});

export const outputPlanSchema = z.object({
  schemaVersion: z.string().min(1),
  summary: z.string().min(1),
  items: z.array(outputPlanItemSchema).default([]),
  requiresApproval: z.boolean().default(true),
});

export type OutputPlan = z.infer<typeof outputPlanSchema>;

/** 产物引用（Artifact；实际文件经 Asset/存储管理，这里给出结构化引用） */
export const ARTIFACT_KINDS = ['video', 'audio', 'image', 'text', 'package', 'directory'] as const;

export const artifactSchema = z.object({
  artifactId: opaqueIdSchema,
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().min(1).max(200),
  mimeType: z.string().nullable().default(null),
  storageKey: z.string().nullable().default(null),
  sizeBytes: z.number().int().nonnegative().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).default({}),
  createdAt: isoDateTimeSchema,
});

export type Artifact = z.infer<typeof artifactSchema>;

/** 校验结果（validate 的产出；AI/人工 QA 复用同一形状） */
export const validationIssueSchema = z.object({
  severity: z.enum(['error', 'warning']),
  code: z.string().min(1),
  message: z.string().min(1),
  artifactId: z.string().nullable().default(null),
});

export const validationResultSchema = z.object({
  ok: z.boolean(),
  issues: z.array(validationIssueSchema).default([]),
});

export type ValidationResult = z.infer<typeof validationResultSchema>;

/**
 * OutputPlugin 行为接口（§92.1）。
 * 实现方由 Plugin 运行时加载（V1 无第三方运行时；内置 Pack 直接实现本接口）。
 */
export interface OutputPlugin {
  manifest(): PackManifest;
  analyze(core: ContentCoreRef, ctx: PluginContext): Promise<OutputPlan>;
  generate(plan: OutputPlan, ctx: PluginContext): Promise<Artifact[]>;
  validate?(artifacts: Artifact[], ctx: PluginContext): Promise<ValidationResult>;
}

/** HandoffDescriptor（§42.3 / P13-05）：跨端交接的可撤销、限时描述符 */
export const HANDOFF_STATES = ['PENDING', 'CLAIMED', 'COMPLETED', 'REVOKED'] as const;

export const handoffDescriptorSchema = z.object({
  handoffId: opaqueIdSchema,
  state: z.enum(HANDOFF_STATES),
  artifactIds: z.array(opaqueIdSchema).min(1),
  targetPlatform: z.string().nullable().default(null),
  /** 过期后不可再领取（跨租户或过期访问必须失败，P13-05） */
  expiresAt: isoDateTimeSchema,
  createdAt: isoDateTimeSchema,
});

export type HandoffDescriptor = z.infer<typeof handoffDescriptorSchema>;

/** 能力可用性（未安装的能力明确返回不可用 + 原因，而不是静默缺失） */
export const capabilityAvailabilitySchema = z.object({
  format: z.string().min(1),
  available: z.boolean(),
  reason: z.string().nullable().default(null),
});

export type CapabilityAvailability = z.infer<typeof capabilityAvailabilitySchema>;

/** 能力快照（GET /api/v1/capabilities 的响应；未安装的能力不出现在列表中） */
export const capabilitySnapshotSchema = z.object({
  packs: z.array(packManifestSchema),
  distributionProviders: z.array(distributionProviderRegistrationSchema),
  outputFormats: z.array(z.string()),
});

export type CapabilitySnapshot = z.infer<typeof capabilitySnapshotSchema>;

/** /capabilities 响应：快照 + 可选的目标输出格式可用性查询 */
export const capabilitiesResponseSchema = capabilitySnapshotSchema.extend({
  outputFormatAvailability: capabilityAvailabilitySchema.nullable().default(null),
});

export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;
