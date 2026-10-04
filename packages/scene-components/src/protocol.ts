import type { ReactElement } from 'react';
import type { z } from 'zod';
import {
  ASPECT_RATIO_SIZES,
  COMPONENT_VALIDATION_REASONS,
  componentCatalogEntrySchema,
  componentFixtureSchema,
  componentVersionSchema,
  type AspectRatio,
  type ComponentCatalogEntry,
  type ComponentFixture,
  type ComponentValidationReason,
  type SceneRenderContext,
} from '@ancs/contracts';

/**
 * 组件协议（P05-01 / 规范 §11.1）。
 *
 * 每个标准场景组件实现 `ComponentDefinition`：
 * - 元数据（type/version/title/…）可序列化（经 `toCatalogEntry` 导出给编辑器/API）；
 * - `inputSchema`（zod）校验 Scene.props；`defaults` 为编辑器初值；
 * - `previewFixture` 是**可直接渲染**的验收输入（P05-02 的截图/渲染证据与 golden 依据）；
 * - `renderer` 只消费 `{ props, context }`（context = 帧/时长/画幅/主题）：**不读网络、不读凭据**。
 *
 * 纪律：组件不得写死颜色/字体（§57）——一律经 `useSceneTheme()` 读取 tokens。
 */

export interface ComponentRenderInput<TProps> {
  props: TProps;
  context: SceneRenderContext;
}

export interface ComponentDefinition<TProps = Record<string, unknown>> {
  type: string;
  version: string;
  title: string;
  description: string;
  /** props Schema（可含 zod 默认值；Scene.props 经其解析） */
  inputSchema: z.ZodType<TProps>;
  /** 编辑器初值（必须能通过 inputSchema 校验） */
  defaults: TProps;
  supportedAspectRatios: readonly AspectRatio[];
  minDurationMs: number;
  /** null = 无上限 */
  maxDurationMs: number | null;
  previewFixture: ComponentFixture;
  renderer: (input: ComponentRenderInput<TProps>) => ReactElement;
}

/** 类型收窄辅助（保留 TProps 推断）。 */
export const defineComponent = <TProps>(definition: ComponentDefinition<TProps>): ComponentDefinition<TProps> =>
  definition;

export interface ComponentValidationResult {
  ok: boolean;
  reasons: ComponentValidationReason[];
  messages: string[];
}

/**
 * 协议自检（**每个组件可独立校验**；注册时必须通过，不得静默注册坏组件）。
 * 覆盖：版本/时长边界/画幅集合/defaults/fixture（props 可解析、时长在范围内、画幅受支持）/renderer 存在。
 */
/** TProps 泛型：任意具体组件定义均可自检（内部只读元数据，不消费 props 类型）。 */
export function validateComponentDefinition<TProps>(definition: ComponentDefinition<TProps>): ComponentValidationResult {
  const reasons: ComponentValidationReason[] = [];
  const messages: string[] = [];
  const fail = (reason: ComponentValidationReason, message: string): void => {
    reasons.push(reason);
    messages.push(message);
  };

  if (definition.type.trim() === '') fail(COMPONENT_VALIDATION_REASONS.TYPE_EMPTY, 'type 不能为空');
  if (!componentVersionSchema.safeParse(definition.version).success) {
    fail(COMPONENT_VALIDATION_REASONS.VERSION_INVALID, `version 必须是 semver：${definition.version}`);
  }
  if (!Number.isInteger(definition.minDurationMs) || definition.minDurationMs <= 0) {
    fail(COMPONENT_VALIDATION_REASONS.MIN_DURATION_INVALID, `minDurationMs 必须为正整数：${String(definition.minDurationMs)}`);
  }
  if (definition.maxDurationMs !== null && definition.maxDurationMs <= definition.minDurationMs) {
    fail(COMPONENT_VALIDATION_REASONS.MAX_DURATION_BELOW_MIN, `maxDurationMs(${String(definition.maxDurationMs)}) 必须大于 minDurationMs`);
  }
  if (definition.supportedAspectRatios.length === 0) {
    fail(COMPONENT_VALIDATION_REASONS.ASPECT_RATIOS_EMPTY, 'supportedAspectRatios 不能为空');
  }
  for (const ratio of definition.supportedAspectRatios) {
    if (!(ratio in ASPECT_RATIO_SIZES)) {
      fail(COMPONENT_VALIDATION_REASONS.ASPECT_RATIO_UNSUPPORTED, `未知画幅：${ratio}`);
    }
  }

  const defaults = definition.inputSchema.safeParse(definition.defaults);
  if (!defaults.success) {
    fail(COMPONENT_VALIDATION_REASONS.DEFAULTS_INVALID, `defaults 未通过 inputSchema：${defaults.error.issues.map((issue) => issue.message).join('；')}`);
  }

  const fixture = componentFixtureSchema.safeParse(definition.previewFixture);
  if (!fixture.success) {
    fail(COMPONENT_VALIDATION_REASONS.FIXTURE_PROPS_INVALID, `previewFixture 结构非法：${fixture.error.issues.map((issue) => issue.message).join('；')}`);
  } else {
    const fixtureProps = definition.inputSchema.safeParse(fixture.data.props);
    if (!fixtureProps.success) {
      fail(COMPONENT_VALIDATION_REASONS.FIXTURE_PROPS_INVALID, `fixture.props 未通过 inputSchema：${fixtureProps.error.issues.map((issue) => issue.message).join('；')}`);
    }
    if (fixture.data.durationMs < definition.minDurationMs || (definition.maxDurationMs !== null && fixture.data.durationMs > definition.maxDurationMs)) {
      fail(COMPONENT_VALIDATION_REASONS.FIXTURE_DURATION_OUT_OF_RANGE, `fixture.durationMs=${String(fixture.data.durationMs)} 超出组件时长范围`);
    }
    if (!definition.supportedAspectRatios.includes(fixture.data.aspectRatio)) {
      fail(COMPONENT_VALIDATION_REASONS.FIXTURE_ASPECT_RATIO_UNSUPPORTED, `fixture.aspectRatio=${fixture.data.aspectRatio} 不在 supportedAspectRatios`);
    }
  }

  if (typeof definition.renderer !== 'function') {
    fail(COMPONENT_VALIDATION_REASONS.RENDERER_MISSING, 'renderer 缺失');
  }

  return { ok: reasons.length === 0, reasons, messages };
}

export type ScenePropsResolution =
  | { ok: true; props: unknown }
  | { ok: false; messages: string[] };

/** Scene.props 解析（zod 校验 + 默认值填充；失败给出明确原因，渲染方必须显式处理而非静默渲染空）。 */
export function resolveSceneProps<TProps>(definition: ComponentDefinition<TProps>, rawProps: unknown): ScenePropsResolution {
  const parsed = definition.inputSchema.safeParse(rawProps ?? {});
  if (!parsed.success) {
    return { ok: false, messages: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) };
  }
  return { ok: true, props: parsed.data };
}

export type DurationStatus = 'OK' | 'TOO_SHORT' | 'TOO_LONG';

/** 场景时长与组件边界的匹配（编辑器提示；渲染仍按 Scene.durationMs 执行，不擅自改时长）。 */
export function durationStatus<TProps>(definition: ComponentDefinition<TProps>, durationMs: number): DurationStatus {
  if (durationMs < definition.minDurationMs) return 'TOO_SHORT';
  if (definition.maxDurationMs !== null && durationMs > definition.maxDurationMs) return 'TOO_LONG';
  return 'OK';
}

/** 目录条目（可序列化元数据；编辑器/API 用，不含 renderer）。 */
export function toCatalogEntry<TProps>(definition: ComponentDefinition<TProps>): ComponentCatalogEntry {
  return componentCatalogEntrySchema.parse({
    type: definition.type,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    supportedAspectRatios: [...definition.supportedAspectRatios],
    minDurationMs: definition.minDurationMs,
    maxDurationMs: definition.maxDurationMs,
    defaultProps: definition.defaults as Record<string, unknown>,
    fixture: definition.previewFixture,
  });
}
