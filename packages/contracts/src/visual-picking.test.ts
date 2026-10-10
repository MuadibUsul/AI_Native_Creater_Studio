import { describe, expect, it } from 'vitest';
import {
  cycleVisualCandidate,
  localPointFor,
  pickVisualObjects,
  projectVisualQuad,
  topmostVisualObject,
  visualHitTargetSchema,
  type VisualHitTarget,
} from './index.js';

/** N04-02-s1：画布原生对象命中（复用 hitTestVisualObject / projectVisualPoint，不新建坐标公式）。 */

const viewport = { width: 1000, height: 1000 };

const target = (overrides: Partial<VisualHitTarget> = {}): VisualHitTarget =>
  visualHitTargetSchema.parse({
    objectId: 'obj_1',
    targetKind: 'VISUAL_OBJECT',
    transform: {},
    crop: {},
    ...overrides,
  });

describe('visual-picking 命中与叠放顺序', () => {
  it('重叠时优先可见细粒度对象（VISUAL_OBJECT 先于 CLIP），不永远命中最外层', () => {
    const clip = target({ objectId: 'clip_1', targetKind: 'CLIP', clipId: 'clip_1', zOrder: 0 });
    const overlay = target({ objectId: 'vo_1', targetKind: 'VISUAL_OBJECT', zOrder: 0 });
    const hits = pickVisualObjects({ point: { x: 500, y: 500 }, viewport, targets: [clip, overlay] });
    expect(hits.map((hit) => hit.objectId)).toEqual(['vo_1', 'clip_1']);
    expect(topmostVisualObject({ point: { x: 500, y: 500 }, viewport, targets: [clip, overlay] })?.objectId).toBe('vo_1');
  });

  it('zOrder 优先于细粒度排序', () => {
    const lower = target({ objectId: 'vo_low', zOrder: 1 });
    const higher = target({ objectId: 'vo_high', zOrder: 5 });
    expect(topmostVisualObject({ point: { x: 10, y: 10 }, viewport, targets: [higher, lower] })?.objectId).toBe('vo_high');
  });

  it('隐藏对象与被隐藏父对象下的子对象都不参与命中', () => {
    const hidden = target({ objectId: 'vo_hidden', visible: false });
    const parent = target({ objectId: 'vo_parent', visible: false });
    const child = target({ objectId: 'vo_child', parentObjectId: 'vo_parent' });
    const visible = target({ objectId: 'vo_visible' });
    const hits = pickVisualObjects({ point: { x: 500, y: 500 }, viewport, targets: [hidden, parent, child, visible] });
    expect(hits.map((hit) => hit.objectId)).toEqual(['vo_visible']);
  });

  it('裁切后的可见区域参与命中（裁掉的像素不算命中）', () => {
    const cropped = target({ objectId: 'vo_crop', crop: { left: 0.5, top: 0, right: 0, bottom: 0 } });
    expect(pickVisualObjects({ point: { x: 250, y: 500 }, viewport, targets: [cropped] })).toHaveLength(0);
    expect(pickVisualObjects({ point: { x: 750, y: 500 }, viewport, targets: [cropped] })).toHaveLength(1);
  });

  it('轮换候选：从当前选中切到下一个，末尾回到第一个', () => {
    const a = target({ objectId: 'a' });
    const b = target({ objectId: 'b' });
    const c = target({ objectId: 'c' });
    const candidates = [a, b, c];
    expect(cycleVisualCandidate(candidates, null)?.objectId).toBe('a');
    expect(cycleVisualCandidate(candidates, 'a')?.objectId).toBe('b');
    expect(cycleVisualCandidate(candidates, 'c')?.objectId).toBe('a');
    expect(cycleVisualCandidate(candidates, 'missing')?.objectId).toBe('a');
    expect(cycleVisualCandidate([], 'a')).toBeNull();
  });
});

describe('visual-picking 投影与局部坐标', () => {
  it('恒等变换的四角投影到画布四角', () => {
    const quad = projectVisualQuad({ transform: target().transform, crop: target().crop, viewport });
    expect(quad).toEqual([
      { x: 0, y: 0 },
      { x: 1000, y: 0 },
      { x: 1000, y: 1000 },
      { x: 0, y: 1000 },
    ]);
  });

  it('localPointFor 与命中检测同源：画布中心对应局部中心', () => {
    const local = localPointFor({ point: { x: 500, y: 500 }, transform: target().transform, crop: target().crop, viewport });
    expect(local.x).toBeCloseTo(0.5, 6);
    expect(local.y).toBeCloseTo(0.5, 6);
  });

  it('旋转/位移后画布点仍能正确反解（正逆互验，且命中一致）', () => {
    const rotated = target({
      transform: { position: { x: 0.1, y: -0.05 }, scale: { x: 1, y: 1 }, rotationDeg: 30, anchor: { x: 0.5, y: 0.5 } },
    });
    const point = { x: 620, y: 470 };
    const local = localPointFor({ point, transform: rotated.transform, crop: rotated.crop, viewport });
    const hits = pickVisualObjects({ point, viewport, targets: [rotated] });
    const inside = local.x >= 0 && local.x <= 1 && local.y >= 0 && local.y <= 1;
    expect(hits.length === 1).toBe(inside);
  });
});
