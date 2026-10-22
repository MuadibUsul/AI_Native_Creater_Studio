import { AgentModelFailure, type AgentContentBlock, type AgentImage, type AgentModelAdapter, type AgentModelMessage, type AgentModelRequest, type AgentModelResponse } from '@ancs/contracts';
import { z } from 'zod';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
};

const imagePart = (image: AgentImage) => ({ type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.data}` } });

/** Preserves parallel tool ids, tool-result images and the assistant's reasoning on replay. */
export function toDeepSeekMessages(messages: readonly AgentModelMessage[]): ChatMessage[] {
  return messages.flatMap((message): ChatMessage[] => {
    const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (message.role === 'assistant') {
      const calls = message.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: JSON.stringify(b.input) } }));
      const reasoning = message.content.filter((b) => b.type === 'opaque').find((b) => b.provider === 'deepseek');
      if (reasoning !== undefined && typeof reasoning.payload !== 'string') throw new AgentModelFailure('BAD_REQUEST', 'Invalid DeepSeek reasoning block');
      return [{ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls, reasoning_content: reasoning?.payload as string ?? '' } : reasoning === undefined ? {} : { reasoning_content: reasoning.payload as string }) }];
    }
    const result: ChatMessage[] = [];
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        result.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content });
      }
    }
    // DeepSeek vision accepts images only in user messages. Finish all parallel
    // tool results first, then attach their images with their originating call id.
    const images = message.content.flatMap((b) => b.type === 'image' ? [imagePart(b.image)]
      : b.type === 'tool_result' && b.images?.length ? [{ type: 'text', text: `Images from tool result ${b.toolUseId}:` }, ...b.images.map(imagePart)] : []);
    if (text || images.length) result.push({ role: 'user', content: images.length ? [{ type: 'text', text }, ...images] : text });
    return result;
  });
}

export interface DeepSeekAgentModelOptions {
  apiKey: string;
  model?: string;
  /** Injection for offline protocol tests; production uses the fixed HTTPS endpoint. */
  fetch?: typeof fetch;
}

/** No adapter retries: the existing workflow owns bounded retries and metering. */
export class DeepSeekAgentModel implements AgentModelAdapter {
  readonly providerId = 'deepseek';
  readonly implementation = 'REAL' as const;
  readonly model: string;
  private readonly apiKey: string;
  private readonly request: typeof fetch;

  constructor(options: DeepSeekAgentModelOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? 'deepseek-v4-pro';
    this.request = options.fetch ?? fetch;
  }

  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    try {
      const hasImages = request.messages.some((message) => message.content.some((block) => block.type === 'image' || (block.type === 'tool_result' && (block.images?.length ?? 0) > 0)));
      // Pro is text-only; Flash supports images. Actual response.model is metered.
      const model = hasImages ? 'deepseek-flash' : this.model;
      const timeout = AbortSignal.timeout(120_000);
      const signal = request.signal === undefined ? timeout : AbortSignal.any([timeout, request.signal as AbortSignal]);
      const response = await this.request('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages: [{ role: 'system', content: request.system }, ...toDeepSeekMessages(request.messages)],
          ...(request.tools.length ? { tools: request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } })) } : {}),
          max_tokens: request.maxOutputTokens, stream: false, thinking: { type: 'enabled' },
          reasoning_effort: request.effort === 'low' ? 'low' : request.effort === 'max' ? 'max' : 'high',
        }),
      });
      if (!response.ok) {
        const status = response.status;
        // Never reflect upstream bodies or transport errors, which may echo credentials.
        throw new AgentModelFailure(status === 401 || status === 403 || status === 402 ? 'AUTH' : status === 429 ? 'RATE_LIMITED' : status === 503 ? 'OVERLOADED' : status >= 500 ? 'TRANSIENT' : 'BAD_REQUEST', `DeepSeek request failed (HTTP ${status})`, status);
      }
      const raw: unknown = await response.json();
      const body = completionSchema.parse(raw);
      const choice = body.choices[0]!;
      const content: AgentContentBlock[] = [];
      if (choice.message.reasoning_content) content.push({ type: 'opaque', provider: 'deepseek', payload: choice.message.reasoning_content });
      if (choice.message.content) content.push({ type: 'text', text: choice.message.content });
      for (const call of choice.message.tool_calls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) as unknown });
      if (!content.length) throw new AgentModelFailure('TRANSIENT', 'DeepSeek returned an empty response');
      const cached = body.usage.prompt_cache_hit_tokens ?? 0;
      if (cached > body.usage.prompt_tokens) throw new AgentModelFailure('TRANSIENT', 'DeepSeek returned invalid token usage');
      return {
        model: body.model, content,
        stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use' : choice.finish_reason === 'stop' ? 'end_turn' : choice.finish_reason === 'length' ? 'max_tokens' : choice.finish_reason === 'content_filter' ? 'refusal' : 'other',
        usage: { inputTokens: body.usage.prompt_tokens - cached, outputTokens: body.usage.completion_tokens, cacheReadInputTokens: cached, cacheCreationInputTokens: 0 },
      };
    } catch (error) {
      if (error instanceof AgentModelFailure) throw error;
      throw new AgentModelFailure('TRANSIENT', 'DeepSeek connection failed or response was invalid');
    }
  }
}

const completionSchema = z.object({
  model: z.string().min(1),
  choices: z.array(z.object({
    finish_reason: z.string(),
    message: z.object({
      content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional(),
      tool_calls: z.array(z.object({ id: z.string().min(1), function: z.object({ name: z.string().min(1), arguments: z.string() }) })).optional(),
    }),
  })).min(1),
  usage: z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), prompt_cache_hit_tokens: z.number().int().nonnegative().optional() }),
});
