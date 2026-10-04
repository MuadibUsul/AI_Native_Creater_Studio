import { z } from 'zod';
import { opaqueIdSchema } from './common/ids.js';
import { isoDateTimeSchema } from './common/time.js';
import { DEFAULT_THEME_TOKENS, themeTokensSchema } from './theme.js';

/**
 * Channel（栏目）契约（规范 §6 / P01-04）。
 *
 * 核心语义（P01-04 验收）：
 * - Channel 保存"栏目级长期默认值"；每次修改产生**不可变的新 Style 版本**；
 * - 消费方（P02-01 起：创建 Project）必须**快照**其使用的样式版本——
 *   因此"修改 Channel 后旧项目不变、新项目继承新默认值"由版本机制保证。
 */

export const ASPECT_RATIOS = ['16:9', '9:16', '1:1', '4:5'] as const;

export const SOURCE_DISPLAY_POLICIES = ['ALWAYS', 'WHEN_REQUIRED', 'MINIMAL'] as const;
export const AI_BROLL_POLICIES = ['MINIMAL', 'BALANCED', 'GENEROUS'] as const;

export const channelStyleDefaultsSchema = z.object({
  language: z.string().min(2),
  defaultAspectRatio: z.enum(ASPECT_RATIOS),
  defaultDurationRangeSeconds: z
    .object({ min: z.number().int().positive(), max: z.number().int().positive() })
    .refine((r) => r.min < r.max, '时长范围必须 min < max'),
  /** Avatar（主持人）占比目标区间（计划 §9.4：15%—30%） */
  hostRatioRange: z
    .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
    .refine((r) => r.min <= r.max, '占比范围必须 min ≤ max'),
  maxConsecutiveHostSeconds: z.number().int().positive(),
  /** 明显视觉变化间隔（计划 §9.4：每 4—12 秒） */
  visualChangeEverySeconds: z
    .object({ min: z.number().positive(), max: z.number().positive() })
    .refine((r) => r.min <= r.max, '间隔范围必须 min ≤ max'),
  /** AI Video 占比上限（计划 §9.4：<10%—20%） */
  aiVideoRatioMax: z.number().min(0).max(1),
  hookStyle: z.string().min(1),
  chapterStyle: z.string().min(1),
  endingStyle: z.string().min(1),
  sourceDisplayPolicy: z.enum(SOURCE_DISPLAY_POLICIES),
  aiBrollPolicy: z.enum(AI_BROLL_POLICIES),
  /** 音乐政策（自由文本：例如 'SUBTLE' / 'NONE' / 指定 BGM 资产策略） */
  musicPolicy: z.string().min(1),
  /** 首选 Provider 策略（自由文本；具体目录自 P03-03 接入，DEC-14） */
  preferredProviderPolicy: z.string().min(1),
  themeTokens: themeTokensSchema,
  /** 引用的身份资产（P06 起填充；null 表示使用平台默认/未绑定） */
  creatorIdentityId: z.string().nullable().default(null),
  voiceIdentityId: z.string().nullable().default(null),
  avatarIdentityId: z.string().nullable().default(null),
  brandIdentityId: z.string().nullable().default(null),
  speechProfileId: z.string().nullable().default(null),
});

export type ChannelStyleDefaults = z.infer<typeof channelStyleDefaultsSchema>;
/** 覆盖：允许在创建/更新时只提供部分字段（浅合并到默认值） */
export const channelStyleOverrideSchema = channelStyleDefaultsSchema.partial();
export type ChannelStyleOverride = z.infer<typeof channelStyleOverrideSchema>;

/** 系统默认样式（计划 §9.4 的产品默认值；可被 Channel 覆盖，不硬编码在业务逻辑里）。 */
export const DEFAULT_CHANNEL_STYLE: ChannelStyleDefaults = {
  language: 'zh-CN',
  defaultAspectRatio: '16:9',
  defaultDurationRangeSeconds: { min: 480, max: 600 },
  hostRatioRange: { min: 0.15, max: 0.3 },
  maxConsecutiveHostSeconds: 25,
  visualChangeEverySeconds: { min: 4, max: 12 },
  aiVideoRatioMax: 0.2,
  hookStyle: '直接问题开场，10 秒内给出悬念',
  chapterStyle: '章节标题 + 一句话导航',
  endingStyle: '结论 + 三个观察变量',
  sourceDisplayPolicy: 'WHEN_REQUIRED',
  aiBrollPolicy: 'MINIMAL',
  musicPolicy: 'SUBTLE',
  preferredProviderPolicy: 'AUTO',
  themeTokens: DEFAULT_THEME_TOKENS,
  creatorIdentityId: null,
  voiceIdentityId: null,
  avatarIdentityId: null,
  brandIdentityId: null,
  speechProfileId: null,
};

export interface ChannelStyleMergeOptions {
  /** 语言由调用方单独指定时优先于覆盖体 */
  language?: string;
}

/** 合并覆盖体到系统默认值（浅合并；嵌套对象整体替换）。 */
export function mergeChannelStyle(
  override: ChannelStyleOverride | undefined,
  options: ChannelStyleMergeOptions = {},
): ChannelStyleDefaults {
  const merged = { ...DEFAULT_CHANNEL_STYLE, ...override };
  if (options.language !== undefined) merged.language = options.language;
  return merged;
}

export const channelSchema = z.object({
  id: opaqueIdSchema,
  name: z.string().min(1).max(80),
  language: z.string().min(2),
  /** 当前生效的 Style 版本号（单调递增；历史版本不可变） */
  currentStyleVersion: z.number().int().positive(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});

export const channelStyleVersionSchema = z.object({
  id: opaqueIdSchema,
  channelId: opaqueIdSchema,
  version: z.number().int().positive(),
  defaults: channelStyleDefaultsSchema,
  note: z.string().nullable(),
  createdAt: isoDateTimeSchema,
});

/** Channel 详情：携带当前样式（快照消费方应记录 styleVersion.id / version）。 */
export const channelWithStyleSchema = channelSchema.extend({
  styleVersion: channelStyleVersionSchema,
});

export type Channel = z.infer<typeof channelSchema>;
export type ChannelStyleVersion = z.infer<typeof channelStyleVersionSchema>;
export type ChannelWithStyle = z.infer<typeof channelWithStyleSchema>;

export const createChannelRequestSchema = z.object({
  name: z.string().min(1).max(80),
  language: z.string().min(2).optional(),
  defaults: channelStyleOverrideSchema.optional(),
});

export const updateChannelRequestSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  /** 提供 defaults 即产生新的 Style 版本（旧版本与旧快照保持不变） */
  defaults: channelStyleOverrideSchema.optional(),
  note: z.string().max(200).optional(),
});

export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;
