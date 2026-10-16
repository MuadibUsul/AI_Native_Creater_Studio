'use client';

import type { ReactElement, ReactNode } from 'react';
import { useI18n } from '@/i18n/I18nProvider';

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

const VARIANT_BADGE: Record<StateBlockVariant, string> = {
  loading: '',
  empty: '',
  error: 'red',
  forbidden: 'amber',
  unauthenticated: 'blue',
  conflict: 'amber',
  unavailable: 'amber',
  info: 'blue',
};

export function StateBlock(props: StateBlockProps): ReactElement {
  const { messages } = useI18n();
  const badge = VARIANT_BADGE[props.variant];
  return (
    <div data-state={props.variant} className="panel pad">
      <span className={`badge ${badge}`.trim()}>{messages.projectFlow.stateBlock.variants[props.variant]}</span>
      <h2 className="mt16">{props.title}</h2>
      {props.description !== undefined ? <p className="muted mt8">{props.description}</p> : null}
      {props.diagnostics !== null && props.diagnostics !== undefined ? (
        <div className="mt16"><code data-testid="state-diagnostics" className="small muted">{props.diagnostics}</code></div>
      ) : null}
      {props.children}
      {props.action || props.secondaryAction ? <div className="row mt24">
        {props.action ? <button type="button" onClick={props.action.onClick} disabled={props.action.disabled ?? false} className="btn primary">{props.action.label}</button> : null}
        {props.secondaryAction ? <button type="button" onClick={props.secondaryAction.onClick} disabled={props.secondaryAction.disabled ?? false} className="btn">{props.secondaryAction.label}</button> : null}
      </div> : null}
    </div>
  );
}
