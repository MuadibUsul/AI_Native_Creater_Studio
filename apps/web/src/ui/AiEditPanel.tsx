'use client';

import { useState } from 'react';
import type { EditPlan } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';

/**
 * AI Edit 面板（P05-06）：自然语言 → 计划（不落库）→ 差异预览与影响 → Apply / 拒绝。
 *
 * 纪律：
 * - **未 Apply 不改数据库**：计划只是本面板状态；Apply 才调用编辑协议提交；
 * - 拒绝 = 清空状态（无副作用）；
 * - 计划中的锁定告警必须展示（AI 不得修改锁定场景，§4.7）；
 * - 成本影响恒为 NONE（计划阶段零 Provider 调用；重生成素材须用户显式发起）。
 */

export interface AiEditPanelProps {
  initialPrompt?: string;
  plan: EditPlan | null;
  planPending: boolean;
  planError: { kind: string; message: string; code: string | null } | null;
  onPlan: (prompt: string) => void;
  onApply: (plan: EditPlan) => void;
  onReject: () => void;
  applyPending: boolean;
  applyError: { kind: string; message: string; code: string | null } | null;
}

export function AiEditPanel(props: AiEditPanelProps) {
  const t = useI18n().messages.projectFlow.aiEdit;
  const [prompt, setPrompt] = useState(props.initialPrompt ?? '');
  const [showReplan, setShowReplan] = useState(false);

  return (
    <div data-testid="ai-edit-panel" className="qf-ai-panel">
      {props.plan ? <div className="qf-ai-intent"><span aria-hidden="true">✧</span><strong>{props.plan.prompt}</strong></div> : null}
      <p className="qf-ai-intro">{props.plan ? t.introPlan : t.introEmpty}</p>
      {props.plan ? <button type="button" className="textbtn small qf-ai-replan-toggle" disabled={props.applyPending} aria-expanded={showReplan} onClick={() => setShowReplan((value) => !value)}>{t.replanToggle}</button> : null}
      {!props.plan || showReplan ? <form className="qf-ai-form" onSubmit={(event) => { event.preventDefault(); if (prompt.trim() !== '') props.onPlan(prompt.trim()); }}>
        <input aria-label={t.promptAria} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t.promptPlaceholder} className="field" />
        <button type="submit" disabled={props.planPending || props.applyPending || prompt.trim() === ''} className="btn blue">{props.planPending ? t.planning : t.generate}</button>
      </form> : null}

      {props.planError !== null ? (
        <p data-testid="ai-edit-plan-error" role="alert" className="notice amber qf-ai-error">
          {props.planError.message}
          {props.planError.code !== null ? t.codeSuffix(props.planError.code) : ''}
        </p>
      ) : null}

      {props.plan !== null ? (
        <section data-testid="ai-edit-plan" className="qf-ai-plan">
          <p className="small muted">{t.planMeta(props.plan.planId.slice(0, 14), props.plan.baseProjectRevision, props.plan.generation.providerId)}</p>

          {props.plan.warnings.map((warning) => (
            <p key={warning} data-testid="ai-edit-warning" className="notice amber qf-ai-warning">
              {warning}
            </p>
          ))}

          <ul data-testid="ai-edit-operations" className="qf-ai-operations">
            {props.plan.operations.map((entry, index) => (
              <li key={`${String(index)}-${entry.summary}`} className="diff-card qf-ai-operation">
                <header><strong>{entry.summary}</strong><span>{entry.operation.op}</span></header>
                {[...new Set([...Object.keys(entry.before), ...Object.keys(entry.after)])].map((field) => <div key={field} className="qf-ai-change">
                  <div className="diff-remove">− {field}: {JSON.stringify(entry.before[field] ?? null)}</div>
                  <div className="diff-add">+ {field}: {JSON.stringify(entry.after[field] ?? null)}</div>
                </div>)}
                {props.plan?.rationale[index] !== undefined ? <p className="qf-ai-rationale">{t.rationale(props.plan.rationale[index])}</p> : null}
              </li>
            ))}
          </ul>

          <div className="qf-ai-impact" data-testid="ai-edit-impact"><span>{t.impactLabel}</span><strong>{t.impactValue(props.plan.impact.scenesAdded, props.plan.impact.scenesRemoved, props.plan.impact.scenesModified, (props.plan.impact.durationDeltaMs >= 0 ? '+' : '') + String(props.plan.impact.durationDeltaMs))}</strong></div>
          <div className="qf-ai-impact"><span>{t.lockedLabel}</span><strong>{props.plan.warnings.length > 0 ? t.lockedSeeAbove : t.lockedNone}</strong></div>
          <div className="qf-ai-impact"><span>{t.costLabel}</span><strong>{props.plan.impact.costImpact === 'NONE' ? t.costNone : props.plan.impact.costImpact}</strong></div>
          <p className="small muted qf-ai-disclaimer">{t.disclaimer}</p>

          <div className="qf-ai-actions">
            <button
              type="button"
              disabled={props.applyPending}
              onClick={() => props.onApply(props.plan as EditPlan)}
              className="btn primary full"
            >
              {props.applyPending ? t.applying : t.apply(props.plan.operations.length)}
            </button>
            <button type="button" disabled={props.applyPending} onClick={props.onReject} className="btn full">
              {t.reject}
            </button>
          </div>
        </section>
      ) : null}

      {props.applyError !== null ? (
        <p data-testid="ai-edit-apply-error" role="alert" className="notice amber qf-ai-error">
          {props.applyError.kind === 'conflict'
            ? t.applyConflict
            : props.applyError.kind === 'validation'
              ? t.applyValidation
              : props.applyError.message}
          {props.applyError.code !== null ? t.codeSuffix(props.applyError.code) : ''}
        </p>
      ) : null}
    </div>
  );
}
