import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { visualHitTargetSchema, type OrderedTargetRef, type VisualHitTarget } from '@ancs/contracts';
import { CanvasInteractionLayer } from './CanvasInteractionLayer';

/** N04-02-s1：画布命中与点选——对象身份、zOrder、多选顺序、悬浮、框选、重叠轮换。 */

const viewport = { width: 1000, height: 1000 };

const target = (overrides: Partial<VisualHitTarget> = {}): VisualHitTarget =>
  visualHitTargetSchema.parse({ objectId: 'vo_1', targetKind: 'VISUAL_OBJECT', transform: {}, crop: {}, ...overrides });

/** jsdom 的 PointerEvent 不携带 clientX，用 MouseEvent 以同名类型派发（React 按类型匹配）。 */
const firePointer = (element: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit): void => {
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
};

const click = (element: Element, clientX: number, clientY: number): void => {
  firePointer(element, 'pointerdown', { clientX, clientY });
  firePointer(element, 'pointerup', { clientX, clientY });
};

describe('CanvasInteractionLayer（画布原生对象命中）', () => {
  it('点击命中上层细粒度对象并发出 objectId（不是屏幕坐标）', () => {
    const onSelectionChange = vi.fn();
    const clip = target({ objectId: 'clip_1', targetKind: 'CLIP', clipId: 'clip_1', zOrder: 0 });
    const overlay = target({ objectId: 'vo_1', zOrder: 0 });
    render(<CanvasInteractionLayer viewport={viewport} objects={[clip, overlay]} onSelectionChange={onSelectionChange} />);
    click(screen.getByTestId('canvas-interaction-layer'), 500, 500);
    expect(onSelectionChange).toHaveBeenCalledWith([
      { targetRef: 'vo_1', targetKind: 'VISUAL_OBJECT', label: 'A', assetVersionId: null },
    ]);
  });

  it('多选保留选择顺序并打 A/B 标签（后一次点击不覆盖前一个目标）', () => {
    const onSelectionChange = vi.fn();
    const clip = target({ objectId: 'clip_1', targetKind: 'CLIP', clipId: 'clip_1' });
    const overlay = target({ objectId: 'vo_1' });
    render(
      <CanvasInteractionLayer
        viewport={viewport}
        objects={[clip, overlay]}
        selectedObjectIds={['vo_1']}
        multiSelect
        onSelectionChange={onSelectionChange}
      />,
    );
    click(screen.getByTestId('canvas-interaction-layer'), 500, 500);
    expect(onSelectionChange).toHaveBeenCalledWith([
      { targetRef: 'vo_1', targetKind: 'VISUAL_OBJECT', label: 'A', assetVersionId: null },
      { targetRef: 'clip_1', targetKind: 'CLIP', label: 'B', assetVersionId: null },
    ] satisfies OrderedTargetRef[]);
  });

  it('悬浮发出轻高亮命中（不触发选择）', () => {
    const onHoverChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <CanvasInteractionLayer
        viewport={viewport}
        objects={[target({ objectId: 'vo_1' })]}
        onHoverChange={onHoverChange}
        onSelectionChange={onSelectionChange}
      />,
    );
    firePointer(screen.getByTestId('canvas-interaction-layer'), 'pointermove', { clientX: 500, clientY: 500 });
    expect(onHoverChange).toHaveBeenCalledWith('vo_1');
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('空白处拖动执行框选（以对象投影中心落入选框为准）', () => {
    const onSelectionChange = vi.fn();
    const rightHalf = target({ objectId: 'vo_right', crop: { left: 0.5, top: 0, right: 0, bottom: 0 } });
    render(<CanvasInteractionLayer viewport={viewport} objects={[rightHalf]} onSelectionChange={onSelectionChange} />);
    const layer = screen.getByTestId('canvas-interaction-layer');
    firePointer(layer, 'pointerdown', { clientX: 100, clientY: 100 });
    firePointer(layer, 'pointermove', { clientX: 900, clientY: 900 });
    firePointer(layer, 'pointerup', { clientX: 900, clientY: 900 });
    expect(onSelectionChange).toHaveBeenCalledWith([
      { targetRef: 'vo_right', targetKind: 'VISUAL_OBJECT', label: 'A', assetVersionId: null },
    ]);
  });

  it('重叠对象轮换：上层已选中时切到下一个候选', () => {
    const onSelectionChange = vi.fn();
    const clip = target({ objectId: 'clip_1', targetKind: 'CLIP', clipId: 'clip_1' });
    const overlay = target({ objectId: 'vo_1' });
    render(
      <CanvasInteractionLayer viewport={viewport} objects={[clip, overlay]} selectedObjectIds={['vo_1']} onSelectionChange={onSelectionChange} />,
    );
    click(screen.getByTestId('canvas-interaction-layer'), 500, 500);
    expect(onSelectionChange).toHaveBeenCalledWith([
      { targetRef: 'clip_1', targetKind: 'CLIP', label: 'A', assetVersionId: null },
    ]);
  });

  it('覆盖层按对象投影绘制四边形（可目检对象轮廓与真实画面一致）', () => {
    render(<CanvasInteractionLayer viewport={viewport} objects={[target({ objectId: 'vo_1' })]} />);
    const polygon = screen.getByTestId('canvas-object-vo_1');
    expect(polygon.getAttribute('points')).toBe('0,0 1000,0 1000,1000 0,1000');
  });
});
