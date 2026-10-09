import { z } from 'zod';

/**
 * N03-05 可编辑变换与基础关键帧（模型层契约）。
 *
 * 纪律（V03-17／V03-18）：
 * - 变换是**参数化修改**：位置/缩放/旋转/锚点/裁切/透明度都落在片段的 `parameters.values` 命名空间里，
 *   编辑不得触发镜头重生成或任何生成式再推理；
 * - 关键帧沿用既有 `composition_animation_bindings`（LINEAR／HOLD），属性路径使用本文件导出的常量；
 * - 命中检测用纯函数实现（裁切 → 旋转 → 缩放/锚点 → 位置），同一实现供预览与命中检验共用，
 *   保证"裁切/旋转前后命中坐标可检验"。
 *
 * 坐标系：所有变换参数均为**归一化**量（相对画布宽高各除一次），锚点同样归一化（0..1，默认中心 0.5）。
 */

export const VISUAL_PARAMETER_SCHEMA_VERSION = 'visual-params/1.0';

export const visualOffsetSchema = z.object({
  x: z.number().finite().min(-4).max(4),
  y: z.number().finite().min(-4).max(4),
}).strict();

export const visualScaleSchema = z.object({
  x: z.number().finite().min(0.01).max(16),
  y: z.number().finite().min(0.01).max(16),
}).strict();

export const visualAnchorSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
}).strict();

export const visualTransformSchema = z.object({
  /** 相对锚点的归一化位移（1 = 一个画布宽度/高度） */
  position: visualOffsetSchema.default({ x: 0, y: 0 }),
  /** 缩放因子（1 = 原始尺寸） */
  scale: visualScaleSchema.default({ x: 1, y: 1 }),
  /** 顺时针旋转角度（度） */
  rotationDeg: z.number().finite().min(-360).max(360).default(0),
  /** 变换锚点（归一化） */
  anchor: visualAnchorSchema.default({ x: 0.5, y: 0.5 }),
}).strict();

export type VisualTransform = z.infer<typeof visualTransformSchema>;

export const visualCropSchema = z.object({
  left: z.number().finite().min(0).max(1).default(0),
  top: z.number().finite().min(0).max(1).default(0),
  right: z.number().finite().min(0).max(1).default(0),
  bottom: z.number().finite().min(0).max(1).default(0),
}).strict().refine(
  (value) => value.left + value.right < 1 && value.top + value.bottom < 1,
  'crop must leave a non-empty visible area',
);

export type VisualCrop = z.infer<typeof visualCropSchema>;

/** 片段参数命名空间：变换、裁切、透明度（其余组件参数由组件自己声明）。 */
export const visualParametersSchema = z.object({
  schemaVersion: z.string().min(1).max(64).default(VISUAL_PARAMETER_SCHEMA_VERSION),
  transform: visualTransformSchema.default({ position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } }),
  crop: visualCropSchema.default({ left: 0, top: 0, right: 0, bottom: 0 }),
  opacity: z.number().finite().min(0).max(1).default(1),
  /** 组件自定义参数（不在此处校验形状，由组件版本声明） */
  values: z.record(z.string(), z.unknown()).default({}),
}).strict();

export type VisualParameters = z.infer<typeof visualParametersSchema>;

export const DEFAULT_VISUAL_PARAMETERS: VisualParameters = visualParametersSchema.parse({});

/** 关键帧属性路径（供 animation binding 使用；线性与保持两种插值）。 */
export const VISUAL_KEYFRAME_PATHS = [
  'transform.position.x',
  'transform.position.y',
  'transform.scale.x',
  'transform.scale.y',
  'transform.rotationDeg',
  'opacity',
] as const;

export const visualKeyframePathSchema = z.enum(VISUAL_KEYFRAME_PATHS);

export type VisualKeyframePath = z.infer<typeof visualKeyframePathSchema>;

export interface VisualViewport {
  width: number;
  height: number;
}

export interface VisualPoint {
  x: number;
  y: number;
}

/**
 * 归一化局部坐标（0..1，以对象原始矩形左上角为原点）→ 画布像素坐标。
 * 顺序：裁切框 → 缩放 → 旋转（绕锚点）→ 位移。
 */
export function projectVisualPoint(input: {
  point: VisualPoint;
  transform: VisualTransform;
  crop: VisualCrop;
  viewport: VisualViewport;
}): VisualPoint {
  const { point, transform, crop, viewport } = input;
  const visibleWidth = 1 - crop.left - crop.right;
  const visibleHeight = 1 - crop.top - crop.bottom;
  // 裁切后局部坐标映射回"完整对象"坐标
  const localX = crop.left + point.x * visibleWidth;
  const localY = crop.top + point.y * visibleHeight;
  const scaledX = localX * transform.scale.x;
  const scaledY = localY * transform.scale.y;
  const anchorX = transform.anchor.x * transform.scale.x;
  const anchorY = transform.anchor.y * transform.scale.y;
  const radians = (transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotatedX = (scaledX - anchorX) * cos - (scaledY - anchorY) * sin;
  const rotatedY = (scaledX - anchorX) * sin + (scaledY - anchorY) * cos;
  const canvasX = (anchorX + rotatedX + transform.position.x) * viewport.width;
  const canvasY = (anchorY + rotatedY + transform.position.y) * viewport.height;
  return { x: canvasX, y: canvasY };
}

/** 画布坐标 → 局部归一化坐标（projectVisualPoint 的逆变换；用于命中检测）。 */
export function invertVisualPoint(input: {
  point: VisualPoint;
  transform: VisualTransform;
  crop: VisualCrop;
  viewport: VisualViewport;
}): VisualPoint {
  const { point, transform, crop, viewport } = input;
  const normalizedX = point.x / viewport.width - transform.position.x;
  const normalizedY = point.y / viewport.height - transform.position.y;
  const anchorX = transform.anchor.x * transform.scale.x;
  const anchorY = transform.anchor.y * transform.scale.y;
  const radians = (-transform.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const rotatedX = (normalizedX - anchorX) * cos - (normalizedY - anchorY) * sin;
  const rotatedY = (normalizedX - anchorX) * sin + (normalizedY - anchorY) * cos;
  const scaledX = rotatedX + anchorX;
  const scaledY = rotatedY + anchorY;
  const localX = scaledX / transform.scale.x;
  const localY = scaledY / transform.scale.y;
  const visibleWidth = 1 - crop.left - crop.right;
  const visibleHeight = 1 - crop.top - crop.bottom;
  return {
    x: (localX - crop.left) / visibleWidth,
    y: (localY - crop.top) / visibleHeight,
  };
}

/** 命中检测：点是否落在（裁切后、旋转后、缩放位移后的）可见矩形内。 */
export function hitTestVisualObject(input: {
  point: VisualPoint;
  transform: VisualTransform;
  crop: VisualCrop;
  viewport: VisualViewport;
}): boolean {
  const local = invertVisualPoint(input);
  return local.x >= 0 && local.x <= 1 && local.y >= 0 && local.y <= 1;
}
