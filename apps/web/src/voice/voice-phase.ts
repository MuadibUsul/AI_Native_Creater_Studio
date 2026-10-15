/**
 * 语音会话在界面上的阶段（Issue #9）：连接中 / 在听 / 正在识别 / AI 思考中 / AI 正在说 / 出错 / 已结束。
 * 一处计算、一处显示：语音条的标签、画布边缘的反馈与 `data-phase`（供真实浏览器验收测量）都取自这里。
 */

import type { AgentPointer } from '@ancs/contracts';
import type { VoiceState } from './useVoice';

export type VoicePhase = 'off' | 'connecting' | 'listening' | 'recognizing' | 'thinking' | 'speaking' | 'finishing' | 'ended' | 'error';

export function voicePhase(input: {
  state: VoiceState;
  /** 用户正在说（服务端检测到开口，或已有这一句的临时转写） */
  hearing: boolean;
  /** AI 的语音回应正在出声 */
  aiSpeaking: boolean;
  /** AI 在处理（一轮在跑、有排队的话、或语音回应在准备） */
  aiWorking: boolean;
}): VoicePhase {
  switch (input.state) {
    case 'off':
    case 'connecting':
    case 'finishing':
    case 'ended':
    case 'error':
      return input.state;
    default:
  }
  // 用户开口优先：开口即打断 AI 的语音回应
  if (input.hearing) return 'recognizing';
  if (input.aiSpeaking) return 'speaking';
  if (input.aiWorking) return 'thinking';
  return 'listening';
}

/** 排队等待发给 AI 的一句话（AI 还在处理上一句时说的）。id = 网关的句子 id，同时作为这一轮的幂等键：重试不会重复执行。 */
export interface QueuedUtterance {
  id: string;
  text: string;
  /** 说这句话时绑定的指向（网关按说出"这里"那一刻解析） */
  pointer: AgentPointer;
  /** 发出失败的原因（已本地化）；失败的句子停在队首，等用户重试或丢弃，不自动重发 */
  failed: string | null;
}
