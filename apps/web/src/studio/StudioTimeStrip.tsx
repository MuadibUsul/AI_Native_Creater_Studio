'use client';

import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  compareMediaTime,
  mediaTimeSchema,
  mediaTimeToDisplaySeconds,
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
import { waveformBars, waveformLevel, type FootageWaveform } from './studio-waveform';
import styles from './studio.module.css';

/**
 * 共看片室时间带：标尺拖动定位播放头；片段区拖动选一段时间（有理时间，按帧网格吸附），点击选中片段。
 * 选择本身不改工程，只交给对话作为"指着哪里"。
 * 缩放（界面精修第三阶段）：zoom > 1 时内容按倍数加宽、横向滚动；坐标换算仍走 contracts 的有理视口（widthPx = 可见宽 × zoom），
 * Ctrl/⌘ + 滚轮以指针处为锚点缩放，其余方式以播放头为锚点；播放头移出可见区时自动跟随。
 * 试改改动：changes 来自服务端 A/B 对照（真实片段区间），只画在标尺下沿，不改选区。
 * 触屏（界面精修第四阶段）：两指捏合按档位缩放、以两指中点为锚；两指平移横向滚动；第二根手指落下时取消单指选择。
 * 波形：声音片段画出所用源区间的实测峰值（媒体索引）；没有测量值就不画。
 */

/** 时间带缩放档位（1 = 适合宽度） */
export const STRIP_ZOOM_LEVELS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16] as const;

/** 离目标倍数最近的缩放档位（按对数距离；双指捏合用） */
export function nearestStripZoom(target: number): number {
  const levels: readonly number[] = STRIP_ZOOM_LEVELS;
  if (!(target > 0)) return levels[0]!;
  return levels.reduce((best, level) => (Math.abs(Math.log(level / target)) < Math.abs(Math.log(best / target)) ? level : best), levels[0]!);
}

/** 下一档缩放（direction 1 放大，-1 缩小），到头不变 */
export function nextStripZoom(current: number, direction: 1 | -1): number {
  const levels: readonly number[] = STRIP_ZOOM_LEVELS;
  if (direction > 0) return levels.find((level) => level > current + 1e-9) ?? levels[levels.length - 1]!;
  return [...levels].reverse().find((level) => level < current - 1e-9) ?? levels[0]!;
}

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
  /** 片段用到的源区间（画波形用）；试改中改过的片段不知道源区间时为空，不画波形 */
  source?: { range: MediaRange; reverse: boolean };
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

/** 标尺刻度：按内容宽度选间隔（以 0.1 秒为单位：0.1/0.2/0.5/1/2/5/10/15/30/60… 秒），刻度时间是有理的十分之一秒。 */
function tickTimes(duration: MediaTime, widthPx: number): { time: MediaTime; tenths: boolean }[] {
  const totalTenths = (Number(duration.ticks) * duration.timebase.num * 10) / duration.timebase.den;
  const maxTicks = Math.max(2, Math.floor(widthPx / 90));
  const step = [1, 2, 5, 10, 20, 50, 100, 150, 300, 600, 1200, 3000].find((candidate) => totalTenths / candidate <= maxTicks) ?? 6000;
  const ticks: { time: MediaTime; tenths: boolean }[] = [];
  for (let tenth = 0; tenth < totalTenths; tenth += step) ticks.push({ time: mediaTimeSchema.parse({ ticks: String(tenth), timebase: { num: 1, den: 10 } }), tenths: step < 10 });
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
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** 试改相对当前版本内容有改动的序列区间（来自服务端对照） */
  changes?: MediaRange[];
  /** 资产版本 → 实测波形（媒体索引） */
  waveforms?: ReadonlyMap<string, FootageWaveform>;
}) {
  const { messages } = useI18n();
  const t = messages.studio.strip;
  const [ref, width] = useWidth();
  const contentRef = useRef<HTMLDivElement | null>(null);
  const zoom = props.zoom ?? 1;
  const contentWidth = width * zoom;
  const onZoomChange = props.onZoomChange;
  // 缩放锚点：滚轮缩放记下指针处的内容比例，缩放后把同一位置放回指针下
  const pendingAnchor = useRef<{ fraction: number; offset: number } | null>(null);
  const [drag, setDrag] = useState<{ anchorX: number; focusX: number; clipId: string | null; moved: boolean } | null>(null);
  const scrubbing = useRef(false);
  const hasDuration = Number(props.duration.ticks) > 0;
  const viewport: TimelineViewport | null = width > 0 && hasDuration
    ? { start: mediaTimeSchema.parse({ ticks: '0', timebase: props.duration.timebase }), end: props.duration, widthPx: contentWidth }
    : null;

  const xOf = (event: { clientX: number }): number => {
    const rect = (contentRef.current ?? ref.current)?.getBoundingClientRect();
    return rect === undefined ? 0 : Math.min(Math.max(event.clientX - rect.left, 0), contentWidth);
  };

  useEffect(() => {
    const element = ref.current;
    if (element === null || onZoomChange === undefined) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const next = nextStripZoom(zoom, event.deltaY < 0 ? 1 : -1);
      if (next === zoom) return;
      const outer = element.getBoundingClientRect();
      const offset = event.clientX - outer.left;
      pendingAnchor.current = { fraction: contentWidth > 0 ? (element.scrollLeft + offset) / contentWidth : 0, offset };
      onZoomChange(next);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, [ref, zoom, contentWidth, onZoomChange]);
  // 触屏双指：捕获阶段记下触点；第二根手指落下时开始捏合并取消单指选择（不再传给片段区）
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ distance: number; zoom: number; midX: number } | null>(null);
  useEffect(() => {
    const element = ref.current;
    if (element === null || onZoomChange === undefined) return;
    const points = () => [...touches.current.values()];
    const distance = () => { const [a, b] = points(); return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0; };
    const midX = () => { const [a, b] = points(); return a && b ? (a.x + b.x) / 2 : 0; };
    const onDown = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (touches.current.size === 2) {
        pinch.current = { distance: distance(), zoom, midX: midX() };
        scrubbing.current = false;
        setDrag(null);
        event.stopPropagation();
      } else if (touches.current.size > 2) event.stopPropagation();
    };
    const onMove = (event: globalThis.PointerEvent) => {
      if (event.pointerType !== 'touch' || !touches.current.has(event.pointerId)) return;
      touches.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
      const gesture = pinch.current;
      if (gesture === null || touches.current.size !== 2) return;
      event.stopPropagation();
      const center = midX();
      element.scrollLeft = Math.max(0, element.scrollLeft - (center - gesture.midX));
      gesture.midX = center;
      if (gesture.distance <= 0) return;
      const next = nearestStripZoom(gesture.zoom * (distance() / gesture.distance));
      if (next === zoom) return;
      const offset = center - element.getBoundingClientRect().left;
      pendingAnchor.current = { fraction: contentWidth > 0 ? (element.scrollLeft + offset) / contentWidth : 0, offset };
      onZoomChange(next);
    };
    const onUp = (event: globalThis.PointerEvent) => {
      if (!touches.current.delete(event.pointerId)) return;
      if (touches.current.size < 2) pinch.current = null;
    };
    element.addEventListener('pointerdown', onDown, true);
    element.addEventListener('pointermove', onMove, true);
    element.addEventListener('pointerup', onUp, true);
    element.addEventListener('pointercancel', onUp, true);
    return () => {
      element.removeEventListener('pointerdown', onDown, true);
      element.removeEventListener('pointermove', onMove, true);
      element.removeEventListener('pointerup', onUp, true);
      element.removeEventListener('pointercancel', onUp, true);
    };
  }, [ref, zoom, contentWidth, onZoomChange]);
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

  // 缩放后：滚轮缩放保持指针处不动；其余方式让播放头留在可见区（靠左四分之一处）
  const lastZoom = useRef(zoom);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const anchor = pendingAnchor.current;
    pendingAnchor.current = null;
    if (anchor !== null) element.scrollLeft = Math.max(0, anchor.fraction * contentWidth - anchor.offset);
    else if (lastZoom.current !== zoom && playheadX !== null) element.scrollLeft = Math.max(0, playheadX - width / 4);
    lastZoom.current = zoom;
  }, [ref, zoom, contentWidth, width, playheadX]);
  // 播放头移出可见区（播放或跳转）时跟随
  useEffect(() => {
    const element = ref.current;
    if (element === null || zoom <= 1 || playheadX === null) return;
    if (playheadX < element.scrollLeft + 8 || playheadX > element.scrollLeft + width - 8) element.scrollLeft = Math.max(0, playheadX - width / 4);
  }, [ref, zoom, width, playheadX]);

  return (
    <div className={styles['strip']} ref={ref} role="group" aria-label={t.label} tabIndex={-1} onKeyDown={onKeyDown} data-zoomed={zoom > 1 ? 'true' : undefined}>
      <div className={styles['stripContent']} ref={contentRef} style={zoom > 1 ? { width: `${String(contentWidth)}px` } : undefined}>
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
        {viewport !== null ? tickTimes(props.duration, contentWidth).map(({ time, tenths }) => (
          <span key={time.ticks} className={styles['tick']} style={{ left: `${String(xAtSequenceTime(viewport, time))}px` }}>{tenths ? formatClock(time) : formatClock(time).replace(/\.\d$/, '')}</span>
        )) : null}
        {viewport !== null ? (props.changes ?? []).map((range) => (
          <span key={`${range.start.ticks}/${range.start.timebase.den}-${range.end.ticks}`} className={styles['change']} title={t.changed} style={{ left: `${String(span(range).left)}px`, width: `${String(span(range).width)}px` }} />
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
                  {lane.audio ? <ClipWaveform wave={clip.assetVersionId === null ? undefined : props.waveforms?.get(clip.assetVersionId)} source={clip.source} width={box.width} /> : null}
                </button>
              );
            })}
          </div>
        ))}
        {shownRange !== null && viewport !== null ? <div className={styles['selection']} style={{ left: `${String(span(shownRange).left)}px`, width: `${String(span(shownRange).width)}px` }} /> : null}
      </div>
      {playheadX !== null ? <div className={styles['playhead']} style={{ left: `${String(playheadX)}px` }} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

/** 声音片段里的波形：每根柱子约 3 px，高度 = 该段实测峰值（分贝刻度）；没有测量值的柱子留空 */
function ClipWaveform(props: { wave: FootageWaveform | undefined; source: StripClip['source']; width: number }) {
  if (props.wave === undefined || props.source === undefined || props.width < 6) return null;
  const bars = waveformBars(props.wave, mediaTimeToDisplaySeconds(props.source.range.start), mediaTimeToDisplaySeconds(props.source.range.end), Math.min(800, Math.floor(props.width / 3)), props.source.reverse)
    .map((value) => (value === null ? null : waveformLevel(value)));
  if (!bars.some((value) => value !== null && value > 0)) return null;
  const path = bars.map((value, index) => {
    if (value === null || value <= 0) return '';
    const height = Math.max(4, value * 96);
    return `M${String(index + 0.15)} ${String(50 - height / 2)}h0.7v${String(height)}h-0.7z`;
  }).join('');
  return <svg className={styles['wave']} viewBox={`0 0 ${String(bars.length)} 100`} preserveAspectRatio="none" aria-hidden="true" data-waveform="true"><path d={path} /></svg>;
}
