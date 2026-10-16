'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_DISTILL_REFERENCES, type DistillReferenceInput, type StrategyPack } from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './studio.module.css';

/**
 * 从参考视频学风格（V6-6 蒸馏器，V6 §6.7）：上传文件或粘贴链接 → 服务端测量剪辑手法 → 一份可选的风格。
 * 结果卡只显示真实测量（测不到的如实列出），可以改说明文字，再"用这个风格"选到对话里。
 */

interface Reference {
  key: string;
  kind: 'file' | 'url';
  label: string;
  url: string | null;
  assetId: string | null;
  percent: number;
  failed: boolean;
}

const STEPS = ['fetch', 'analyze', 'compose', 'save'] as const;
const fmt = (value: number, digits = 1): string => String(Math.round(value * 10 ** digits) / 10 ** digits);

export function StudioDistillDrawer(props: { workspaceId: string; canEdit: boolean; onClose: () => void; onUse: (pack: StrategyPack) => void }) {
  const { messages, locale } = useI18n();
  const t = messages.studio.distill;
  const client = useAncsClient();
  const queryClient = useQueryClient();
  const id = useId();
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [references, setReferences] = useState<Reference[]>([]);
  const [link, setLink] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<{ summary: string; guidance: string }>({ summary: '', guidance: '' });
  const [savedNotice, setSavedNotice] = useState(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') props.onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.(); };
    // 只在打开/关闭时移动焦点；onClose 每次渲染都是新函数，不作为依赖
  }, []);

  const full = references.length >= MAX_DISTILL_REFERENCES;
  const addFiles = (files: File[]) => {
    for (const file of files.slice(0, MAX_DISTILL_REFERENCES - references.length)) {
      const key = `${file.name}-${String(file.size)}-${globalThis.crypto.randomUUID()}`;
      setReferences((current) => [...current, { key, kind: 'file', label: file.name, url: null, assetId: null, percent: 0, failed: false }]);
      const update = (patch: Partial<Reference>) => setReferences((current) => current.map((item) => (item.key === key ? { ...item, ...patch } : item)));
      // 参考视频放在工作区素材库（不属于任何作品）
      void client.assets.uploadResumable(props.workspaceId, { assetType: 'USER_UPLOAD', filename: file.name, contentType: file.type || 'video/mp4', data: file }, {
        concurrency: 3,
        onProgress: ({ uploadedBytes, totalBytes }) => update({ percent: totalBytes === 0 ? 0 : Math.round((uploadedBytes / totalBytes) * 100) }),
      }).then((asset) => update({ assetId: asset.id, percent: 100 }), () => update({ failed: true }));
    }
  };
  const addLink = () => {
    const value = link.trim();
    if (!/^https?:\/\/\S+$/i.test(value)) { setLinkError(t.invalidLink); return; }
    setLinkError(null);
    setReferences((current) => [...current, { key: `url-${globalThis.crypto.randomUUID()}`, kind: 'url', label: value, url: value, assetId: null, percent: 100, failed: false }]);
    setLink('');
  };
  const ready = references.length > 0 && references.every((item) => (item.kind === 'url' ? item.url !== null : item.assetId !== null));

  const start = useMutation({
    mutationFn: () => client.agent.startDistill(props.workspaceId, {
      references: references.map((item): DistillReferenceInput => (item.kind === 'url' ? { url: item.url! } : { assetId: item.assetId! })),
      name: name.trim() === '' ? null : name.trim(),
      locale,
    }, { idempotencyKey: `distill-${globalThis.crypto.randomUUID()}` }),
    onSuccess: (run) => { setRunId(run.runId); setStartError(null); },
    onError: (error) => setStartError(describeError(error).message),
  });
  const run = useQuery({
    queryKey: ['studio', 'distill', props.workspaceId, runId],
    queryFn: () => client.agent.getDistill(props.workspaceId, runId!),
    enabled: runId !== null,
    refetchInterval: (query) => (query.state.data === undefined || query.state.data.status === 'RUNNING' ? 1500 : false),
  });
  const packId = run.data?.status === 'SUCCEEDED' ? run.data.packId : null;
  const pack = useQuery({
    queryKey: ['studio', 'strategy', props.workspaceId, packId],
    queryFn: () => client.agent.strategy(props.workspaceId, packId!),
    enabled: packId !== null,
  });
  useEffect(() => {
    if (packId !== null) void queryClient.invalidateQueries({ queryKey: ['studio', 'strategies', props.workspaceId] });
  }, [packId, queryClient, props.workspaceId]);

  const save = useMutation({
    mutationFn: (current: StrategyPack) => client.agent.updateStrategy(props.workspaceId, current.id, {
      summary: { ...current.summary, [locale]: draft.summary.trim() || current.summary[locale] },
      agentGuidance: draft.guidance.trim() || current.agentGuidance,
    }, { idempotencyKey: `strategy-${globalThis.crypto.randomUUID()}` }),
    onSuccess: (updated) => {
      queryClient.setQueryData(['studio', 'strategy', props.workspaceId, updated.id], updated);
      void queryClient.invalidateQueries({ queryKey: ['studio', 'strategies', props.workspaceId] });
      setEditing(false);
      setSavedNotice(true);
    },
  });

  const reset = () => { setRunId(null); setReferences([]); setName(''); setEditing(false); setSavedNotice(false); };
  const errorText = (reason: string): string => (t.errors as Record<string, string>)[reason] ?? t.errors.generic;

  let body: React.ReactNode;
  if (runId === null) {
    body = (
      <>
        <p className={styles['distillIntro']}>{t.intro}</p>
        <p className={styles['lineMeta']}>{t.rights}</p>
        <ul className={styles['distillList']} aria-label={t.title}>
          {references.map((item) => (
            <li key={item.key} className={styles['distillItem']}>
              <QuietIcon name={item.kind === 'url' ? 'link' : 'film'} />
              <span className={styles['distillLabel']} title={item.label}>{item.label}</span>
              <span className={styles['lineMeta']}>{item.kind === 'url' ? t.fromLink : item.failed ? t.uploadFailed : item.assetId === null ? t.uploading(item.percent) : t.fromFile}</span>
              <button type="button" className="btn icononly ghost small" aria-label={t.remove(item.label)} onClick={() => setReferences((current) => current.filter((other) => other.key !== item.key))}><QuietIcon name="close" /></button>
            </li>
          ))}
        </ul>
        {full ? <p className={styles['lineMeta']}>{t.tooMany(MAX_DISTILL_REFERENCES)}</p> : (
          <div className={styles['distillAdd']}>
            <button type="button" className="btn small" disabled={!props.canEdit} onClick={() => fileInput.current?.click()}><QuietIcon name="upload" />{t.addFile}</button>
            <label htmlFor={`${id}-link`} className={styles['visuallyHidden']}>{t.linkLabel}</label>
            <input id={`${id}-link`} className="field" type="url" value={link} placeholder={t.linkPlaceholder} disabled={!props.canEdit}
              onChange={(event) => setLink(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); addLink(); } }} />
            <button type="button" className="btn small" disabled={!props.canEdit || link.trim() === ''} onClick={addLink}><QuietIcon name="link" />{t.addLink}</button>
          </div>
        )}
        {linkError !== null ? <p className={styles['alert']} role="alert">{linkError}</p> : null}
        <div className={styles['distillField']}>
          <label htmlFor={`${id}-name`}>{t.nameLabel}</label>
          <input id={`${id}-name`} className="field" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
        </div>
        {startError !== null ? <p className={styles['alert']} role="alert">{startError}</p> : null}
        <div className="row gap8">
          <button type="button" className="btn primary small" disabled={!props.canEdit || !ready || start.isPending} onClick={() => start.mutate()}><QuietIcon name="spark" />{start.isPending ? t.starting : t.start}</button>
        </div>
        <input ref={fileInput} type="file" accept="video/*" multiple className={styles['visuallyHidden']} tabIndex={-1} aria-hidden="true"
          onChange={(event) => { addFiles(Array.from(event.target.files ?? [])); event.target.value = ''; }} />
      </>
    );
  } else if (run.data === undefined || run.data.status === 'RUNNING') {
    const current = run.data?.step ?? 'fetch';
    body = (
      <div role="status" className={styles['distillProgress']}>
        <p><span className={styles['spinner']} aria-hidden="true" />{t.working}</p>
        <ol className={styles['distillSteps']}>
          {STEPS.map((step) => {
            const index = STEPS.indexOf(step);
            const at = STEPS.indexOf(current);
            return <li key={step} className={index < at ? styles['distillStepDone'] : index === at ? styles['distillStepActive'] : ''} aria-current={index === at ? 'step' : undefined}>{index < at ? <QuietIcon name="check" /> : null}{t.steps[step]}</li>;
          })}
        </ol>
      </div>
    );
  } else if (run.data.status !== 'SUCCEEDED') {
    body = (
      <div role="alert" className={styles['alert']}>
        <strong>{t.failedTitle}</strong>
        <p>{errorText(run.data.error?.reason ?? 'generic')}</p>
        <button type="button" className="btn small" onClick={reset}>{t.retry}</button>
      </div>
    );
  } else if (pack.data === undefined) {
    body = <p role="status"><span className={styles['spinner']} aria-hidden="true" />{t.working}</p>;
  } else {
    const current = pack.data;
    const dna = current.editingDna;
    const pacing = dna.pacing ?? [];
    const peak = Math.max(1, ...pacing);
    const missing = [
      dna.shotScaleVariety === null ? t.notMeasuredItems.shotScale : null,
      dna.zoomsPerMinute === null ? t.notMeasuredItems.zooms : null,
      dna.speedRampsPerMinute === null ? t.notMeasuredItems.speedRamps : null,
      dna.captionStyle === null ? t.notMeasuredItems.captions : null,
      dna.beatCutRatio === null ? t.notMeasuredItems.beat : null,
    ].filter((item): item is string => item !== null);
    body = (
      <div className={styles['distillResult']}>
        <h3>{current.name[locale]}</h3>
        <p className={styles['lineMeta']}>{run.data.composer === 'MODEL' ? t.composerModel : t.composerRules}</p>
        {editing ? (
          <div className={styles['distillEdit']}>
            <label htmlFor={`${id}-summary`}>{t.summaryLabel}</label>
            <textarea id={`${id}-summary`} className="field" rows={4} value={draft.summary} onChange={(event) => setDraft({ ...draft, summary: event.target.value })} />
            <label htmlFor={`${id}-guidance`}>{t.guidanceLabel}</label>
            <textarea id={`${id}-guidance`} className="field" rows={5} value={draft.guidance} onChange={(event) => setDraft({ ...draft, guidance: event.target.value })} />
            <div className="row gap8">
              <button type="button" className="btn primary small" disabled={save.isPending} onClick={() => save.mutate(current)}>{save.isPending ? t.saving : t.save}</button>
              <button type="button" className="btn small" onClick={() => setEditing(false)}>{t.cancel}</button>
            </div>
          </div>
        ) : <p>{current.summary[locale]}</p>}
        {savedNotice ? <p className={styles['lineMeta']} role="status">{t.saved}</p> : null}
        <dl className={styles['distillDna']}>
          {dna.shotSeconds.median === null ? null : <><dt>{t.shotLength}</dt><dd>{t.shotLengthValue(fmt(dna.shotSeconds.median, 2), fmt(dna.shotSeconds.typical.min), fmt(dna.shotSeconds.typical.max))}</dd></>}
          {dna.cutsPerMinute === null ? null : <><dt>{t.cutRate}</dt><dd>{t.cutRateValue(fmt(dna.cutsPerMinute))}</dd></>}
          {dna.beatCutRatio === null ? null : <><dt>{t.beatSync}</dt><dd>{t.beatSyncValue(`${String(Math.round(dna.beatCutRatio * 100))}%`)}</dd></>}
          {dna.transitionsPerMinute === null ? null : <><dt>{t.transitions}</dt><dd>{t.transitionsValue(fmt(dna.transitionsPerMinute))}</dd></>}
          {/* 色调与声音是写给 AI 的英文测量描述，按原文显示并标注语言 */}
          {dna.colorTendency === null ? null : <><dt>{t.color}</dt><dd lang="en">{dna.colorTendency}</dd></>}
          {dna.soundHabits === null ? null : <><dt>{t.sound}</dt><dd lang="en">{dna.soundHabits}</dd></>}
        </dl>
        {pacing.length === 10 ? (
          <figure className={styles['distillPacing']}>
            <figcaption>{t.pacing}</figcaption>
            <div className={styles['distillBars']} role="img" aria-label={`${t.pacing}: ${pacing.map((value) => fmt(value)).join(', ')}`}>
              {pacing.map((value, index) => <span key={index} style={{ height: `${String(Math.max(4, (value / peak) * 100))}%` }} title={fmt(value)} />)}
            </div>
          </figure>
        ) : null}
        {dna.measured === null ? null : <p className={styles['lineMeta']}>{t.measured(dna.measured.references, fmt(dna.measured.analyzedSeconds / 60), dna.measured.shots)}</p>}
        {missing.length === 0 ? null : <p className={styles['lineMeta']}>{t.notMeasured} {missing.join(locale === 'en' ? ', ' : '、')}</p>}
        <div className="row gap8">
          <button type="button" className="btn primary small" onClick={() => props.onUse(current)}><QuietIcon name="check" />{t.use}</button>
          {props.canEdit && !editing ? <button type="button" className="btn small" onClick={() => { setDraft({ summary: current.summary[locale], guidance: current.agentGuidance }); setEditing(true); setSavedNotice(false); }}>{t.edit}</button> : null}
          <button type="button" className="btn small ghost" onClick={reset}>{t.retry}</button>
        </div>
      </div>
    );
  }

  return (
    <aside className={styles['drawer']} aria-label={t.title}>
      <div className={styles['drawerHead']}>
        <h2>{t.title}</h2>
        <button ref={closeRef} type="button" className="btn icononly ghost small" aria-label={t.close} onClick={props.onClose}><QuietIcon name="close" /></button>
      </div>
      <div className={`${styles['drawerBody']} ${styles['distillBody']}`}>{body}</div>
    </aside>
  );
}
