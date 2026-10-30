'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { StudioFootage } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import type { UploadProgress } from './StudioCanvas';
import styles from './studio.module.css';

/** 素材抽屉：上传进度与 AI 对每段素材的理解进度（镜头 / 语音 / 画面）。 */
export function StudioFootageDrawer(props: {
  footage: StudioFootage[];
  uploads: UploadProgress[];
  canEdit: boolean;
  /** V6-7：我的形象与声音（数字人出镜用的照片与声音样本） */
  identityHref?: string;
  onAdd: () => void;
  onClose: () => void;
  /** 画面理解失败或因本月 AI 额度暂停时"再理解一次"（编辑者可用） */
  onRetryVisual?: (assetId: string) => void;
  /** 正在重新排队的素材 */
  retryingAssetId?: string | null;
  /** 重新排队失败的原因（含额度仍用完的说明） */
  retryError?: { assetId: string; message: string } | null;
}) {
  const { messages } = useI18n();
  const t = messages.studio.footage;
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
    // 只在打开/关闭时移动焦点；onClose 每次渲染都是新函数，不作为依赖
  }, []);
  const pending = props.uploads.filter((upload) => upload.failed || upload.percent < 100);

  return (
    <aside className={styles['drawer']} aria-label={t.title}>
      <div className={styles['drawerHead']}>
        <h2>{t.title}</h2>
        <div className="row gap8">
          {props.canEdit ? <button type="button" className="btn small" onClick={props.onAdd}><QuietIcon name="upload" />{t.add}</button> : null}
          <button ref={closeRef} type="button" className="btn icononly ghost small" aria-label={t.close} onClick={props.onClose}><QuietIcon name="close" /></button>
        </div>
      </div>
      <div className={styles['drawerBody']}>
        {pending.map((upload) => (
          <div key={upload.id} className={styles['footageItem']}>
            <div className={styles['footageName']}><strong title={upload.name}>{upload.name}</strong><span className="small muted">{upload.failed ? t.uploadFailed : upload.queued ? t.queued : t.uploading(upload.percent)}</span></div>
          </div>
        ))}
        {props.footage.length === 0 && pending.length === 0 ? <p className="muted mt16">{t.empty}</p> : null}
        {props.identityHref !== undefined ? (
          <Link className="textbtn small" href={props.identityHref}><QuietIcon name="image" />{messages.studio.generation.identityLink}</Link>
        ) : null}
        {props.footage.map((item) => (
          <div key={item.assetId} className={styles['footageItem']}>
            <div className={styles['footageName']}>
              <strong title={item.name}>{item.name}</strong>
              <span className="small">{t.status[item.status]}</span>
            </div>
            <div className={styles['facts']}>
              <span>{t.kinds[item.kind]}{item.duration !== null ? ` · ${t.seconds(item.duration)}` : ''}</span>
              {item.status === 'READY' ? (Object.keys(t.aspects) as (keyof typeof t.aspects)[]).map((aspect) => (
                <span key={aspect} data-understanding={`${aspect}:${item.understanding[aspect]}`}>{t.aspects[aspect]} <b>{t.understanding[item.understanding[aspect]]}</b></span>
              )) : null}
            </div>
            {props.canEdit && props.onRetryVisual !== undefined && item.status === 'READY' && (item.understanding.visual === 'FAILED' || item.understanding.visual === 'LIMIT_REACHED') ? (
              <div className="row gap8 mt8">
                <button type="button" className="btn small" aria-label={t.retryVisualAria(item.name)} disabled={props.retryingAssetId === item.assetId} onClick={() => props.onRetryVisual?.(item.assetId)}>
                  <QuietIcon name="spark" />{props.retryingAssetId === item.assetId ? t.retrying : t.retryVisual}
                </button>
              </div>
            ) : null}
            {props.retryError?.assetId === item.assetId ? <p className={styles['alert']} role="alert">{props.retryError.message}</p> : null}
          </div>
        ))}
      </div>
    </aside>
  );
}
