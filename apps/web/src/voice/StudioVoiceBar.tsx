'use client';

import { useEffect, useRef, type RefObject } from 'react';
import type { RealtimeVoice } from '@ancs/contracts';
import { useI18n } from '@/i18n/I18nProvider';
import { QuietIcon } from '@/ui/QuietIcon';
import type { VoicePhase } from './voice-phase';
import type { VoiceErrorCode, VoiceState } from './useVoice';
import styles from './voice.module.css';

/** 麦克风开关（放在发送按钮旁；V 键同样可用）。 */
export function VoiceToggle(props: { state: VoiceState; disabled: boolean; onStart: () => void; onStop: () => void }) {
  const { messages } = useI18n();
  const t = messages.studio.voice;
  const on = props.state === 'connecting' || props.state === 'listening' || props.state === 'finishing';
  return (
    <button
      type="button"
      className={`ui-round ${on ? styles['toggleOn'] : ''} ${styles['toggle']}`}
      aria-pressed={on}
      aria-label={on ? t.stop : t.start}
      aria-keyshortcuts="V"
      title={on ? t.endHint : t.startHint}
      disabled={props.disabled || props.state === 'finishing'}
      onClick={on ? props.onStop : props.onStart}
    >
      <QuietIcon name="voice" />
    </button>
  );
}

const BAR_WEIGHTS = [0.55, 1, 0.8, 0.45];

/** 麦克风电平：从 ref 按帧读，直接改 DOM（不触发 React 重渲染）；四根条按固定比例反映同一个真实电平 */
function LevelMeter(props: { levelRef: RefObject<number>; live: boolean }) {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => {
    if (!props.live) {
      for (const bar of bars.current) if (bar !== null) bar.style.transform = 'scaleY(0.25)';
      return;
    }
    let frame = requestAnimationFrame(function tick() {
      const level = Math.min(1, props.levelRef.current * 7);
      bars.current.forEach((bar, index) => {
        if (bar !== null) bar.style.transform = `scaleY(${String(Math.max(0.2, level * BAR_WEIGHTS[index]!))})`;
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [props.levelRef, props.live]);
  return (
    <span className={styles['meter']} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => <span key={index} ref={(element) => { bars.current[index] = element; }} />)}
    </span>
  );
}

function PhaseIcon(props: { phase: VoicePhase; levelRef: RefObject<number> }) {
  switch (props.phase) {
    case 'connecting':
    case 'thinking':
    case 'finishing':
      return <span className={styles['dots']} aria-hidden="true"><span /><span /><span /></span>;
    case 'speaking':
      return <QuietIcon name="volume" className={styles['phaseIcon']} />;
    case 'error':
      return <QuietIcon name="info" className={styles['phaseIcon']} />;
    case 'ended':
      return <QuietIcon name="check" className={styles['phaseIcon']} />;
    default:
      return <LevelMeter levelRef={props.levelRef} live={props.phase === 'listening' || props.phase === 'recognizing'} />;
  }
}

/** 恢复得了的错误（重新连接有意义）；未配置 / 无权限 / 浏览器不支持 / 服务端密钥失效重连也没用 */
const RECOVERABLE: ReadonlySet<VoiceErrorCode> = new Set(['PERMISSION_DENIED', 'CONNECTION_FAILED', 'CONNECTION_LOST', 'SESSION_EXPIRED', 'ASR_FAILED']);

export interface VoiceDockProps {
  phase: VoicePhase;
  error: VoiceErrorCode | null;
  /** 画布边缘的一行反馈（已本地化）：主文字（边说边出的转写、交给 AI 的话、提示）+ 次要说明（指向、排队） */
  caption: { main: string; detail: string | null; tone: 'normal' | 'alert' } | null;
  levelRef: RefObject<number>;
  badges: string[];
  mark: { visible: boolean; active: boolean; onToggle: () => void };
  voices: { list: RealtimeVoice[]; value: string | null; onChange: (id: string) => void } | null;
  browserVoice: boolean;
  readAloud: { enabled: boolean; onToggle: () => void };
  /** 停止说话 / 停止这一轮：会话进行中一直占位（不适用时禁用），避免 AI 说完时按钮消失、整条语音条重新居中导致点错（例如点到"采用"） */
  stopSpeaking: { enabled: boolean; onStop: () => void };
  stopTurn: { enabled: boolean; onStop: () => void } | null;
  /** 正在出声的那一轮（供验收测量把回应对应到轮次） */
  replyTurnId: string | null;
  trial: { onKeep: () => void; onDiscard: () => void; busy: boolean } | null;
  undo: { onUndo: () => void; busy: boolean } | null;
  failed: { onRetry: () => void; onDrop: () => void } | null;
  onEnd: () => void;
  onReconnect: () => void;
  onDismiss: () => void;
}

/**
 * Issue #9 画布内的悬浮语音条（参考 Google Stitch）：浮在画面下方预留的边上（画面自动让出空间，不压视频、字幕、时间带），
 * 一行状态 + 少量按钮；上方一行短反馈。各阶段互斥显示：连接中 / 在听 / 正在听你说 / AI 思考中 / AI 正在说 / 出错 / 已结束。
 * "停止说话"只停声音；"停止这一轮"停 AI 的执行；"放弃试改 / 撤销改动"处理改动；"结束语音"只结束语音会话——四件事分开。
 */
export function StudioVoiceDock(props: VoiceDockProps) {
  const { messages } = useI18n();
  const t = messages.studio.voice;
  const live = props.phase !== 'error' && props.phase !== 'ended';
  return (
    <div className={styles['layer']} data-phase={props.phase} data-reply-turn={props.replyTurnId ?? undefined} data-voice-dock="" role="region" aria-label={t.region}>
      {props.caption !== null ? (
        <p className={`${styles['caption']} ${props.caption.tone === 'alert' ? styles['captionAlert'] : ''}`} role={props.caption.tone === 'alert' ? 'alert' : 'status'} aria-live="polite" data-voice-caption="">
          <b>{props.caption.main}</b>
          {props.caption.detail !== null ? <span className={styles['detail']}>{` · ${props.caption.detail}`}</span> : null}
        </p>
      ) : null}
      <div className={styles['pill']} role="toolbar" aria-label={t.controls}>
        <span className={styles['status']} data-voice-status="">
          <PhaseIcon phase={props.phase} levelRef={props.levelRef} />
          <span className={styles['statusLabel']}>{t.phases[props.phase]}</span>
        </span>
        {props.badges.map((badge) => <span key={badge} className={styles['badge']}>{badge}</span>)}
        {live && props.mark.visible ? (
          <button type="button" className={styles['button']} aria-pressed={props.mark.active} aria-keyshortcuts="M" title={t.markAreaHint} aria-label={props.mark.active ? t.markAreaActive : t.markArea} onClick={props.mark.onToggle}>
            <QuietIcon name="expand" /><span className={styles['label']}>{props.mark.active ? t.markAreaActive : t.markArea}</span>
          </button>
        ) : null}
        {live && props.voices !== null && props.voices.list.length > 0 ? (
          <label className={styles['voicePicker']} title={t.voiceLabel}>
            <span className={styles['visuallyHidden']}>{t.voiceLabel}</span>
            <select value={props.voices.value ?? ''} onChange={(event) => props.voices?.onChange(event.target.value)} disabled={props.voices.list.length < 2}>
              {props.voices.list.map((voice) => <option key={voice.id} value={voice.id}>{voice.name}</option>)}
            </select>
          </label>
        ) : live && props.browserVoice ? <span className={styles['badge']} title={t.browserVoiceHint}>{t.browserVoice}</span> : null}
        {live ? (
          <button type="button" className={styles['button']} aria-pressed={props.readAloud.enabled} title={t.readAloudHint} aria-label={t.readAloud} onClick={props.readAloud.onToggle}>
            <QuietIcon name="volume" /><span className={styles['label']}>{t.readAloud}</span>
          </button>
        ) : null}
        {live ? (
          <button type="button" className={styles['button']} title={t.stopSpeakingHint} aria-label={t.stopSpeaking} disabled={!props.stopSpeaking.enabled} onClick={props.stopSpeaking.onStop}>
            <QuietIcon name="pause" /><span className={styles['label']}>{t.stopSpeaking}</span>
          </button>
        ) : null}
        {live && props.stopTurn !== null ? (
          <button type="button" className={styles['button']} title={t.stopTurnHint} aria-label={t.stopTurn} disabled={!props.stopTurn.enabled} onClick={props.stopTurn.onStop}>
            <span className={styles['stopGlyph']} aria-hidden="true" /><span className={styles['label']}>{t.stopTurn}</span>
          </button>
        ) : null}
        {props.failed !== null ? (
          <>
            <button type="button" className={styles['button']} onClick={props.failed.onRetry}>{t.retry}</button>
            <button type="button" className={styles['button']} onClick={props.failed.onDrop}>{t.drop}</button>
          </>
        ) : null}
        {props.trial !== null ? (
          <>
            <span className={styles['divider']} aria-hidden="true" />
            <button type="button" className={`${styles['button']} ${styles['primary']}`} disabled={props.trial.busy} aria-label={t.keep} onClick={props.trial.onKeep}>
              <QuietIcon name="check" /><span className={styles['label']}>{t.keep}</span>
            </button>
            <button type="button" className={styles['button']} disabled={props.trial.busy} aria-label={t.discard} onClick={props.trial.onDiscard}>
              <QuietIcon name="undo" /><span className={styles['label']}>{t.discard}</span>
            </button>
          </>
        ) : null}
        {props.undo !== null ? (
          <button type="button" className={styles['button']} disabled={props.undo.busy} aria-label={t.undo} onClick={props.undo.onUndo}>
            <QuietIcon name="undo" /><span className={styles['label']}>{t.undo}</span>
          </button>
        ) : null}
        <span className={styles['divider']} aria-hidden="true" />
        {props.phase === 'error' ? (
          <>
            {props.error !== null && RECOVERABLE.has(props.error) ? (
              <button type="button" className={`${styles['button']} ${styles['primary']}`} onClick={props.onReconnect}>
                <QuietIcon name="voice" /><span>{t.reconnect}</span>
              </button>
            ) : null}
            <button type="button" className={`${styles['button']} ${styles['iconOnly']}`} aria-label={t.dismiss} title={t.dismiss} onClick={props.onDismiss}><QuietIcon name="close" /></button>
          </>
        ) : props.phase === 'ended' ? (
          <button type="button" className={`${styles['button']} ${styles['iconOnly']}`} aria-label={t.dismiss} title={t.dismiss} onClick={props.onDismiss}><QuietIcon name="close" /></button>
        ) : (
          <button type="button" className={`${styles['button']} ${styles['end']}`} aria-label={t.end} aria-keyshortcuts="V" title={t.endHint} disabled={props.phase === 'finishing'} onClick={props.onEnd}>
            <QuietIcon name="close" /><span className={styles['label']}>{t.end}</span>
          </button>
        )}
      </div>
    </div>
  );
}
