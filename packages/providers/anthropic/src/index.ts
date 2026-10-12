import Anthropic from '@anthropic-ai/sdk';
import {
  AgentModelFailure,
  type AgentContentBlock,
  type AgentModelAdapter,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentStopReason,
} from '@ancs/contracts';

/**
 * 真实 Claude 适配器（V6 §8 Agent Runtime 的模型端口实现）。
 *
 * - 流式请求 + `finalMessage()`：长输出不受非流式超时限制；
 * - 提示缓存：系统提示（连同其前的工具目录）设一个断点，另用顶层自动缓存覆盖不断增长的对话前缀；
 * - 思考块等供应商专有块按原样转成 `opaque` 返回，回放时原序送回（不改写历史）；
 * - 客户端工具开启 `eager_input_streaming`：服务端不再校验输入，调用方必须按工具 schema 校验（Agent Runtime 已做）；
 * - 失败分类为 `AgentModelFailure`（限流/过载/瞬时可重试；鉴权/请求错误不可重试）；错误信息不含凭据。
 * 凭据由入口注入（业务包不读 process.env），只存在于服务端进程。
 */

export const ANTHROPIC_PROVIDER_ID = 'anthropic';

export interface AnthropicAgentModelOptions {
  apiKey: string;
  model: string;
  /** 仅测试/私有网关使用 */
  baseURL?: string;
  /** SDK 内置重试上限（429/5xx/连接错误；付费调用有界重试） */
  maxRetries?: number;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class AnthropicAgentModel implements AgentModelAdapter {
  readonly providerId = ANTHROPIC_PROVIDER_ID;
  readonly implementation = 'REAL' as const;
  readonly model: string;
  private readonly client: Anthropic;

  constructor(options: AnthropicAgentModelOptions) {
    if (options.apiKey.trim().length === 0) throw new Error('Anthropic API key is required');
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 600_000,
      ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  }

  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: this.model,
      max_tokens: request.maxOutputTokens,
      // 顶层自动缓存：缓存最后一个可缓存块，循环中下一次调用读取整段已缓存对话
      cache_control: { type: 'ephemeral' },
      system: [{ type: 'text', text: request.system, cache_control: { type: 'ephemeral' } }],
      tools: request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
        eager_input_streaming: true,
      })),
      messages: request.messages.map(toMessageParam),
      output_config: { effort: request.effort },
    };
    let message: Anthropic.Message;
    let jsonRetries = 0;
    for (;;) {
      try {
        const stream = this.client.messages.stream(params, request.signal === undefined ? undefined : { signal: request.signal as AbortSignal });
        message = await stream.finalMessage();
        break;
      } catch (error) {
        // eager 输入流下工具输入无法解析时 finalMessage 会拒绝；只对这种情况有界重发（API 错误原样分类）
        if (!(error instanceof Anthropic.APIError) && !(error instanceof Anthropic.APIUserAbortError) && jsonRetries < 2 && !request.signal?.aborted) {
          jsonRetries += 1;
          continue;
        }
        throw classifyError(error);
      }
    }
    return {
      model: message.model,
      content: message.content.map(fromContentBlock),
      stopReason: mapStopReason(message.stop_reason),
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}

function toMessageParam(message: AgentModelRequest['messages'][number]): Anthropic.MessageParam {
  return { role: message.role, content: message.content.map(toContentBlockParam) };
}

function toContentBlockParam(block: AgentContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: block.toolUseId, content: block.content, is_error: block.isError };
    case 'opaque':
      if (block.provider !== ANTHROPIC_PROVIDER_ID) {
        throw new AgentModelFailure('BAD_REQUEST', `cannot replay a ${block.provider} block to ${ANTHROPIC_PROVIDER_ID}`);
      }
      return block.payload as Anthropic.ContentBlockParam;
  }
}

function fromContentBlock(block: Anthropic.ContentBlock): AgentContentBlock {
  if (block.type === 'text') return { type: 'text', text: block.text };
  if (block.type === 'tool_use') return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
  // 思考块、编辑过的思考块等：原样保留，下一次调用原序回放
  return { type: 'opaque', provider: ANTHROPIC_PROVIDER_ID, payload: block };
}

function mapStopReason(reason: Anthropic.StopReason | null): AgentStopReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'end_turn';
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    case 'pause_turn':
      return 'pause_turn';
    default:
      return 'other';
  }
}

function classifyError(error: unknown): AgentModelFailure {
  if (error instanceof AgentModelFailure) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new AgentModelFailure('TRANSIENT', 'model request aborted');
  if (error instanceof Anthropic.APIConnectionError) return new AgentModelFailure('TRANSIENT', 'model connection failed');
  if (error instanceof Anthropic.RateLimitError) return new AgentModelFailure('RATE_LIMITED', 'model rate limited', 429);
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new AgentModelFailure('AUTH', 'model credentials rejected', error.status);
  }
  if (error instanceof Anthropic.BadRequestError) return new AgentModelFailure('BAD_REQUEST', truncate(error.message), 400);
  if (error instanceof Anthropic.APIError) {
    const status = typeof error.status === 'number' ? error.status : null;
    if (status === 529) return new AgentModelFailure('OVERLOADED', 'model overloaded', 529);
    if (status !== null && status >= 500) return new AgentModelFailure('TRANSIENT', `model server error ${String(status)}`, status);
    return new AgentModelFailure('BAD_REQUEST', truncate(error.message), status);
  }
  return new AgentModelFailure('TRANSIENT', 'model response could not be parsed');
}

function truncate(text: string): string {
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
}
