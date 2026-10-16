'use client';

import { useEffect, useRef, useState } from 'react';
import { COMPOSITION_FINAL_RENDER_ERROR_REASONS } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import { exportVideoAssetId, useExportRun, useStudioActions } from './useStudio';
import styles from './studio.module.css';

/** 导出尺寸：按作品画幅取 1080p 级（短边 1080）。 */
export function exportSize(aspectRatio: string): { width: number; height: number } {
  switch (aspectRatio) {
    case '9:16': return { width: 1080, height: 1920 };
    case '1:1': return { width: 1080, height: 1080 };
    case '4:5': return { width: 1080, height: 1350 };
    default: return { width: 1920, height: 1080 };
  }
}

/** 导出浮层：发起终渲染工作流（冻结当前版本 → 渲染 → 技术检查），完成后给短期下载链接。 */
export function StudioExport(props: {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  aspectRatio: string;
  revision: number;
  hasContent: boolean;
  canEdit: boolean;
  onClose: () => void;
}) {
  const { messages } = useI18n();
  const t = messages.studio.export;
  const client = useAncsClient();
  const actions = useStudioActions(props.workspaceId, props.projectId);
  const [runId, setRunId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const run = useExportRun(props.workspaceId, runId);
  const size = exportSize(props.aspectRatio);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    panelRef.current?.querySelector<HTMLElement>('button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // 只在打开时聚焦一次；onClose 每次渲染都是新函数，不作为依赖
  }, []);

  const start = () => {
    setDownloadError(null);
    actions.startExport.mutate({ sequenceId: props.sequenceId, ...size, revision: props.revision }, { onSuccess: (started) => setRunId(started.id) });
  };
  const download = async () => {
    const assetId = exportVideoAssetId(run.data);
    if (assetId === null) return;
    try {
      const link = await client.assets.downloadUrl(props.workspaceId, assetId);
      window.location.assign(link.url);
    } catch (error) {
      setDownloadError(describeError(error).message);
    }
  };

  const status = run.data?.status;
  const failedText = run.data?.status === 'FAILED'
    ? (JSON.stringify(run.data.error ?? {}).includes(COMPOSITION_FINAL_RENDER_ERROR_REASONS.REVISION_CHANGED) ? t.revisionChanged : t.failed)
    : actions.startExport.isError ? describeError(actions.startExport.error).message : null;
  const stepLabel = run.data?.currentStep !== null && run.data?.currentStep !== undefined
    ? (t.steps as Record<string, string>)[run.data.currentStep] ?? run.data.currentStep
    : null;

  return (
    <div ref={panelRef} className={styles['popover']} role="dialog" aria-label={t.title}>
      <div className="row between">
        <h2>{t.title}</h2>
        <button type="button" className="btn icononly ghost small" aria-label={messages.common.close} onClick={props.onClose}><QuietIcon name="close" /></button>
      </div>
      <p>{t.body}</p>
      <div className="small muted">{t.size(size.width, size.height)} · H.264 / AAC</div>
      {!props.hasContent ? <p role="status">{t.empty}</p> : null}
      {status === 'RUNNING' || status === 'CANCEL_REQUESTED' || actions.startExport.isPending ? (
        <div className="row gap8" role="status"><span className={styles['spinner']} style={{ borderColor: 'var(--ui-border-subtle)', borderTopColor: 'var(--ui-fg-primary)' }} aria-hidden="true" />{stepLabel === null ? t.queued : t.running(stepLabel)}</div>
      ) : null}
      {status === 'SUCCEEDED' ? (
        <div className="col" style={{ gap: 8 }} role="status">
          <div className="row gap8"><QuietIcon name="check" /><strong>{t.done}</strong></div>
          <button type="button" className="btn primary" onClick={() => void download()}><QuietIcon name="download" />{t.download}</button>
          {downloadError !== null ? <p role="alert">{downloadError}</p> : null}
        </div>
      ) : null}
      {failedText !== null ? <p className={styles['alert']} role="alert">{failedText}</p> : null}
      {status === undefined || status === 'FAILED' || status === 'CANCELLED' || status === 'SUCCEEDED' ? (
        <button type="button" className={status === 'SUCCEEDED' ? 'btn' : 'btn primary'} disabled={!props.hasContent || !props.canEdit || actions.startExport.isPending} onClick={start}>
          {status === undefined ? t.start : t.again}
        </button>
      ) : null}
    </div>
  );
}
