'use client';

import { useState, type KeyboardEvent, type ReactNode } from 'react';
import styles from './studio.module.css';

/**
 * 制作规则开关组（特效 / 配音 / 生成）：一组"作品允许 AI 做什么"的开关，按 Radix Toggle Group 的键盘模型组织——
 * 整组只占一个 Tab 停靠点（落在第一个开启项，没有则第一项），←/→（↑/↓）在组内移动、Home/End 到首尾，Space/Enter 切换。
 * 开/关同时写在文字里（"特效：开"），不只靠颜色或浮起。
 */
export interface StudioRule {
  key: string;
  pressed: boolean;
  disabled: boolean;
  title: string;
  icon: ReactNode;
  label: string;
  onToggle: () => void;
}

const NEXT_KEYS = new Set(['ArrowRight', 'ArrowDown']);
const PREVIOUS_KEYS = new Set(['ArrowLeft', 'ArrowUp']);

export function StudioRuleGroup(props: { label: string; rules: StudioRule[] }) {
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  // Tab 停靠点：最近聚焦过的项 → 第一个开启项 → 第一项；落在被禁用的项上时改到第一个可用项（例如某个开关正在保存）
  const preferred = focusIndex ?? Math.max(props.rules.findIndex((rule) => rule.pressed), 0);
  const tabIndexAt = props.rules[preferred]?.disabled === false ? preferred : props.rules.findIndex((rule) => !rule.disabled);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const forward = NEXT_KEYS.has(event.key);
    if (!forward && !PREVIOUS_KEYS.has(event.key) && event.key !== 'Home' && event.key !== 'End') return;
    const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    if (items.length === 0) return;
    const current = items.indexOf(event.target as HTMLButtonElement);
    const next = event.key === 'Home' ? 0
      : event.key === 'End' ? items.length - 1
        : (Math.max(current, 0) + (forward ? 1 : -1) + items.length) % items.length;
    event.preventDefault();
    items[next]?.focus();
  };

  return (
    <div className={styles['ruleGroup']} role="group" aria-label={props.label} onKeyDown={onKeyDown}>
      {props.rules.map((rule, index) => (
        <button
          key={rule.key}
          type="button"
          className="btn small ghost"
          aria-pressed={rule.pressed}
          title={rule.title}
          disabled={rule.disabled}
          tabIndex={index === tabIndexAt ? 0 : -1}
          onFocus={() => setFocusIndex(index)}
          onClick={rule.onToggle}
        >{rule.icon}{rule.label}</button>
      ))}
    </div>
  );
}
