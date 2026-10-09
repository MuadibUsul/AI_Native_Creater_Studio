import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VISUAL_PARAMETERS,
  VISUAL_KEYFRAME_PATHS,
  hitTestVisualObject,
  invertVisualPoint,
  projectVisualPoint,
  visualCropSchema,
  visualParametersSchema,
  visualTransformSchema,
} from './index.js';

/** N03-05：变换/裁切/透明度参数契约与命中坐标换算（纯函数，可离线检验）。 */

const viewport = { width: 1_000, height: 500 };
const identity = visualTransformSchema.parse({});

describe('可编辑变换与基础关键帧契约（N03-05）', () => {
  it('默认参数是旧语义（无位移/缩放/裁切，完全不透明）且关键帧路径固定', () => {
    expect(DEFAULT_VISUAL_PARAMETERS).toMatchObject({
      transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } },
      crop: { left: 0, top: 0, right: 0, bottom: 0 },
      opacity: 1,
      values: {},
    });
    expect(VISUAL_KEYFRAME_PATHS).toContain('transform.rotationDeg');
    expect(VISUAL_KEYFRAME_PATHS).toContain('opacity');
  });

  it('裁切必须留出非空可见区域（四边归一化 0..1）', () => {
    expect(visualCropSchema.safeParse({ left: 0.2, right: 0.3, top: 0, bottom: 0 }).success).toBe(true);
    expect(visualCropSchema.safeParse({ left: 0.6, right: 0.4, top: 0, bottom: 0 }).success).toBe(false);
    expect(visualCropSchema.safeParse({ left: -0.1, top: 0, right: 0, bottom: 0 }).success).toBe(false);
    expect(visualParametersSchema.safeParse({ opacity: 1.2 }).success).toBe(false);
    expect(visualTransformSchema.safeParse({ scale: { x: 0, y: 1 } }).success).toBe(false);
  });

  it('位移/缩放/锚点的投影与逆投影互为逆运算', () => {
    const transform = visualTransformSchema.parse({
      position: { x: 0.25, y: -0.1 },
      scale: { x: 2, y: 1.5 },
      rotationDeg: 0,
      anchor: { x: 0.5, y: 0.5 },
    });
    const projected = projectVisualPoint({ point: { x: 0.3, y: 0.7 }, transform, crop: visualCropSchema.parse({}), viewport });
    const inverse = invertVisualPoint({ point: projected, transform, crop: visualCropSchema.parse({}), viewport });
    expect(inverse.x).toBeCloseTo(0.3, 10);
    expect(inverse.y).toBeCloseTo(0.7, 10);
  });

  it('裁切前后命中坐标可检验：可见区域外不命中，区域中心命中', () => {
    const crop = visualCropSchema.parse({ left: 0.25, right: 0.25, top: 0.1, bottom: 0.1 });
    // 以"完整对象坐标"取点：(0.1, 0.5) 在未裁切时命中；裁掉左右各 25% 后落在可见区域之外
    const uncroppedPoint = projectVisualPoint({ point: { x: 0.1, y: 0.5 }, transform: identity, crop: visualCropSchema.parse({}), viewport });
    expect(hitTestVisualObject({ point: uncroppedPoint, transform: identity, crop: visualCropSchema.parse({}), viewport })).toBe(true);
    expect(hitTestVisualObject({ point: uncroppedPoint, transform: identity, crop, viewport })).toBe(false);
    // 可见区域中心仍命中
    const visibleCenter = projectVisualPoint({ point: { x: 0.5, y: 0.5 }, transform: identity, crop, viewport });
    expect(hitTestVisualObject({ point: visibleCenter, transform: identity, crop, viewport })).toBe(true);
  });

  it('旋转后命中坐标可检验：90° 旋转使原水平方向点落到竖直方向', () => {
    const rotated = visualTransformSchema.parse({ rotationDeg: 90, anchor: { x: 0, y: 0 } });
    // 绕左上角顺时针 90°：局部 (0.5, 0) → 画布 (0, 0.5 * height/width 比例)... 用像素反推更直接：
    const projected = projectVisualPoint({ point: { x: 0.5, y: 0 }, transform: rotated, crop: visualCropSchema.parse({}), viewport });
    expect(projected.x).toBeCloseTo(0, 8);
    expect(projected.y).toBeCloseTo(0.5 * viewport.height, 8);
    // 该点仍判为命中（落在对象内），而对象外部的点不命中
    expect(hitTestVisualObject({ point: projected, transform: rotated, crop: visualCropSchema.parse({}), viewport })).toBe(true);
    expect(hitTestVisualObject({ point: { x: 900, y: 20 }, transform: rotated, crop: visualCropSchema.parse({}), viewport })).toBe(false);
  });
});
