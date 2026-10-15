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
  type StreamingSpeechSynthesizer,
} from '@ancs/contracts';
import { bindAttention, isUnclosedUtterance, joinTranscript, verifyVoiceSessionCredential, voiceReplyText, voiceSessionGate, type DomainDeps } from '@ancs/domain';

/**
 * V6-2 Realtime Gateway：浏览器的麦克风音频 → 流式语音识别 → 边说边出的转写 + 按发话时刻绑定的指向 →
 * 一句话说完交还给浏览器（浏览器把它当作一轮对话发给 AI，权限、幂等与预算仍走 API）。
 *
 * - 鉴权：只认 API 签发的语音会话短期凭证（同一把 ANCS_VOICE_SESSION_SECRET）；浏览器来源必须在白名单内；
 * - 网关不读写工程、不调用 AI、不采用任何东西；长期 Provider Key 只在本进程；
 * - 一句话以未闭合的词结尾（"但是/不对/除了…"）先保留，等后半句（最多 holdMs）。
 * - AI 的语音回应（Issue #9）：`speak` 只带一轮的 id，回应文字在本会话所属作品里读；边合成边下发，
 *   `stop-speaking` 或用户开口（`speech-start`）立即中止并丢弃未发出的音频。同一时刻只念一轮。
 */

const MAX_POINTER_SAMPLES = 4000;
const START_TIMEOUT_MS = 10_000;

export interface RealtimeGatewayOptions {
  deps: DomainDeps;
  recognizer?: StreamingSpeechRecognizer;
  /** AI 语音回应的合成（不配 = ready.tts 为 null，客户端退回浏览器朗读） */
  synthesizer?: StreamingSpeechSynthesizer;
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

  function handleConnection(ws: WebSocket, scope: { workspaceId: string; projectId: string; sessionId: string; generation: number; expiresAt: Date }) {
    const send = (message: RealtimeServerMessage) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message)); };
    // 会话门（Issue #9）：凭证只在握手时校验；到期那一刻、以及交出每一句话之前复查（过期/撤销/关闭/换代都立刻生效）
    let sessionClosed = false;
    const closeForSession = (reason: string) => {
      if (sessionClosed) return;
      sessionClosed = true;
      stopReply();
      log('session_gate_closed', { session: scope.sessionId, reason });
      send({ type: 'error', code: 'SESSION_EXPIRED', message: 'the voice session has expired or was closed; reconnect to continue', retryable: false });
      if (ws.readyState === ws.OPEN) ws.close(REALTIME_CLOSE_CODES.CREDENTIAL_INVALID, 'voice session expired');
    };
    const expiryTimer = setTimeout(() => closeForSession('VOICE_SESSION_EXPIRED'), Math.max(0, Math.min(scope.expiresAt.getTime() - Date.now(), 2_147_000_000)));
    // 正在念的一轮回应（同一时刻只有一个）；中止 = 停止合成、不再下发
    let reply: { turnId: string; controller: AbortController } | null = null;
    const stopReply = () => { reply?.controller.abort(); };
    const speak = async (turnId: string, voiceId: string | null) => {
      stopReply();
      const synthesizer = options.synthesizer;
      if (synthesizer === undefined) { send({ type: 'reply-end', turnId, reason: 'failed', message: 'speech replies are not configured on the server' }); return; }
      const text = await voiceReplyText(options.deps, { workspaceId: scope.workspaceId, projectId: scope.projectId, turnId }).catch(() => null);
      if (text === null) { send({ type: 'reply-end', turnId, reason: 'failed', message: 'no reply to read for this turn' }); return; }
      const voice = synthesizer.voices.find((item) => item.id === voiceId) ?? synthesizer.voices[0]!;
      const controller = new AbortController();
      const current = { turnId, controller };
      reply = current;
      const started = Date.now();
      let firstChunkMs: number | null = null;
      let bytes = 0;
      send({ type: 'reply-start', turnId, sampleRate: synthesizer.sampleRate, voiceId: voice.id });
      try {
        await synthesizer.synthesize({ text, voiceId: voice.id, locale, signal: controller.signal }, (chunk) => {
          if (controller.signal.aborted || ws.readyState !== ws.OPEN) return;
          if (firstChunkMs === null) firstChunkMs = Date.now() - started;
          bytes += chunk.byteLength;
          ws.send(chunk, { binary: true });
        });
        send({ type: 'reply-end', turnId, reason: controller.signal.aborted ? 'stopped' : 'done', message: null });
      } catch (error) {
        send({ type: 'reply-end', turnId, reason: controller.signal.aborted ? 'stopped' : 'failed', message: controller.signal.aborted ? null : 'speech reply failed' });
        if (!controller.signal.aborted) log('reply_failed', { session: scope.sessionId, code: (error as { code?: unknown }).code ?? 'UNKNOWN' });
      } finally {
        if (reply === current) reply = null;
        log('reply', { session: scope.sessionId, characters: text.length, voice: voice.id, firstChunkMs, totalMs: Date.now() - started, audioSeconds: Number((bytes / 2 / synthesizer.sampleRate).toFixed(2)), stopped: controller.signal.aborted });
      }
    };
    let locale: 'zh-CN' | 'en' = 'zh-CN';
    let asr: StreamingAsrSession | null = null;
    let started = false;
    let ending = false;
    const samples: RealtimePointerSample[] = [];
    let utterance: { id: string; finals: string[]; words: RealtimeWord[]; partial: string; partialWords: RealtimeWord[]; start: number; revision: number; hold: NodeJS.Timeout | null } | null = null;
    const startTimer = setTimeout(() => { if (!started) ws.close(REALTIME_CLOSE_CODES.PROTOCOL_ERROR, 'start message expected'); }, START_TIMEOUT_MS);

    /** 正在过会话门的句子：关麦收尾时等它们交出后再关连接 */
    const deliveries = new Set<Promise<void>>();
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
      // 交出之前复查会话门：会话已失效的一句不交给 AI（查不了库也不交：如实请用户再说一次，不自动重试）
      const delivery = voiceSessionGate(options.deps, { sessionId: scope.sessionId, generation: scope.generation }).then(
        (gate) => {
          if (!gate.open) { closeForSession(gate.reason); return; }
          send({ type: 'utterance', utteranceId: current.id, text, attention });
          log('utterance', { session: scope.sessionId, evidence: attention.evidence, characters: text.length });
        },
        () => send({ type: 'error', code: 'SESSION_CHECK_FAILED', message: 'could not confirm the voice session; please say that again', retryable: true }),
      );
      deliveries.add(delivery);
      void delivery.finally(() => deliveries.delete(delivery));
    };

    /** 一句话说完（服务端端点 / UtteranceEnd / 关麦）：未闭合就先保留，等后半句 */
    const finalize = (force: boolean) => {
      if (utterance !== null && utterance.finals.length === 0 && utterance.partial === '' && utterance.hold === null) {
        // 这一段最终什么也没识别出来（噪声）：清掉临时显示，不交出
        send({ type: 'transcript', utteranceId: utterance.id, revision: utterance.revision + 1, text: '', isFinal: true });
        utterance = null;
        return;
      }
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
          onSpeechStart(atSeconds) {
            // 用户开口：先停掉正在念的回应（不等转写），再告诉客户端立刻停播
            stopReply();
            send({ type: 'speech-start', atSeconds });
          },
          onError(error) {
            // 可重试的失败只丢掉这一句（如实告诉用户再说一次；不自动重试）；不可重试的失败客户端会结束会话
            if (error.retryable && utterance !== null && utterance.hold === null) {
              send({ type: 'transcript', utteranceId: utterance.id, revision: utterance.revision + 1, text: '', isFinal: true });
              utterance = null;
            }
            send({ type: 'error', code: error.code, message: error.message, retryable: error.retryable });
          },
          onClose() {
            finalize(true);
            if (ending) void Promise.allSettled([...deliveries]).then(() => { if (ws.readyState === ws.OPEN) ws.close(1000, 'done'); });
          },
        });
        const synthesizer = options.synthesizer;
        send({
          type: 'ready',
          asr: { providerId: options.recognizer.providerId, implementation: options.recognizer.implementation, model: options.recognizer.model },
          tts: synthesizer === undefined ? null : { providerId: synthesizer.providerId, implementation: synthesizer.implementation, model: synthesizer.model, voices: [...synthesizer.voices] },
        });
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
        stopReply();
        if (asr === null) ws.close(1000, 'done');
        else asr.finish();
      } else if (message.type === 'stop-speaking') {
        stopReply();
      } else if (message.type === 'speak') {
        if (started && !ending) void speak(message.turnId, message.voiceId);
      }
    });
    ws.on('close', () => {
      clearTimeout(startTimer);
      clearTimeout(expiryTimer);
      stopReply();
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
