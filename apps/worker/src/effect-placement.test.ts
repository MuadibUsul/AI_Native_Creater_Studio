import { describe, expect, it } from 'vitest';
import { visualCropSchema } from '@ancs/contracts';
import { effectRegionTransform } from '@ancs/domain';
import { placementOf } from './render-plan/ffmpeg-graph.js';

/**
 * V6-3：特效区域 → 片段变换 → 终渲染/预览的放置几何（同一 FFmpeg 媒体图）。
 * 图层被缩放到区域大小，左上角落在区域左上角（误差 ≤ 1 像素，偶数取整）。
 */
describe('特效图层放置几何', () => {
  it.each([
    { x: 0, y: 0, width: 1, height: 1 },
    { x: 0.5, y: 0.25, width: 0.4, height: 0.5 },
    { x: 0.1, y: 0.6, width: 0.2, height: 0.3 },
    { x: 0.75, y: 0, width: 0.25, height: 1 },
  ])('区域 %o', (region) => {
    const canvas = { width: 1920, height: 1080 };
    const placement = placementOf({ transform: effectRegionTransform(region), crop: visualCropSchema.parse({}) }, canvas);
    expect(Math.abs(placement.scaleWidth - region.width * canvas.width)).toBeLessThanOrEqual(2);
    expect(Math.abs(placement.scaleHeight - region.height * canvas.height)).toBeLessThanOrEqual(2);
    expect(Math.abs(placement.x - region.x * canvas.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(placement.y - region.y * canvas.height)).toBeLessThanOrEqual(1);
  });
});
