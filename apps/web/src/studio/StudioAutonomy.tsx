'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  AGENT_ERROR_REASONS,
  AUTONOMOUS_RUN_ERROR_REASONS,
  AUTONOMY_ERROR_REASONS,
  MAX_AUTONOMY_BUDGET_MICROS,
  type AgentLocale,
  type AutonomousRun,
  type AutonomyPolicy,
} from '@ancs/contracts';
import { useAncsClient } from '@/lib/client';
import { describeError } from '@/lib/errors';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from '@/ui/QuietIcon';
import { formatUsdMicros } from './studio-time';
import styles from './studio.module.css';

/**
 * 交给 AI 剪完（V6-9，裁决 0020 / Proposal 0.1 AP-05）：
 * - 设置：一句需求、目标时长、剪完以后（先给我看 / 自检通过就直接用）、AI 费用上限；提交 = 签署授权 + 开始运行
 *   （签署人、时间、版本由服务端写入；总预算是硬上限）。新建页与共看片室共用同一组字段；
 * - 进度卡：等素材 / 正在剪（步骤数与最近一步）/ 自检 / 交付；可随时停下；
 * - 交付报告：如实列出用了哪些素材、生成内容、自检与节奏、没满足的约束与实际花费（服务端算好，界面只翻译代码）。
 * 这一版不调用付费生成，所以只给两档；"完全授权"随付费生成代为确认一起开放（V6-10）。
 */

export type AutonomyTier = 'ASK_EACH' | 'AUTO_SAFE';

export interface AutonomySetup {
  goal: string;
  targetDurationSeconds: number | null;
  approval: AutonomyTier;
  /** 用户输入的美元金额（文本） */
  budgetUsd: string;
}

/** 与服务端的下限一致：一次运行至少要能放下几次导演调用 */
export const MIN_AUTONOMY_BUDGET_MICROS = 200_000;
const DURATIONS = [null, 15, 30, 60, 90, 180, 300] as const;

export function defaultAutonomySetup(goal: string, policy?: AutonomyPolicy | null): AutonomySetup {
  const signed = policy?.signature !== null && policy?.signature !== undefined && policy.budgetMicros !== null;
  return {
    goal,
    targetDurationSeconds: null,
    approval: signed && policy.approval !== 'ASK_EACH' ? 'AUTO_SAFE' : 'ASK_EACH',
    budgetUsd: signed && policy.budgetMicros !== null ? (policy.budgetMicros / 1_000_000).toFixed(2) : '2.00',
  };
}

/** 文本金额 → 微美元；不是合法金额或超出范围时为 null */
export function budgetMicrosOf(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole = '0', cents = ''] = trimmed.split('.');
  const micros = Number(whole) * 1_000_000 + Number(cents.padEnd(2, '0')) * 10_000;
  return micros >= MIN_AUTONOMY_BUDGET_MICROS && micros <= MAX_AUTONOMY_BUDGET_MICROS ? micros : null;
}

export function autonomySetupValid(setup: AutonomySetup): boolean {
  return setup.goal.trim().length > 0 && budgetMicrosOf(setup.budgetUsd) !== null;
}

type StartErrorKey = keyof Messages['autonomy']['setup']['startErrors'];
export function autonomyStartErrorKey(error: unknown): StartErrorKey {
  const reason = describeError(error).details['reason'];
  if (reason === AUTONOMY_ERROR_REASONS.NOT_SIGNED) return 'NOT_SIGNED';
  if (reason === AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED) return 'BUDGET_EXHAUSTED';
  if (reason === AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED) return 'MONTHLY_AI_LIMIT';
  if (reason === AUTONOMOUS_RUN_ERROR_REASONS.RUN_IN_PROGRESS) return 'RUN_IN_PROGRESS';
  return 'GENERIC';
}

/** 签署授权，再开始运行（两步各带幂等键；重试不会重复签署或重复开始） */
export function useStartAutonomy(workspaceId: string) {
  const client = useAncsClient();
  return useMutation({
    mutationFn: async (input: { projectId: string; setup: AutonomySetup; locale: AgentLocale; strategy?: { packId: string; knobs: Record<string, string> } | null }) => {
      const budgetMicros = budgetMicrosOf(input.setup.budgetUsd);
      if (budgetMicros === null) throw new Error('invalid budget');
      const key = globalThis.crypto.randomUUID();
      await client.autonomy.sign(workspaceId, input.projectId, { approval: input.setup.approval, budgetMicros }, { idempotencyKey: `autonomy-sign-${key}` });
      return client.autonomy.startRun(workspaceId, input.projectId, {
        goal: input.setup.goal.trim(),
        targetDurationSeconds: input.setup.targetDurationSeconds,
        strategyPackId: input.strategy?.packId ?? null,
        strategyKnobs: input.strategy?.knobs ?? {},
        locale: input.locale,
      }, { idempotencyKey: `autonomy-run-${key}` });
    },
  });
}

/** 设置字段（受控）：需求、目标时长、剪完以后、费用上限 */
export function AutonomySetupFields({ value, onChange, touched, idPrefix, goalVisible = true }: {
  value: AutonomySetup;
  onChange: (next: AutonomySetup) => void;
  touched: boolean;
  idPrefix: string;
  /** 新建页里需求可以沿用作品名之外单独填；共看片室里总是显示 */
  goalVisible?: boolean;
}) {
  const { messages } = useI18n();
  const t = messages.autonomy.setup;
  const goalMissing = touched && value.goal.trim().length === 0;
  const budgetInvalid = touched && budgetMicrosOf(value.budgetUsd) === null;
  return (
    <>
      {goalVisible ? (
        <div className="col" style={{ gap: 8 }}>
          <label htmlFor={`${idPrefix}-goal`}>{t.goalLabel}</label>
          <textarea
            id={`${idPrefix}-goal`}
            className="field"
            rows={3}
            maxLength={2000}
            value={value.goal}
            placeholder={t.goalPlaceholder}
            aria-invalid={goalMissing}
            aria-describedby={goalMissing ? `${idPrefix}-goal-error` : undefined}
            onChange={(event) => onChange({ ...value, goal: event.target.value })}
          />
          {goalMissing ? <span id={`${idPrefix}-goal-error`} className="small" role="alert">{t.goalRequired}</span> : null}
        </div>
      ) : null}
      <div className="col" style={{ gap: 8 }}>
        <span id={`${idPrefix}-approval-label`}>{t.approvalLabel}</span>
        <div className={styles['starts']} role="radiogroup" aria-labelledby={`${idPrefix}-approval-label`}>
          {(['ASK_EACH', 'AUTO_SAFE'] as const).map((tier) => (
            <button key={tier} type="button" role="radio" aria-checked={value.approval === tier} className={styles['start']} onClick={() => onChange({ ...value, approval: tier })}>
              <strong>{t.approvals[tier].title}</strong>
              <span>{t.approvals[tier].hint}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles['autonomyRow']}>
        <div className="col" style={{ gap: 8 }}>
          <label htmlFor={`${idPrefix}-duration`}>{t.durationLabel}</label>
          <select
            id={`${idPrefix}-duration`}
            className="field"
            value={value.targetDurationSeconds === null ? '' : String(value.targetDurationSeconds)}
            onChange={(event) => onChange({ ...value, targetDurationSeconds: event.target.value === '' ? null : Number(event.target.value) })}
          >
            {DURATIONS.map((seconds) => <option key={seconds ?? 'auto'} value={seconds === null ? '' : String(seconds)}>{seconds === null ? t.durationAuto : t.duration(seconds)}</option>)}
          </select>
        </div>
        <div className="col" style={{ gap: 8 }}>
          <label htmlFor={`${idPrefix}-budget`}>{t.budgetLabel}</label>
          <input
            id={`${idPrefix}-budget`}
            className="field"
            inputMode="decimal"
            value={value.budgetUsd}
            aria-invalid={budgetInvalid}
            aria-describedby={`${idPrefix}-budget-hint`}
            onChange={(event) => onChange({ ...value, budgetUsd: event.target.value })}
          />
        </div>
      </div>
      <span id={`${idPrefix}-budget-hint`} className="small muted" role={budgetInvalid ? 'alert' : undefined}>
        {budgetInvalid ? t.budgetInvalid(formatUsdMicros(MIN_AUTONOMY_BUDGET_MICROS), formatUsdMicros(MAX_AUTONOMY_BUDGET_MICROS).replace('.00', '')) : t.budgetHint}
      </span>
    </>
  );
}

/** 共看片室里的"交给 AI 剪完"对话框：显示当前授权（可撤回），签署并开始 */
export function StudioAutonomyDialog({ workspaceId, projectId, policy, initialGoal, strategy, onClose, onStarted }: {
  workspaceId: string;
  projectId: string;
  policy: AutonomyPolicy;
  initialGoal: string;
  strategy: { packId: string; knobs: Record<string, string> } | null;
  onClose: () => void;
  onStarted: (run: AutonomousRun) => void;
}) {
  const { messages, locale } = useI18n();
  const t = messages.autonomy.setup;
  const client = useAncsClient();
  const [setup, setSetup] = useState<AutonomySetup>(() => defaultAutonomySetup(initialGoal, policy));
  const [touched, setTouched] = useState(false);
  const [signed, setSigned] = useState(policy);
  const start = useStartAutonomy(workspaceId);
  const revoke = useMutation({
    mutationFn: () => client.autonomy.revoke(workspaceId, projectId, { idempotencyKey: `autonomy-revoke-${globalThis.crypto.randomUUID()}` }),
    onSuccess: setSigned,
  });
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    dialogRef.current?.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (!autonomySetupValid(setup)) return;
    start.mutate({ projectId, setup, locale, strategy }, { onSuccess: onStarted });
  };
  const tierName = (tier: AutonomyPolicy['approval']) => (tier === 'ASK_EACH' ? t.approvals.ASK_EACH.title : t.approvals.AUTO_SAFE.title);
  return (
    <div className={styles['autonomyBackdrop']} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} className={styles['autonomyDialog']} role="dialog" aria-modal="true" aria-labelledby="autonomy-dialog-title">
        <header className={styles['autonomyDialogHead']}>
          <span className="ui-ai-mark" aria-hidden="true" />
          <h2 id="autonomy-dialog-title">{t.dialogTitle}</h2>
          <span className={styles['spacer']} />
          <button type="button" className="btn icononly ghost small" aria-label={t.close} onClick={onClose}><QuietIcon name="close" /></button>
        </header>
        <p className="small muted">{t.toggleHint}</p>
        <form className="col" style={{ gap: 'var(--ui-space-4)' }} onSubmit={submit} noValidate>
          <AutonomySetupFields value={setup} onChange={setSetup} touched={touched} idPrefix="autonomy-dialog" />
          {signed.signature !== null && signed.budgetMicros !== null ? (
            <div className={styles['autonomySigned']}>
              <span className="small">{t.signed(tierName(signed.approval), formatUsdMicros(signed.budgetMicros), signed.signature.version)}</span>
              <button type="button" className="textbtn small" disabled={revoke.isPending || start.isPending} onClick={() => revoke.mutate()}>{revoke.isPending ? t.revoking : t.revoke}</button>
            </div>
          ) : null}
          {start.isError ? <p className={styles['alert']} role="alert">{t.startErrors[autonomyStartErrorKey(start.error)]}</p> : null}
          <div className="row">
            <button type="submit" className="btn primary" disabled={start.isPending}><QuietIcon name="spark" />{start.isPending ? t.starting : t.start}</button>
            <button type="button" className="btn" onClick={onClose}>{t.close}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const ACTIVE = new Set<AutonomousRun['status']>(['WAITING_FOR_FOOTAGE', 'PLANNING', 'CUTTING_CHAPTERS', 'DIRECTING', 'CHECKING']);
export const autonomousRunActive = (run: AutonomousRun | null | undefined): boolean => run !== null && run !== undefined && ACTIVE.has(run.status);

type FailKey = keyof Messages['autonomy']['card']['failed'];
function failureKey(run: AutonomousRun): FailKey {
  const raw = JSON.stringify(run.error ?? {});
  if (raw.includes(AUTONOMOUS_RUN_ERROR_REASONS.FOOTAGE_TIMEOUT)) return 'FOOTAGE_TIMEOUT';
  if (raw.includes(AUTONOMOUS_RUN_ERROR_REASONS.NO_FOOTAGE)) return 'NO_FOOTAGE';
  if (raw.includes(AUTONOMOUS_RUN_ERROR_REASONS.SESSION_BUSY)) return 'SESSION_BUSY';
  if (raw.includes(AUTONOMY_ERROR_REASONS.NOT_SIGNED)) return 'NOT_SIGNED';
  if (raw.includes(AUTONOMY_ERROR_REASONS.BUDGET_EXHAUSTED)) return 'BUDGET_EXHAUSTED';
  if (raw.includes('MODEL')) return 'MODEL';
  return 'GENERIC';
}

const numberText = (value: number, locale: string) => value.toLocaleString(locale, { maximumFractionDigits: 1 });

/** 进度与交付报告卡（对话栏里、对话记录之后） */
export function StudioAutonomyCard({ run, canEdit, stopping, error, onStop }: {
  run: AutonomousRun;
  canEdit: boolean;
  stopping: boolean;
  error: string | null;
  onStop: () => void;
}) {
  const { messages, locale } = useI18n();
  const t = messages.autonomy.card;
  const active = ACTIVE.has(run.status);
  const report = run.report;
  const [open, setOpen] = useState(!active);
  const join = (items: string[]) => items.join(locale === 'en' ? ', ' : '、');
  const paren = (text: string) => (locale === 'en' ? `(${text})` : `（${text}）`);
  const labelled = (label: string, text: string) => (locale === 'en' ? `${label}: ${text}` : `${label}：${text}`);
  useEffect(() => { if (!active) setOpen(true); }, [active]);
  return (
    <article className={styles['autonomyCard']} data-status={run.status} aria-label={t.label}>
      <header className={styles['generationHead']}>
        <span className={`ui-ai-mark ${active ? styles['autonomyPulse'] : ''}`} aria-hidden="true" />
        <strong role="status">{t.status[run.status]}</strong>
        {run.status === 'DIRECTING' && run.progress.steps > 0 ? <span className={styles['lineMeta']}>{t.steps(run.progress.steps)}</span> : null}
        <span className={styles['spacer']} />
        {active && canEdit ? <button type="button" className="btn small" disabled={stopping} onClick={onStop}>{stopping ? t.stopping : t.stop}</button> : null}
      </header>
      <p className={`${styles['lineMeta']} ${styles['autonomyGoal']}`}>{t.goal(run.goal)}</p>
      {run.status === 'WAITING_FOR_FOOTAGE' ? <p className={styles['lineMeta']}>{t.waitingBody}</p> : null}
      {run.status === 'DIRECTING' && run.progress.lastStep !== null ? <p className={`${styles['autonomyStep']} ui-ai-text`}>{run.progress.lastStep}</p> : null}
      {run.status === 'FAILED' ? <p className={styles['alert']} role="alert">{t.failed[failureKey(run)]}</p> : null}
      {error !== null ? <p className={styles['alert']} role="alert">{error}</p> : null}
      {report !== null ? (
        <section className={styles['autonomyReport']} aria-label={t.reportTitle}>
          <p>{t.outcome[report.outcome]}{report.notAdoptedReason !== null && report.outcome !== 'FAILED' && report.notAdoptedReason !== 'NO_CHANGES' ? `${locale === 'en' ? ' ' : ''}${t.notAdopted[report.notAdoptedReason]}` : ''}</p>
          <button type="button" className="textbtn small" aria-expanded={open} onClick={() => setOpen(!open)}>{t.reportTitle}</button>
          {open ? (
            <ul className={styles['autonomyFacts']}>
              <li>
                {t.timeline(report.timeline.lengthSeconds, report.timeline.clips, report.timeline.captions)}
                {report.sources.originalShare !== null ? ` · ${t.originalShare(Math.round(report.sources.originalShare * 100))}` : ''}
              </li>
              {report.sources.footage.length > 0 ? (
                <li>{labelled(t.footageUsed, join(report.sources.footage.map((item) => `${item.name} ${paren(t.seconds(item.seconds))}`)))}</li>
              ) : null}
              {report.sources.generated.length > 0 ? (
                <li>{labelled(t.generated, join(report.sources.generated.map((item) => `${t.generatedKinds[item.kind]} · ${item.name} ${paren(t.seconds(item.seconds))}`)))}</li>
              ) : null}
              <li>
                {t.review(report.review.warnings, report.review.notes)}
                {report.review.findings.length > 0 ? (
                  <ul>{report.review.findings.slice(0, 6).map((finding, index) => <li key={`${finding.kind}-${String(index)}`}>{finding.severity === 'warning' ? '! ' : ''}{finding.at[0]}–{finding.at[1]} s · {t.findingKinds[finding.kind] ?? finding.message}</li>)}</ul>
                ) : null}
                {report.review.notChecked.length > 0 ? <div className={styles['lineMeta']}>{t.notChecked(join(report.review.notChecked.map((item) => t.notCheckedItems.find(([key]) => item.includes(key))?.[1] ?? item)))}</div> : null}
              </li>
              {report.pace !== null ? (
                <li>
                  {t.pace(numberText(report.pace.cutsPerMinute, locale), report.pace.wordsPerSecond === null ? null : numberText(report.pace.wordsPerSecond, locale))}
                  {report.pace.deviations.length > 0 ? ` · ${t.paceDeviations(report.pace.deviations.length)}` : ''}
                </li>
              ) : null}
              {report.plan !== null ? <li>{t.plan(report.plan.version, report.plan.logline, report.plan.scenes)}</li> : null}
              {report.unmet.length > 0 ? (
                <li>{t.unmetTitle}<ul>{report.unmet.map((item) => <li key={item.code}>{t.unmet[item.code](item.detail)}</li>)}</ul></li>
              ) : null}
              <li>
                {t.cost(formatUsdMicros(report.cost.spentMicros), report.cost.budgetMicros === null ? null : formatUsdMicros(report.cost.budgetMicros))}
                {report.cost.unpricedCalls > 0 ? ` · ${t.unpriced(report.cost.unpricedCalls)}` : ''}
              </li>
              {report.note !== null && report.note.trim().length > 0 ? <li className={styles['autonomyNote']}>{labelled(t.note, report.note)}</li> : null}
            </ul>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}
