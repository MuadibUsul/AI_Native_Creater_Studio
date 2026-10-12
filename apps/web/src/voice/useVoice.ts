'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  REALTIME_SAMPLE_RATE,
  REALTIME_VOICE_PATH,
  realtimeServerMessageSchema,
  type AgentLocale,
  type AgentPointer,
  type RealtimeAttention,
} from '@ancs/contracts';
import { describeError } from '@/lib/errors';
import { useAncsClient } from '@/lib/client';

/**
 * V6-2 实时语音（浏览器侧）：麦克风 → AudioWorklet 重采样为 16 kHz PCM16 → Realtime Gateway。
 *
 * - 开麦前向 API 申请语音会话（需要编辑权限），只拿到短期凭证；Provider Key 不在浏览器；
 * - 音频时钟 = 已发送的采样数；每次选择或播放位置变化都带着这个时钟发一条指向样本，
 *   网关据此把"这个/这里"绑定到说出那一刻的指向；
 * - 一句话说完（网关断句）→ onUtterance：调用方把它当作一轮对话发出（与打字同一路径）；
 * - 用户开口（出现转写）→ onSpeechStart：调用方立刻停掉 AI 的朗读（打断）。
 */

export type VoiceState = 'off' | 'connecting' | 'listening' | 'finishing' | 'error';
export type VoiceErrorCode = 'UNSUPPORTED' | 'PERMISSION_DENIED' | 'NOT_CONFIGURED' | 'FORBIDDEN' | 'CONNECTION_FAILED' | 'ASR_FAILED';

export interface VoiceUtterance {
  text: string;
  attention: RealtimeAttention;
}

const POINTER_PLAYHEAD_STEP_SECONDS = 0.25;

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

export function useVoice(options: {
  workspaceId: string;
  projectId: string;
  locale: AgentLocale;
  onUtterance: (utterance: VoiceUtterance) => void;
  onSpeechStart?: () => void;
}) {
  const client = useAncsClient();
  const [state, setState] = useState<VoiceState>('off');
  const [error, setError] = useState<VoiceErrorCode | null>(null);
  const [partial, setPartial] = useState('');
  const [held, setHeld] = useState(false);
  const [attention, setAttention] = useState<RealtimeAttention | null>(null);
  const [asr, setAsr] = useState<{ providerId: string; implementation: string } | null>(null);
  const [level, setLevel] = useState(0);

  const socketRef = useRef<WebSocket | null>(null);
  const audioRef = useRef<{ context: AudioContext; stream: MediaStream; node: AudioWorkletNode } | null>(null);
  const samplesRef = useRef(0);
  const lastPointerRef = useRef<{ key: string; playhead: number | null } | null>(null);
  const callbacks = useRef(options);
  callbacks.current = options;

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio === null) return;
    audio.node.port.onmessage = null;
    audio.node.disconnect();
    for (const track of audio.stream.getTracks()) track.stop();
    void audio.context.close().catch(() => undefined);
  }, []);

  const fail = useCallback((code: VoiceErrorCode) => {
    setError(code);
    setState('error');
    releaseAudio();
    const socket = socketRef.current;
    socketRef.current = null;
    if (socket !== null && socket.readyState <= WebSocket.OPEN) socket.close();
  }, [releaseAudio]);

  const start = useCallback(async () => {
    if (socketRef.current !== null) return;
    setError(null);
    setPartial('');
    setHeld(false);
    setAttention(null);
    if (typeof navigator === 'undefined' || navigator.mediaDevices?.getUserMedia === undefined || typeof AudioWorkletNode === 'undefined') { fail('UNSUPPORTED'); return; }
    setState('connecting');
    let stream: MediaStream;
    try {
      // 回声消除：AI 的朗读与片中声音不应被当成用户的话（V4 §8.3）
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
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      const parsed = realtimeServerMessageSchema.safeParse(JSON.parse(event.data));
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.type === 'ready') {
        ready = true;
        setAsr({ providerId: message.asr.providerId, implementation: message.asr.implementation });
        void startAudio(stream, socket).then(() => setState('listening'), () => fail('UNSUPPORTED'));
      } else if (message.type === 'transcript') {
        if (!message.isFinal) callbacks.current.onSpeechStart?.();
        setPartial(message.text);
      } else if (message.type === 'attention') {
        setAttention(message.attention);
      } else if (message.type === 'held') {
        setHeld(true);
      } else if (message.type === 'utterance') {
        setHeld(false);
        setPartial('');
        setAttention(message.attention);
        callbacks.current.onUtterance({ text: message.text, attention: message.attention });
      } else if (message.type === 'error') {
        fail(message.code === 'ASR_NOT_CONFIGURED' ? 'NOT_CONFIGURED' : 'ASR_FAILED');
      }
    };
    socket.onerror = () => { if (!ready) fail('CONNECTION_FAILED'); };
    socket.onclose = () => {
      if (socketRef.current === socket) socketRef.current = null;
      releaseAudio();
      setState((current) => (current === 'error' ? current : 'off'));
      setPartial('');
      setHeld(false);
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
        setLevel(event.data.level);
      };
      source.connect(node);
      audioRef.current = { context, stream: media, node };
    }
  }, [client, fail, releaseAudio]);

  /** 关麦：网关把最后一句收尾后关闭连接 */
  const stop = useCallback(() => {
    const socket = socketRef.current;
    releaseAudio();
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'end' }));
      setState('finishing');
    } else {
      setState('off');
    }
  }, [releaseAudio]);

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
    releaseAudio();
    socketRef.current?.close();
    socketRef.current = null;
  }, [releaseAudio]);

  return { state, error, partial, held, attention, asr, level, start, stop, notePointer, active: state === 'connecting' || state === 'listening' || state === 'finishing' };
}
