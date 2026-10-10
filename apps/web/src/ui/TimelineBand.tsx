'use client';

import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  addTemporalRange,
  describeTemporalSelection,
  sequenceTimeAtX,
  temporalSelectionFromDrag,
  temporalSelectionRanges,
  xAtSequenceTime,
  type FrameRate,
  type MediaRange,
  type MediaTime,
  type TemporalSelection,
  type TimelineViewport,
} from '@ancs/contracts';
import ui from './Monochrome.module.css';

/**
 * N04-04-s1：横向时间带（增量设计 §2.1、§4）。
 *
 * - 播放头（标尺拖动 scrub）与**独立时间选区**（选择带拖动）是两个模型，命中区域不重叠；
 * - 所有换算经 `@ancs/contracts` 的有理时基（`sequenceTimeAtX` / `xAtSequenceTime`），不在此处用浮点毫秒当权威；
 * - 时间点的点击产物是 `POINT`，拖动产物是半开 `RANGES`；Shift+拖动叠加多区间（保留显式区间）；
 * - 选择动作本身不改工程：组件只向父层发 `TemporalSelection`，由父层组装 `SelectionAnchor`。
 */

export interface TimelineBandClip {
  id: string;
  label: string;
  range: MediaRange;
}

export interface TimelineBandLane {
  id: string;
  label: string;
  kind: 'VIDEO' | 'AUDIO' | 'GRAPHIC' | 'CAPTION';
  clips: TimelineBandClip[];
}

export interface TimelineBandProps {
  viewport: TimelineViewport;
  playhead: MediaTime | null;
  selection: TemporalSelection | null;
  lanes?: TimelineBandLane[];
  frameRate?: FrameRate;
  disabled?: boolean;
  onPlayheadChange?: (time: MediaTime) => void;
  onSelectionChange?: (selection: TemporalSelection | null) => void;
  onClipSelect?: (clipId: string) => void;
}

function formatTime(time: MediaTime): string {
  const seconds = (Number(time.ticks) * time.timebase.num) / time.timebase.den;
  const sign = seconds < 0 ? '-' : '';
  const absolute = Math.abs(seconds);
  const minutes = Math.floor(absolute / 60);
  const wholeSeconds = Math.floor(absolute % 60);
  const millis = Math.round((absolute - Math.floor(absolute)) * 1000);
  return `${sign}${String(minutes).padStart(2, '0')}:${String(wholeSeconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

/** 把指针的 clientX 换算成时间带内部像素 x（以容器左边缘为 0）。 */
function pointerX(event: { clientX: number }, container: HTMLElement | null): number {
  if (container === null) return event.clientX;
  const rect = container.getBoundingClientRect();
  return event.clientX - rect.left;
}

export function TimelineBand({
  viewport,
  playhead,
  selection,
  lanes = [],
  frameRate,
  disabled = false,
  onPlayheadChange,
  onSelectionChange,
  onClipSelect,
}: TimelineBandProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<{ anchorXPx: number; focusXPx: number } | null>(null);
  const scrubbingRef = useRef(false);

  const emitSelectionFromDrag = useCallback(
    (anchorXPx: number, focusXPx: number, additive: boolean) => {
      const options = frameRate === undefined ? {} : { frameRate };
      const dragged = temporalSelectionFromDrag({ viewport, anchorXPx, focusXPx, ...options });
      if (additive && dragged.kind === 'RANGES' && selection !== null && selection.kind === 'RANGES') {
        onSelectionChange?.(addTemporalRange(selection, dragged.ranges[0]!));
        return;
      }
      onSelectionChange?.(dragged);
    },
    [frameRate, onSelectionChange, selection, viewport],
  );

  const handleRulerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const x = pointerX(event, containerRef.current);
    if (!Number.isFinite(x)) return;
    scrubbingRef.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    onPlayheadChange?.(sequenceTimeAtX(viewport, x, frameRate === undefined ? {} : { frameRate }));
  };

  const handleRulerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || !scrubbingRef.current) return;
    const x = pointerX(event, containerRef.current);
    if (!Number.isFinite(x)) return;
    onPlayheadChange?.(sequenceTimeAtX(viewport, x, frameRate === undefined ? {} : { frameRate }));
  };

  const endRuler = (event: ReactPointerEvent<HTMLDivElement>): void => {
    scrubbingRef.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleSelectionDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    const x = pointerX(event, containerRef.current);
    if (!Number.isFinite(x)) return;
    setDraft({ anchorXPx: x, focusXPx: x });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const handleSelectionMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (disabled || draft === null) return;
    const x = pointerX(event, containerRef.current);
    if (!Number.isFinite(x)) return;
    setDraft({ anchorXPx: draft.anchorXPx, focusXPx: x });
  };

  const handleSelectionUp = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (draft === null) return;
    const focusXPx = pointerX(event, containerRef.current);
    if (Number.isFinite(draft.anchorXPx) && Number.isFinite(focusXPx)) {
      emitSelectionFromDrag(draft.anchorXPx, focusXPx, event.shiftKey);
    }
    setDraft(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      setDraft(null);
      onSelectionChange?.(null);
    }
  };

  const committedRanges = selection === null ? [] : temporalSelectionRanges(selection);
  const draftRanges =
    draft === null || !Number.isFinite(draft.anchorXPx) || !Number.isFinite(draft.focusXPx)
      ? []
      : temporalSelectionRanges(
          temporalSelectionFromDrag({
            viewport,
            anchorXPx: draft.anchorXPx,
            focusXPx: draft.focusXPx,
            ...(frameRate === undefined ? {} : { frameRate }),
          }),
        );
  const previewRanges = draftRanges.length > 0 ? draftRanges : committedRanges;
  const playheadX = playhead === null ? null : xAtSequenceTime(viewport, playhead);
  const tickFractions = [0, 0.25, 0.5, 0.75, 1];
  const selectionLabel = describeTemporalSelection(selection, formatTime);

  return (
    <div
      data-testid="timeline-band"
      ref={containerRef}
      onKeyDown={handleKeyDown}
      className={`relative flex flex-col gap-1 select-none ${ui['panel']}`}
      style={{ width: `${String(viewport.widthPx)}px` }}
    >
      <div className="flex items-center justify-between px-2 pt-2 text-xs">
        <span className={ui['primaryText']}>横向时间带</span>
        <span data-testid="timeline-selection-label" className={ui['mutedText']}>
          {selectionLabel === null ? '未选择时间段（拖动选择带或 Shift+拖动叠加）' : `时间选区：${selectionLabel}`}
        </span>
      </div>

      <div className="relative px-2" style={{ height: '100%' }}>
        {/* 标尺：拖动改播放头（与时间选区分离，命中区域不重叠） */}
        <div
          data-testid="timeline-ruler"
          role="slider"
          aria-label="时间标尺（播放头）"
          aria-valuemin={0}
          aria-valuemax={1000}
          aria-valuenow={playhead === null ? 0 : Math.round(xAtSequenceTime(viewport, playhead))}
          className={`relative h-6 cursor-ew-resize border-b ${ui['divider']}`}
          onPointerDown={handleRulerDown}
          onPointerMove={handleRulerMove}
          onPointerUp={endRuler}
          onPointerCancel={endRuler}
        >
          {tickFractions.map((fraction) => (
            <span
              key={fraction}
              className={`absolute top-0 text-[10px] ${ui['mutedText']}`}
              style={{ left: `${String(fraction * 100)}%`, transform: 'translateX(-50%)' }}
            >
              {formatTime(sequenceTimeAtX(viewport, fraction * viewport.widthPx))}
            </span>
          ))}
        </div>

        {/* 专用选择带：拖动选时段；Shift+拖动叠加多区间 */}
        <div
          data-testid="timeline-selection-track"
          aria-label="时间选区带"
          className={`relative h-5 cursor-crosshair border-b ${ui['divider']} ${ui['inset']}`}
          onPointerDown={handleSelectionDown}
          onPointerMove={handleSelectionMove}
          onPointerUp={handleSelectionUp}
          onPointerCancel={handleSelectionUp}
        />

        {/* 轨道/片段块：点击片段选对象（不改播放头） */}
        <div data-testid="timeline-lanes" className="relative mt-1 flex flex-col gap-1">
          {lanes.length === 0 ? (
            <p data-testid="timeline-lanes-empty" className={`px-1 text-xs ${ui['mutedText']}`}>
              暂无片段/轨道数据。
            </p>
          ) : (
            lanes.map((lane) => (
              <div key={lane.id} data-testid={`timeline-lane-${lane.id}`} className="relative h-6">
                <span className={`absolute -left-0 top-0 w-16 truncate text-[10px] ${ui['mutedText']}`}>{lane.label}</span>
                {lane.clips.map((clip) => {
                  const start = xAtSequenceTime(viewport, clip.range.start);
                  const end = xAtSequenceTime(viewport, clip.range.end);
                  const left = Math.max(0, Math.min(start, end));
                  const width = Math.max(0, Math.abs(end - start));
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      data-testid={`timeline-clip-${clip.id}`}
                      aria-label={`片段 ${clip.label}`}
                      disabled={disabled}
                      onClick={() => onClipSelect?.(clip.id)}
                      className={`absolute top-0 h-6 overflow-hidden rounded-sm border px-1 text-left text-[10px] ${ui['button']}`}
                      style={{ left: `${String(left)}px`, width: `${String(Math.max(width, 2))}px` }}
                    >
                      {clip.label}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* 选区覆盖层（跨标尺与轨道） */}
        <div data-testid="timeline-selection-overlay" className="pointer-events-none absolute inset-0 top-0">
          {previewRanges.map((range, index) => {
            const start = xAtSequenceTime(viewport, range.start);
            const end = xAtSequenceTime(viewport, range.end);
            const left = Math.max(0, Math.min(start, end));
            const width = Math.max(0, Math.abs(end - start));
            return (
              <div
                key={`${String(index)}-${range.start.ticks}`}
                data-testid={`timeline-range-${String(index)}`}
                className="absolute top-0 bottom-0 border-x"
                style={{ left: `${String(left)}px`, width: `${String(width)}px`, background: 'var(--ui-bg-hover)' }}
              />
            );
          })}
        </div>

        {/* 播放头 */}
        {playheadX !== null ? (
          <div
            data-testid="timeline-playhead"
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 w-px"
            style={{ left: `${String(playheadX)}px`, background: 'var(--ui-fg-primary)' }}
          />
        ) : null}
      </div>

      <div className="flex items-center gap-2 px-2 pb-2 text-xs">
        <button
          type="button"
          data-testid="timeline-selection-clear"
          disabled={disabled || selection === null}
          onClick={() => onSelectionChange?.(null)}
          className={ui['button']}
        >
          清除时间选区
        </button>
        <span className={ui['mutedText']}>播放头：{playhead === null ? '—' : formatTime(playhead)}</span>
      </div>
    </div>
  );
}
