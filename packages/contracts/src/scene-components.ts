import { z } from 'zod';
import { ASPECT_RATIOS } from './channels.js';
import { DEFAULT_THEME_TOKENS, themeTokensSchema } from './theme.js';

/**
 * 组件协议契约（P05-01 / 规范 §11.1、§57；计划 §8 P05-01）。
 *
 * 本文件只承载**可序列化的协议元数据**（platform-neutral：contracts 不依赖 React/Remotion）。
 * `ComponentDefinition` 中不可序列化的部分（zod inputSchema、React renderer）定义在
 * `packages/scene-components`（`@ancs/scene-components`）。
 *
 * §11.1：每个 Component 必须有 ComponentDefinition { type, version, inputSchema, defaults,
 * supportedAspectRatios, minDuration, maxDuration?, previewFixture, renderer }。
 */

export const COMPONENT_PROTOCOL_VERSION = '1.0';

/** 组件版本（semver；Scene.componentVersion 记录它，§4.3 不变量 8）。 */
export const componentVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/, '组件版本必须是 semver（如 1.0.0）');

/** 场景类型（V1 = STANDARD_SCENE_TYPES 的 20 类；扩展 Pack 可追加，故此处为开放字符串）。 */
export const sceneComponentTypeSchema = z.string().min(1).max(80);

export const aspectRatioSchema = z.enum(ASPECT_RATIOS);
export type AspectRatio = z.infer<typeof aspectRatioSchema>;

/** 预览/验收 fixture：可直接渲染的一组输入（props 以 schema 校验）。 */
export const componentFixtureSchema = z.object({
  /** 未校验的 props 输入（由 inputSchema.parse 校验与补默认值） */
  props: z.record(z.string(), z.unknown()).default({}),
  durationMs: z.number().int().positive(),
  aspectRatio: aspectRatioSchema.default('16:9'),
  /** 可选主题覆盖（默认 DEFAULT_THEME_TOKENS） */
  theme: themeTokensSchema.partial().optional(),
  note: z.string().max(200).nullable().default(null),
});

export type ComponentFixture = z.infer<typeof componentFixtureSchema>;

/**
 * 组件目录条目（可序列化）：编辑器与 API 用它展示"有哪些组件、默认 props 与时长边界"，
 * 不包含 renderer/inputSchema（那些在 scene-components 包内）。
 */
export const componentCatalogEntrySchema = z.object({
  type: sceneComponentTypeSchema,
  version: componentVersionSchema,
  title: z.string().min(1).max(120),
  description: z.string().min(1).max(400),
  supportedAspectRatios: z.array(aspectRatioSchema).min(1),
  minDurationMs: z.number().int().positive(),
  maxDurationMs: z.number().int().positive().nullable(),
  /** 默认 props（schema 解析后的完整值；可直接作为 Scene.props 初值） */
  defaultProps: z.record(z.string(), z.unknown()),
  fixture: componentFixtureSchema,
});

export type ComponentCatalogEntry = z.infer<typeof componentCatalogEntrySchema>;

/** 组件协议校验的明确原因码（拒绝必须给出原因，不得静默）。 */
export const COMPONENT_VALIDATION_REASONS = {
  TYPE_EMPTY: 'TYPE_EMPTY',
  VERSION_INVALID: 'VERSION_INVALID',
  MIN_DURATION_INVALID: 'MIN_DURATION_INVALID',
  MAX_DURATION_BELOW_MIN: 'MAX_DURATION_BELOW_MIN',
  ASPECT_RATIOS_EMPTY: 'ASPECT_RATIOS_EMPTY',
  ASPECT_RATIO_UNSUPPORTED: 'ASPECT_RATIO_UNSUPPORTED',
  DEFAULTS_INVALID: 'DEFAULTS_INVALID',
  FIXTURE_PROPS_INVALID: 'FIXTURE_PROPS_INVALID',
  FIXTURE_DURATION_OUT_OF_RANGE: 'FIXTURE_DURATION_OUT_OF_RANGE',
  FIXTURE_ASPECT_RATIO_UNSUPPORTED: 'FIXTURE_ASPECT_RATIO_UNSUPPORTED',
  RENDERER_MISSING: 'RENDERER_MISSING',
  DUPLICATE_TYPE_VERSION: 'DUPLICATE_TYPE_VERSION',
} as const;

export type ComponentValidationReason =
  (typeof COMPONENT_VALIDATION_REASONS)[keyof typeof COMPONENT_VALIDATION_REASONS];

/**
 * 场景渲染上下文（与 Scene 契约对齐：毫秒时间轴 + 目标画幅；主题来自 Channel/Brand tokens）。
 * 组件**只消费**这些输入：不读网络、不读凭据、不读时钟（帧由渲染器提供）。
 */
export const sceneRenderContextSchema = z.object({
  frame: z.number().int().nonnegative(),
  fps: z.number().int().positive(),
  durationMs: z.number().int().positive(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  aspectRatio: aspectRatioSchema,
  theme: themeTokensSchema.default(DEFAULT_THEME_TOKENS),
});

export type SceneRenderContext = z.infer<typeof sceneRenderContextSchema>;

/** 画幅 → 像素尺寸（V1 以 1920 宽为基准；P05-04 预览与 P07 渲染共用同一换算）。 */
export const ASPECT_RATIO_SIZES: Readonly<Record<AspectRatio, { width: number; height: number }>> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};
