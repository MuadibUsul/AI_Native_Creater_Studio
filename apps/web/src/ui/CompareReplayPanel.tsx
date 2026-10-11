'use client';

import { useMemo } from 'react';
import {
  buildComparePlaybackPlan,
  xAtSequenceTime,
  type ComparePlaybackPlan,
  type CompareReport,
  type MediaRange,
  type MediaTime,
  type TimelineViewport,
} from '@ancs/contracts';
import ui from './Monochrome.module.css';

/**
 * N06-08（收口）：A/B 对照回放面板（播放器侧的**可见**消费面）。
 *
 * - 只消费 `buildComparePlaybackPlan` 的产物，**不自己算几何**（像素由同一 viewport 换算）；
 * - 差异标记**按时间轴定位**；不可定位的差异单列（不静默丢掉）；
 * - 切换 A/B 只改"在看哪一侧"，**不改工程**；
 * - 点击标记把播放头移到该差异起点（`onSeek` 交由上层播放器执行）。
 */

export type CompareSide = 'LEFT' | 'RIGHT';

const CHANGE_LABEL: Record<string, string> = {
  CHANGED: '改动', ADDED: '新增', REMOVED: '删除', UNCHANGED: '未变',
};

export interface CompareReplayPanelProps {
  report: CompareReport;
  viewport: TimelineViewport;
  /** 当前在看哪一侧（切换只影响显示，不改工程） */
  side: CompareSide;
  onSideChange: (side: CompareSide) => void;
  /** 局部循环区间（来自时间选区；null = 不循环） */
  loopRange?: MediaRange | null;
  onSeek?: (time: MediaTime) => void;
}

export function CompareReplayPanel({ report, viewport, side, onSideChange, loopRange = null, onSeek }: CompareReplayPanelProps) {
  const plan: ComparePlaybackPlan = useMemo(
    () => buildComparePlaybackPlan({ report, loopRange }),
    [report, loopRange],
  );
  const placed = plan.marks.filter((mark) => mark.range !== null);
  const unplaced = plan.marks.filter((mark) => mark.range === null);
  const loopLeft = plan.loopRange === null ? null : xAtSequenceTime(viewport, plan.loopRange.start);
  const loopWidth = plan.loopRange === null ? 0 : xAtSequenceTime(viewport, plan.loopRange.end) - loopLeft!;

  return (
    <div data-testid="compare-replay-panel" className={`flex flex-col gap-2 p-2 text-xs ${ui['panel']}`} style={{ width: `${String(viewport.widthPx)}px` }}>
      <div className="flex items-center justify-between">
        <span className={ui['primaryText']}>A/B 对照</span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="compare-side-left"
            aria-pressed={side === 'LEFT'}
            onClick={() => onSideChange('LEFT')}
            className={`px-2 ${ui['button']}`}
          >A：{plan.leftLabel}</button>
          <button
            type="button"
            data-testid="compare-side-right"
            aria-pressed={side === 'RIGHT'}
            onClick={() => onSideChange('RIGHT')}
            className={`px-2 ${ui['button']}`}
          >B：{plan.rightLabel}</button>
        </div>
      </div>

      <div data-testid="compare-summary" className={ui['mutedText']}>
        改动 {plan.summary.changed} · 新增 {plan.summary.added} · 删除 {plan.summary.removed} · 未变 {plan.summary.unchanged}
        {plan.summary.unplaced > 0 ? ` · 未定位 ${plan.summary.unplaced}` : ''}
      </div>

      {/* 差异标记条：按时间轴定位 */}
      <div data-testid="compare-mark-strip" className={`relative h-6 border-b ${ui['divider']}`}>
        {placed.map((mark) => {
          const left = xAtSequenceTime(viewport, mark.range!.start);
          const width = Math.max(2, xAtSequenceTime(viewport, mark.range!.end) - left);
          return (
            <button
              key={mark.clipId}
              type="button"
              data-testid={`compare-mark-${mark.clipId}`}
              data-change={mark.change}
              data-side={mark.side}
              aria-label={`${mark.clipId} ${CHANGE_LABEL[mark.change] ?? mark.change}`}
              className={`absolute top-0 h-6 overflow-hidden px-1 text-left text-[10px] ${ui['button']}`}
              style={{ left: `${String(Math.max(0, left))}px`, width: `${String(width)}px` }}
              onClick={() => onSeek?.(mark.range!.start)}
            >
              {CHANGE_LABEL[mark.change] ?? mark.change}
            </button>
          );
        })}
        {/* 局部循环区间 */}
        {plan.loopRange !== null ? (
          <div
            data-testid="compare-loop-range"
            className="pointer-events-none absolute top-0 h-6 border-x opacity-40"
            style={{ left: `${String(Math.max(0, loopLeft!))}px`, width: `${String(Math.max(0, loopWidth))}px` }}
          />
        ) : null}
      </div>

      {plan.loopRange !== null ? (
        <span data-testid="compare-loop-label" className={ui['mutedText']}>局部循环已启用</span>
      ) : (
        <span data-testid="compare-loop-label" className={ui['mutedText']}>未启用局部循环（先在时间带选一段时间）</span>
      )}

      {unplaced.length > 0 ? (
        <div data-testid="compare-unplaced" className={ui['mutedText']}>
          无法在时间轴定位的差异：{unplaced.map((mark) => `${mark.clipId}(${CHANGE_LABEL[mark.change] ?? mark.change})`).join('、')}
        </div>
      ) : null}
    </div>
  );
}
