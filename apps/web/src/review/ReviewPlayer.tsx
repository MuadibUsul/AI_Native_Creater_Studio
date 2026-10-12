'use client';

import { useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import type { ReviewRegion, SequencePreview } from '@ancs/contracts';
import { activeCaptions } from '@/studio/StudioCanvas';
import styles from './review.module.css';

/**
 * 审片播放器：播放服务端低清预览（原生控件，手机上可靠）；字幕由浏览器叠加；
 * 当前时刻有框选的批注时显示虚线框；标记时可在画面上拖出一个框（0–1 归一化坐标）。
 */

function parseRatio(aspectRatio: string): number {
  const [width, height] = aspectRatio.split(':').map(Number);
  return width !== undefined && height !== undefined && width > 0 && height > 0 ? width / height : 16 / 9;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export interface PlayerNoteRegion {
  id: string;
  region: ReviewRegion;
}

export function ReviewPlayer(props: {
  aspectRatio: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  preview: SequencePreview | null;
  badge: { text: string; trial: boolean } | null;
  status: string | null;
  seconds: number;
  noteRegions: PlayerNoteRegion[];
  drawing: boolean;
  draftRegion: ReviewRegion | null;
  drawLabel: string;
  onDraftRegion: (region: ReviewRegion | null) => void;
  onTime: (seconds: number) => void;
  onVideoError: () => void;
}) {
  const ratio = parseRatio(props.aspectRatio);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const captions = props.preview === null ? [] : activeCaptions(props.preview.captions, props.seconds);

  const pointAt = (event: ReactPointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (rect === undefined || rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
    return { x: clamp01((event.clientX - rect.left) / rect.width), y: clamp01((event.clientY - rect.top) / rect.height) };
  };
  const regionFrom = (from: { x: number; y: number }, to: { x: number; y: number }): ReviewRegion | null => {
    const x = Math.min(from.x, to.x);
    const y = Math.min(from.y, to.y);
    const width = Math.abs(to.x - from.x);
    const height = Math.abs(to.y - from.y);
    if (width < 0.02 || height < 0.02) return null;
    const round = (value: number) => Math.round(value * 1000) / 1000;
    return { x: round(x), y: round(y), width: round(Math.min(width, 1 - x)), height: round(Math.min(height, 1 - y)) };
  };

  return (
    <div className={styles['stage']}>
      <div
        ref={frameRef}
        className={styles['frame']}
        style={{ aspectRatio: String(ratio), maxWidth: `calc(var(--review-stage-height) * ${String(ratio)})` }}
      >
        {props.preview?.playbackUrl ? (
          <video
            ref={props.videoRef}
            className={styles['video']}
            src={props.preview.playbackUrl}
            controls={!props.drawing}
            playsInline
            preload="auto"
            onTimeUpdate={(event) => props.onTime(event.currentTarget.currentTime)}
            onSeeked={(event) => props.onTime(event.currentTarget.currentTime)}
            onError={props.onVideoError}
          />
        ) : null}
        {props.status !== null ? <div className={styles['stageStatus']} role="status">{props.status}</div> : null}
        {captions.length > 0 ? <div className={styles['caption']}>{captions.map((caption) => <span key={caption.captionId}>{caption.text}</span>)}</div> : null}
        {props.badge !== null ? <span className={`${styles['badge']} ${props.badge.trial ? styles['badgeTrial'] : ''}`}>{props.badge.text}</span> : null}
        {props.noteRegions.map((item) => (
          <span key={item.id} className={styles['noteRegion']} aria-hidden="true" style={boxStyle(item.region)} />
        ))}
        {props.draftRegion !== null ? <span className={styles['draftRegion']} aria-hidden="true" style={boxStyle(props.draftRegion)} /> : null}
        {props.drawing ? (
          <div
            className={styles['drawLayer']}
            role="application"
            aria-label={props.drawLabel}
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              const start = pointAt(event);
              setDrag(start);
              props.onDraftRegion(null);
            }}
            onPointerMove={(event) => { if (drag !== null) props.onDraftRegion(regionFrom(drag, pointAt(event))); }}
            onPointerUp={(event) => {
              if (drag !== null) props.onDraftRegion(regionFrom(drag, pointAt(event)));
              setDrag(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

const boxStyle = (region: ReviewRegion) => ({
  left: `${String(region.x * 100)}%`,
  top: `${String(region.y * 100)}%`,
  width: `${String(region.width * 100)}%`,
  height: `${String(region.height * 100)}%`,
});
