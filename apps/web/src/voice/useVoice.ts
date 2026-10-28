'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REALTIME_CLOSE_CODES,
  REALTIME_SAMPLE_RATE,
  REALTIME_VOICE_PATH,
  realtimeServerMessageSchema,
  type AgentLocale,
  type AgentPointer,
  type RealtimeAttention,
  type RealtimeServerMessage,
  type RealtimeVoice,
} from '@ancs/contracts';
import { describeError } from '@/lib/errors';
import { useAncsClient } from '@/lib/client';
import { ReplyPlayer, type ReplyPlaybackState } from './reply-player';

/**
 * V6-2 / Issue #9 实时语音（浏览器侧）：麦克风 → AudioWorklet 重采样为 16 kHz PCM16 → Realtime Gateway，一直开着直到用户结束。
 *
 * - 开麦前向 API 申请语音会话（需要编辑权限），只拿到短期凭证；Provider Key 不在浏览器；
 * - 音频时钟 = 已发送的采样数；每次选择或播放位置变化都带着这个时钟发一条指向样本，网关据此把"这个/这里"绑定到说出那一刻的指向；
 * - 一句话说完（网关断句）→ onUtterance：调用方把它当作一轮对话发出（与打字同一路径）；
 * - 用户开口（网关的 speech-start，或出现临时转写）→ 立刻停播 AI 的语音回应（打断）并通知调用方；
 * - AI 的语音回应：`speak(turnId)` 只把这一轮的 id 交给网关，网关读回应文字并边合成边下发；没配置服务端合成时返回 false，调用方退回浏览器朗读；
 * - 断线、凭证过期、识别服务失败都明确报出，**不自动重连**（重新连接要用户点）；已经交出去的话不会因重连而重复执行。
 */

export type VoiceState = 'off' | 'connecting' | 'listening' | 'finishing' | 'ended' | 'error';
export type VoiceErrorCode =
  | 'UNSUPPORTED'
  | 'PERMISSION_DENIED'
  | 'NOT_CONFIGURED'
  | 'FORBIDDEN'
  | 'CONNECTION_FAILED'
  | 'CONNECTION_LOST'
  | 'SESSION_EXPIRED'
  | 'PROVIDER_AUTH'
  | 'ASR_FAILED';
/** 不结束会话的一次性提示：这一句没听成（识别服务暂时失败）/ 语音回应没念出来 */
export type VoiceNoticeCode = 'SAY_AGAIN' | 'REPLY_FAILED' | 'IDLE_STOPPED';

export interface VoiceUtterance {
  utteranceId: string;
  text: string;
  attention: RealtimeAttention;
}

export interface VoiceTts {
  providerId: string;
  implementation: 'REAL' | 'MOCK' | 'SCRIPTED';
  voices: RealtimeVoice[];
}

const POINTER_PLAYHEAD_STEP_SECONDS = 0.25;
const ENDED_VISIBLE_MS = 2500;
const VOICE_CHOICE_KEY = 'ancs.voice.replyVoice';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace -- Node 的环境变量类型只能这样扩展
  namespace NodeJS {
    interface ProcessEnv {
      /** 网关不与 Web 同源时的地址（构建期内联；须用点号访问 Next 才会替换） */
      NEXT_PUBLIC_ANCS_REALTIME_URL?: string;
    }
  }
}

function gatewayUrl(sessionId: string, token: string): string {
  const configured = process.env.NEXT_PUBLIC_ANCS_REALTIME_URL;
  const base = configured !== undefined && configured !== ''
    ? configured.replace(/\/+$/, '')
    : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}${REALTIME_VOICE_PATH}`;
  return `${base}?session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(token)}`;
}

/** 网关报的错误 → 界面上的原因；retryable 的只提示"再说一次"，不结束会话 */
export function voiceErrorFromServer(message: Extract<RealtimeServerMessage, { type: 'error' }>): { fatal: VoiceErrorCode } | { notice: VoiceNoticeCode } {
  if (message.code === 'ASR_NOT_CONFIGURED') return { fatal: 'NOT_CONFIGURED' };
  if (message.code === 'SESSION_EXPIRED') return { fatal: 'SESSION_EXPIRED' };
  if (message.code === 'ASR_AUTH_FAILED') return { fatal: 'PROVIDER_AUTH' };
  if (message.retryable) return { notice: 'SAY_AGAIN' };
  return { fatal: 'ASR_FAILED' };
}

/** 连接关闭 → 原因（用户自己结束的不算错误） */
export function voiceErrorFromClose(code: number, ready: boolean): VoiceErrorCode {
  if (code === REALTIME_CLOSE_CODES.CREDENTIAL_INVALID) return 'SESSION_EXPIRED';
  if (code === REALTIME_CLOSE_CODES.ASR_UNAVAILABLE) return ready ? 'ASR_FAILED' : 'NOT_CONFIGURED';
  return ready ? 'CONNECTION_LOST' : 'CONNECTION_FAILED';
}

function readVoiceChoice(): string | null {
  try { return window.localStorage.getItem(VOICE_CHOICE_KEY); } catch { return null; }
}
function saveVoiceChoice(voiceId: string): void {
  try { window.localStorage.setItem(VOICE_CHOICE_KEY, voiceId); } catch { /* 存不了就只在本页面内生效 */ }
}

/** 一直开着时，这么久没人说话、AI 也没在忙或说话，就停止收音（语音识别按时长计费） */
export const VOICE_IDLE_STOP_MS = 3 * 60_000;

/** 现在是不是"空等"：在听、没人在说、没有半句、AI 没在说也没在忙 */
export function voiceIdle(input: { state: VoiceState; hearing: boolean; partial: string; replyState: ReplyPlaybackState; busy: boolean }): boolean {
  return input.state === 'listening' && !input.hearing && input.partial === '' && input.replyState === 'idle' && !input.busy;
}

export function useVoice(options: {
  workspaceId: string;
  projectId: string;
  locale: AgentLocale;
  onUtterance: (utterance: VoiceUtterance) => void;
  onSpeechStart?: () => void;
  /** AI 正在处理（这一轮进行中或有排队的话）：空等计时暂停 */
  busy?: boolean;
  /** 空等多久后停止收音（缺省 3 分钟） */
  idleStopMs?: number;
}) {
  const client = useAncsClient();
  const [state, setState] = useState<VoiceState>('off');
  const [error, setError] = useState<VoiceErrorCode | null>(null);
  const [notice, setNotice] = useState<VoiceNoticeCode | null>(null);
  const [partial, setPartial] = useState('');
  const [hearing, setHearing] = useState(false);
  const [held, setHeld] = useState(false);
  const [attention, setAttention] = useState<RealtimeAttention | null>(null);
  const [asr, setAsr] = useState<{ providerId: string; implementation: string } | null>(null);
  const [tts, setTts] = useState<VoiceTts | null>(null);
  const [voiceId, setVoiceIdState] = useState<string | null>(null);
  const [reply, setReply] = useState<{ state: ReplyPlaybackState; turnId: string | null }>({ state: 'idle', turnId: null });

  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null>(null);
  /** 麦克风电平（0–1）：放在 ref 里由电平条自己按帧读取，不让整个工作室每 20 ms 重渲染一次 */
  const levelRef = useRef(0);
  const samplesRef = useRef(0);
  const lastPointerRef = useRef<{ key: string; playhead: number | null } | null>(null);
  const endingRef = useRef(false);
  const hearingRef = useRef(false);
  hearingRef.current = hearing;
  const endedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;
  const playerRef = useRef<ReplyPlayer | null>(null);
  if (playerRef.current === null) {
    playerRef.current = new ReplyPlayer(() => audioRef.current?.context ?? null, (next, turnId) => setReply({ state: next, turnId }));
  }
  const player = playerRef.current;

  const releaseAudio = useCallback(() => {
    player.stop();
    const audio = audioRef.current;
    audioRef.current = null;
    levelRef.current = 0;
    if (audio === null) return;
    audio.node.port.onmessage = null;
    audio.node.disconnect();
    for (const track of audio.stream.getTracks()) track.stop();
    void audio.context.close().catch(() => undefined);
  }, [player]);

  const resetUtterance = useCallback(() => {
    setPartial('');
    setHeld(false);
    setHearing(false);
  }, []);

  const fail = useCallback((code: VoiceErrorCode) => {
    setError(code);
    setState('error');
    resetUtterance();
    releaseAudio();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close();
  }, [releaseAudio, resetUtterance]);

  const start = useCallback(async () => {
    if (socketRef.current !== null) return;
    if (endedTimer.current !== null) clearTimeout(endedTimer.current);
    endingRef.current = false;
    setError(null);
    setNotice(null);
    resetUtterance();
    setAttention(null);
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined || typeof AudioWorkletNode === 'undefined') { fail('UNSUPPORTED'); return; }
    setState('connecting');
    let stream: MediaStream;
    try {
      // 回声消除：AI 的语音回应与片中声音不应被当成用户的话（V4 §8.3）
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch {
      fail('PERMISSION_DENIED');
      return;
    }
    let credential: { sessionId: string; token: string };
    try {
      const created = await client.projects.createVoiceSession(callbacks.current.workspaceId, callbacks.current.projectId, {}, { idempotencyKey: `voice-${globalThis.crypto.randomUUID()}` });
      credential = { sessionId: created.session.sessionId, token: created.credential.token };
    } catch (caught) {
      for (const track of stream.getTracks()) track.stop();
      const described = describeError(caught);
      fail(described.kind === 'forbidden' ? 'FORBIDDEN' : described.status === 501 ? 'NOT_CONFIGURED' : 'CONNECTION_FAILED');
      return;
    }

    const socket = new WebSocket(gatewayUrl(credential.sessionId, credential.token));
    socket.binaryType = 'arraybuffer';
    socketRef.current = socket;
    samplesRef.current = 0;
    lastPointerRef.current = null;
    let ready = false;
    socket.onopen = () => socket.send(JSON.stringify({ type: 'start', locale: callbacks.current.locale, sampleRate: REALTIME_SAMPLE_RATE }));
    socket.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data instanceof ArrayBuffer) { player.push(event.data); return; }
      if (typeof event.data !== 'string') return;
      const parsed = realtimeServerMessageSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      const message = parsed.data;
      switch (message.type) {
        case 'ready': {
          ready = true;
          setAsr({ providerId: message.asr.providerId, implementation: message.asr.implementation });
          const voices = message.tts?.voices ?? [];
          setTts(message.tts === null ? null : { providerId: message.tts.providerId, implementation: message.tts.implementation, voices });
          const remembered = readVoiceChoice();
          setVoiceIdState(voices.find((voice) => voice.id === remembered)?.id ?? voices[0]?.id ?? null);
          void startAudio(stream, socket).then(() => setState('listening'), () => fail('UNSUPPORTED'));
          return;
        }
        case 'speech-start':
          player.stop();
          setHearing(true);
          setAttention(null); // 新的一句：不再显示上一句绑定的指向
          callbacks.current.onSpeechStart?.();
          return;
        case 'transcript':
          if (!message.isFinal && message.text !== '') {
            if (!hearingRef.current) { player.stop(); callbacks.current.onSpeechStart?.(); }
            setHearing(true);
          }
          if (message.isFinal && message.text === '') { resetUtterance(); return; }
          setPartial(message.text);
          return;
        case 'attention':
          setAttention(message.attention);
          return;
        case 'held':
          setHeld(true);
          return;
        case 'utterance':
          resetUtterance();
          setAttention(null);
          callbacks.current.onUtterance({ utteranceId: message.utteranceId, text: message.text, attention: message.attention });
          return;
        case 'reply-start':
          player.begin(message.turnId, message.sampleRate);
          return;
        case 'reply-end':
          player.end(message.turnId);
          if (message.reason === 'failed') setNotice('REPLY_FAILED');
          return;
        case 'error': {
          const mapped = voiceErrorFromServer(message);
          if ('fatal' in mapped) fail(mapped.fatal);
          else { resetUtterance(); setNotice(mapped.notice); }
          return;
        }
        default:
      }
    };
    socket.onerror = () => { if (!ready) fail('CONNECTION_FAILED'); };
    socket.onclose = (event?: CloseEvent) => {
      const current = socketRef.current === socket;
      if (current) socketRef.current = null;
      releaseAudio();
      resetUtterance();
      if (!current) return;
      if (endingRef.current) {
        setState('ended');
        endedTimer.current = setTimeout(() => setState((now) => (now === 'ended' ? 'off' : now)), ENDED_VISIBLE_MS);
        return;
      }
      const code = voiceErrorFromClose(event?.code ?? 1006, ready);
      setError((existing) => existing ?? code);
      setState('error');
    };

    async function startAudio(media: MediaStream, target: WebSocket) {
      const context = new AudioContext();
      await context.audioWorklet.addModule('/audio/pcm-capture-worklet.js');
      const source = context.createMediaStreamSource(media);
      const node = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 });
      node.port.onmessage = (event: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
        if (target.readyState !== WebSocket.OPEN) return;
        target.send(event.data.pcm);
        samplesRef.current += event.data.pcm.byteLength / 2;
        levelRef.current = event.data.level;
      };
      source.connect(node);
      audioRef.current = { context, stream: media, node };
    }
  }, [client, fail, releaseAudio, resetUtterance, player]);

  /** 结束语音：网关把最后一句收尾后关闭连接；AI 的语音回应立即停 */
  const stop = useCallback(() => {
    const socket = socketRef.current;
    endingRef.current = true;
    releaseAudio();
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end' }));
      setState('finishing');
    } else {
      socketRef.current = null;
      resetUtterance();
      setState('off');
    }
  }, [releaseAudio, resetUtterance]);

  // 空等太久自动停止收音（省识别费用），如实提示；有人说话、AI 在忙或在说时重新计时
  const idle = voiceIdle({ state, hearing, partial, replyState: reply.state, busy: options.busy === true });
  const idleStopMs = options.idleStopMs ?? VOICE_IDLE_STOP_MS;
  useEffect(() => {
    if (!idle) return;
    const timer = setTimeout(() => { stop(); setNotice('IDLE_STOPPED'); }, idleStopMs);
    return () => clearTimeout(timer);
  }, [idle, idleStopMs, stop]);

  /** 出错或结束后收起（不重连） */
  const dismiss = useCallback(() => {
    if (socketRef.current !== null) return;
    setError(null);
    setState('off');
  }, []);

  /** 念 AI 这一轮的回应（服务端合成）；没配置服务端合成或没连上时返回 false，调用方退回浏览器朗读 */
  const speak = useCallback((turnId: string): boolean => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN || tts === null) return false;
    socket.send(JSON.stringify({ type: 'speak', turnId, voiceId }));
    return true;
  }, [tts, voiceId]);

  /** 停止说话：本地立刻停播，并让网关丢弃没播的部分（不影响 AI 正在做的这一轮、不撤回试改） */
  const stopSpeaking = useCallback(() => {
    player.stop();
    const socket = socketRef.current;
    if (socket !== null && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'stop-speaking' }));
  }, [player]);

  const setVoiceId = useCallback((next: string) => {
    setVoiceIdState(next);
    saveVoiceChoice(next);
  }, []);

  /** 指向变化（选择或播放位置）：带音频时钟发给网关；播放头只在移动超过 0.25 秒时发 */
  const notePointer = useCallback((pointer: AgentPointer, playheadSeconds: number | null, label: string | null) => {
    const socket = socketRef.current;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    const key = JSON.stringify(pointer);
    const last = lastPointerRef.current;
    if (last !== null && last.key === key && (playheadSeconds === null || (last.playhead !== null && Math.abs(last.playhead - playheadSeconds) < POINTER_PLAYHEAD_STEP_SECONDS))) return;
    lastPointerRef.current = { key, playhead: playheadSeconds };
    socket.send(JSON.stringify({
      type: 'pointer',
      sample: { atSample: samplesRef.current, pointer, playhead: playheadSeconds === null ? null : playheadSeconds.toFixed(3), label },
    }));
  }, []);

  useEffect(() => () => {
    if (endedTimer.current !== null) clearTimeout(endedTimer.current);
    releaseAudio();
    socketRef.current?.close();
    socketRef.current = null;
  }, [releaseAudio]);

  return {
    state, error, notice, clearNotice: () => setNotice(null), partial, hearing, held, attention, asr, tts, voiceId, setVoiceId, reply, levelRef,
    start, stop, dismiss, speak, stopSpeaking, notePointer,
    active: state === 'connecting' || state === 'listening' || state === 'finishing',
  };
}
