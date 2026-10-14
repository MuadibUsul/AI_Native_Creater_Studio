import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModelFailure, type AgentModelRequest } from '@ancs/contracts';
import { GeminiAgentModel, createGeminiSpeech, createGeminiVeo, fromGeminiParts, toGeminiContents } from './index.js';

/**
 * Gemini 适配器 × 本地假服务：请求形状（系统提示、工具 schema、思考档位、工具结果、思考签名原样回放）、
 * 响应转换、重试与错误分类、TTS 音频格式、Veo 长任务与下载（跳转后不带密钥）。不访问网络、不需要真实密钥。
 */

const FAKE_KEY = 'gemini-test-key-000000000000'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: Record<string, unknown> | null }
type Handler = (request: IncomingMessage, response: ServerResponse, recorded: Recorded, index: number) => void;

let servers: Server[] = [];

async function startFake(handler: Handler): Promise<{ baseUrl: string; origin: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    request.on('end', () => {
      const recorded = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: raw.length > 0 ? JSON.parse(raw) as Record<string, unknown> : null };
      requests.push(recorded);
      handler(request, response, recorded, requests.length - 1);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  return { baseUrl: `${origin}/v1beta`, origin, requests };
}

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
};

afterEach(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

const noWait = () => Promise.resolve();

function request(overrides: Partial<AgentModelRequest> = {}): AgentModelRequest {
  return {
    system: 'You are the director.',
    tools: [{ name: 'trim_clip', description: 'Trim a clip', inputSchema: { $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', properties: { clipId: { type: 'string' } }, required: ['clipId'], additionalProperties: false } }],
    messages: [{ role: 'user', content: [{ type: 'text', text: '剪短一点' }] }],
    maxOutputTokens: 4096,
    effort: 'medium',
    ...overrides,
  };
}

describe('GeminiAgentModel', () => {
  it('请求形状：系统提示、工具 schema（去掉 $schema）、思考档位；密钥只在请求头', async () => {
    const fake = await startFake((_request, response) => json(response, 200, {
      candidates: [{ content: { role: 'model', parts: [{ text: '好的，我先看一下素材。', thoughtSignature: 'sig-text' }, { functionCall: { id: 'call_1', name: 'trim_clip', args: { clipId: 'clp_1' } }, thoughtSignature: 'sig-call' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30, thoughtsTokenCount: 50, cachedContentTokenCount: 20 },
      modelVersion: 'gemini-test-flash',
    }));
    const model = new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'gemini-test-flash', baseUrl: fake.baseUrl, wait: noWait });
    const result = await model.respond(request());

    const sent = fake.requests[0]!;
    expect(sent.url).toBe('/v1beta/models/gemini-test-flash:generateContent');
    expect(sent.url).not.toContain(FAKE_KEY);
    expect(sent.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(sent.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are the director.' }] },
      contents: [{ role: 'user', parts: [{ text: '剪短一点' }] }],
      tools: [{ functionDeclarations: [{ name: 'trim_clip', description: 'Trim a clip', parametersJsonSchema: { type: 'object', required: ['clipId'], additionalProperties: false } }] }],
      generationConfig: { maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: 'medium' } },
    });
    const declared = (sent.body!['tools'] as { functionDeclarations: { parametersJsonSchema: Record<string, unknown> }[] }[])[0]!.functionDeclarations[0]!.parametersJsonSchema;
    expect(declared).not.toHaveProperty('$schema');

    expect(result).toEqual({
      model: 'gemini-test-flash',
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 80, cacheReadInputTokens: 20, cacheCreationInputTokens: 0 },
      content: [
        { type: 'opaque', provider: 'gemini', payload: { kind: 'signature', thoughtSignature: 'sig-text' } },
        { type: 'text', text: '好的，我先看一下素材。' },
        { type: 'opaque', provider: 'gemini', payload: { kind: 'signature', thoughtSignature: 'sig-call' } },
        { type: 'tool_use', id: 'call_1', name: 'trim_clip', input: { clipId: 'clp_1' } },
      ],
    });
  });

  it('回放：思考签名原样挂回、工具结果按 id 找回工具名、工具返回的图像跟在后面；别家的工具调用用占位签名', () => {
    const blocks = fromGeminiParts([
      { text: '先看画面', thoughtSignature: 'sig-a' },
      { functionCall: { id: 'call_7', name: 'look', args: { at: '1.5' } }, thoughtSignature: 'sig-b' },
      { functionCall: { name: 'look', args: { at: '3' } } },
      { text: '', thoughtSignature: 'sig-tail' },
    ]);
    const localId = (blocks.find((block) => block.type === 'tool_use' && block.input !== null && (block.input as { at?: string }).at === '3') as { id: string }).id;
    const contents = toGeminiContents([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: blocks },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 'call_7', content: '{"ok":true}', isError: false, images: [{ mediaType: 'image/jpeg', data: 'AAAA' }] },
        { type: 'tool_result', toolUseId: localId, content: 'out of range', isError: true },
      ] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name: 'look', input: {} }] },
    ]);
    expect(contents[1]).toEqual({ role: 'model', parts: [
      { text: '先看画面', thoughtSignature: 'sig-a' },
      { functionCall: { id: 'call_7', name: 'look', args: { at: '1.5' } }, thoughtSignature: 'sig-b' },
      { functionCall: { name: 'look', args: { at: '3' } } },
      { text: '', thoughtSignature: 'sig-tail' },
    ] });
    expect(contents[2]).toEqual({ role: 'user', parts: [
      { functionResponse: { id: 'call_7', name: 'look', response: { result: '{"ok":true}' } } },
      { functionResponse: { name: 'look', response: { error: 'out of range' } } },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
    ] });
    expect(contents[3]).toEqual({ role: 'model', parts: [{ functionCall: { id: 'toolu_x', name: 'look', args: {} }, thoughtSignature: 'skip_thought_signature_validator' }] });
    expect(() => toGeminiContents([{ role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', payload: {} }] }])).toThrow(AgentModelFailure);
  });

  it('过载 / 限流有界重试；写坏的工具调用重发；鉴权与请求错误不重试；错误里没有密钥', async () => {
    const fake = await startFake((_request, response, _recorded, index) => {
      if (index === 0) return json(response, 503, { error: { code: 503, message: 'This model is currently experiencing high demand.', status: 'UNAVAILABLE' } });
      if (index === 1) return json(response, 200, { candidates: [{ content: { parts: [] }, finishReason: 'MALFORMED_FUNCTION_CALL' }] });
      return json(response, 200, { candidates: [{ content: { parts: [{ text: '剪好了' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 } });
    });
    const model = new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'gemini-test-flash', baseUrl: fake.baseUrl, wait: noWait, thinkingLevels: false });
    const result = await model.respond(request({ tools: [] }));
    expect(fake.requests).toHaveLength(3);
    expect(fake.requests[2]!.body).not.toHaveProperty('tools');
    expect((fake.requests[2]!.body!['generationConfig'] as Record<string, unknown>)['thinkingConfig']).toBeUndefined();
    expect(result).toMatchObject({ stopReason: 'end_turn', content: [{ type: 'text', text: '剪好了' }], model: 'gemini-test-flash' });

    const limited = await startFake((_request, response) => json(response, 429, { error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED' } }));
    const limitedModel = new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'm', baseUrl: limited.baseUrl, wait: noWait, maxRetries: 1 });
    await expect(limitedModel.respond(request())).rejects.toMatchObject({ kind: 'RATE_LIMITED', status: 429, retryable: true });
    expect(limited.requests).toHaveLength(2);

    for (const [status, kind] of [[401, 'AUTH'], [400, 'BAD_REQUEST']] as const) {
      const failing = await startFake((_request, response) => json(response, status, { error: { code: status, message: `bad thing ${String(status)}` } }));
      const error = await new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'm', baseUrl: failing.baseUrl, wait: noWait }).respond(request()).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ kind, status });
      expect(String((error as Error).message)).not.toContain(FAKE_KEY);
      expect(failing.requests).toHaveLength(1);
    }
    const long = await startFake((_request, response) => json(response, 400, { error: { code: 400, message: 'The input token count (2000000) exceeds the maximum number of tokens allowed (1048576).' } }));
    await expect(new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'm', baseUrl: long.baseUrl, wait: noWait }).respond(request())).rejects.toMatchObject({ kind: 'CONTEXT_TOO_LONG' });

    const blocked = await startFake((_request, response) => json(response, 200, { promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(new GeminiAgentModel({ apiKey: FAKE_KEY, model: 'm', baseUrl: blocked.baseUrl, wait: noWait }).respond(request())).resolves.toMatchObject({ stopReason: 'refusal', content: [] });
  });
});

describe('Gemini 语音与 Veo', () => {
  it('TTS：预置声音；裸 PCM（audio/L16）包成 WAV，WAV 原样返回', async () => {
    const pcm = Buffer.alloc(48_000, 1);
    const fake = await startFake((_request, response, _recorded, index) => json(response, 200, {
      candidates: [{ content: { parts: [{ inlineData: index === 0 ? { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } : { mimeType: 'audio/wav', data: Buffer.from('RIFFxxxxWAVE').toString('base64') } }] } }],
    }));
    const speech = createGeminiSpeech({ apiKey: FAKE_KEY, model: 'gemini-test-tts', baseUrl: fake.baseUrl });
    const wav = Buffer.from(await speech.synthesize({ text: '冰岛的冬天', voiceName: 'Kore' }));
    expect(fake.requests[0]!.body).toEqual({
      contents: [{ parts: [{ text: '冰岛的冬天' }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } } },
    });
    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(Buffer.from(await speech.synthesize({ text: 'hi', voiceName: 'Puck' })).toString('ascii')).toBe('RIFFxxxxWAVE');
  });

  it('TTS：按分钟的配额用完时按供应商给的 retryDelay 等待后重试（有界）；按天的配额用完不重试', async () => {
    const quota = (quotaId: string, retryDelay: string) => ({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [
      { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
    ] } });
    const fake = await startFake((_request, response, _recorded, index) => (index < 2
      ? json(response, 429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '7s'))
      : json(response, 200, { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: Buffer.from('RIFF').toString('base64') } }] } }] })));
    const waits: number[] = [];
    const speech = createGeminiSpeech({ apiKey: FAKE_KEY, model: 'tts', baseUrl: fake.baseUrl, wait: (ms) => { waits.push(ms); return Promise.resolve(); } });
    await speech.synthesize({ text: 'one', voiceName: 'Kore' });
    expect(waits).toEqual([7_250, 7_250]);
    expect(fake.requests).toHaveLength(3);

    const daily = await startFake((_request, response) => json(response, 429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '30s')));
    const dailyWaits: number[] = [];
    const exhausted = createGeminiSpeech({ apiKey: FAKE_KEY, model: 'tts', baseUrl: daily.baseUrl, wait: (ms) => { dailyWaits.push(ms); return Promise.resolve(); } });
    await expect(exhausted.synthesize({ text: 'one', voiceName: 'Kore' })).rejects.toMatchObject({ status: 429, dailyQuota: true });
    expect(dailyWaits).toEqual([]);
    expect(daily.requests).toHaveLength(1);

    const stuck = await startFake((_request, response) => json(response, 429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '1s')));
    await expect(createGeminiSpeech({ apiKey: FAKE_KEY, model: 'tts', baseUrl: stuck.baseUrl, maxRetries: 2, wait: noWait }).synthesize({ text: 'x', voiceName: 'Kore' })).rejects.toMatchObject({ status: 429 });
    expect(stuck.requests).toHaveLength(3);
  });

  it('Veo：提交 → 轮询 → 下载；文件跳转到别的主机时不带密钥；被过滤 / 出错如实返回', async () => {
    const storage = await startFake((_request, response) => { response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(Buffer.from('MP4DATA')); });
    let polls = 0;
    const api = await startFake((request, response, recorded) => {
      if (recorded.url.endsWith(':predictLongRunning')) return json(response, 200, { name: 'models/veo-test/operations/op1' });
      if (recorded.url === '/v1beta/models/veo-test/operations/op1') {
        polls += 1;
        return json(response, 200, polls < 2 ? { name: 'op1', done: false } : { name: 'op1', done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: `${apiOrigin}/v1beta/files/abc:download?alt=media` } }] } } });
      }
      if (recorded.url === '/v1beta/models/veo-test/operations/op2') return json(response, 200, { done: true, response: { generateVideoResponse: { raiMediaFilteredCount: 1, raiMediaFilteredReasons: ['unsafe content'] } } });
      if (recorded.url === '/v1beta/models/veo-test/operations/op3') return json(response, 200, { done: true, error: { code: 13, message: 'internal failure' } });
      if (recorded.url.startsWith('/v1beta/files/abc:download')) {
        response.writeHead(302, { location: `${storage.origin}/bucket/video.mp4` });
        return response.end();
      }
      return json(response, 404, { error: { message: `unexpected ${request.url ?? ''}` } });
    });
    const apiOrigin = api.origin;
    const veo = createGeminiVeo({ apiKey: FAKE_KEY, model: 'veo-test', baseUrl: api.baseUrl });
    const operation = await veo.start({ prompt: 'a calm lake at dawn', durationSeconds: 4, aspectRatio: '16:9', resolution: '720p' });
    expect(operation).toBe('models/veo-test/operations/op1');
    expect(api.requests[0]!.body).toEqual({ instances: [{ prompt: 'a calm lake at dawn' }], parameters: { aspectRatio: '16:9', durationSeconds: 4, resolution: '720p' } });
    expect(await veo.poll(operation)).toEqual({ done: false });
    const done = await veo.poll(operation);
    expect(done).toMatchObject({ done: true, error: null, filtered: null });
    const bytes = await veo.download((done as { videoUri: string }).videoUri);
    expect(Buffer.from(bytes).toString('ascii')).toBe('MP4DATA');
    expect(api.requests.find((item) => item.url.startsWith('/v1beta/files/'))!.headers['x-goog-api-key']).toBe(FAKE_KEY);
    expect(storage.requests[0]!.headers['x-goog-api-key']).toBeUndefined();

    expect(await veo.poll('models/veo-test/operations/op2')).toEqual({ done: true, videoUri: null, error: null, filtered: 'unsafe content' });
    expect(await veo.poll('models/veo-test/operations/op3')).toEqual({ done: true, videoUri: null, error: 'internal failure', filtered: null });
    for (const bad of ['../../evil', 'models/x/operations/../../files', 'operations/a?b=1']) await expect(veo.poll(bad)).rejects.toThrow('unexpected Veo operation name');
  });
});
