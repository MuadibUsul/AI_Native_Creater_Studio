'use client';

import type { ReactElement, ReactNode } from 'react';

/**
 * 状态块（P05-03 验收：空 / 加载 / 失败 / 无权限 / 冲突状态**均可操作**）。
 * 每个状态都必须给出下一步动作（action），不得只显示错误文字。
 */

export type StateBlockVariant = 'loading' | 'empty' | 'error' | 'forbidden' | 'unauthenticated' | 'conflict' | 'unavailable' | 'info';

export interface StateBlockAction {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}

export interface StateBlockProps {
  variant: StateBlockVariant;
  title: string;
  description?: string;
  /** 关键诊断信息（服务端 code / requestId 等；不显示堆栈） */
  diagnostics?: string | null;
  action?: StateBlockAction | null;
  secondaryAction?: StateBlockAction | null;
  children?: ReactNode;
}

const VARIANT_STYLE: Record<StateBlockVariant, { border: string; badge: string; label: string }> = {
  loading: { border: 'border-slate-700', badge: 'bg-slate-700 text-slate-200', label: '加载中' },
  empty: { border: 'border-slate-700 border-dashed', badge: 'bg-slate-800 text-slate-300', label: '空' },
  error: { border: 'border-rose-700', badge: 'bg-rose-900 text-rose-100', label: '失败' },
  forbidden: { border: 'border-amber-700', badge: 'bg-amber-900 text-amber-100', label: '无权限' },
  unauthenticated: { border: 'border-sky-700', badge: 'bg-sky-900 text-sky-100', label: '未登录' },
  conflict: { border: 'border-orange-700', badge: 'bg-orange-900 text-orange-100', label: '冲突' },
  unavailable: { border: 'border-slate-600', badge: 'bg-slate-700 text-slate-200', label: '不可用' },
  info: { border: 'border-slate-700', badge: 'bg-slate-800 text-slate-300', label: '说明' },
};

export function StateBlock(props: StateBlockProps): ReactElement {
  const style = VARIANT_STYLE[props.variant];
  return (
    <div
      data-state={props.variant}
      className={`flex flex-col items-start gap-3 rounded-lg border ${style.border} bg-slate-900/60 p-6`}
    >
      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${style.badge}`}>{style.label}</span>
      <h2 className="text-lg font-semibold">{props.title}</h2>
      {props.description !== undefined ? <p className="text-sm text-slate-300">{props.description}</p> : null}
      {props.diagnostics !== null && props.diagnostics !== undefined ? (
        <code data-testid="state-diagnostics" className="rounded bg-slate-950 px-2 py-1 text-xs text-slate-400">
          {props.diagnostics}
        </code>
      ) : null}
      {props.children}
      {props.action !== null && props.action !== undefined ? (
        <button
          type="button"
          onClick={props.action.onClick}
          disabled={props.action.disabled ?? false}
          className="rounded bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {props.action.label}
        </button>
      ) : null}
      {props.secondaryAction !== null && props.secondaryAction !== undefined ? (
        <button
          type="button"
          onClick={props.secondaryAction.onClick}
          disabled={props.secondaryAction.disabled ?? false}
          className="rounded border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {props.secondaryAction.label}
        </button>
      ) : null}
    </div>
  );
}
