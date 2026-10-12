'use client';

import type { StrategyPackSummary } from '@ancs/contracts';
import { useId } from 'react';
import { useI18n } from '@/i18n/I18nProvider';
import type { StudioStrategyChoice } from './useStudio';
import styles from './studio.module.css';

/**
 * 风格（可选）：选一个策略包与它的少量旋钮。默认不选——AI 按素材和这句话自己判断（V6 §6.6）。
 * 选择只作为这一轮对话的风格参考发给服务端，不改变 AI 能用的工具。
 */
export function StudioStrategyPicker(props: {
  packs: StrategyPackSummary[];
  value: StudioStrategyChoice | null;
  disabled: boolean;
  onChange: (value: StudioStrategyChoice | null) => void;
}) {
  const { messages, locale } = useI18n();
  const t = messages.studio.strategy;
  const id = useId();
  const selected = props.value === null ? undefined : props.packs.find((pack) => pack.id === props.value?.packId);
  const choose = (packId: string) => {
    const pack = props.packs.find((candidate) => candidate.id === packId);
    props.onChange(pack === undefined ? null : { packId: pack.id, knobs: Object.fromEntries(pack.knobs.map((knob) => [knob.key, knob.defaultValue])) });
  };

  return (
    <div className={styles['strategyRow']}>
      <div className={styles['strategyField']}>
        <label htmlFor={`${id}-pack`}>{t.label}</label>
        <select id={`${id}-pack`} className="field" value={selected?.id ?? ''} disabled={props.disabled} onChange={(event) => choose(event.target.value)} title={selected?.summary[locale] ?? t.hint}>
          <option value="">{t.none}</option>
          {props.packs.map((pack) => <option key={pack.id} value={pack.id}>{pack.name[locale]}</option>)}
        </select>
      </div>
      {selected !== undefined && props.value !== null ? selected.knobs.map((knob) => (
        <div key={knob.key} className={styles['strategyField']}>
          <label htmlFor={`${id}-${knob.key}`}>{knob.label[locale]}</label>
          <select
            id={`${id}-${knob.key}`}
            className="field"
            value={props.value?.knobs[knob.key] ?? knob.defaultValue}
            disabled={props.disabled}
            onChange={(event) => { if (props.value !== null) props.onChange({ ...props.value, knobs: { ...props.value.knobs, [knob.key]: event.target.value } }); }}
          >
            {knob.options.map((option) => <option key={option.value} value={option.value}>{option.label[locale]}</option>)}
          </select>
        </div>
      )) : null}
      <span className={styles['strategyHint']}>{selected === undefined ? t.hint : selected.summary[locale]}</span>
    </div>
  );
}
