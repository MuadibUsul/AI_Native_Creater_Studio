import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { legacyMillisecondsToMediaTime, projectSequenceToTimeline, timelineViewportSchema } from '@ancs/contracts';
import { TimelineBand } from './TimelineBand';
import { projectionToBandLanes } from './timeline-projection-adapter';

/**
 * N04-04（主体）：**真实片段**经权威投影后，由横向时间带渲染出来并可点选。
 * 证据点：投影的可见片段集合与组件实际渲染的片段一致（不各算一套几何）。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });
const viewport = timelineViewportSchema.parse({ start: mt(0), end: mt(10_000), widthPx: 1_000 });

const tracks = [
  { trackId: 'trk_v', kind: 'VIDEO' as const, position: 0, name: 'V1', hidden: false, muted: false, locked: false },
  { trackId: 'trk_a', kind: 'AUDIO' as const, position: 1, name: 'A1', hidden: false, muted: false, locked: false },
];
const clips = [
  { clipId: 'clip_a', trackId: 'trk_v', sequenceRange: range(0, 3_000), label: '开场', hidden: false },
  { clipId: 'clip_b', trackId: 'trk_v', sequenceRange: range(4_000, 7_000), label: '产品', hidden: false },
  { clipId: 'clip_a_audio', trackId: 'trk_a', sequenceRange: range(0, 3_000), label: '', hidden: false },
];

describe('N04-04 真实片段投影 → 时间带渲染', () => {
  it('两条轨道都渲染，片段与投影的可见集合一致，且几何来自同一 viewport', () => {
    const projection = projectSequenceToTimeline({ tracks, clips, viewport });
    render(<TimelineBand viewport={viewport} playhead={null} selection={null} lanes={projectionToBandLanes(projection)} />);

    expect(screen.getByTestId('timeline-lane-trk_v')).toBeTruthy();
    expect(screen.getByTestId('timeline-lane-trk_a')).toBeTruthy();
    // 投影认为可见的三个片段都被渲染出来（不各算一套）
    for (const clipId of projection.visibleClipIds) {
      expect(screen.getByTestId(`timeline-clip-${clipId}`)).toBeTruthy();
    }
    expect(projection.visibleClipIds).toHaveLength(3);
    // label 缺省时回落到片段 id（可见而非空白按钮）
    expect(screen.getByTestId('timeline-clip-clip_a_audio').textContent).toBe('clip_a_audio');
    // 像素几何：1s = 100px → clip_a 0—3s 宽 300px；clip_b 4—7s 左 400px
    expect(screen.getByTestId('timeline-clip-clip_a').style.width).toBe('300px');
    expect(screen.getByTestId('timeline-clip-clip_b').style.left).toBe('400px');
  });

  it('点击片段发出 clipId（供后续组装 SelectionAnchor，组件自身不改工程）', () => {
    const onClipSelect = vi.fn();
    const projection = projectSequenceToTimeline({ tracks, clips, viewport });
    render(
      <TimelineBand viewport={viewport} playhead={null} selection={null} lanes={projectionToBandLanes(projection)} onClipSelect={onClipSelect} />,
    );
    fireEvent.click(screen.getByTestId('timeline-clip-clip_b'));
    expect(onClipSelect).toHaveBeenCalledWith('clip_b');
  });

  it('可视窗口外的片段不渲染（但仍在数据里）', () => {
    const tail = timelineViewportSchema.parse({ start: mt(8_000), end: mt(10_000), widthPx: 200 });
    const projection = projectSequenceToTimeline({ tracks, clips, viewport: tail });
    render(<TimelineBand viewport={tail} playhead={null} selection={null} lanes={projectionToBandLanes(projection)} />);
    expect(screen.queryByTestId('timeline-clip-clip_a')).toBeNull();
    // 轨道仍在（空轨占位），但没有任何片段按钮
    expect(screen.getByTestId('timeline-lane-trk_v')).toBeTruthy();
    expect(screen.queryAllByTestId(/^timeline-clip-/)).toHaveLength(0);
    expect(projection.lanes.every((lane) => lane.empty)).toBe(true);
    expect(projection.outsideViewportClipIds).toHaveLength(3);
  });
});

describe('N04-04 逐帧步进接入时间带', () => {
  const FR = { num: 30, den: 1 } as const;
  const mtMs = (ms: number) => legacyMillisecondsToMediaTime(ms);

  it('点"下一帧/上一帧"把播放头按帧步进（分数帧率不丢帧）', () => {
    const onPlayheadChange = vi.fn();
    const projection = projectSequenceToTimeline({ tracks, clips, viewport });
    render(
      <TimelineBand
        viewport={viewport} playhead={mtMs(1_000)} selection={null}
        lanes={projectionToBandLanes(projection)} frameRate={FR} onPlayheadChange={onPlayheadChange}
      />,
    );
    // 1.000s 对齐在帧边界上 → 下一帧 = 1/30 s ≈ 1033.33ms
    const nextBtn = screen.getByTestId('timeline-step-next') as HTMLButtonElement;
    // eslint-disable-next-line no-console
    try {
      fireEvent.click(nextBtn);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.log('DEBUG click error=', error instanceof Error ? error.message : String(error));
    }
    // eslint-disable-next-line no-console
    console.log('DEBUG calls=', String(onPlayheadChange.mock.calls.length));
    const next = onPlayheadChange.mock.calls[0]![0] as { ticks: string; timebase: { num: number; den: number } };
    expect((Number(next.ticks) * next.timebase.num * 1000) / next.timebase.den).toBeCloseTo(1_033.333, 2);

    onPlayheadChange.mockClear();
    fireEvent.click(screen.getByTestId('timeline-step-prev'));
    const prev = onPlayheadChange.mock.calls[0]![0] as { ticks: string; timebase: { num: number; den: number } };
    expect((Number(prev.ticks) * prev.timebase.num * 1000) / prev.timebase.den).toBeCloseTo(966.667, 2);
    // 帧时间码可读（非空且形状正确）
    expect(screen.getByTestId('timeline-frame-timecode').textContent).toMatch(/^\d{2}:\d{2}:\d{2}:\d{2}$/);
  });

  it('未提供 frameRate 时不渲染逐帧控件（不假装支持）', () => {
    const projection = projectSequenceToTimeline({ tracks, clips, viewport });
    render(<TimelineBand viewport={viewport} playhead={null} selection={null} lanes={projectionToBandLanes(projection)} />);
    expect(screen.queryByTestId('timeline-step-next')).toBeNull();
  });
});
