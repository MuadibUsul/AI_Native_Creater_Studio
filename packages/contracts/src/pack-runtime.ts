import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { channelFitSchema } from './atoms.js';
import { contentAtomSchema } from './atoms.js';
import { pluginCapabilitySchema, pluginContextSchema, outputPlanSchema } from './extensions.js';
import type { OutputPlan, PackManifest } from './extensions.js';

/**
 * Pack 运行时契约（P11-03 / 规范 §92；计划 §8）。
 *
 * 纪律（验收："Pack 通过公开契约工作，不直接访问核心数据库或 Secret"）：
 * - **安装/启用/绑定三段生命周期**（DB 持久化）：安装 = 平台级（官方 Pack 随启动幂等安装）；
 *   启用 = workspace 级（**权益白名单 packs 强制**——未含于套餐 → 403 PACK_NOT_ENTITLED）；
 *   绑定 = project 级（**版本锁定**——analyze 只对已绑定版本运行）；
 * - **受限 PluginContext**：能力门控（未声明 read_content_core → 拿不到核心数据/Atom）；
 *   上下文只含显式授予的数据面——**永不提供 DB 连接或 Secret**；
 * - 首个官方 Pack（Shorts Analyzer）证明契约可工作：消费 Fit/Atom 出 OutputPlan 骨架。
 */

export const PACK_INSTALLATION_VERSION = 'pack-installation-v1' as const;

export const packInstallationSchema = z.object({
  id: opaqueIdSchema,
  packId: z.string().min(3).max(120),
  version: z.string().min(1).max(40),
  name: z.string().min(1).max(80),
  capabilities: z.array(pluginCapabilitySchema).default([]),
  outputFormats: z.array(z.string().max(64)).default([]),
  /** 官方 = 随平台分发（签名强制属 P16-01 第三方） */
  official: z.boolean().default(true),
  status: z.enum(['INSTALLED', 'RETIRED']).default('INSTALLED'),
  installedAt: isoDateTimeSchema,
});

export type PackInstallation = z.infer<typeof packInstallationSchema>;

export const packEnablementSchema = z.object({
  workspaceId: opaqueIdSchema,
  packId: z.string().min(3).max(120),
  version: z.string().min(1).max(40),
  enabledAt: isoDateTimeSchema,
});

export type PackEnablement = z.infer<typeof packEnablementSchema>;

export const projectPackBindingSchema = z.object({
  projectId: opaqueIdSchema,
  packId: z.string().min(3).max(120),
  /** 版本锁定：analyze 只对绑定版本运行 */
  version: z.string().min(1).max(40),
  boundAt: isoDateTimeSchema,
});

export type ProjectPackBinding = z.infer<typeof projectPackBindingSchema>;

/** 受限插件上下文 = PluginContext + **按能力门控的数据面**（无 DB/无 Secret） */
export const restrictedPluginContextSchema = pluginContextSchema.extend({
  packId: z.string().min(3).max(120),
  packVersion: z.string().min(1).max(40),
  data: z.object({
    /** 仅 grantedCapabilities 含 read_content_core 时非 null（核心摘要——不含正文全文） */
    core: z
      .object({
        inputsDigest: z.string().regex(/^[0-9a-f]{64}$/),
        counts: z.object({
          documentCount: z.number().int().nonnegative(),
          claimCount: z.number().int().nonnegative(),
          factCount: z.number().int().nonnegative(),
          sourceCount: z.number().int().nonnegative(),
        }),
      })
      .nullable(),
    /** 仅 read_content_core 时非空（Atom 自带来源引用） */
    atoms: z.array(contentAtomSchema).default([]),
    /** 插件声明渠道的 Fit（无法评估时 null） */
    fit: channelFitSchema.nullable().default(null),
  }),
});

export type RestrictedPluginContext = z.infer<typeof restrictedPluginContextSchema>;

/** Pack 插件（§92.1 OutputPlugin 的 analyze 切面；generate/validate 随 P12 各 Pack 落地） */
export interface PackPlugin {
  readonly manifest: PackManifest;
  analyze(ctx: RestrictedPluginContext): Promise<OutputPlan>;
}

export const packAnalyzeResultSchema = z.object({
  plan: outputPlanSchema,
  context: restrictedPluginContextSchema,
});

export type PackAnalyzeResult = z.infer<typeof packAnalyzeResultSchema>;

export const PACK_ERROR_REASONS = {
  /** Pack 未安装（平台级） */
  PACK_NOT_INSTALLED: 'PACK_NOT_INSTALLED',
  /** 未为该工作区启用（与权益 403 的 PACK_NOT_ENABLED 常量区分） */
  PACK_ENABLEMENT_REQUIRED: 'PACK_ENABLEMENT_REQUIRED',
  /** 项目未绑定（版本锁定前置） */
  PACK_NOT_BOUND: 'PACK_NOT_BOUND',
  /** 权益白名单不含该 Pack（P09-01 packs 维度） */
  PACK_NOT_ENTITLED: 'PACK_NOT_ENTITLED',
  /** 运行时未注册该插件实例 */
  PLUGIN_NOT_REGISTERED: 'PLUGIN_NOT_REGISTERED',
} as const;

export type PackErrorReason = (typeof PACK_ERROR_REASONS)[keyof typeof PACK_ERROR_REASONS];

/** 已启用 Pack 视图（workspace 列表用） */
export const workspacePackViewSchema = z.object({
  installation: packInstallationSchema,
  enabled: z.boolean(),
  enabledVersion: z.string().nullable().default(null),
});

export type WorkspacePackView = z.infer<typeof workspacePackViewSchema>;

