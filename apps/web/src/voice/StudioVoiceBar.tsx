'use client';

import type { RealtimeAttention } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import type { VoiceErrorCode, VoiceState } from './useVoice';
import styles from './voice.module.css';

/** 麦克风开关（放在发送按钮旁）。 */
export function VoiceToggle(props: { state: VoiceState; disabled: boolean; onStart: () => void; onStop: () => void }) {
  const { messages } = useI18n();
  const t = messages.studio.voice;
  const on = props.state === 'connecting' || props.state === 'listening' || props.state === 'finishing';
  return (
    <button
      type="button"
      className={`btn icononly ${on ? 'primary' : ''} ${styles['toggle']}`}
      aria-pressed={on}
      aria-label={on ? t.stop : t.start}
      title={on ? t.stop : t.start}
      disabled={props.disabled || props.state === 'finishing'}
      onClick={on ? props.onStop : props.onStart}
    >
      <QuietIcon name="voice" />
    </button>
  );
}

/**
 * 语音状态行：在听 / 听到的话（边说边出）/ 理解的指向 / 还没说完 / 错误；
 * 朗读开关与"停止说话"（只停朗读，不停 AI 的一轮、不撤回试改）。
 */
export function StudioVoiceBar(props: {
  state: VoiceState;
  error: VoiceErrorCode | null;
  partial: string;
  held: boolean;
  attention: RealtimeAttention | null;
  attentionLabel: string | null;
  scripted: boolean;
  level: number;
  readAloud: { supported: boolean; enabled: boolean; speaking: boolean; onToggle: (enabled: boolean) => void; onStop: () => void };
}) {
  const { messages } = useI18n();
  const t = messages.studio.voice;
  const active = props.state === 'connecting' || props.state === 'listening' || props.state === 'finishing';
  if (!active && props.error === null && !props.readAloud.speaking) return null;
  const pointing = props.attention === null ? null
    : props.attention.word !== null && props.attentionLabel !== null ? t.pointingAt(props.attentionLabel, props.attention.word)
      : t.pointing(props.attentionLabel ?? t.wholeVideo);
  return (
    <div className={styles['bar']} aria-live="polite">
      {props.error !== null ? <span className={styles['error']} role="alert">{t.errors[props.error]}</span> : (
        <>
          <span className={styles['status']}>
            <span className={styles['meter']} aria-hidden="true" style={{ transform: `scaleY(${String(Math.min(1, 0.2 + props.level * 6))})` }} />
            {props.state === 'connecting' ? t.connecting : props.state === 'finishing' ? t.finishing : t.listening}
          </span>
          {props.partial !== '' ? <span className={styles['heard']}>{t.heard}<b>{props.partial}</b></span> : null}
          {props.held ? <span className={styles['hint']}>{t.held}</span> : null}
          {pointing !== null && props.partial !== '' ? <span className={styles['hint']}>{pointing}</span> : null}
          {props.scripted ? <span className={styles['badge']}>{t.asrScripted}</span> : null}
        </>
      )}
      <span className={styles['spacer']} />
      {props.readAloud.supported ? (
        <label className={styles['readAloud']} title={t.readAloudHint}>
          <input type="checkbox" checked={props.readAloud.enabled} onChange={(event) => props.readAloud.onToggle(event.target.checked)} />
          {t.readAloud}
        </label>
      ) : null}
      {props.readAloud.speaking ? <button type="button" className="btn small" onClick={props.readAloud.onStop}><QuietIcon name="volume" />{t.stopSpeaking}</button> : null}
    </div>
  );
}
