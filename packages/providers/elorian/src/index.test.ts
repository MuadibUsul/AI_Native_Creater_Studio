import { describe, expect, it } from 'vitest';
import { AgentModelFailure, type AgentModelRequest } from '@ancs/contracts';
import { ElorianAgentModel, toElorianMessages } from './index.js';

const TEST_API_KEY = 'test-only-placeholder'; // secrets:check-ignore：离线协议测试假凭据

const request: AgentModelRequest = {
  system: 'Video editor',
  tools: [{ name: 'list_footage', description: 'List footage', inputSchema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: '看看素材' }] }],
  maxOutputTokens: 1024,
  effort: 'high',
};
const completion = {
  model: 'elorian-1-agent',
  choices: [{
    finish_reason: 'tool_calls',
    message: {
      content: null,
      tool_calls: [
        { id: 'call_1', function: { name: 'list_footage', arguments: '{}' } },
        { id: 'call_2', function: { name: 'list_footage', arguments: '{"page":2}' } },
      ],
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } },
};

describe('Elorian vision/director adapter', () => {
  it('sends tools and headers, preserves parallel calls, and splits cached usage', async () => {
    let sent: Record<string, unknown> = {};
    const model = new ElorianAgentModel({
      apiKey: TEST_API_KEY,
      fetch: async (url, init) => {
        expect(url).toBe('https://api.elorian.ai/v1/chat/completions');
        expect(init?.redirect).toBe('error');
        expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-placeholder' });
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return Response.json(completion);
      },
    });
    const result = await model.respond(request);
    expect(sent).toMatchObject({
      model: 'elorian-1-agent',
      max_completion_tokens: 1024,
      stream: false,
      tools: [{ type: 'function', function: { name: 'list_footage' } }],
    });
    expect(JSON.stringify(sent)).not.toContain('test-only-placeholder');
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 });
  });

  it('maps images into user messages and replays tool results with their images', () => {
    const replay = toElorianMessages([
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'look_at_footage', input: { at: '1.0' } }] },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 'call_1', content: 'frame', isError: false, images: [{ mediaType: 'image/jpeg', data: 'YQ==' }] },
      ] },
      { role: 'user', content: [{ type: 'image', image: { mediaType: 'image/png', data: 'Yg==' } }] },
    ]);
    expect(replay[0]).toMatchObject({ role: 'assistant', tool_calls: [{ id: 'call_1', function: { name: 'look_at_footage' } }] });
    expect(replay[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'frame' });
    expect(replay[2]).toMatchObject({ role: 'user', content: [{ text: '' }, { text: 'Images from tool result call_1:' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,YQ==' } }] });
    expect(replay[3]).toMatchObject({ role: 'user', content: [{ text: '' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,Yg==' } }] });
  });

  it.each([[401, 'AUTH'], [402, 'AUTH'], [429, 'RATE_LIMITED'], [503, 'OVERLOADED'], [500, 'TRANSIENT'], [400, 'BAD_REQUEST']])('classifies HTTP %s without reflecting credentials or retrying', async (status, kind) => {
    let calls = 0;
    const model = new ElorianAgentModel({ apiKey: TEST_API_KEY, fetch: async () => { calls++; return new Response('test-only-placeholder', { status: Number(status) }); } });
    await expect(model.respond(request)).rejects.toMatchObject({ kind, status, message: `Elorian request failed (HTTP ${String(status)})` });
    expect(calls).toBe(1);
  });

  it('treats insufficient quota as a non-retryable auth failure', async () => {
    const model = new ElorianAgentModel({
      apiKey: TEST_API_KEY,
      fetch: async () => Response.json(
        { error: { message: 'credits exhausted', type: 'insufficient_quota', code: 'credits_exhausted' } },
        { status: 429 },
      ),
    });
    await expect(model.respond(request)).rejects.toMatchObject({
      kind: 'AUTH',
      status: 429,
      message: 'Elorian request failed (HTTP 429, insufficient quota)',
    });
    expect(new AgentModelFailure('AUTH', 'x', 429).retryable).toBe(false);
  });

  it('redacts transport/parse errors and rejects malformed tool arguments', async () => {
    for (const fakeFetch of [
      async () => { throw new Error('test-only-placeholder'); },
      async () => Response.json({ ...completion, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad', function: { name: 'list_footage', arguments: '{broken' } }] } }] }),
    ]) {
      const model = new ElorianAgentModel({ apiKey: TEST_API_KEY, fetch: fakeFetch });
      await expect(model.respond(request)).rejects.toEqual(new AgentModelFailure('TRANSIENT', 'Elorian connection failed or response was invalid'));
    }
    const empty = new ElorianAgentModel({
      apiKey: TEST_API_KEY,
      fetch: async () => Response.json({ ...completion, choices: [{ finish_reason: 'stop', message: { content: null } }] }),
    });
    await expect(empty.respond(request)).rejects.toEqual(new AgentModelFailure('TRANSIENT', 'Elorian returned an empty response'));
  });
});
