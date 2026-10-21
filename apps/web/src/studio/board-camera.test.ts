import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, fitCamera, panBy, toScreen, unionRect, wheelCamera, zoomAt } from './board-camera';

/** 无限画布的镜头数学：适配、以点为中心缩放、平移、滚轮（触控板捏合带 ctrlKey）。 */
describe('无限画布镜头', () => {
  it('适配：目标完整落在扣掉留白的视口里并居中；不放大超过 1:1', () => {
    const insets = { top: 72, right: 32, bottom: 28, left: 24 };
    const camera = fitCamera({ width: 1000, height: 700 }, { x: 0, y: -40, width: 1392, height: 900 }, insets);
    // 可用 944 × 600：按宽 944/1392 ≈ 0.678，按高 600/900 ≈ 0.667 → 取高
    expect(camera.k).toBeCloseTo(600 / 900, 6);
    const topLeft = toScreen(camera, { x: 0, y: -40 });
    const bottomRight = toScreen(camera, { x: 1392, y: 860 });
    expect(topLeft.y).toBeCloseTo(72, 6);
    expect(bottomRight.y).toBeCloseTo(672, 6);
    expect((topLeft.x + bottomRight.x) / 2).toBeCloseTo(24 + 944 / 2, 6);
    // 小内容不放大
    expect(fitCamera({ width: 2000, height: 2000 }, { x: 0, y: 0, width: 100, height: 100 }).k).toBe(1);
  });

  it('以点为中心缩放：那一点下的世界位置不动；缩放有上下限', () => {
    const camera = { x: 40, y: 20, k: 0.5 };
    const point = { x: 300, y: 200 };
    const before = { x: (point.x - camera.x) / camera.k, y: (point.y - camera.y) / camera.k };
    const zoomed = zoomAt(camera, point, 2);
    expect(zoomed.k).toBe(1);
    expect(toScreen(zoomed, before).x).toBeCloseTo(point.x, 9);
    expect(toScreen(zoomed, before).y).toBeCloseTo(point.y, 9);
    expect(zoomAt(camera, point, 1000).k).toBe(MAX_ZOOM);
    expect(zoomAt(camera, point, 0.0001).k).toBe(MIN_ZOOM);
  });

  it('滚轮：普通滚动平移，Ctrl/⌘（含触控板捏合）缩放；按行滚动换算成像素', () => {
    const camera = { x: 0, y: 0, k: 1 };
    expect(wheelCamera(camera, { deltaX: 10, deltaY: 30, deltaMode: 0, ctrlKey: false, metaKey: false }, { x: 0, y: 0 })).toEqual(panBy(camera, -10, -30));
    expect(wheelCamera(camera, { deltaX: 0, deltaY: 3, deltaMode: 1, ctrlKey: false, metaKey: false }, { x: 0, y: 0 })).toEqual({ x: 0, y: -48, k: 1 });
    expect(wheelCamera(camera, { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true, metaKey: false }, { x: 0, y: 0 }).k).toBeGreaterThan(1);
    expect(wheelCamera(camera, { deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, metaKey: true }, { x: 0, y: 0 }).k).toBeLessThan(1);
  });

  it('外框合并', () => {
    expect(unionRect([])).toBeNull();
    expect(unionRect([{ x: 0, y: 0, width: 960, height: 540 }, { x: 1032, y: 0, width: 360, height: 900 }])).toEqual({ x: 0, y: 0, width: 1392, height: 900 });
  });
});
