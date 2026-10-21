'use client';

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { AGENT_ERROR_REASONS, type AgentTurn, type Proposal, type StrategyPackSummary } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import type { Messages } from '@/i18n/messages';
import { QuietIcon } from '@/ui/QuietIcon';
import { formatUsdMicros } from './studio-time';
import { StudioStrategyPicker } from './StudioStrategyPicker';
import type { StudioStrategyChoice } from './useStudio';
import styles from './studio.module.css';

/**
 * 对话栏（左侧 AI 面板，参照 Stitch）：上面是对话记录，下面是这一轮的风格与制作规则、输入框（+ 上传素材、麦克风、发送）。
 * 一句话一轮；AI 的改动成为试改（提案），"就这样"采用、"撤回"丢弃，采用后可"撤销这次修改"。
 * 停止进行中的一轮、撤回试改、撤销已采用的修改是三个不同动作，各自有独立按钮。
 */

export function turnFailureText(turn: AgentTurn, t: Messages['studio']['chat']): string {
  const raw = JSON.stringify(turn.error ?? {});
  if (raw.includes(AGENT_ERROR_REASONS.MODEL_NOT_CONFIGURED)) return t.errors.modelNotConfigured;
  if (raw.includes(AGENT_ERROR_REASONS.MODEL_REFUSED)) return t.errors.refused;
  if (raw.includes(AGENT_ERROR_REASONS.BUDGET_EXCEEDED)) return t.errors.budget;
  return t.errors.generic;
}

export interface ConversationProps {
  turns: AgentTurn[];
  proposal: Proposal | null;
  /** 最近一轮的提案已采用且仍是工程的最新改动 → 可整体撤销 */
  canUndoChange: boolean;
  notice: string | null;
  error: string | null;
  pointerLabel: string | null;
  canEdit: boolean;
  sending: boolean;
  cancelling: boolean;
  adopting: boolean;
  discarding: boolean;
  undoing: boolean;
  onClearPointer: () => void;
  onSend: (message: string) => void;
  onStop: (turn: AgentTurn) => void;
  onKeep: (proposal: Proposal) => void;
  onDiscard: (proposal: Proposal) => void;
  onUndoChange: () => void;
  strategies: StrategyPackSummary[];
  strategy: StudioStrategyChoice | null;
  onStrategyChange: (value: StudioStrategyChoice | null) => void;
  /** V6-6：打开"从参考视频学风格" */
  onLearnStrategy?: () => void;
  /** V6-7/V6-8：付费生成的报价卡（确认/放弃/进行中/结果） */
  generationCards?: ReactNode;
  /** V6-9：交给 AI 剪完的进度与交付报告卡 */
  autonomyCard?: ReactNode;
  /** V6-2 语音：麦克风开关（发送按钮旁）；语音条本身浮在画布底部（Issue #9） */
  voiceToggle?: ReactNode;
  /** 制作规则开关组（特效 / 配音 / 生成），放在输入框上方 */
  rules?: ReactNode;
  /** 输入框里的"+"：上传素材 */
  onUpload?: () => void;
  /** 从首页带来的一句想法：预填到输入框（不自动发送） */
  initialDraft?: string | null;
}

export function StudioConversation(props: ConversationProps) {
  const { messages } = useI18n();
  const t = messages.studio.chat;
  const [draft, setDraft] = useState('');
  const [showSteps, setShowSteps] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (props.initialDraft) setDraft((current) => (current.length > 0 ? current : props.initialDraft ?? ''));
  }, [props.initialDraft]);
  const latest = props.turns[0];
  const earlier = props.turns.slice(1, 21);
  const running = latest?.status === 'RUNNING';
  const canSend = props.canEdit && !running && !props.sending && draft.trim().length > 0;

  // 新的一轮、AI 回复或状态变化时，对话记录滚到最新
  const tail = `${latest?.id ?? ''}:${latest?.status ?? ''}:${latest?.reply ?? ''}:${props.notice ?? ''}:${props.error ?? ''}:${props.proposal?.status ?? ''}`;
  useEffect(() => {
    const thread = threadRef.current;
    if (thread !== null) thread.scrollTop = thread.scrollHeight;
  }, [tail]);

  const submit = () => {
    if (!canSend) return;
    props.onSend(draft.trim());
    setDraft('');
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const proposalOpen = props.proposal?.status === 'OPEN' ? props.proposal : null;
  return (
    <section aria-label={t.label} className={styles['chat']}>
      <div className={styles['chatHead']}>
        <span className="ui-ai-mark" aria-hidden="true" />
        <h2>{t.panelTitle}</h2>
      </div>
      <div ref={threadRef} className={styles['thread']} aria-live="polite">
        {latest === undefined ? (
          <div className={styles['aiMessage']}><span className={styles['speaker']}>{t.ai}</span><p>{t.intro}</p></div>
        ) : null}
        {earlier.slice().reverse().map((turn) => (
          <div key={turn.id} className={styles['earlierTurn']}>
            <div className={styles['userMessage']}><span className={styles['speaker']}>{t.you}</span><p>{turn.message}</p></div>
            {turn.reply ? <div className={styles['aiMessage']}><span className={styles['speaker']}>{t.ai}</span><p>{turn.reply}</p></div> : null}
          </div>
        ))}
        {latest !== undefined ? (
          <>
            <div className={styles['userMessage']}><span className={styles['speaker']}>{t.you}</span><p>{latest.message}</p></div>
            <div className={`${styles['aiMessage']} ${running ? styles['aiWorking'] : ''}`}>
              <span className={styles['speaker']}>{t.ai}</span>
              <div className={styles['lineBody']}>
                {running ? (
                  <div className={styles['actions']} style={{ marginTop: 0 }}>
                    <span role="status" className={`${styles['working']} ui-ai-text`}>{latest.purpose === 'GENERATE' ? t.generating : t.working}</span>
                    <button type="button" className="btn small" disabled={props.cancelling} onClick={() => props.onStop(latest)}>
                      {props.cancelling ? t.stopping : t.stop}
                    </button>
                  </div>
                ) : latest.status === 'CANCELLED' ? (
                  <p>{t.stopped}</p>
                ) : latest.status === 'FAILED' ? (
                  <div className={styles['alert']} role="alert"><strong>{t.failedTitle}</strong><div>{turnFailureText(latest, t)}</div></div>
                ) : (
                  <>
                    <p>{latest.reply ?? ''}</p>
                    {latest.proposalId === null ? <div className={styles['lineMeta']}>{t.noChange}</div> : null}
                  </>
                )}
                {!running && (latest.toolCalls.length > 0 || (latest.costMicros ?? 0) > 0) ? (
                  <div className={styles['lineMeta']}>
                    {latest.toolCalls.length > 0 ? (
                      <button type="button" className="textbtn small" aria-expanded={showSteps} onClick={() => setShowSteps(!showSteps)}>
                        {t.steps(latest.toolCalls.length)} · {showSteps ? t.hideSteps : t.showSteps}
                      </button>
                    ) : null}
                    {latest.costMicros !== null && latest.costMicros > 0 ? <span> · {t.turnCost(formatUsdMicros(latest.costMicros))}</span> : null}
                  </div>
                ) : null}
                {showSteps && !running ? (
                  <ol className={styles['steps']}>
                    {latest.toolCalls.map((call, index) => <li key={`${call.name}-${String(index)}`}>{call.ok ? '✓' : '✕'} {call.summary}</li>)}
                  </ol>
                ) : null}
                {proposalOpen !== null && latest.status === 'COMPLETED' ? (
                  <div className={styles['decision']}>
                    <span>{t.proposalReady}</span>
                    <div className={styles['actions']}>
                      <button type="button" className="btn primary small" disabled={!props.canEdit || props.adopting || props.discarding} onClick={() => props.onKeep(proposalOpen)}>
                        <QuietIcon name="check" />{props.adopting ? t.keeping : t.keep}
                      </button>
                      <button type="button" className="btn small" disabled={!props.canEdit || props.adopting || props.discarding} onClick={() => props.onDiscard(proposalOpen)}>
                        {t.discard}
                      </button>
                    </div>
                  </div>
                ) : null}
                {props.canUndoChange ? (
                  <div className={styles['actions']}>
                    <span>{t.kept}</span>
                    <button type="button" className="btn small" disabled={!props.canEdit || props.undoing} onClick={props.onUndoChange}>
                      <QuietIcon name="undo" />{props.undoing ? t.undoing : t.undoChange}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}
        {props.notice !== null ? <div className={styles['lineMeta']} role="status">{props.notice}</div> : null}
        {props.error !== null ? <div className={styles['alert']} role="alert">{props.error}</div> : null}
        {props.autonomyCard ?? null}
        {props.generationCards ?? null}
      </div>
      <div className={styles['composerArea']}>
        {props.rules !== undefined || props.strategies.length > 0 ? (
          <div className={styles['chatSettings']} role="group" aria-label={t.settingsLabel}>
            {props.rules ?? null}
            {props.strategies.length > 0 ? <StudioStrategyPicker packs={props.strategies} value={props.strategy} disabled={!props.canEdit} onChange={props.onStrategyChange} {...(props.onLearnStrategy !== undefined ? { onLearn: props.onLearnStrategy } : {})} /> : null}
          </div>
        ) : null}
        <div className={`ui-prompt ${styles['prompt']} ${running ? 'ui-ai-working' : ''}`}>
          <span className={`${styles['chip']} ${props.pointerLabel !== null ? styles['chipActive'] : ''}`}>
            {props.pointerLabel ?? messages.studio.pointer.none}
            {props.pointerLabel !== null ? (
              <button type="button" className={styles['chipClear']} aria-label={messages.studio.pointer.clear} onClick={props.onClearPointer}>
                <QuietIcon name="close" />
              </button>
            ) : null}
          </span>
          <textarea
            rows={2}
            aria-label={t.inputLabel}
            aria-keyshortcuts="/"
            data-composer-input
            value={draft}
            disabled={!props.canEdit}
            placeholder={props.pointerLabel !== null ? t.placeholderSelected : t.placeholder}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <div className="ui-prompt-footer">
            {props.onUpload !== undefined && props.canEdit ? (
              <button type="button" className="ui-round" aria-label={t.upload} title={t.upload} onClick={props.onUpload}><QuietIcon name="plus" /></button>
            ) : null}
            <span className="ui-grow" />
            {props.voiceToggle ?? null}
            <button type="button" className="ui-round ui-send" aria-label={t.send} title={t.send} disabled={!canSend} onClick={submit}>
              <QuietIcon name="arrowUp" />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
