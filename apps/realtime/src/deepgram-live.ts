import WebSocket from 'ws';
import type { RealtimeWord, StreamingAsrEvents, StreamingAsrSession, StreamingSpeechRecognizer } from '@ancs/contracts';

/**
 * Deepgram 流式语音识别适配器（**真实 Provider**，V6-2）。协议：`wss://api.deepgram.com/v1/listen`，
 * 二进制帧发 PCM16，服务端回 `Results`（interim / is_final / speech_final）与 `UtteranceEnd`；
 * 空闲时发 `KeepAlive`，收尾发 `CloseStream`。
 *
 * 纪律：密钥只在本进程内存里（请求头），不写日志、不进错误返回；握手失败按 HTTP 状态区分
 * （401/403 = 密钥问题不可重试，429/5xx = 可重试）；字段缺失如实降级（没有词级时间就不给 words）。
 * 真实服务的验证需要 DEEPGRAM_API_KEY（见 docs/V06/integration-checklist.md）；当前证据是本地按同一协议的假服务。
 */

export interface DeepgramLiveOptions {
  apiKey: string;
  /** 覆盖地址（测试注入本地假服务） */
  baseUrl?: string;
  /** 各语言模型（缺省：中文 nova-2，英文 nova-3） */
  models?: { 'zh-CN'?: string; en?: string };
  /** 静音多久算一句话结束（毫秒，缺省 400） */
  endpointingMs?: number;
  /** 没有新词多久发 UtteranceEnd（毫秒，缺省 1000） */
  utteranceEndMs?: number;
  keepAliveMs?: number;
}

interface DeepgramWord { word?: unknown; punctuated_word?: unknown; start?: unknown; end?: unknown }
interface DeepgramMessage {
  type?: unknown;
  start?: unknown;
  duration?: unknown;
  is_final?: unknown;
  speech_final?: unknown;
  last_word_end?: unknown;
  channel?: { alternatives?: { transcript?: unknown; words?: DeepgramWord[] }[] };
}

const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function mapWords(words: DeepgramWord[] | undefined): RealtimeWord[] {
  if (!Array.isArray(words)) return [];
  return words.flatMap((word) => {
    const text = typeof word.punctuated_word === 'string' ? word.punctuated_word : typeof word.word === 'string' ? word.word : null;
    const start = num(word.start);
    const end = num(word.end);
    return text === null || start === null || end === null ? [] : [{ text, start: Math.max(0, start), end: Math.max(0, end) }];
  });
}

export function createDeepgramLiveRecognizer(options: DeepgramLiveOptions): StreamingSpeechRecognizer {
  const models = { 'zh-CN': options.models?.['zh-CN'] ?? 'nova-2', en: options.models?.en ?? 'nova-3' };
  const base = (options.baseUrl ?? 'wss://api.deepgram.com').replace(/\/+$/, '');
  return {
    providerId: 'deepgram',
    implementation: 'REAL',
    model: `${models['zh-CN']}/${models.en}`,
    open: (session, events: StreamingAsrEvents) => new Promise<StreamingAsrSession>((resolve, reject) => {
      const url = new URL(`${base}/v1/listen`);
      const params: Record<string, string> = {
        model: models[session.locale], language: session.locale === 'zh-CN' ? 'zh-CN' : 'en',
        encoding: 'linear16', sample_rate: String(session.sampleRate), channels: '1',
        interim_results: 'true', punctuate: 'true', smart_format: 'true', vad_events: 'true',
        endpointing: String(options.endpointingMs ?? 400), utterance_end_ms: String(options.utteranceEndMs ?? 1000),
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const socket = new WebSocket(url, { headers: { Authorization: `Token ${options.apiKey}` }, handshakeTimeout: 10_000 });
      let opened = false;
      let closed = false;
      let lastAudioAt = Date.now();
      const keepAlive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN && Date.now() - lastAudioAt >= (options.keepAliveMs ?? 4000)) socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }, Math.min(options.keepAliveMs ?? 4000, 4000));
      const finish = () => { if (!closed) { closed = true; clearInterval(keepAlive); events.onClose(); } };

      socket.on('unexpected-response', (_request, response) => {
        const status = response.statusCode ?? 0;
        const failure = { code: status === 401 || status === 403 ? 'ASR_AUTH_FAILED' : status === 429 ? 'ASR_RATE_LIMITED' : 'ASR_CONNECT_FAILED', message: `speech recognition service rejected the connection (${String(status)})`, retryable: !(status === 401 || status === 403 || status === 400) };
        response.resume();
        clearInterval(keepAlive);
        if (!opened) reject(Object.assign(new Error(failure.message), failure));
      });
      socket.on('error', (error) => {
        if (!opened) { clearInterval(keepAlive); reject(Object.assign(new Error('could not reach the speech recognition service'), { code: 'ASR_CONNECT_FAILED', retryable: true, cause: error.message })); return; }
        events.onError({ code: 'ASR_STREAM_FAILED', message: 'speech recognition stream failed', retryable: true });
      });
      socket.on('close', finish);
      socket.on('message', (data, isBinary) => {
        if (isBinary) return;
        let message: DeepgramMessage;
        try { message = JSON.parse(data.toString()) as DeepgramMessage; } catch { return; }
        if (message.type === 'Results') {
          const alternative = message.channel?.alternatives?.[0];
          events.onResult({
            start: num(message.start) ?? 0,
            duration: num(message.duration) ?? 0,
            text: typeof alternative?.transcript === 'string' ? alternative.transcript : '',
            words: mapWords(alternative?.words),
            isFinal: message.is_final === true,
            speechFinal: message.speech_final === true,
          });
        } else if (message.type === 'UtteranceEnd') {
          events.onUtteranceEnd(num(message.last_word_end));
        }
      });
      socket.on('open', () => {
        opened = true;
        resolve({
          sendAudio(chunk) {
            if (socket.readyState !== WebSocket.OPEN) return;
            lastAudioAt = Date.now();
            socket.send(chunk);
          },
          finish() {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'CloseStream' }));
          },
          close() {
            clearInterval(keepAlive);
            if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
          },
        });
      });
    }),
  };
}
