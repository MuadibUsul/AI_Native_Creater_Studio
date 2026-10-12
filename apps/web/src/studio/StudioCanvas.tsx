'use client';

import { useEffect, useRef, useState, type DragEvent, type ReactNode, type RefObject } from 'react';
import type { RenderPlanCaption, SequencePreview } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './studio.module.css';

/**
 * 作品画布：播放服务端低清预览（与终渲染同一计划）；字幕由浏览器按计划叠加，不烧录。
 * 视频保持原色；试改预览有明确标记，采用前工程不变。
 */

export type CanvasMode = 'empty' | 'processing' | 'noCut' | 'video';

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
  onAddFootage: () => void;
  onDropFiles: (files: File[]) => void;
  onFirstCut: () => void;
  onRetryPreview: () => void;
  onVideoError: () => void;
  onTimeUpdate: () => void;
  onLoaded: () => void;
  onPlayState: (playing: boolean) => void;
}) {
  const { messages } = useI18n();
  const t = messages.studio.canvas;
  const ratio = parseRatio(props.aspectRatio);
  const [stageRef, box] = useFittedBox(ratio);
  const [dragging, setDragging] = useState(false);

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

  let content: ReactNode;
  if (props.mode === 'empty') {
    content = (
      <div className={styles['empty']}>
        <h2>{t.emptyTitle}</h2>
        <p>{t.emptyBody}</p>
        {props.canEdit ? <button type="button" className={styles['onMatteButton']} onClick={props.onAddFootage}><QuietIcon name="upload" />{t.addFootage}</button> : null}
        {uploadsList}
      </div>
    );
  } else if (props.mode === 'processing') {
    content = (
      <div className={styles['empty']} role="status">
        <span className={styles['spinner']} aria-hidden="true" />
        <h2>{t.processingTitle}</h2>
        <p>{t.processingBody}</p>
        {uploadsList}
      </div>
    );
  } else if (props.mode === 'noCut') {
    content = (
      <div className={styles['empty']}>
        <h2>{t.noCutTitle}</h2>
        <p>{t.noCutBody}</p>
        {props.canEdit ? <button type="button" className={styles['onMatteButton']} disabled={props.firstCutBusy} onClick={props.onFirstCut}><QuietIcon name="spark" />{t.firstCut}</button> : null}
        {uploadsList}
      </div>
    );
  } else {
    const captions = props.shown === null ? [] : activeCaptions(props.shown.captions, props.seconds);
    const pending = props.target === null || props.target.status === 'QUEUED' || props.target.status === 'RENDERING';
    content = (
      <div className={styles['frame']} style={{ width: `${String(box.width)}px`, height: `${String(box.height)}px` }}>
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

  return (
    <div
      ref={stageRef}
      className={`${styles['stage']} ${dragging ? styles['stageDrop'] : ''}`}
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      aria-label={t.label}
      role="region"
    >
      {content}
      {dragging ? <span className={styles['visuallyHidden']} role="status">{t.dropHere}</span> : null}
    </div>
  );
}
