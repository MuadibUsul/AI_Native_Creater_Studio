import { z } from 'zod';
import { bilingualTextSchema } from './strategy.js';
import type { SourceMediaProbeResult } from './assets.js';
import type { MotionValidator } from './custom-motion.js';
import { frameRegionSchema } from './frame-region.js';

/**
 * V6 §7.2 代码生成特效（V6-3）。
 *
 * - 特效 = 一段特效代码（模板库里的可信代码，或 AI 当场写的代码）+ 参数 + 种子，渲染成**带透明通道**的图层视频，
 *   作为普通片段放在上层视频轨上（指定的画面区域与时间范围）。预览分段缓存、终渲染、撤销都沿用时间线的同一套机制。
 * - 代码契约与 Custom Motion 沙箱一致（纯 JS、顶层 `registerMotion({ name, component })`、只用注入的全局；
 *   另有确定性随机数 `random(key)`）。AI 写的代码先过四道门禁（静态分析/类型检查/沙箱评估/抽帧）才渲染；
 *   渲染在隔离子进程的无凭据浏览器页面里进行，浏览器的网络/存储/DOM 能力被遮蔽。
 * - 参数事后可改：改参数只用同一段代码重渲图层，不再调用 AI 写代码。
 * - 能力探测：AI 写特效代码默认关闭，部署方按评测结果开启（`ANCS_EFFECT_CODEGEN=enabled`）；关闭时用模板库。
 */

/** text（V6-5 图解）：标题、要点、图表数据等文字；多项用换行或 | 分隔，长度受 maxLength 限制。 */
export const EFFECT_PARAM_KINDS = ['color', 'number', 'choice', 'text'] as const;
/** 文字参数的最大长度上限（单个参数） */
export const MAX_EFFECT_TEXT_PARAM = 600;
/** 特效图层的最长时长（秒）：图解卡片常常要配满一段讲述 */
export const MAX_EFFECT_SECONDS = 30;

export const effectParamSchema = z.object({
  key: z.string().regex(/^[a-z][a-zA-Z0-9]{0,31}$/),
  kind: z.enum(EFFECT_PARAM_KINDS),
  label: bilingualTextSchema,
  /** 给 AI 的说明（英文） */
  description: z.string().min(1).max(200),
  default: z.union([z.string(), z.number()]),
  min: z.number().optional(),
  max: z.number().optional(),
  options: z.array(z.string().min(1).max(32)).max(8).optional(),
  /** text 参数的最大长度 */
  maxLength: z.number().int().positive().max(MAX_EFFECT_TEXT_PARAM).optional(),
}).strict();
export type EffectParam = z.infer<typeof effectParamSchema>;

export const EFFECT_COVERAGE = ['REGION', 'FULL_FRAME'] as const;

export const effectTemplateSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
  name: bilingualTextSchema,
  /** 给 AI 的说明（英文）：什么效果、适合什么场合 */
  description: z.string().min(1).max(400),
  params: z.array(effectParamSchema).max(8),
  /** 建议时长（秒） */
  defaultSeconds: z.number().positive().max(MAX_EFFECT_SECONDS),
  /** 建议作用范围：画面里的一块区域，或整个画面 */
  coverage: z.enum(EFFECT_COVERAGE),
  /** 特效代码（与 Custom Motion 同一契约） */
  code: z.string().min(20).max(20_000),
  /**
   * 数据图解（V6-5）：参数里出现的每个数字都必须能在本工程的来源文字（文章）里找到，
   * 服务端在渲染前校验（数据图表不得使用虚构数值）。
   */
  numbersFromSource: z.boolean().default(false),
}).strict();
export type EffectTemplate = z.infer<typeof effectTemplateSchema>;

/** 特效作用的画面区域（与对话框选、审片框选同一形状）。 */
export const effectRegionSchema = frameRegionSchema;
export type EffectRegion = z.infer<typeof effectRegionSchema>;

/** 特效图层资产的元数据（存在资产 metadata.effect 里；改参数时据此用同一段代码重渲）。 */
export const effectLayerMetadataSchema = z.object({
  kind: z.literal('EFFECT_LAYER'),
  source: z.enum(['TEMPLATE', 'CODE']),
  templateId: z.string().nullable(),
  name: z.string().min(1).max(80),
  code: z.string().min(20).max(20_000),
  codeSha256: z.string().regex(/^[0-9a-f]{64}$/),
  params: z.record(z.string(), z.union([z.string(), z.number()])),
  seed: z.string().min(1).max(64),
  region: effectRegionSchema,
  render: z.object({ width: z.number().int().positive(), height: z.number().int().positive(), fps: z.number().positive(), durationInFrames: z.number().int().positive(), renderMs: z.number().int().nonnegative() }).strict(),
  /** AI 写的代码：门禁报告摘要 */
  validation: z.object({ verdict: z.literal('APPROVED'), sourceSha256: z.string(), stages: z.array(z.string()) }).strict().nullable(),
}).strict();
export type EffectLayerMetadata = z.infer<typeof effectLayerMetadataSchema>;

export interface EffectRenderRequest {
  code: string;
  params: Record<string, string | number>;
  seed: string;
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

/** 特效渲染端口（Worker 装配：隔离子进程里的无头浏览器渲染）。返回透明图层视频与一张预览帧。 */
export interface AgentEffectRenderer {
  readonly implementation: 'REAL' | 'SCRIPTED';
  render(request: EffectRenderRequest): Promise<{
    /** 带透明通道的视频（PNG 编码的 QuickTime，FFmpeg 原生解码保留 alpha） */
    video: Uint8Array;
    poster: Uint8Array;
    probe: SourceMediaProbeResult;
    renderMs: number;
  }>;
}

export const EFFECT_CODEGEN_MODES = ['disabled', 'enabled'] as const;
export type EffectCodegenMode = (typeof EFFECT_CODEGEN_MODES)[number];

/** 导演工具用到的特效端口（Worker 装配）。未装配时特效工具明确报"本部署不可用"。 */
export interface AgentEffectPorts {
  renderer: AgentEffectRenderer;
  /** AI 写的特效代码先过 Custom Motion 四道门禁（静态分析/类型检查/沙箱评估/抽帧）；未装配时不接受 AI 写的代码 */
  validator?: MotionValidator;
  /** AI 写特效代码（能力探测后由部署方开启；默认 disabled，只用模板库） */
  codegen: EffectCodegenMode;
}

export const EFFECT_ERROR_REASONS = {
  TEMPLATE_NOT_FOUND: 'EFFECT_TEMPLATE_NOT_FOUND',
  CODEGEN_DISABLED: 'EFFECT_CODEGEN_DISABLED',
  VALIDATION_REJECTED: 'EFFECT_VALIDATION_REJECTED',
  RENDERER_UNAVAILABLE: 'EFFECT_RENDERER_UNAVAILABLE',
  RENDER_FAILED: 'EFFECT_RENDER_FAILED',
  NOT_AN_EFFECT: 'EFFECT_CLIP_NOT_EFFECT',
  /** 图解里的数字在来源文字里找不到（或工程没有来源文字） */
  NUMBERS_NOT_IN_SOURCE: 'EFFECT_NUMBERS_NOT_IN_SOURCE',
} as const;
