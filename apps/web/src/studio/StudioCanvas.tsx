'use client';

import { useEffect, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import type { FrameRegion, RenderPlanCaption, SequencePreview } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import { unionRect, useBoardCamera } from './board-camera';
import styles from './studio.module.css';

/**
 * 作品画布：播放服务端低清预览（与终渲染同一计划）；字幕由浏览器按计划叠加，不烧录。
 * 视频保持原色；试改预览有明确标记，采用前工程不变。
 *
 * 无限画布（参照 Stitch）：成片屏幕放在世界坐标原点，素材、制作计划、文章等画框并排在右侧；拖动空白处平移，
 * ⌘/Ctrl + 滚轮或双指捏合缩放，"看全部"/"只看成片"适配。语音条与画布视图按钮浮在视口上，不随镜头缩放；
 * 时间带在画布外，测量不受影响。手机宽度保持一列（不变换，只放成片屏幕）。
 */

/** 世界坐标里成片屏幕的尺寸：长边 640（与右侧画框的文字大小成比例，"看全部"时画框文字仍清楚） */
export function monitorWorldSize(ratio: number): { width: number; height: number } {
  return ratio >= 1 ? { width: 640, height: Math.round(640 / ratio) } : { width: Math.round(640 * ratio), height: 640 };
}
/** 成片屏幕与右侧画框之间的间距、右侧画框列宽（世界坐标） */
export const BOARD_GAP = 56;
export const BOARD_SIDE_WIDTH = 300;

/** 手机宽度（与样式表的 760px 断点一致）：一列布局，不做画布变换 */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(max-width: 760px)');
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return narrow;
}

/** 元素的布局高度（不受父级变换影响） */
function useLayoutHeight(ref: RefObject<HTMLElement | null>, active: boolean): number {
  const [height, setHeight] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (element === null || !active) { setHeight(0); return; }
    const update = () => setHeight(element.offsetHeight);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return height;
}

/** article（V6-5）：从文章开始的工程，还没有素材也还没有剪辑 */
export type CanvasMode = 'empty' | 'processing' | 'noCut' | 'article' | 'video';

export interface UploadProgress {
  id: string;
  name: string;
  percent: number;
  failed: boolean;
}

function parseRatio(aspectRatio: string): number {
  const [width, height] = aspectRatio.split(':').map(Number);
  return width !== undefined && height !== undefined && width > 0 && height > 0 ? width / height : 16 / 9;
}

/** 在容器内按画幅放下最大的画面框（不裁切、不拉伸）。 */
function useFittedBox(ratio: number): [RefObject<HTMLDivElement | null>, { width: number; height: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const update = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const height = element.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const fittedWidth = Math.max(0, Math.min(width, height * ratio));
      setBox({ width: Math.floor(fittedWidth), height: Math.floor(fittedWidth / ratio) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ratio]);
  return [ref, box];
}

const secondsOf = (time: { ticks: string; timebase: { num: number; den: number } }): number => (Number(time.ticks) * time.timebase.num) / time.timebase.den;

export function activeCaptions(captions: readonly RenderPlanCaption[], seconds: number): RenderPlanCaption[] {
  return captions.filter((caption) => secondsOf(caption.sequenceRange.start) <= seconds && seconds < secondsOf(caption.sequenceRange.end));
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** 两个拖动端点（0–1）→ 画面区域；太小（< 2%）视为没框。 */
export function regionFromPoints(from: { x: number; y: number }, to: { x: number; y: number }): FrameRegion | null {
  const x = Math.min(from.x, to.x);
  const y = Math.min(from.y, to.y);
  const width = Math.abs(to.x - from.x);
  const height = Math.abs(to.y - from.y);
  if (![x, y, width, height].every(Number.isFinite) || width < 0.02 || height < 0.02) return null;
  const round = (value: number) => Math.round(value * 1000) / 1000;
  return { x: round(x), y: round(y), width: round(Math.min(width, 1 - x)), height: round(Math.min(height, 1 - y)) };
}

const regionStyle = (region: FrameRegion) => ({
  left: `${String(region.x * 100)}%`,
  top: `${String(region.y * 100)}%`,
  width: `${String(region.width * 100)}%`,
  height: `${String(region.height * 100)}%`,
});

export function StudioCanvas(props: {
  aspectRatio: string;
  mode: CanvasMode;
  videoRef: RefObject<HTMLVideoElement | null>;
  shown: SequencePreview | null;
  target: SequencePreview | null;
  targetFailed: boolean;
  trial: boolean;
  seconds: number;
  uploads: UploadProgress[];
  canEdit: boolean;
  firstCutBusy: boolean;
  /** 从文章开始的工程：文章段数（article 状态显示） */
  articleParagraphs?: number;
  onAddFootage: () => void;
  onDropFiles: (files: File[]) => void;
  onFirstCut: () => void;
  /** V6-9：交给 AI 剪完（打开设置）；有进行中的自主制作时不给 */
  onDelegate?: (() => void) | null;
  /** V6-9 交给 AI 剪完的按钮文案 */
  delegateLabel?: string;
  onRetryPreview: () => void;
  onVideoError: () => void;
  onTimeUpdate: () => void;
  onLoaded: () => void;
  onPlayState: (playing: boolean) => void;
  /** 框出的画面区域（V6-3："这里"指画面上的一块） */
  region: FrameRegion | null;
  /** 正在框选：画面上覆盖一层拖动框选 */
  drawing: boolean;
  onRegion: (region: FrameRegion) => void;
  /** Issue #9：浮在看片区底部的语音条；有它时看片区下边距加大，画面按画幅缩进让出位置（不压视频与字幕） */
  voiceDock?: ReactNode;
  /** 无限画布：成片屏幕右侧的画框（素材、制作计划、文章…）；手机宽度不显示 */
  boardFrames?: ReactNode;
}) {
  const { messages } = useI18n();
  const t = messages.studio.canvas;
  const tb = messages.studio.board;
  const ratio = parseRatio(props.aspectRatio);
  const [stageRef, fitted] = useFittedBox(ratio);
  const narrow = useNarrow();
  const board = !narrow;
  const monitor = monitorWorldSize(ratio);
  const box = board ? monitor : fitted;
  const sideRef = useRef<HTMLDivElement | null>(null);
  const hasSide = board && props.boardFrames !== undefined && props.boardFrames !== null;
  const sideHeight = useLayoutHeight(sideRef, hasSide);
  const voiceOn = props.voiceDock !== undefined && props.voiceDock !== null;
  const monitorRect = { x: 0, y: 0, width: monitor.width, height: monitor.height };
  const all = hasSide && sideHeight > 0 ? unionRect([monitorRect, { x: monitor.width + BOARD_GAP, y: 0, width: BOARD_SIDE_WIDTH, height: sideHeight }]) : null;
  // 画框标签浮在画框上方（屏幕上恒定大小），留白里已给它让出位置
  const camera = useBoardCamera(stageRef, {
    enabled: board,
    all,
    monitor: monitorRect,
    insets: { top: 92, right: 32, bottom: voiceOn ? 124 : 32, left: 32 },
    initial: 'all',
  });
  // 键盘：Shift+1 看全部，Shift+2 只看成片（正在输入、带其他修饰键时不接管）
  useEffect(() => {
    if (!board) return;
    const onKey = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      if (event.code === 'Digit1') { event.preventDefault(); camera.fitAll(); }
      if (event.code === 'Digit2') { event.preventDefault(); camera.fitMonitor(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [board, camera.fitAll, camera.fitMonitor]);
  const [dragging, setDragging] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [drawFrom, setDrawFrom] = useState<{ x: number; y: number } | null>(null);
  const [drawDraft, setDrawDraft] = useState<FrameRegion | null>(null);
  const pointAt = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const shownRegion = drawDraft ?? props.region;

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!props.canEdit || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (!props.canEdit || event.dataTransfer.files.length === 0) return;
    event.preventDefault();
    props.onDropFiles(Array.from(event.dataTransfer.files));
  };

  const uploadsList = props.uploads.length === 0 ? null : (
    <div className={styles['uploadList']} aria-live="polite">
      {props.uploads.map((upload) => (
        <div key={upload.id} className={styles['uploadRow']}>
          <strong title={upload.name}>{upload.name}</strong>
          <span>{upload.failed ? messages.studio.footage.uploadFailed : messages.studio.footage.uploading(upload.percent)}</span>
        </div>
      ))}
    </div>
  );

  const delegate = props.canEdit && props.onDelegate !== undefined && props.onDelegate !== null
    ? <button type="button" className={styles['onMatteButtonQuiet']} onClick={props.onDelegate}><QuietIcon name="spark" />{props.delegateLabel}</button>
    : null;
  let content: ReactNode;
  if (props.mode === 'empty') {
    content = (
      <div className={styles['empty']}>
        <h2>{t.emptyTitle}</h2>
        <p>{t.emptyBody}</p>
        {props.canEdit ? (
          <div className={styles['emptyActions']}>
            <button type="button" className={styles['onMatteButton']} onClick={props.onAddFootage}><QuietIcon name="upload" />{t.addFootage}</button>
            {delegate}
          </div>
        ) : null}
        {uploadsList}
      </div>
    );
  } else if (props.mode === 'processing') {
    content = (
      <div className={styles['empty']} role="status">
        <span className={styles['spinner']} aria-hidden="true" />
        <h2>{t.processingTitle}</h2>
        <p>{t.processingBody}</p>
        {delegate}
        {uploadsList}
      </div>
    );
  } else if (props.mode === 'article') {
    content = (
      <div className={styles['empty']}>
        <h2>{t.articleTitle(props.articleParagraphs ?? 0)}</h2>
        <p>{t.articleBody}</p>
        {props.canEdit ? (
          <div className={styles['emptyActions']}>
            <button type="button" className={styles['onMatteButton']} disabled={props.firstCutBusy} onClick={props.onFirstCut}><QuietIcon name="spark" />{t.articleFirstCut}</button>
            <button type="button" className={styles['onMatteButtonQuiet']} onClick={props.onAddFootage}><QuietIcon name="upload" />{t.addFootage}</button>
            {delegate}
          </div>
        ) : null}
        {uploadsList}
      </div>
    );
  } else if (props.mode === 'noCut') {
    content = (
      <div className={styles['empty']}>
        <h2>{t.noCutTitle}</h2>
        <p>{t.noCutBody}</p>
        {props.canEdit ? (
          <div className={styles['emptyActions']}>
            <button type="button" className={styles['onMatteButton']} disabled={props.firstCutBusy} onClick={props.onFirstCut}><QuietIcon name="spark" />{t.firstCut}</button>
            {delegate}
          </div>
        ) : null}
        {uploadsList}
      </div>
    );
  } else {
    const captions = props.shown === null ? [] : activeCaptions(props.shown.captions, props.seconds);
    const pending = props.target === null || props.target.status === 'QUEUED' || props.target.status === 'RENDERING';
    content = (
      <div ref={frameRef} className={styles['frame']} style={{ width: `${String(box.width)}px`, height: `${String(box.height)}px` }}>
        {props.shown?.playbackUrl ? (
          <video
            ref={props.videoRef}
            className={styles['video']}
            src={props.shown.playbackUrl}
            playsInline
            preload="auto"
            aria-label={t.label}
            onError={props.onVideoError}
            onTimeUpdate={props.onTimeUpdate}
            onLoadedMetadata={props.onLoaded}
            onPlay={() => props.onPlayState(true)}
            onPause={() => props.onPlayState(false)}
            onEnded={() => props.onPlayState(false)}
          />
        ) : null}
        {captions.length > 0 ? <div className={styles['caption']}>{captions.map((caption) => <span key={caption.captionId}>{caption.text}</span>)}</div> : null}
        {props.shown !== null ? <span className={`${styles['badge']} ${props.trial ? styles['badgeTrial'] : ''}`}>{props.trial ? t.trialBadge : t.currentBadge}</span> : null}
        {shownRegion !== null ? <span className={styles['regionBox']} role="img" aria-label={t.areaLabel} style={regionStyle(shownRegion)} /> : null}
        {props.drawing ? (
          <div
            className={styles['drawLayer']}
            role="application"
            aria-label={t.markAreaHint}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrawFrom(pointAt(event));
              setDrawDraft(null);
            }}
            onPointerMove={(event) => { if (drawFrom !== null) setDrawDraft(regionFromPoints(drawFrom, pointAt(event))); }}
            onPointerUp={(event) => {
              if (drawFrom !== null) {
                const region = regionFromPoints(drawFrom, pointAt(event));
                if (region !== null) props.onRegion(region);
              }
              setDrawFrom(null);
              setDrawDraft(null);
            }}
            onPointerCancel={() => { setDrawFrom(null); setDrawDraft(null); }}
          />
        ) : null}
        {props.targetFailed ? (
          <div className={styles['stageStatus']}><div role="alert">
            <strong>{t.renderFailed}</strong>
            <p>{t.renderFailedBody}</p>
            <button type="button" className={styles['onMatteButton']} onClick={props.onRetryPreview}>{messages.common.retry}</button>
          </div></div>
        ) : pending ? (
          <div className={styles['stageStatus']}><div role="status">
            <span className={styles['spinner']} aria-hidden="true" />
            <span>{t.rendering}</span>
          </div></div>
        ) : null}
      </div>
    );
  }

  const { x, y, k } = camera.camera;
  return (
    <div
      ref={stageRef}
      className={`${styles['stage']} ${dragging ? styles['stageDrop'] : ''}`}
      data-voice={voiceOn ? 'on' : undefined}
      data-board={board ? 'on' : undefined}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-label={t.label}
      role="region"
    >
      {board ? (
        <>
          <div className={styles['world']} style={{ transform: `translate(${String(x)}px, ${String(y)}px) scale(${String(k)})`, ['--board-inv' as string]: String(1 / k) }}>
            <section data-board-frame className={styles['monitor']} style={{ width: `${String(monitor.width)}px`, height: `${String(monitor.height)}px` }} data-mode={props.mode}>
              <h3 className={styles['boardLabel']}>{tb.monitor}</h3>
              {content}
            </section>
            {hasSide ? (
              <div ref={sideRef} className={styles['boardSide']} style={{ left: `${String(monitor.width + BOARD_GAP)}px`, width: `${String(BOARD_SIDE_WIDTH)}px` }}>
                {props.boardFrames}
              </div>
            ) : null}
          </div>
          <div className={`${styles['boardControls']} ui-glass`} role="toolbar" aria-label={tb.viewLabel} title={tb.hint}>
            <button type="button" className="btn icononly ghost small" aria-label={tb.zoomOut} onClick={() => camera.zoomBy(1 / 1.25)}>−</button>
            <span className={styles['boardZoom']} aria-live="polite">{tb.zoomLevel(Math.round(k * 100))}</span>
            <button type="button" className="btn icononly ghost small" aria-label={tb.zoomIn} onClick={() => camera.zoomBy(1.25)}>+</button>
            <span className={styles['divider']} aria-hidden="true" />
            <button type="button" className="btn ghost small" aria-pressed={camera.follow === 'all'} aria-keyshortcuts="Shift+1" onClick={camera.fitAll}>{tb.fitAll}</button>
            <button type="button" className="btn ghost small" aria-pressed={camera.follow === 'monitor'} aria-keyshortcuts="Shift+2" onClick={camera.fitMonitor}>{tb.fitMonitor}</button>
          </div>
        </>
      ) : content}
      {props.voiceDock ?? null}
      {dragging ? <span className={styles['visuallyHidden']} role="status">{t.dropHere}</span> : null}
    </div>
  );
}
