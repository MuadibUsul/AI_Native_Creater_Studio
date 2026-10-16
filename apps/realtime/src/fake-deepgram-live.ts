import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * **本地假服务**（测试替身，不是真实 Provider）：按 Deepgram 流式协议应答，用来验证适配器、网关与浏览器闭环。
 * 按收到的音频时长（PCM16）播放脚本：音频累计到某一秒就发出对应的 `Results` / `UtteranceEnd`；
 * 收到 `CloseStream` 时把剩下的脚本发完再关闭。也记录鉴权头、查询参数与 KeepAlive，供断言。
 */

export interface FakeDeepgramStep {
  atSeconds: number;
  message: Record<string, unknown>;
}

export interface FakeDeepgramConnection {
  query: URLSearchParams;
  audioBytes: number;
  keepAlives: number;
  closeStream: boolean;
}

/** 一段识别结果（与 Deepgram `Results` 同形）。words: [文字, 开始秒, 结束秒] */
export function deepgramResult(input: { words: [string, number, number][]; isFinal: boolean; speechFinal?: boolean; transcript?: string; separator?: string }): Record<string, unknown> {
  const start = input.words[0]?.[1] ?? 0;
  const end = input.words.at(-1)?.[2] ?? start;
  return {
    type: 'Results', channel_index: [0, 1], start, duration: Math.max(0, end - start), is_final: input.isFinal, speech_final: input.speechFinal ?? false,
    channel: { alternatives: [{
      transcript: input.transcript ?? input.words.map(([text]) => text).join(input.separator ?? ' '), confidence: 0.98,
      words: input.words.map(([text, wordStart, wordEnd]) => ({ word: text.toLowerCase(), punctuated_word: text, start: wordStart, end: wordEnd, confidence: 0.98 })),
    }] },
  };
}

export const deepgramUtteranceEnd = (lastWordEnd: number): Record<string, unknown> => ({ type: 'UtteranceEnd', channel: [0, 1], last_word_end: lastWordEnd });

export async function startFakeDeepgramLive(options: {
  apiKey: string;
  /** 每个连接的脚本（可按查询参数里的语言给不同脚本） */
  script: (query: URLSearchParams) => FakeDeepgramStep[];
  /** 握手直接以这个状态码拒绝（模拟 401 / 429） */
  rejectWith?: number;
}): Promise<{ url: string; connections: FakeDeepgramConnection[]; close(): Promise<void> }> {
  const server = createServer();
  const connections: FakeDeepgramConnection[] = [];
  const wss = new WebSocketServer({
    server,
    verifyClient: (info, done) => {
      if (options.rejectWith !== undefined) { done(false, options.rejectWith); return; }
      done(info.req.headers.authorization === `Token ${options.apiKey}`, 401);
    },
  });
  wss.on('connection', (socket, request) => {
    const query = new URL(request.url ?? '/', 'http://fake').searchParams;
    const connection: FakeDeepgramConnection = { query, audioBytes: 0, keepAlives: 0, closeStream: false };
    connections.push(connection);
    const sampleRate = Number(query.get('sample_rate') ?? 16_000);
    const pending = [...options.script(query)].sort((left, right) => left.atSeconds - right.atSeconds);
    const flush = (seconds: number) => {
      while (pending.length > 0 && pending[0]!.atSeconds <= seconds) socket.send(JSON.stringify(pending.shift()!.message));
    };
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        connection.audioBytes += (data as Buffer).length;
        flush(connection.audioBytes / 2 / sampleRate);
        return;
      }
      const message = JSON.parse(data.toString()) as { type?: string };
      if (message.type === 'KeepAlive') connection.keepAlives += 1;
      if (message.type === 'CloseStream') {
        connection.closeStream = true;
        flush(Number.POSITIVE_INFINITY);
        socket.send(JSON.stringify({ type: 'Metadata', duration: connection.audioBytes / 2 / sampleRate }));
        socket.close(1000);
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `ws://127.0.0.1:${String(port)}`,
    connections,
    close: () => new Promise<void>((done) => {
      for (const client of wss.clients) client.terminate();
      wss.close(() => server.close(() => done()));
    }),
  };
}
