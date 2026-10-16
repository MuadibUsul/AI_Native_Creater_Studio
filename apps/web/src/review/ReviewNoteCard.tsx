'use client';

import { useState } from 'react';
import type { ReviewNote } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import { useNoteTurns } from './useReview';
import styles from './review.module.css';

/**
 * 一条批注：位置（点一下跳过去）、状态、文字、确定的方案；展开后和 AI 讨论这一处怎么改。
 * 讨论里 AI 只给方案、不改作品；"就按这个改"把 AI 最近的方案定为这条批注的方案。
 */
export function ReviewNoteCard(props: {
  workspaceId: string;
  note: ReviewNote;
  rangeLabel: string;
  canEdit: boolean;
  locked: boolean;
  busy: boolean;
  onSeek: () => void;
  onAsk: (message: string) => void;
  onAgree: (plan: string | null) => void;
  onDismiss: () => void;
  onReopen: () => void;
  onDelete: () => void;
}) {
  const { messages } = useI18n();
  const t = messages.review.notes;
  const { note } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const turns = useNoteTurns(props.workspaceId, open || note.discussion.running ? note.id : null, note.discussion.running);
  const thread = [...(turns.data ?? [])].reverse();
  const editable = props.canEdit && !props.locked && note.status !== 'APPLIED';
  const ask = (message: string) => {
    const text = message.trim();
    if (text.length === 0) return;
    props.onAsk(text);
    setDraft('');
    setOpen(true);
  };

  return (
    <li className={`${styles['note']} ${note.status === 'DISMISSED' ? styles['noteMuted'] : ''}`} data-status={note.status}>
      <div className={styles['noteHead']}>
        <button type="button" className={styles['timeChip']} onClick={props.onSeek} aria-label={t.seek(props.rangeLabel)}>{props.rangeLabel}</button>
        <span className={`${styles['statusChip']} ${styles[`status${note.status}`] ?? ''}`}>{t.status[note.status]}</span>
        {note.region !== null ? <span className={styles['noteMeta']}><QuietIcon name="expand" />{t.region}</span> : null}
        <span className={styles['spacer']} />
        {editable ? (
          <button type="button" className="btn icononly ghost small" aria-label={t.remove} onClick={props.onDelete}><QuietIcon name="close" /></button>
        ) : null}
      </div>
      <p className={styles['noteText']}>{note.text}</p>
      {note.status === 'AGREED' || note.status === 'APPLIED' ? <p className={styles['notePlan']}>{note.plan === null ? t.planAuto : withPrefix(t.planPrefix, note.plan)}</p> : null}

      {open ? (
        <div className={styles['thread']}>
          {thread.map((turn) => (
            <div key={turn.id} className={styles['threadItem']}>
              <p><b>{t.you}</b><span>{turn.message}</span></p>
              {turn.status === 'RUNNING' ? <p className={styles['thinking']} role="status"><span className={styles['spinner']} aria-hidden="true" />{t.thinking}</p>
                : turn.reply !== null ? <p><b>{t.ai}</b><span>{turn.reply}</span></p>
                  : turn.status !== 'COMPLETED' ? <p className={styles['threadError']}>{t.failed}</p> : null}
            </div>
          ))}
          {editable ? (
            <form className={styles['askRow']} onSubmit={(event) => { event.preventDefault(); ask(draft); }}>
              <input className="field" value={draft} placeholder={t.askPlaceholder} aria-label={t.askPlaceholder} disabled={props.busy || note.discussion.running} onChange={(event) => setDraft(event.target.value)} />
              <button type="submit" className="btn small" disabled={props.busy || note.discussion.running || draft.trim().length === 0}>{t.send}</button>
            </form>
          ) : null}
        </div>
      ) : null}

      {editable ? (
        <div className={styles['noteActions']}>
          {open ? (
            <button type="button" className="btn small ghost" onClick={() => setOpen(false)}>{t.hideThread}</button>
          ) : (
            <button type="button" className="btn small" disabled={props.busy || note.discussion.running} onClick={() => (note.discussion.turns === 0 ? ask(t.askFirst) : setOpen(true))}>
              <QuietIcon name="spark" />{t.ask}
            </button>
          )}
          {note.status === 'OPEN' ? (
            note.discussion.lastReply !== null
              ? <button type="button" className="btn small primary" onClick={() => props.onAgree(note.discussion.lastReply)}><QuietIcon name="check" />{t.agree}</button>
              : <button type="button" className="btn small" onClick={() => props.onAgree(null)}>{t.agreeAuto}</button>
          ) : null}
          {note.status === 'OPEN' || note.status === 'AGREED' ? <button type="button" className="btn small ghost" onClick={props.onDismiss}>{t.dismiss}</button> : null}
          {note.status === 'DISMISSED' || note.status === 'AGREED' ? <button type="button" className="btn small ghost" onClick={props.onReopen}>{t.reopen}</button> : null}
        </div>
      ) : null}
      {!open && note.discussion.running ? <p className={styles['thinking']} role="status"><span className={styles['spinner']} aria-hidden="true" />{t.thinking}</p> : null}
    </li>
  );
}

/** 方案前加"方案："，AI 的回应本身已经这样开头时不重复。 */
function withPrefix(prefix: string, plan: string): string {
  return plan.startsWith(prefix.trim()) ? plan : `${prefix}${plan}`;
}
