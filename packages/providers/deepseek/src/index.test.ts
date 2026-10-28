import { describe, expect, it } from 'vitest';
import { AgentModelFailure, type AgentModelRequest } from '@ancs/contracts';
import { DeepSeekAgentModel, toDeepSeekMessages } from './index.js';

const TEST_API_KEY = 'test-only-placeholder'; // secrets:check-ignore：离线协议测试假凭据

const request: AgentModelRequest = {
  system: 'Video editor', tools: [{ name: 'list_footage', description: 'List footage', inputSchema: { type: 'object', properties: {} } }],
  messages: [{ role: 'user', content: [{ type: 'text', text: '看看素材' }] }], maxOutputTokens: 1024, effort: 'high',
};
const completion = {
  model: 'deepseek-v4-pro', choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'Inspect first.', tool_calls: [
    { id: 'call_1', function: { name: 'list_footage', arguments: '{}' } },
    { id: 'call_2', function: { name: 'list_footage', arguments: '{"page":2}' } },
  ] } }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 30 },
};

describe('DeepSeek director adapter', () => {
  it('sends tools and headers, preserves reasoning/parallel calls, and splits cached usage', async () => {
    let sent: Record<string, unknown> = {};
    const model = new DeepSeekAgentModel({ apiKey: TEST_API_KEY, fetch: async (url, init) => {
      expect(url).toBe('https://api.deepseek.com/chat/completions');
      expect(init?.redirect).toBe('error');
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-placeholder' });
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return Response.json(completion);
    } });
    const result = await model.respond(request);
    expect(sent).toMatchObject({ model: 'deepseek-v4-pro', thinking: { type: 'enabled' }, reasoning_effort: 'high', tools: [{ type: 'function', function: { name: 'list_footage' } }] });
    expect(JSON.stringify(sent)).not.toContain('test-only-placeholder');
    expect(result.stopReason).toBe('tool_use');
    expect(result.usage).toEqual({ inputTokens: 70, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 0 });
    const replay = toDeepSeekMessages([
      { role: 'assistant', content: result.content },
      { role: 'user', content: [
        { type: 'tool_result', toolUseId: 'call_1', content: 'first', isError: false, images: [{ mediaType: 'image/png', data: 'YQ==' }] },
        { type: 'tool_result', toolUseId: 'call_2', content: 'second', isError: true },
      ] },
    ]);
    expect(replay[0]).toMatchObject({ role: 'assistant', reasoning_content: 'Inspect first.', tool_calls: [{ id: 'call_1' }, { id: 'call_2' }] });
    expect(replay[1]).toMatchObject({ role: 'tool', tool_call_id: 'call_1', content: 'first' });
    expect(replay[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_2', content: 'second' });
    expect(replay[3]).toMatchObject({ role: 'user', content: [{ text: '' }, { text: 'Images from tool result call_1:' }, { type: 'image_url' }] });
  });

  it('uses the vision-capable Flash model for image rounds and meters its actual model', async () => {
    const model = new DeepSeekAgentModel({ apiKey: TEST_API_KEY, fetch: async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: 'deepseek-flash' });
      return Response.json({ ...completion, model: 'deepseek-flash' });
    } });
    const response = await model.respond({ ...request, messages: [{ role: 'user', content: [{ type: 'image', image: { mediaType: 'image/png', data: 'YQ==' } }] }] });
    expect(response.model).toBe('deepseek-flash');
  });

  it('V7 B1: sends only the newest images; older ones become a note, so steps without new images use the configured model', async () => {
    const frame = { mediaType: 'image/jpeg' as const, data: 'YQ==' };
    const call = (id: string): AgentModelRequest['messages'][number] => ({ role: 'assistant', content: [{ type: 'opaque', provider: 'deepseek', payload: 'think' }, { type: 'tool_use', id, name: 'look_at_footage', input: {} }] });
    const result = (id: string, images: number): AgentModelRequest['messages'][number] => ({ role: 'user', content: [{ type: 'tool_result', toolUseId: id, content: `result ${id}`, isError: false, ...(images ? { images: Array.from({ length: images }, () => frame) } : {}) }] });
    const afterLook: AgentModelRequest['messages'] = [...request.messages, call('call_1'), result('call_1', 2)];
    const afterRead = [...afterLook, call('call_2'), result('call_2', 0)];
    const afterSecondLook = [...afterRead, call('call_3'), result('call_3', 1)];
    const sent: { model: string; images: number; body: string }[] = [];
    const model = new DeepSeekAgentModel({ apiKey: TEST_API_KEY, fetch: async (_url, init) => {
      const body = String(init?.body);
      const parsed = JSON.parse(body) as { model: string };
      sent.push({ model: parsed.model, images: body.split('"type":"image_url"').length - 1, body });
      return Response.json({ ...completion, model: parsed.model });
    } });
    for (const messages of [afterLook, afterRead, afterSecondLook]) await model.respond({ ...request, messages });

    // 刚看到的图照常发给支持图片的 Flash；之后没有新图的一步回到配置的模型，旧图换成说明
    expect(sent.map(({ model: used, images }) => [used, images])).toEqual([['deepseek-flash', 2], ['deepseek-v4-pro', 0], ['deepseek-flash', 1]]);
    expect(sent[1]!.body).toContain('Images from tool result call_1 (2) were shown in an earlier step and are omitted now');
    expect(sent[2]!.body).toContain('Images from tool result call_1 (2) were shown');
    expect(sent[2]!.body).toContain('Images from tool result call_3:');
    // 旧消息在之后每一步的投影都相同：请求只由轮次日志决定，前缀缓存在图片换成说明之后保持可用
    const earlier = toDeepSeekMessages(afterRead);
    expect(toDeepSeekMessages(afterSecondLook).slice(0, earlier.length)).toEqual(earlier);
    // 工具结果与调用 id 的配对、推理内容的回放不受影响
    expect(earlier.filter((message) => message.role === 'tool').map((message) => message.tool_call_id)).toEqual(['call_1', 'call_2']);
    expect(earlier.filter((message) => message.role === 'assistant').every((message) => message.reasoning_content === 'think')).toBe(true);
  });

  it.each([[401, 'AUTH'], [402, 'AUTH'], [429, 'RATE_LIMITED'], [503, 'OVERLOADED'], [500, 'TRANSIENT'], [400, 'BAD_REQUEST']])('classifies HTTP %s without reflecting credentials or retrying', async (status, kind) => {
    let calls = 0;
    const model = new DeepSeekAgentModel({ apiKey: TEST_API_KEY, fetch: async () => { calls++; return new Response('test-only-placeholder', { status: Number(status) }); } });
    await expect(model.respond(request)).rejects.toMatchObject({ kind, status, message: `DeepSeek request failed (HTTP ${status})` });
    expect(calls).toBe(1);
  });

  it('redacts transport/parse errors and rejects malformed tool arguments', async () => {
    for (const fakeFetch of [
      async () => { throw new Error('test-only-placeholder'); },
      async () => Response.json({ ...completion, choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'bad', function: { name: 'list_footage', arguments: '{broken' } }] } }] }),
    ]) {
      const model = new DeepSeekAgentModel({ apiKey: TEST_API_KEY, fetch: fakeFetch });
      await expect(model.respond(request)).rejects.toEqual(new AgentModelFailure('TRANSIENT', 'DeepSeek connection failed or response was invalid'));
    }
  });
});
