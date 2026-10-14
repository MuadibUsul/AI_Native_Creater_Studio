'use client';

import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import styles from './studio.module.css';

/**
 * 共看片室快捷键列表（detail.design "Hold to Reveal"：列表教一次，按住每次都教）。
 * 两种出现方式：按 ? 或点"快捷键"固定打开（有关闭按钮，Esc 也关）；按住 Ctrl / ⌘ 半秒临时显示、松开即收起。
 * 键名不写平台专属符号（空格 / Shift / Home 等在各平台一致），按键本身由 StudioRoom 统一处理。
 */
export function StudioShortcuts(props: { open: boolean; held: boolean; onClose: () => void }) {
  const { messages } = useI18n();
  const t = messages.studio.shortcuts;
  if (!props.open && !props.held) return null;
  return (
    <section className={styles['shortcuts']} aria-label={t.title} data-held={!props.open && props.held ? 'true' : undefined}>
      <header className={styles['shortcutsHead']}>
        <h2>{t.title}</h2>
        {props.open ? (
          <button type="button" className="btn icononly ghost small" aria-label={t.close} onClick={props.onClose}><QuietIcon name="close" /></button>
        ) : <span className={styles['shortcutsHint']}>{t.holdHint}</span>}
      </header>
      <dl className={styles['shortcutsList']}>
        {t.items.map((item) => (
          <div key={item.label}>
            <dt>{item.keys.map((key) => <kbd key={key}>{key}</kbd>)}</dt>
            <dd>{item.label}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
