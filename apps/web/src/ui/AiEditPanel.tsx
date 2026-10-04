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
  const [prompt, setPrompt] = useState('');

  return (
    <div data-testid="ai-edit-panel" className="flex flex-col gap-3 rounded border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="text-sm font-semibold text-slate-300">AI Edit</h2>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim() !== '') props.onPlan(prompt.trim());
        }}
      >
        <input
          aria-label="AI Edit 意图"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="例如：把第一个场景延长 500ms"
          className="flex-1 rounded border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm"
        />
        <button type="submit" disabled={props.planPending || prompt.trim() === ''} className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:opacity-50">
          {props.planPending ? '生成计划中…' : '生成计划'}
        </button>
      </form>

      {props.planError !== null ? (
        <p data-testid="ai-edit-plan-error" className="rounded border border-rose-700 bg-rose-950/40 px-3 py-2 text-xs text-rose-200">
          {props.planError.message}
          {props.planError.code !== null ? `（${props.planError.code}）` : ''}
        </p>
      ) : null}

      {props.plan !== null ? (
        <section data-testid="ai-edit-plan" className="flex flex-col gap-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">
              计划 {props.plan.planId.slice(0, 14)}… · 基于 revision {props.plan.baseProjectRevision} · 尝试 {props.plan.generation.attempts} 次 ·{' '}
              {props.plan.generation.providerId}
            </span>
            <span className="text-slate-500">成本影响：{props.plan.impact.costImpact === 'NONE' ? '无（计划阶段零 Provider 调用）' : props.plan.impact.costImpact}</span>
          </div>

          {props.plan.warnings.map((warning) => (
            <p key={warning} data-testid="ai-edit-warning" className="rounded border border-amber-700 bg-amber-950/40 px-2 py-1 text-amber-200">
              {warning}
            </p>
          ))}

          <ul data-testid="ai-edit-operations" className="flex flex-col gap-1">
            {props.plan.operations.map((entry, index) => (
              <li key={`${String(index)}-${entry.summary}`} className="rounded border border-slate-800 px-2 py-1">
                <span className="font-mono text-slate-300">{entry.operation.op}</span>
                <span className="ml-2">{entry.summary}</span>
                {Object.keys(entry.before).length > 0 || Object.keys(entry.after).length > 0 ? (
                  <div className="mt-1 font-mono text-[11px] text-slate-500">
                    {Object.entries(entry.before).map(([key, value]) => (
                      <span key={`b-${key}`}>
                        {key}: {JSON.stringify(value)} → {JSON.stringify(entry.after[key])}
                        {'  '}
                      </span>
                    ))}
                  </div>
                ) : null}
                {props.plan?.rationale[index] !== undefined ? <div className="text-[11px] text-slate-500">理由：{props.plan.rationale[index]}</div> : null}
              </li>
            ))}
          </ul>

          <p data-testid="ai-edit-impact" className="text-slate-400">
            影响：新增 {props.plan.impact.scenesAdded} · 删除 {props.plan.impact.scenesRemoved} · 修改 {props.plan.impact.scenesModified} · 时长{' '}
            {props.plan.impact.durationDeltaMs >= 0 ? '+' : ''}
            {props.plan.impact.durationDeltaMs}ms
          </p>

          <div className="flex gap-2">
            <button
              type="button"
              disabled={props.applyPending}
              onClick={() => props.onApply(props.plan as EditPlan)}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              {props.applyPending ? '应用中…' : `应用（${String(props.plan.operations.length)} 项）`}
            </button>
            <button type="button" onClick={props.onReject} className="rounded border border-slate-600 px-3 py-1.5 text-sm hover:bg-slate-800">
              拒绝计划
            </button>
          </div>
        </section>
      ) : null}

      {props.applyError !== null ? (
        <p data-testid="ai-edit-apply-error" className="rounded border border-orange-700 bg-orange-950/40 px-3 py-2 text-xs text-orange-200">
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
