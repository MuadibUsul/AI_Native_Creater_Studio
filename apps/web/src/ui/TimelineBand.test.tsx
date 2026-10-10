import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { mediaTimeSchema, timelineViewportSchema, type TemporalSelection } from '@ancs/contracts';
import { TimelineBand } from './TimelineBand';

/** N04-04-s1：横向时间带——播放头与时间选区分离、拖动区间、Shift 叠加多区间。 */

const mt = (seconds: number) => mediaTimeSchema.parse({ ticks: String(Math.round(seconds * 1000)), timebase: { num: 1, den: 1000 } });
const viewport = timelineViewportSchema.parse({ start: mt(0), end: mt(10), widthPx: 1000 });
const toSeconds = (time: { ticks: string; timebase: { num: number; den: number } }): number =>
  (Number(time.ticks) * time.timebase.num) / time.timebase.den;

/**
 * jsdom 的 PointerEvent 不携带 clientX（本仓库 jsdom 26），因此用 MouseEvent 以同名事件类型派发；
 * React 的 onPointerDown/onPointerMove/onPointerUp 按事件类型匹配，与构造器无关。
 */
const firePointer = (element: Element, type: 'pointerdown' | 'pointermove' | 'pointerup', init: MouseEventInit): void => {
  fireEvent(element, new MouseEvent(type, { bubbles: true, cancelable: true, ...init }));
};

describe('TimelineBand（播放头 / 时间选区分离）', () => {
  it('标尺拖动只改播放头，不产生时间选区', () => {
    const onPlayheadChange = vi.fn();
    const onSelectionChange = vi.fn();
    render(
      <TimelineBand viewport={viewport} playhead={null} selection={null} onPlayheadChange={onPlayheadChange} onSelectionChange={onSelectionChange} />,
    );
    const ruler = screen.getByTestId('timeline-ruler');
    firePointer(ruler, 'pointerdown', { clientX: 500 });
    expect(onPlayheadChange).toHaveBeenCalledTimes(1);
    expect(toSeconds(onPlayheadChange.mock.calls[0]![0])).toBeCloseTo(5, 6);
    firePointer(ruler, 'pointermove', { clientX: 700 });
    expect(toSeconds(onPlayheadChange.mock.calls[1]![0])).toBeCloseTo(7, 6);
    expect(onSelectionChange).not.toHaveBeenCalled();
  });

  it('选择带拖动产生半开区间；单击（位移小于阈值）产生 POINT', () => {
    const onSelectionChange = vi.fn();
    render(<TimelineBand viewport={viewport} playhead={null} selection={null} onSelectionChange={onSelectionChange} />);
    const track = screen.getByTestId('timeline-selection-track');

    firePointer(track, 'pointerdown', { clientX: 200 });
    firePointer(track, 'pointermove', { clientX: 800 });
    firePointer(track, 'pointerup', { clientX: 800 });
    const range = onSelectionChange.mock.calls[0]![0] as TemporalSelection;
    expect(range.kind).toBe('RANGES');
    if (range.kind === 'RANGES') {
      expect(toSeconds(range.ranges[0]!.start)).toBeCloseTo(2, 6);
      expect(toSeconds(range.ranges[0]!.end)).toBeCloseTo(8, 6);
    }

    onSelectionChange.mockClear();
    firePointer(track, 'pointerdown', { clientX: 400 });
    firePointer(track, 'pointerup', { clientX: 401 });
    const point = onSelectionChange.mock.calls[0]![0] as TemporalSelection;
    expect(point.kind).toBe('POINT');
  });

  it('Shift+拖动在既有区间上叠加多区间（保留显式区间，不合并中间整段）', () => {
    const onSelectionChange = vi.fn();
    const existing: TemporalSelection = { kind: 'RANGES', ranges: [{ start: mt(1), end: mt(2) }] };
    render(<TimelineBand viewport={viewport} playhead={null} selection={existing} onSelectionChange={onSelectionChange} />);
    const track = screen.getByTestId('timeline-selection-track');
    firePointer(track, 'pointerdown', { clientX: 500 });
    firePointer(track, 'pointerup', { clientX: 800, shiftKey: true });
    const selection = onSelectionChange.mock.calls[0]![0] as TemporalSelection;
    expect(selection.kind).toBe('RANGES');
    if (selection.kind === 'RANGES') {
      expect(selection.ranges).toHaveLength(2);
      expect(toSeconds(selection.ranges[0]!.start)).toBeCloseTo(1, 6);
      expect(toSeconds(selection.ranges[1]!.start)).toBeCloseTo(5, 6);
    }
  });

  it('渲染播放头、选区覆盖层与轨道片段块；清除按钮清空选区', () => {
    const onSelectionChange = vi.fn();
    const onClipSelect = vi.fn();
    const selection: TemporalSelection = { kind: 'RANGES', ranges: [{ start: mt(2), end: mt(4) }] };
    render(
      <TimelineBand
        viewport={viewport}
        playhead={mt(3)}
        selection={selection}
        lanes={[{ id: 'video', label: '视频', kind: 'VIDEO', clips: [{ id: 'clip_1', label: 'SCENE', range: { start: mt(0), end: mt(5) } }] }]}
        onSelectionChange={onSelectionChange}
        onClipSelect={onClipSelect}
      />,
    );
    const playhead = screen.getByTestId('timeline-playhead');
    expect(playhead.style.left).toBe('300px');
    expect(screen.getByTestId('timeline-range-0')).toBeTruthy();
    expect(screen.getByTestId('timeline-selection-label').textContent).toContain('时间选区');
    fireEvent.click(screen.getByTestId('timeline-clip-clip_1'));
    expect(onClipSelect).toHaveBeenCalledWith('clip_1');
    fireEvent.click(screen.getByTestId('timeline-selection-clear'));
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });

  it('Esc 取消当前手势/草案（清空时间选区，不等于撤销工程）', () => {
    const onSelectionChange = vi.fn();
    render(
      <TimelineBand
        viewport={viewport}
        playhead={null}
        selection={{ kind: 'POINT', at: mt(2), boundaryDirection: 'AT' }}
        onSelectionChange={onSelectionChange}
      />,
    );
    fireEvent.keyDown(screen.getByTestId('timeline-band'), { key: 'Escape' });
    expect(onSelectionChange).toHaveBeenCalledWith(null);
  });
});
