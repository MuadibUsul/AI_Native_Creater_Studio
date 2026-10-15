'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useWorkspaceSelection } from '@/ui/StudioShell';
import { QuietIcon } from '@/ui/QuietIcon';
import { useI18n } from '@/i18n/I18nProvider';

export function DesignSystemControls() {
  const { toggleTheme, openHelp } = useWorkspaceSelection();
  const t = useI18n().messages.entry.designSystem;
  return <div className="row mt24 gap8">
    <button type="button" className="btn small" onClick={toggleTheme}><QuietIcon name="sun" />{t.toggleTheme}</button>
    <button type="button" className="btn small" onClick={openHelp}>{t.shortcuts}</button>
  </div>;
}

export function DesignSystemExampleActions() {
  const { workspaceId } = useWorkspaceSelection();
  const [showCancelNote, setShowCancelNote] = useState(false);
  const t = useI18n().messages.entry.designSystem;
  const createHref = workspaceId ? `/w/${workspaceId}/new` : '/';

  return <>
    <div className="row mt24 gap8 qf-design-actions">
      <Link href={createHref} className="btn primary">{t.startCreating}</Link>
      <Link href={createHref} className="btn blue">{t.generateDraft}</Link>
      <button type="button" className="btn" onClick={() => setShowCancelNote(true)}>{t.cancel}</button>
    </div>
    {showCancelNote ? <p role="status" className="small muted mt8">{t.cancelNote}</p> : null}
  </>;
}

export function DesignSystemStatusAction({ kind }: { kind: 'conflict' | 'consent' }) {
  const { workspaceId } = useWorkspaceSelection();
  const [visible, setVisible] = useState(false);
  const { messages } = useI18n();
  const t = messages.entry.designSystem;
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const conflict = kind === 'conflict';
  const titleId = `qf-design-${kind}-title`;

  useEffect(() => {
    if (!visible || !dialog.current) return;
    const element = dialog.current;
    if (typeof element.showModal === 'function') element.showModal();
    else element.setAttribute('open', '');
    element.querySelector('button')?.focus();
    return () => {
      if (element.open && typeof element.close === 'function') element.close();
      else element.removeAttribute('open');
    };
  }, [visible]);

  const dismiss = () => {
    if (dialog.current?.open && typeof dialog.current.close === 'function') dialog.current.close();
    else dialog.current?.removeAttribute('open');
    setVisible(false);
    trigger.current?.focus();
  };

  return <>
    <button ref={trigger} type="button" className="textbtn small mt8" onClick={() => setVisible(true)}>
      {conflict ? t.viewResolution : t.viewConsentFlow} <QuietIcon name="arrow" />
    </button>
    {visible ? <dialog ref={dialog} className="qf-pack-dialog" aria-labelledby={titleId} onCancel={(event) => { event.preventDefault(); dismiss(); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } }}>
      <div className="row between"><h2 id={titleId}>{conflict ? t.conflictDialogTitle : t.consentDialogTitle}</h2><button type="button" className="btn ghost icononly" aria-label={messages.common.close} onClick={dismiss}><QuietIcon name="close" /></button></div>
      {conflict ? <>
        <p className="mt16">{t.conflictDialogBody}</p>
        <div className="diff-card"><header>{t.diffHeader}</header><div className="diff-remove">{t.diffLocal}</div><div className="diff-add">{t.diffServer}</div></div>
        <p className="small muted">{t.conflictDialogNote}</p>
      </> : <>
        <p className="mt16">{t.consentDialogBody}</p>
        <p className="notice mt16">{t.consentDialogNotice}</p>
        <p className="small muted mt16">{t.consentDialogSamples}</p>
        <Link className="btn primary mt24" href={workspaceId ? `/w/${workspaceId}/identity` : '/'}>{workspaceId ? t.goIdentity : t.goHome}</Link>
      </>}
      <div className="row mt24"><button type="button" className="btn" onClick={dismiss}>{t.gotIt}</button></div>
    </dialog> : null}
  </>;
}
