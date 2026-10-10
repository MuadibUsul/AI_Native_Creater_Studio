'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { voiceCaptureStatusSchema, type VoiceCaptureConstraints, type VoiceCaptureStatus } from '@ancs/contracts';

/**
 * N05-02：浏览器麦克风采集（协议与本地反馈，不接 Provider）。
 *
 * - 必须**显式授权**后采集；状态可见（监听中/被拒/不可用/错误）；
 * - 离开/停止会话立即停止采集并释放资源（最小保留，不默认永久采集）；
 * - 本地只做电平反馈（AudioWorklet 的轻量替代此处用 AnalyserNode），**不做上传/推理**；
 * - 真实流式 ASR/VAD 传输未接入（无凭据）→ 本 hook 不代表"真实语音已通"。
 */

export interface MicrophoneCapture {
  status: VoiceCaptureStatus;
  /** 本地电平 0..1（仅供本地反馈，不是识别结果）。 */
  level: number;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => void;
}

type AudioContextLike = {
  createMediaStreamSource: (stream: MediaStream) => { connect: (node: unknown) => void };
  createAnalyser: () => { fftSize: number; frequencyBinCount: number; getByteTimeDomainData: (array: Uint8Array) => void };
  close: () => Promise<void>;
};

type AudioContextCtor = new () => AudioContextLike;

const resolveAudioContextCtor = (): AudioContextCtor | null => {
  const globalObject = globalThis as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
  return globalObject.AudioContext ?? globalObject.webkitAudioContext ?? null;
};

const idleStatus = (): VoiceCaptureStatus =>
  voiceCaptureStatusSchema.parse({ state: 'IDLE', listening: false, visible: true, startedAtMonotonicMs: null, lastErrorCode: null });

export function useMicrophoneCapture(constraints: VoiceCaptureConstraints = { sampleRate: 16_000, channelCount: 1 }): MicrophoneCapture {
  const [status, setStatus] = useState<VoiceCaptureStatus>(idleStatus);
  const [level, setLevel] = useState(0);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContextLike | null>(null);
  const frameRef = useRef<number | null>(null);

  const stop = useCallback((): void => {
    if (frameRef.current !== null) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = contextRef.current;
    contextRef.current = null;
    if (context !== null) void context.close().catch(() => undefined);
    setLevel(0);
    setStatus(idleStatus());
  }, []);

  const start = useCallback(async (): Promise<void> => {
    if (streamRef.current !== null) return;
    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') {
      setStatus(voiceCaptureStatusSchema.parse({ state: 'UNAVAILABLE', listening: false, visible: true, startedAtMonotonicMs: null, lastErrorCode: 'MEDIA_DEVICES_UNAVAILABLE' }));
      return;
    }
    setStatus(voiceCaptureStatusSchema.parse({ state: 'REQUESTING_PERMISSION', listening: false, visible: true, startedAtMonotonicMs: null, lastErrorCode: null }));
    let stream: MediaStream;
    try {
      stream = await mediaDevices.getUserMedia({ audio: { channelCount: constraints.channelCount, sampleRate: constraints.sampleRate } });
    } catch (error) {
      // 浏览器抛 DOMException（未必 instanceof Error）；按 .name 判别，避免把权限拒绝误报为未知错误。
      const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : 'UNKNOWN';
      const denied = name === 'NotAllowedError' || name === 'SecurityError';
      setStatus(voiceCaptureStatusSchema.parse({
        state: denied ? 'DENIED' : 'ERROR',
        listening: false,
        visible: true,
        startedAtMonotonicMs: null,
        lastErrorCode: name,
      }));
      return;
    }
    streamRef.current = stream;
    const Ctor = resolveAudioContextCtor();
    if (Ctor !== null) {
      try {
        const context = new Ctor();
        const source = context.createMediaStreamSource(stream);
        const analyser = context.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        contextRef.current = context;
        const buffer = new Uint8Array(analyser.frequencyBinCount);
        const tick = (): void => {
          analyser.getByteTimeDomainData(buffer);
          let sum = 0;
          for (const value of buffer) {
            const normalized = (value - 128) / 128;
            sum += normalized * normalized;
          }
          setLevel(Math.min(1, Math.sqrt(sum / buffer.length) * 3));
          frameRef.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : null;
        };
        frameRef.current = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tick) : null;
      } catch {
        // 电平反馈失败不影响采集本身（仍可采集，只是没有本地电平）。
        contextRef.current = null;
      }
    }
    setStatus(voiceCaptureStatusSchema.parse({
      state: 'CAPTURING',
      listening: true,
      visible: true,
      startedAtMonotonicMs: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
      lastErrorCode: null,
    }));
  }, [constraints.channelCount, constraints.sampleRate]);

  const toggle = useCallback((): void => {
    if (status.listening) stop();
    else void start();
  }, [start, status.listening, stop]);

  useEffect(() => () => stop(), [stop]);

  return { status, level, start, stop, toggle };
}
