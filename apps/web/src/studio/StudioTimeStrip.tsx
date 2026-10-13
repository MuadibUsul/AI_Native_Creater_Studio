'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  compareMediaTime,
  mediaTimeSchema,
  sequenceTimeAtX,
  stepFrames,
  temporalSelectionFromDrag,
  temporalSelectionRanges,
  xAtSequenceTime,
  type FrameRate,
  type MediaRange,
  type MediaTime,
  type TimelineViewport,
} from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { formatClock } from './studio-time';
import styles from './studio.module.css';

/**
 * 共看片室时间带：标尺拖动定位播放头；片段区拖动选一段时间（有理时间，按帧网格吸附），点击选中片段。
 * 选择本身不改工程，只交给对话作为"指着哪里"。
 */

export interface StudioSelection {
  range: MediaRange | null;
  clipId: string | null;
}

/** 时间带上的一个片段：当前版本取自工程文档，试改时取自试改预览的计划（同一 id，采用后不变）。 */
export interface StripClip {
  id: string;
  trackId: string;
  kind: 'VIDEO' | 'AUDIO';
  assetVersionId: string | null;
  sequenceRange: MediaRange;
}

export interface StripLane {
  trackId: string;
  kind: 'VIDEO' | 'AUDIO';
  /** 特效轨（V6-3）：轨上是特效图层 */
  effect?: boolean;
  /** 讲述轨（V6-5）：轨上是 AI 合成的讲述配音 */
  narration?: boolean;
}

const DRAG_THRESHOLD_PX = 4;

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => setWidth(element.getBoundingClientRect().width);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** 标尺刻度：按可用宽度选 1/2/5/10/15/30/60 秒间隔。 */
function tickTimes(duration: MediaTime, widthPx: number): MediaTime[] {
  const total = (Number(duration.ticks) * duration.timebase.num) / duration.timebase.den;
  const maxTicks = Math.max(2, Math.floor(widthPx / 90));
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300].find((candidate) => total / candidate <= maxTicks) ?? 600;
  const ticks: MediaTime[] = [];
  for (let second = 0; second < total; second += step) ticks.push(mediaTimeSchema.parse({ ticks: String(second), timebase: { num: 1, den: 1 } }));
  return ticks;
}

export function StudioTimeStrip(props: {
  duration: MediaTime;
  frameRate: FrameRate;
  lanes: StripLane[];
  clips: StripClip[];
  clipLabel: (clip: StripClip) => string;
  playhead: MediaTime;
  selection: StudioSelection;
  onSeek: (time: MediaTime) => void;
  onSelectionChange: (selection: StudioSelection) => void;
}) {
  const { messages } = useI18n();
  const t = messages.studio.strip;
  const [ref, width] = useWidth();
  const [drag, setDrag] = useState<{ anchorX: number; focusX: number; clipId: string | null; moved: boolean } | null>(null);
  const scrubbing = useRef(false);
  const hasDuration = Number(props.duration.ticks) > 0;
  const viewport: TimelineViewport | null = width > 0 && hasDuration
    ? { start: mediaTimeSchema.parse({ ticks: '0', timebase: props.duration.timebase }), end: props.duration, widthPx: width }
    : null;

  const xOf = (event: { clientX: number }): number => {
    const rect = ref.current?.getBoundingClientRect();
    return rect === undefined ? 0 : Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  };
  const timeAt = (x: number): MediaTime | null => (viewport === null ? null : sequenceTimeAtX(viewport, x, { frameRate: props.frameRate }));

  const onRulerDown = (event: PointerEvent<HTMLDivElement>) => {
    const time = timeAt(xOf(event));
    if (time === null) return;
    scrubbing.current = true;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    props.onSeek(time);
  };
  const onRulerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!scrubbing.current) return;
    const time = timeAt(xOf(event));
    if (time !== null) props.onSeek(time);
  };
  const onRulerUp = (event: PointerEvent<HTMLDivElement>) => {
    scrubbing.current = false;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  const onLanesDown = (event: PointerEvent<HTMLDivElement>) => {
    if (viewport === null || event.button !== 0) return;
    const clipId = (event.target as HTMLElement).closest<HTMLElement>('[data-clip-id]')?.dataset['clipId'] ?? null;
    const x = xOf(event);
    setDrag({ anchorX: x, focusX: x, clipId, moved: false });
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onLanesMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag === null) return;
    const x = xOf(event);
    setDrag({ ...drag, focusX: x, moved: drag.moved || Math.abs(x - drag.anchorX) > DRAG_THRESHOLD_PX });
  };
  const onLanesUp = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const finished = drag;
    setDrag(null);
    if (finished === null || viewport === null) return;
    if (finished.moved) {
      const selection = temporalSelectionFromDrag({ viewport, anchorXPx: finished.anchorX, focusXPx: finished.focusX, frameRate: props.frameRate, pointThresholdPx: DRAG_THRESHOLD_PX });
      const range = temporalSelectionRanges(selection)[0];
      if (range !== undefined) props.onSelectionChange({ range, clipId: null });
      return;
    }
    if (finished.clipId !== null) {
      props.onSelectionChange({ range: null, clipId: finished.clipId });
      return;
    }
    const time = timeAt(finished.anchorX);
    if (time !== null) props.onSeek(time);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') props.onSelectionChange({ range: null, clipId: null });
  };

  const draftRange = drag !== null && drag.moved && viewport !== null
    ? temporalSelectionRanges(temporalSelectionFromDrag({ viewport, anchorXPx: drag.anchorX, focusXPx: drag.focusX, frameRate: props.frameRate, pointThresholdPx: DRAG_THRESHOLD_PX }))[0] ?? null
    : null;
  const shownRange = draftRange ?? props.selection.range;
  const span = (range: MediaRange): { left: number; width: number } => {
    if (viewport === null) return { left: 0, width: 0 };
    const left = xAtSequenceTime(viewport, range.start);
    return { left, width: Math.max(2, xAtSequenceTime(viewport, range.end) - left) };
  };
  const lanes = props.lanes.map((lane) => ({
    trackId: lane.trackId,
    label: lane.effect === true ? t.effects : lane.narration === true ? t.narration : lane.kind === 'VIDEO' ? t.video : t.audio,
    audio: lane.kind === 'AUDIO',
    effect: lane.effect === true,
    narration: lane.narration === true,
  }));
  const playheadX = viewport === null || props.clips.length === 0 || compareMediaTime(props.playhead, props.duration) > 0 ? null : xAtSequenceTime(viewport, props.playhead);

  return (
    <div className={styles['strip']} ref={ref} role="group" aria-label={t.label} tabIndex={-1} onKeyDown={onKeyDown}>
      <div
        className={styles['ruler']}
        role="slider"
        tabIndex={0}
        aria-label={t.ruler}
        aria-valuemin={0}
        aria-valuemax={Math.round((Number(props.duration.ticks) * props.duration.timebase.num) / props.duration.timebase.den)}
        aria-valuenow={Math.round((Number(props.playhead.ticks) * props.playhead.timebase.num) / props.playhead.timebase.den)}
        aria-valuetext={formatClock(props.playhead)}
        onPointerDown={onRulerDown}
        onPointerMove={onRulerMove}
        onPointerUp={onRulerUp}
        onPointerCancel={onRulerUp}
        onKeyDown={(event) => {
          if (viewport === null || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
          event.preventDefault();
          const delta = (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 1);
          props.onSeek(stepFrames({ time: props.playhead, frameRate: props.frameRate, delta, bounds: { start: viewport.start, end: viewport.end } }));
        }}
      >
        {viewport !== null ? tickTimes(props.duration, width).map((time) => (
          <span key={time.ticks} className={styles['tick']} style={{ left: `${String(xAtSequenceTime(viewport, time))}px` }}>{formatClock(time).replace(/\.\d$/, '')}</span>
        )) : null}
      </div>
      <div className={styles['lanes']} aria-label={t.selectArea} onPointerDown={onLanesDown} onPointerMove={onLanesMove} onPointerUp={onLanesUp} onPointerCancel={onLanesUp}>
        {props.clips.length === 0 ? <p className={styles['stripEmpty']}>{t.empty}</p> : lanes.map((lane) => (
          <div key={lane.trackId} className={`${styles['lane']} ${lane.audio ? styles['laneAudio'] : ''} ${lane.effect ? styles['laneEffect'] : ''} ${lane.narration ? styles['laneNarration'] : ''}`}>
            <span className={styles['laneLabel']}>{lane.label}</span>
            {props.clips.filter((clip) => clip.trackId === lane.trackId).map((clip) => {
              const box = span(clip.sequenceRange);
              const label = props.clipLabel(clip);
              const selected = props.selection.clipId === clip.id;
              return (
                <button
                  key={clip.id}
                  type="button"
                  data-clip-id={clip.id}
                  className={`${styles['clip']} ${lane.audio ? styles['clipAudio'] : ''} ${lane.effect ? styles['clipEffect'] : ''} ${lane.narration ? styles['clipNarration'] : ''} ${selected ? styles['clipSelected'] : ''}`}
                  style={{ left: `${String(box.left)}px`, width: `${String(box.width)}px` }}
                  aria-pressed={selected}
                  aria-label={t.clip(lane.effect ? t.effect(label) : lane.narration ? t.narrationClip(label) : label, formatClock(clip.sequenceRange.start), formatClock(clip.sequenceRange.end))}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      props.onSelectionChange({ range: null, clipId: selected ? null : clip.id });
                    }
                  }}
                >
                  {lane.audio && !lane.narration ? '' : label}
                </button>
              );
            })}
          </div>
        ))}
        {shownRange !== null && viewport !== null ? <div className={styles['selection']} style={{ left: `${String(span(shownRange).left)}px`, width: `${String(span(shownRange).width)}px` }} /> : null}
      </div>
      {playheadX !== null ? <div className={styles['playhead']} style={{ left: `${String(playheadX)}px` }} aria-hidden="true" /> : null}
    </div>
  );
}
