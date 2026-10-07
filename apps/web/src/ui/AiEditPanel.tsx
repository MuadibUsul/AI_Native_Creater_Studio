'use client';

import { useState } from 'react';
import type { EditPlan } from '@ancs/contracts';

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
  const [prompt, setPrompt] = useState(props.initialPrompt ?? '');
  const [showReplan, setShowReplan] = useState(false);

  return (
    <div data-testid="ai-edit-panel" className="qf-ai-panel">
      {props.plan ? <div className="qf-ai-intent"><span aria-hidden="true">✧</span><strong>{props.plan.prompt}</strong></div> : null}
      <p className="qf-ai-intro">{props.plan ? '由服务端生成的修改建议。请核对差异、锁定内容和影响范围。' : '说明希望修改的内容；生成计划不会直接改动作品。'}</p>
      {props.plan ? <button type="button" className="textbtn small qf-ai-replan-toggle" disabled={props.applyPending} aria-expanded={showReplan} onClick={() => setShowReplan((value) => !value)}>修改意图并重新生成计划</button> : null}
      {!props.plan || showReplan ? <form className="qf-ai-form" onSubmit={(event) => { event.preventDefault(); if (prompt.trim() !== '') props.onPlan(prompt.trim()); }}>
        <input aria-label="AI Edit 意图" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：缩短当前旁白，保留观点和来源" className="field" />
        <button type="submit" disabled={props.planPending || props.applyPending || prompt.trim() === ''} className="btn blue">{props.planPending ? '生成计划中…' : '生成计划'}</button>
      </form> : null}

      {props.planError !== null ? (
        <p data-testid="ai-edit-plan-error" role="alert" className="notice amber qf-ai-error">
          {props.planError.message}
          {props.planError.code !== null ? `（${props.planError.code}）` : ''}
        </p>
      ) : null}

      {props.plan !== null ? (
        <section data-testid="ai-edit-plan" className="qf-ai-plan">
          <p className="small muted">计划 {props.plan.planId.slice(0, 14)}… · 项目 revision {props.plan.baseProjectRevision} · {props.plan.generation.providerId}</p>

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
                {props.plan?.rationale[index] !== undefined ? <p className="qf-ai-rationale">理由：{props.plan.rationale[index]}</p> : null}
              </li>
            ))}
          </ul>

          <div className="qf-ai-impact" data-testid="ai-edit-impact"><span>影响范围</span><strong>新增 {props.plan.impact.scenesAdded} · 删除 {props.plan.impact.scenesRemoved} · 修改 {props.plan.impact.scenesModified} · 时长 {props.plan.impact.durationDeltaMs >= 0 ? '+' : ''}{props.plan.impact.durationDeltaMs}ms</strong></div>
          <div className="qf-ai-impact"><span>已锁定内容</span><strong>{props.plan.warnings.length > 0 ? '见上方提醒' : '未提示修改'}</strong></div>
          <div className="qf-ai-impact"><span>成本影响</span><strong>{props.plan.impact.costImpact === 'NONE' ? '无（计划阶段零 Provider 调用）' : props.plan.impact.costImpact}</strong></div>
          <p className="small muted qf-ai-disclaimer">应用后将通过编辑协议写入，仍需人工核对事实与画面。素材重生成须另行确认。</p>

          <div className="qf-ai-actions">
            <button
              type="button"
              disabled={props.applyPending}
              onClick={() => props.onApply(props.plan as EditPlan)}
              className="btn primary full"
            >
              {props.applyPending ? '应用中…' : `应用（${String(props.plan.operations.length)} 项）`}
            </button>
            <button type="button" disabled={props.applyPending} onClick={props.onReject} className="btn full">
              拒绝计划
            </button>
          </div>
        </section>
      ) : null}

      {props.applyError !== null ? (
        <p data-testid="ai-edit-apply-error" role="alert" className="notice amber qf-ai-error">
          {props.applyError.kind === 'conflict'
            ? '应用失败：项目已被其他编辑更新（409）——请刷新后重新生成计划。'
            : props.applyError.kind === 'validation'
              ? '应用被拒绝：计划包含非法操作，未提交任何变更（整批在同一事务）。'
              : props.applyError.message}
          {props.applyError.code !== null ? `（${props.applyError.code}）` : ''}
        </p>
      ) : null}
    </div>
  );
}
