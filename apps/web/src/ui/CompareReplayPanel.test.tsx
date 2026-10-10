import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { legacyMillisecondsToMediaTime, timelineViewportSchema, type CompareReport } from '@ancs/contracts';
import { CompareReplayPanel } from './CompareReplayPanel';

/**
 * N06-08（收口）：A/B 对照面板 —— 差异标记落到时间轴、切换只改显示、点击标记 seek、循环区间可见。
 */
const mt = (ms: number) => legacyMillisecondsToMediaTime(ms);
const range = (startMs: number, endMs: number) => ({ start: mt(startMs), end: mt(endMs) });
const viewport = timelineViewportSchema.parse({ start: mt(0), end: mt(10_000), widthPx: 1_000 }); // 1s = 100px

const report: CompareReport = {
  proposalId: 'prop_1', workspaceId: 'ws_1', projectId: 'p_1',
  comparedAgainst: { kind: 'CURRENT', ref: null },
  leftLabel: '确认版', rightLabel: '候选 B', alignment: 'CLIP_ID',
  diffs: [
    { objectKind: 'CLIP', objectId: 'clip_changed', label: null, change: 'CHANGED', axes: ['CONTENT'], beforeAssetVersionId: 'av_1', afterAssetVersionId: 'av_1', beforeTrackId: 't1', afterTrackId: 't1', beforeSequenceRange: range(4_000, 7_000), afterSequenceRange: range(4_000, 6_000), alignedBy: 'CLIP_ID' },
    { objectKind: 'CLIP', objectId: 'clip_removed', label: null, change: 'REMOVED', axes: ['CONTENT'], beforeAssetVersionId: 'av_1', afterAssetVersionId: null, beforeTrackId: 't1', afterTrackId: null, beforeSequenceRange: range(0, 3_000), afterSequenceRange: null, alignedBy: 'CLIP_ID' },
    { objectKind: 'CLIP', objectId: 'clip_unplaced', label: null, change: 'CHANGED', axes: ['STYLE'], beforeAssetVersionId: null, afterAssetVersionId: null, beforeTrackId: null, afterTrackId: null, beforeSequenceRange: null, afterSequenceRange: null, alignedBy: 'CLIP_ID' },
  ],
  unchangedCount: 2, addedCount: 0, removedCount: 1, changedCount: 2,
  anchorMatchedCount: 0, unmatchedAnchors: [], assetVersionIds: ['av_1'],
};

describe('N06-08 CompareReplayPanel', () => {
  it('差异标记按时间轴定位（像素来自同一 viewport）并标出所属侧', () => {
    render(<CompareReplayPanel report={report} viewport={viewport} side="RIGHT" onSideChange={vi.fn()} />);
    const changed = screen.getByTestId('compare-mark-clip_changed');
    expect(changed.style.left).toBe('400px');   // 4s
    expect(changed.style.width).toBe('200px');  // 4s→6s（用试改后区间）
    expect(changed.getAttribute('data-side')).toBe('BOTH');
    const removed = screen.getByTestId('compare-mark-clip_removed');
    expect(removed.getAttribute('data-side')).toBe('LEFT');
    expect(removed.style.left).toBe('0px');
    expect(removed.style.width).toBe('300px');
  });

  it('切换 A/B 只通知上层改显示，不改工程也不自己 seek', () => {
    const onSideChange = vi.fn();
    const onSeek = vi.fn();
    render(<CompareReplayPanel report={report} viewport={viewport} side="LEFT" onSideChange={onSideChange} onSeek={onSeek} />);
    fireEvent.click(screen.getByTestId('compare-side-right'));
    expect(onSideChange).toHaveBeenCalledWith('RIGHT');
    expect(onSeek).not.toHaveBeenCalled();
  });

  it('点击标记把播放头移到该差异起点', () => {
    const onSeek = vi.fn();
    render(<CompareReplayPanel report={report} viewport={viewport} side="LEFT" onSideChange={vi.fn()} onSeek={onSeek} />);
    fireEvent.click(screen.getByTestId('compare-mark-clip_changed'));
    expect(onSeek).toHaveBeenCalledTimes(1);
    const at = onSeek.mock.calls[0]![0] as { ticks: string; timebase: { num: number; den: number } };
    expect((Number(at.ticks) * at.timebase.num) / at.timebase.den).toBeCloseTo(4, 6); // 4 秒
  });

  it('不可定位的差异单列出来（不静默丢掉），并可显示局部循环', () => {
    render(<CompareReplayPanel report={report} viewport={viewport} side="LEFT" onSideChange={vi.fn()} loopRange={range(1_000, 3_000)} />);
    expect(screen.getByTestId('compare-unplaced').textContent).toContain('clip_unplaced');
    expect(screen.getByTestId('compare-loop-range')).toBeTruthy();
    expect(screen.getByTestId('compare-loop-label').textContent).toContain('已启用');
    expect(screen.getByTestId('compare-summary').textContent).toContain('未定位 1');
  });
});
