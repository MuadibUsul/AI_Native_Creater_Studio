import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModelFailure, type AgentModelRequest } from '@ancs/contracts';
import { AnthropicAgentModel } from './index.js';

/**
 * 真实 SDK × 本地假服务（SSE 流）：验证请求形状（缓存断点、工具、effort、思考块原样回放）、
 * 响应转换（思考块 → opaque、工具调用、用量）与错误分类。不访问网络、不需要真实密钥。
 */

const FAKE_KEY = 'sk-ant-test-0000000000000000'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

interface RequestBody { model?: unknown; stream?: unknown; cache_control?: unknown; system?: unknown; tools?: unknown; output_config?: unknown; thinking?: unknown; messages?: unknown[] }
interface Recorded { body: RequestBody }
type Handler = (request: IncomingMessage, response: ServerResponse, recorded: Recorded) => void;

let server: Server | null = null;

async function startFake(handler: Handler): Promise<{ baseURL: string; requests: Recorded[] }> {
  const requests: Recorded[] = [];
  server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    request.on('end', () => {
      const recorded = { body: JSON.parse(raw) as RequestBody };
      requests.push(recorded);
      handler(request, response, recorded);
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${String(port)}`, requests };
}

afterEach(async () => {
  await new Promise<void>((resolve) => { if (server === null) resolve(); else server.close(() => resolve()); });
  server = null;
});

function sse(response: ServerResponse, events: Record<string, unknown>[]): void {
  response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const event of events) response.write(`event: ${String(event['type'])}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

const thinkingThenToolUse: Record<string, unknown>[] = [
  { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 900, cache_creation_input_tokens: 40 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'look at the timeline first' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-abc' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Checking.' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_timeline', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"detail":' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '"full"}' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 57 } },
  { type: 'message_stop' },
];

const baseRequest: AgentModelRequest = {
  system: 'You are the director.',
  tools: [{ name: 'get_timeline', description: 'Read the timeline', inputSchema: { type: 'object', properties: { detail: { type: 'string' } }, additionalProperties: false } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: '剪一版' }] }],
  maxOutputTokens: 8000,
  effort: 'medium',
};

describe('AnthropicAgentModel（真实 SDK × 本地假服务）', () => {
  it('请求形状：缓存断点、工具 eager 输入流、effort；响应：思考块 → opaque，工具调用与用量完整', async () => {
    const fake = await startFake((_request, response) => { sse(response, thinkingThenToolUse); });
    const model = new AnthropicAgentModel({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', baseURL: fake.baseURL, maxRetries: 0 });
    const result = await model.respond(baseRequest);

    const body = fake.requests[0]?.body ?? {};
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.stream).toBe(true);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system).toEqual([{ type: 'text', text: 'You are the director.', cache_control: { type: 'ephemeral' } }]);
    expect(body.tools).toEqual([{ name: 'get_timeline', description: 'Read the timeline', input_schema: baseRequest.tools[0]?.inputSchema, eager_input_streaming: true }]);
    expect(body.output_config).toEqual({ effort: 'medium' });
    expect(body).not.toHaveProperty('thinking');

    expect(result.model).toBe('claude-opus-5-5');
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 120, outputTokens: 57, cacheReadInputTokens: 900, cacheCreationInputTokens: 40 });
    expect(result.content).toEqual([
      { type: 'opaque', provider: 'anthropic', payload: { type: 'thinking', thinking: 'look at the timeline first', signature: 'sig-abc' } },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'get_timeline', input: { detail: 'full' } },
    ]);
  });

  it('回放：opaque 思考块按原样原序送回，工具结果带 is_error', async () => {
    const fake = await startFake((_request, response) => {
      sse(response, [
        { type: 'message_start', message: { id: 'msg_2', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好了' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
        { type: 'message_stop' },
      ]);
    });
    const model = new AnthropicAgentModel({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', baseURL: fake.baseURL, maxRetries: 0 });
    const thinking = { type: 'thinking', thinking: 'look at the timeline first', signature: 'sig-abc' };
    const result = await model.respond({
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: 'assistant', content: [{ type: 'opaque', provider: 'anthropic', payload: thinking }, { type: 'tool_use', id: 'toolu_1', name: 'get_timeline', input: { detail: 'full' } }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_1', content: 'clip id unknown', isError: true }] },
      ],
    });
    const messages = fake.requests[0]?.body.messages ?? [];
    expect(messages[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 'toolu_1', name: 'get_timeline', input: { detail: 'full' } }] });
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'clip id unknown', is_error: true }] });
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage.cacheReadInputTokens).toBe(0);
    expect(result.content).toEqual([{ type: 'text', text: '好了' }]);
  });

  it('错误分类：429 → RATE_LIMITED（可重试），401 → AUTH，529 → OVERLOADED；错误信息不含密钥', async () => {
    let status = 429;
    const fake = await startFake((_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ type: 'error', error: { type: 'some_error', message: 'nope' } }));
    });
    const model = new AnthropicAgentModel({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', baseURL: fake.baseURL, maxRetries: 0 });
    for (const [code, kind, retryable] of [[429, 'RATE_LIMITED', true], [401, 'AUTH', false], [529, 'OVERLOADED', true], [400, 'BAD_REQUEST', false]] as const) {
      status = code;
      const error = await model.respond(baseRequest).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AgentModelFailure);
      expect((error as AgentModelFailure).kind).toBe(kind);
      expect((error as AgentModelFailure).retryable).toBe(retryable);
      expect((error as AgentModelFailure).message).not.toContain(FAKE_KEY);
    }
  });

  it('图像：用户消息里的图像块与工具结果附带的抽帧都按 base64 图像块发送', async () => {
    const fake = await startFake((_request, response) => { sse(response, thinkingThenToolUse); });
    const model = new AnthropicAgentModel({ apiKey: FAKE_KEY, model: 'claude-haiku-5-5', baseURL: fake.baseURL, maxRetries: 0 });
    const image = { mediaType: 'image/jpeg' as const, data: '/9j/4AAQSkZJRg==' };
    await model.respond({
      ...baseRequest,
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'describe' }, { type: 'image', image }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_9', name: 'look', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_9', content: '{"frames":1}', isError: false, images: [image] }] },
      ],
    });
    const messages = fake.requests[0]?.body.messages ?? [];
    const imageBlock = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/4AAQSkZJRg==' } };
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'describe' }, imageBlock] });
    expect(messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', content: [{ type: 'text', text: '{"frames":1}' }, imageBlock], is_error: false }] });
  });

  it('拒绝回放其他供应商的 opaque 块', async () => {
    const fake = await startFake((_request, response) => { sse(response, thinkingThenToolUse); });
    const model = new AnthropicAgentModel({ apiKey: FAKE_KEY, model: 'claude-opus-5-5', baseURL: fake.baseURL, maxRetries: 0 });
    const error = await model.respond({
      ...baseRequest,
      messages: [...baseRequest.messages, { role: 'assistant', content: [{ type: 'opaque', provider: 'other', payload: {} }] }],
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentModelFailure);
    expect(fake.requests).toHaveLength(0);
  });
});
