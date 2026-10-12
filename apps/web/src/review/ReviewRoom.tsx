'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AGENT_ERROR_REASONS, REVIEW_ERROR_REASONS, type ReviewNote, type ReviewRegion, type SequencePreview } from '@ancs/contracts';
import { describeError } from '@/lib/errors';
import { applyAppearance, saveDeviceAppearance } from '@/lib/appearance';
import { useSession, useWorkspace } from '@/lib/queries';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from '@/ui/QuietIcon';
import { displaySeconds, formatClock, frameTimeAtSeconds, pointerSecondsText } from '@/studio/studio-time';
import { useStudioActions, useStudioPreview, useStudioState, useStudioTimeline } from '@/studio/useStudio';
import { ReviewNoteCard } from './ReviewNoteCard';
import { ReviewPlayer } from './ReviewPlayer';
import { reviewKeys, useReviewActions, useReviewProposal, useReviewState } from './useReview';
import styles from './review.module.css';

/**
 * V6-4 批注式审片（手机网页优先，桌面同样可用）：
 * 1. 看片，停在有问题的地方点"在这里标记"，写一句话（可选：在画面上框出位置）；
 * 2. 逐条"问 AI 怎么改"，AI 只给方案；满意就"就按这个改"（或交给 AI 决定，或"不改了"）；
 * 3. "全部执行"：AI 一次做完所有已确定的批注 → 试改就地播放（只重渲改动的分段）→ 就这样 / 不要了。
 * 规则都在服务端；这里只经 SDK 读写。
 */

const EDIT_ROLES = new Set(['OWNER', 'ADMIN', 'EDITOR']);

function errorText(error: unknown, t: Messages['review']): string {
  const described = describeError(error);
  if (described.kind === 'forbidden') return t.readOnly;
  const reason = described.details['reason'];
  if (reason === REVIEW_ERROR_REASONS.ROUND_LOCKED) return t.errors.locked;
  if (reason === AGENT_ERROR_REASONS.TURN_IN_PROGRESS) return t.errors.busy;
  return described.code === null ? t.errors.generic : `${t.errors.generic} (${described.code})`;
}

const startSeconds = (note: ReviewNote): number => Number(note.pointer.timeRange?.start ?? 0);
const endSeconds = (note: ReviewNote): number => Number(note.pointer.timeRange?.end ?? 0);

interface Draft {
  start: number;
  end: number;
  text: string;
  region: ReviewRegion | null;
  drawing: boolean;
}

export function ReviewRoom({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const { messages, locale, setLocale } = useI18n();
  const t = messages.review;
  const queryClient = useQueryClient();
  const session = useSession();
  const workspace = useWorkspace(workspaceId);
  const canEdit = workspace.data === undefined ? true : EDIT_ROLES.has(workspace.data.role);

  const stateQuery = useStudioState(workspaceId, projectId);
  const state = stateQuery.data;
  const { timeline } = useStudioTimeline(projectId, state?.sequenceId, state?.project.revision);
  const reviewQuery = useReviewState(workspaceId, projectId);
  const review = reviewQuery.data;
  const round = review?.round ?? null;
  const proposalQuery = useReviewProposal(workspaceId, projectId, round?.status === 'READY' ? round.proposalId : null);
  const trial = proposalQuery.data?.status === 'OPEN' ? proposalQuery.data : null;
  const actions = useReviewActions(workspaceId, projectId);
  const studioActions = useStudioActions(workspaceId, projectId);

  // 执行完成或被采用后，工程版本可能变化：刷新工作台状态
  const roundStatus = round?.status;
  const refetchState = stateQuery.refetch;
  useEffect(() => {
    if (roundStatus === 'READY' || roundStatus === 'APPLIED') void refetchState();
  }, [roundStatus, refetchState]);
  // 一次执行改好了：把播放器带回视野（手机上点"全部执行"时页面通常滚在批注列表处）
  const watchRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (roundStatus === 'READY') watchRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, [roundStatus]);

  const frameRate = timeline?.frameRate ?? { num: 30, den: 1 };
  const durationSeconds = timeline === null ? 0 : displaySeconds(timeline.duration);
  const hasClips = (timeline?.clips.length ?? 0) > 0;
  const revision = state?.project.revision;
  const previewTarget = useMemo(() => (revision === undefined ? null
    : trial !== null ? { revision, proposalId: trial.proposalId }
      : hasClips ? { revision, proposalId: null } : null), [revision, trial, hasClips]);
  const preview = useStudioPreview(workspaceId, projectId, state?.sequenceId, previewTarget);
  const target = previewTarget === null ? null : preview.preview.data ?? null;
  const [shown, setShown] = useState<SequencePreview | null>(null);
  useEffect(() => {
    if (previewTarget === null) { setShown(null); return; }
    if (target?.status === 'READY' && target.playbackUrl !== null) setShown((current) => (current?.id === target.id ? current : target));
  }, [previewTarget, target]);
  const showingTrial = trial !== null && shown?.proposalId === trial.proposalId;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [seconds, setSeconds] = useState(0);
  const seek = useCallback((value: number) => {
    const video = videoRef.current;
    setSeconds(value);
    if (video !== null) {
      video.pause();
      video.currentTime = Number.isFinite(video.duration) ? Math.min(value, video.duration) : value;
    }
  }, []);

  const notes = useMemo(() => [...(review?.notes ?? [])].sort((left, right) => startSeconds(left) - startSeconds(right)), [review?.notes]);
  const clock = (value: number) => formatClock(frameTimeAtSeconds(value, frameRate));
  const rangeLabel = (note: ReviewNote) => `${clock(startSeconds(note))}–${clock(endSeconds(note))}`;
  const activeRegions = notes
    .filter((note) => note.region !== null && note.status !== 'DISMISSED' && startSeconds(note) <= seconds && seconds < endSeconds(note))
    .map((note) => ({ id: note.id, region: note.region! }));

  const locked = round?.status === 'APPLYING' || round?.status === 'READY';
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onError = (caught: unknown) => setError(errorText(caught, t));

  const mark = () => {
    const video = videoRef.current;
    video?.pause();
    const at = Math.min(video?.currentTime ?? seconds, durationSeconds);
    // 默认标记这一刻前后各 1 秒（可前后挪动）
    const start = Math.max(0, at - 1);
    const end = Math.min(durationSeconds, start + 2);
    setError(null);
    setDraft({ start, end: end > start ? end : start + 0.1, text: '', region: null, drawing: false });
  };
  const shiftDraft = (delta: number) => setDraft((current) => {
    if (current === null) return current;
    const length = current.end - current.start;
    const start = Math.min(Math.max(0, current.start + delta), Math.max(0, durationSeconds - length));
    seek(start + length / 2);
    return { ...current, start, end: start + length };
  });
  const submitDraft = () => {
    if (draft === null || state === undefined || draft.text.trim().length === 0) return;
    const start = frameTimeAtSeconds(draft.start, frameRate);
    const end = frameTimeAtSeconds(draft.end, frameRate);
    const middle = (draft.start + draft.end) / 2;
    // 指向这一刻画面上的片段（当前版本的视频轨），AI 由此找到"这里"
    const clipIds = (timeline?.clips ?? [])
      .filter((clip) => clip.trackId === timeline?.videoTrackId && displaySeconds(clip.sequenceRange.start) <= middle && middle < displaySeconds(clip.sequenceRange.end))
      .map((clip) => clip.id);
    actions.addNote.mutate({
      sequenceId: state.sequenceId,
      pointer: { timeRange: { start: pointerSecondsText(start), end: pointerSecondsText(end) }, clipIds },
      region: draft.region,
      text: draft.text.trim(),
    }, { onSuccess: () => setDraft(null), onError });
  };

  const agreed = notes.filter((note) => note.status === 'AGREED').length;
  const undecided = notes.filter((note) => note.status === 'OPEN').length;
  const apply = () => {
    if (state === undefined) return;
    setError(null);
    actions.apply.mutate({ state, locale }, { onError });
  };
  const keep = () => {
    if (trial === null) return;
    setError(null);
    studioActions.adopt.mutate(trial, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: reviewKeys.state(workspaceId, projectId) }),
      onError,
    });
  };
  const discard = () => {
    if (trial === null) return;
    setError(null);
    studioActions.discard.mutate(trial, {
      onSuccess: () => void queryClient.invalidateQueries({ queryKey: reviewKeys.state(workspaceId, projectId) }),
      onError,
    });
  };

  const toggleTheme = () => {
    const next = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
    applyAppearance(next);
    const userId = session.data?.user?.id;
    if (userId) saveDeviceAppearance(userId, next);
  };

  if (stateQuery.isPending || reviewQuery.isPending) {
    return <div className={styles['room']} lang={locale}><div className={styles['loading']} role="status"><span className={styles['spinner']} aria-hidden="true" />{t.loading}</div></div>;
  }
  if (state === undefined || review === undefined) {
    const described = describeError(stateQuery.error ?? reviewQuery.error);
    return (
      <div className="page narrow" lang={locale}>
        <div className="panel pad mt32" role="alert">
          <h2>{t.loadFailed}</h2>
          <p className="muted mt8">{described.message}</p>
          <div className="row mt24">
            <button type="button" className="btn primary" onClick={() => { void stateQuery.refetch(); void reviewQuery.refetch(); }}>{messages.common.retry}</button>
            <Link className="btn" href={`/w/${workspaceId}/studio/${projectId}`}>{t.back}</Link>
          </div>
        </div>
      </div>
    );
  }

  const playerStatus = previewTarget === null ? t.emptyVideo
    : target?.status === 'FAILED' || preview.request.isError ? t.previewFailed
      : shown === null ? t.previewRendering : null;
  const issue = round?.status === 'OPEN' ? round.applyIssue : null;

  return (
    <div className={styles['room']} lang={locale}>
      <header className={styles['topbar']}>
        <Link className="btn icononly ghost small" href={`/w/${workspaceId}/studio/${projectId}`} aria-label={t.back}><QuietIcon name="chevron" style={{ transform: 'rotate(180deg)' }} /></Link>
        <div className={styles['titleGroup']}>
          <span className={styles['eyebrow']}>{t.title}</span>
          <h1 className={styles['title']} title={state.project.title}>{state.project.title}</h1>
        </div>
        <span className={styles['spacer']} />
        <button type="button" className="btn small ghost" aria-label={messages.common.switchLanguageAria} onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}><QuietIcon name="globe" />{messages.common.switchLanguage}</button>
        <button type="button" className="btn icononly ghost small" aria-label={messages.common.toggleTheme} onClick={toggleTheme}><QuietIcon name="sun" /></button>
      </header>

      <div className={styles['body']}>
        <section ref={watchRef} className={styles['watch']} aria-label={t.title}>
          <ReviewPlayer
            aspectRatio={state.project.aspectRatio}
            videoRef={videoRef}
            preview={shown}
            badge={shown === null ? null : { text: showingTrial ? t.trialBadge : t.currentBadge, trial: showingTrial }}
            status={playerStatus}
            seconds={seconds}
            noteRegions={draft === null ? activeRegions : []}
            drawing={draft?.drawing ?? false}
            draftRegion={draft?.region ?? null}
            drawLabel={t.composer.regionOn}
            onDraftRegion={(region) => setDraft((current) => (current === null ? current : { ...current, region }))}
            onTime={setSeconds}
            onVideoError={preview.refresh}
          />
          {durationSeconds > 0 ? (
            <div className={styles['markers']} aria-hidden="true">
              <span className={styles['markersPlayhead']} style={{ left: `${String(Math.min(100, (seconds / durationSeconds) * 100))}%` }} />
              {notes.map((note) => (
                <span
                  key={note.id}
                  className={`${styles['marker']} ${styles[`marker${note.status}`] ?? ''}`}
                  style={{ left: `${String((startSeconds(note) / durationSeconds) * 100)}%`, width: `${String(Math.max(0.8, ((endSeconds(note) - startSeconds(note)) / durationSeconds) * 100))}%` }}
                />
              ))}
            </div>
          ) : null}

          {draft === null ? (
            <div className={styles['markRow']}>
              <span className={styles['clock']}>{clock(seconds)}</span>
              <span className={styles['hint']}>{shown !== null && canEdit && !locked ? t.markHint : null}</span>
              <button type="button" className="btn primary" disabled={!canEdit || locked || shown === null || showingTrial} onClick={mark}><QuietIcon name="plus" />{t.mark}</button>
            </div>
          ) : (
            <form className={styles['composer']} onSubmit={(event) => { event.preventDefault(); submitDraft(); }}>
              <div className={styles['composerHead']}>
                <b>{t.composer.title}</b>
                <span className={styles['timeChip']}>{t.composer.at(`${clock(draft.start)}–${clock(draft.end)}`)}</span>
              </div>
              <div className={styles['composerRegion']}>
                <button type="button" className="btn small" onClick={() => shiftDraft(-1)}>{t.composer.earlier}</button>
                <button type="button" className="btn small" onClick={() => shiftDraft(1)}>{t.composer.later}</button>
                <button type="button" className={`btn small ${draft.drawing ? 'primary' : ''}`} aria-pressed={draft.drawing} onClick={() => setDraft({ ...draft, drawing: !draft.drawing })}>
                  <QuietIcon name="expand" />{draft.region !== null ? t.composer.regionSet : draft.drawing ? t.composer.regionOn : t.composer.region}
                </button>
                {draft.region !== null ? <button type="button" className="btn small ghost" onClick={() => setDraft({ ...draft, region: null })}>{t.composer.regionClear}</button> : null}
              </div>
              <label className={styles['composerField']}>
                <span>{t.composer.textLabel}</span>
                <textarea className="field" rows={2} value={draft.text} placeholder={t.composer.textPlaceholder} maxLength={1000} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
              </label>
              <div className={styles['composerActions']}>
                <button type="button" className="btn ghost" onClick={() => setDraft(null)}>{t.composer.cancel}</button>
                <button type="submit" className="btn primary" disabled={draft.text.trim().length === 0 || actions.addNote.isPending}>{t.composer.add}</button>
              </div>
            </form>
          )}
        </section>

        <section className={styles['notesPanel']} aria-label={t.notes.title(notes.length)}>
          <h2 className={styles['notesTitle']}>{t.notes.title(notes.length)}</h2>
          {notes.length === 0 ? <p className={styles['emptyNotes']}>{round?.status === 'APPLIED' ? t.apply.applied(round.appliedRevision ?? 0) : t.notes.empty}</p> : (
            <ul className={styles['noteList']}>
              {notes.map((note) => (
                <ReviewNoteCard
                  key={note.id}
                  workspaceId={workspaceId}
                  note={note}
                  rangeLabel={rangeLabel(note)}
                  canEdit={canEdit}
                  locked={locked || round?.status === 'APPLIED'}
                  busy={actions.discuss.isPending}
                  onSeek={() => seek(startSeconds(note))}
                  onAsk={(message) => { setError(null); actions.discuss.mutate({ state, locale, noteId: note.id, message }, { onError }); }}
                  onAgree={(plan) => actions.updateNote.mutate({ noteId: note.id, patch: { status: 'AGREED', plan } }, { onError })}
                  onDismiss={() => actions.updateNote.mutate({ noteId: note.id, patch: { status: 'DISMISSED' } }, { onError })}
                  onReopen={() => actions.updateNote.mutate({ noteId: note.id, patch: { status: 'OPEN' } }, { onError })}
                  onDelete={() => actions.deleteNote.mutate(note.id, { onError })}
                />
              ))}
            </ul>
          )}
          {notes.length === 0 ? <p className={styles['intro']}>{t.intro}</p> : null}
        </section>
      </div>

      <footer className={styles['applyBar']} aria-live="polite">
        {error !== null ? <p className={styles['error']} role="alert">{error}</p> : null}
        {!canEdit ? <p className={styles['hint']}>{t.readOnly}</p>
          : round?.status === 'APPLYING' ? (
            <p className={styles['applyStatus']} role="status"><span className={styles['spinner']} aria-hidden="true" />{t.apply.applying(round.appliedNoteIds.length)}</p>
          ) : round?.status === 'READY' ? (
            <div className={styles['applyRow']}>
              <div className={styles['applyText']}>
                <p>{t.apply.ready}</p>
                {shown !== null && showingTrial && shown.segments.reused > 0 ? <p className={styles['hint']}>{t.apply.reused(shown.segments.reused, shown.segments.total)}</p> : null}
              </div>
              <div className={styles['applyButtons']}>
                <Link className="btn small ghost" href={`/w/${workspaceId}/studio/${projectId}`}>{t.apply.refine}</Link>
                <button type="button" className="btn" disabled={trial === null || studioActions.discard.isPending} onClick={discard}>{t.apply.discard}</button>
                <button type="button" className="btn primary" disabled={trial === null || studioActions.adopt.isPending} onClick={keep}><QuietIcon name="check" />{t.apply.keep}</button>
              </div>
            </div>
          ) : round?.status === 'APPLIED' && notes.length > 0 ? (
            <p className={styles['applyStatus']}><QuietIcon name="check" />{t.apply.applied(round.appliedRevision ?? 0)}</p>
          ) : notes.length > 0 ? (
            <div className={styles['applyRow']}>
              <div className={styles['applyText']}>
                {issue !== null ? <p className={styles['hint']}>{t.apply.issue[issue.kind]}{issue.kind === 'NO_CHANGES' && issue.reply !== null ? issue.reply : ''}</p> : null}
                <p className={styles['hint']}>{agreed === 0 ? t.apply.none : undecided > 0 ? t.apply.undecided(undecided) : null}</p>
              </div>
              <button type="button" className="btn primary" disabled={agreed === 0 || actions.apply.isPending} onClick={apply}><QuietIcon name="spark" />{t.apply.button(agreed)}</button>
            </div>
          ) : null}
      </footer>
    </div>
  );
}
