import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  ApiFailure,
  REALTIME_CLOSE_CODES,
  REALTIME_SAMPLE_RATE,
  REALTIME_VOICE_PATH,
  originOf,
  realtimeClientMessageSchema,
  type RealtimePointerSample,
  type RealtimeServerMessage,
  type RealtimeWord,
  type StreamingAsrSession,
  type StreamingSpeechRecognizer,
} from '@ancs/contracts';
import { bindAttention, isUnclosedUtterance, joinTranscript, verifyVoiceSessionCredential, type DomainDeps } from '@ancs/domain';

/**
 * V6-2 Realtime Gateway：浏览器的麦克风音频 → 流式语音识别 → 边说边出的转写 + 按发话时刻绑定的指向 →
 * 一句话说完交还给浏览器（浏览器把它当作一轮对话发给 AI，权限、幂等与预算仍走 API）。
 *
 * - 鉴权：只认 API 签发的语音会话短期凭证（同一把 ANCS_VOICE_SESSION_SECRET）；浏览器来源必须在白名单内；
 * - 网关不读写工程、不调用 AI、不采用任何东西；长期 Provider Key 只在本进程；
 * - 一句话以未闭合的词结尾（"但是/不对/除了…"）先保留，等后半句（最多 holdMs）。
 */

const MAX_POINTER_SAMPLES = 4000;
const START_TIMEOUT_MS = 10_000;

export interface RealtimeGatewayOptions {
  deps: DomainDeps;
  recognizer?: StreamingSpeechRecognizer;
  /** 允许的浏览器来源（完整 origin）；没有 Origin 头的非浏览器客户端不受此限 */
  allowedOrigins: readonly string[];
  /** 未说完的话最多等多久（毫秒，缺省 4000） */
  holdMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface RealtimeGateway {
  /** 挂到 HTTP 服务器上：接管 REALTIME_VOICE_PATH 的升级请求；exclusive = 其他路径的升级一律 404 */
  attach(server: Server, options?: { exclusive?: boolean }): void;
  close(): Promise<void>;
}

function reject(socket: Duplex, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${String(status)} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export function createRealtimeGateway(options: RealtimeGatewayOptions): RealtimeGateway {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const allowed = new Set(options.allowedOrigins.map((origin) => origin.replace(/\/+$/, '').toLowerCase()));
  const log = options.log ?? (() => undefined);
  const holdMs = options.holdMs ?? 4000;

  const exclusiveServers = new WeakSet<Server>();
  const onUpgrade = function (this: Server, request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(request.url ?? '/', 'http://gateway');
    if (url.pathname !== REALTIME_VOICE_PATH) {
      if (exclusiveServers.has(this)) reject(socket, 404, 'Not Found');
      return; // 其他路径交给别的处理器
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !allowed.has(originOf(origin) ?? '')) { reject(socket, 403, 'Forbidden'); return; }
    const sessionId = url.searchParams.get('session') ?? '';
    const token = url.searchParams.get('token') ?? undefined;
    verifyVoiceSessionCredential(options.deps, { sessionId, token }).then(
      (scope) => wss.handleUpgrade(request, socket, head, (ws) => handleConnection(ws, scope)),
      (error: unknown) => {
        const status = error instanceof ApiFailure ? error.httpStatus : 500;
        log('rejected', { status });
        reject(socket, status === 409 ? 409 : status === 501 ? 501 : 401, status === 409 ? 'Conflict' : status === 501 ? 'Not Implemented' : 'Unauthorized');
      },
    );
  };

  function handleConnection(ws: WebSocket, scope: { workspaceId: string; projectId: string; sessionId: string }) {
    const send = (message: RealtimeServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    let locale: 'zh-CN' | 'en' = 'zh-CN';
    let asr: StreamingAsrSession | null = null;
    let started = false;
    let ending = false;
    const samples: RealtimePointerSample[] = [];
    let utterance: { id: string; finals: string[]; words: RealtimeWord[]; partial: string; partialWords: RealtimeWord[]; start: number; revision: number; hold: NodeJS.Timeout | null } | null = null;
    const startTimer = setTimeout(() => { if (!started) ws.close(REALTIME_CLOSE_CODES.PROTOCOL_ERROR, 'start message expected'); }, START_TIMEOUT_MS);

    const currentText = () => (utterance === null ? '' : joinTranscript([...utterance.finals, utterance.partial], locale));
    const attentionNow = () => bindAttention({
      words: utterance === null ? [] : [...utterance.words, ...utterance.partialWords],
      samples, sampleRate: REALTIME_SAMPLE_RATE, locale, utteranceStart: utterance?.start ?? 0,
    });

    const deliver = () => {
      if (utterance === null) return;
      const current = utterance;
      if (current.hold !== null) clearTimeout(current.hold);
      const text = joinTranscript(current.finals, locale);
      utterance = null;
      if (text.length === 0) return;
      const attention = bindAttention({ words: current.words, samples, sampleRate: REALTIME_SAMPLE_RATE, locale, utteranceStart: current.start });
      send({ type: 'transcript', utteranceId: current.id, revision: current.revision + 1, text, isFinal: true });
      send({ type: 'utterance', utteranceId: current.id, text, attention });
      log('utterance', { session: scope.sessionId, evidence: attention.evidence, characters: text.length });
    };

    /** 一句话说完（服务端端点 / UtteranceEnd / 关麦）：未闭合就先保留，等后半句 */
    const finalize = (force: boolean) => {
      if (utterance === null || utterance.finals.length === 0) return;
      const text = joinTranscript(utterance.finals, locale);
      if (!force && isUnclosedUtterance(text, locale)) {
        if (utterance.hold === null) {
          send({ type: 'held', utteranceId: utterance.id, text });
          utterance.hold = setTimeout(() => deliver(), holdMs);
        }
        return;
      }
      deliver();
    };

    const openAsr = async () => {
      if (options.recognizer === undefined) {
        send({ type: 'error', code: 'ASR_NOT_CONFIGURED', message: 'speech recognition is not configured on the server', retryable: false });
        ws.close(REALTIME_CLOSE_CODES.ASR_UNAVAILABLE, 'speech recognition not configured');
        return;
      }
      try {
        asr = await options.recognizer.open({ locale, sampleRate: REALTIME_SAMPLE_RATE }, {
          onResult(result) {
            if (result.text.trim().length === 0 && !result.speechFinal) return;
            if (utterance === null) {
              if (result.text.trim().length === 0) return;
              utterance = { id: `utt_${randomUUID()}`, finals: [], words: [], partial: '', partialWords: [], start: result.words[0]?.start ?? result.start, revision: 0, hold: null };
            } else if (utterance.hold !== null && result.text.trim().length > 0) {
              // 后半句来了：取消等待，继续同一句
              clearTimeout(utterance.hold);
              utterance.hold = null;
            }
            if (result.isFinal) {
              if (result.text.trim().length > 0) { utterance.finals.push(result.text); utterance.words.push(...result.words); }
              utterance.partial = '';
              utterance.partialWords = [];
            } else {
              utterance.partial = result.text;
              utterance.partialWords = result.words;
            }
            utterance.revision += 1;
            send({ type: 'transcript', utteranceId: utterance.id, revision: utterance.revision, text: currentText(), isFinal: false });
            send({ type: 'attention', utteranceId: utterance.id, attention: attentionNow() });
            if (result.speechFinal) finalize(false);
          },
          onUtteranceEnd() { finalize(false); },
          onError(error) { send({ type: 'error', code: error.code, message: error.message, retryable: error.retryable }); },
          onClose() {
            finalize(true);
            if (ending && ws.readyState === ws.OPEN) ws.close(1000, 'done');
          },
        });
        send({ type: 'ready', asr: { providerId: options.recognizer.providerId, implementation: options.recognizer.implementation, model: options.recognizer.model } });
      } catch (error) {
        const detail = error as { code?: unknown; message?: unknown; retryable?: unknown };
        send({ type: 'error', code: typeof detail.code === 'string' ? detail.code : 'ASR_CONNECT_FAILED', message: 'could not start speech recognition', retryable: detail.retryable !== false });
        ws.close(REALTIME_CLOSE_CODES.ASR_UNAVAILABLE, 'speech recognition unavailable');
      }
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (asr !== null && !ending) asr.sendAudio(new Uint8Array(data as Buffer));
        return;
      }
      let parsed;
      try { parsed = realtimeClientMessageSchema.safeParse(JSON.parse(data.toString())); } catch { parsed = null; }
      if (parsed === null || !parsed.success) { ws.close(REALTIME_CLOSE_CODES.PROTOCOL_ERROR, 'invalid message'); return; }
      const message = parsed.data;
      if (message.type === 'start') {
        if (started) return;
        started = true;
        clearTimeout(startTimer);
        locale = message.locale;
        void openAsr();
      } else if (message.type === 'pointer') {
        samples.push(message.sample);
        if (samples.length > MAX_POINTER_SAMPLES) samples.splice(0, samples.length - MAX_POINTER_SAMPLES);
      } else if (message.type === 'end') {
        ending = true;
        if (asr === null) ws.close(1000, 'done');
        else asr.finish();
      }
      // stop-speaking：AI 的语音回应目前由浏览器朗读，本地已停播；网关没有未播放的服务端音频需要丢弃
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      if (utterance?.hold) clearTimeout(utterance.hold);
      asr?.close();
    });
    log('connected', { session: scope.sessionId });
  }

  const servers = new Set<Server>();
  return {
    attach(server, attachOptions) {
      servers.add(server);
      if (attachOptions?.exclusive === true) exclusiveServers.add(server);
      server.on('upgrade', onUpgrade);
    },
    close: () => new Promise<void>((done) => {
      for (const server of servers) server.off('upgrade', onUpgrade);
      for (const client of wss.clients) client.terminate();
      wss.close(() => done());
    }),
  };
}
