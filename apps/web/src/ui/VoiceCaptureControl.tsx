'use client';

import { useMicrophoneCapture, type MicrophoneCapture } from '@/lib/useMicrophoneCapture';
import type { VoiceCaptureStatus } from '@ancs/contracts';
import ui from './Monochrome.module.css';

/**
 * N05-02：可见的麦克风采集开关与状态（黑白语义层）。
 * - 监听状态可见、可随时停止；错误原因可辨；
 * - 只做本地电平反馈；真实流式识别待凭据（不宣称已通）。
 */

export interface VoiceCaptureControlProps {
  capture?: MicrophoneCapture;
  disabled?: boolean;
}

function stateText(status: VoiceCaptureStatus): string {
  switch (status.state) {
    case 'IDLE': return '麦克风未开启';
    case 'REQUESTING_PERMISSION': return '等待麦克风授权…';
    case 'CAPTURING': return '采集中';
    case 'DENIED': return '麦克风被拒（请在浏览器设置中允许）';
    case 'UNAVAILABLE': return '此环境不支持麦克风采集';
    case 'ERROR': return `采集错误：${status.lastErrorCode ?? 'UNKNOWN'}`;
  }
}

export function VoiceCaptureControl({ capture, disabled = false }: VoiceCaptureControlProps) {
  const local = useMicrophoneCapture();
  const mic = capture ?? local;
  const busy = mic.status.state === 'REQUESTING_PERMISSION';
  const label = mic.status.listening ? '停止聆听' : busy ? '请求权限中…' : '开始聆听';

  return (
    <div data-testid="voice-capture-control" className={`flex flex-wrap items-center gap-2 p-2 text-xs ${ui['panel']}`}>
      <button
        type="button"
        data-testid="voice-capture-toggle"
        disabled={disabled || busy}
        aria-pressed={mic.status.listening}
        onClick={() => mic.toggle()}
        className={ui['button']}
      >
        {label}
      </button>

      {mic.status.listening ? (
        <span data-testid="voice-capture-listening" role="status" aria-live="polite" className={ui['status']}>● 正在聆听</span>
      ) : null}

      <span data-testid="voice-capture-state" className={ui['mutedText']}>{stateText(mic.status)}</span>

      <span
        data-testid="voice-capture-level"
        role="meter"
        aria-label="输入电平"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={Number(mic.level.toFixed(2))}
        className={ui['inset']}
        style={{ width: '80px', height: '6px', overflow: 'hidden' }}
      >
        <span style={{ display: 'block', height: '100%', width: `${String(Math.round(mic.level * 100))}%`, background: 'var(--ui-fg-primary)' }} />
      </span>

      <span className={ui['mutedText']}>音频仅用于本地反馈；结束会话即停止采集。真实流式识别待凭据。</span>

      {mic.status.state === 'DENIED' || mic.status.state === 'ERROR' ? (
        <span data-testid="voice-capture-error" role="alert" className={ui['notice']}>{stateText(mic.status)}</span>
      ) : null}
    </div>
  );
}
