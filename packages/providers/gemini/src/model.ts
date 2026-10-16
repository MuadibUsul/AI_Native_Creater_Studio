import {
  AgentModelFailure,
  type AgentContentBlock,
  type AgentEffort,
  type AgentModelAdapter,
  type AgentModelMessage,
  type AgentModelRequest,
  type AgentModelResponse,
  type AgentStopReason,
} from '@ancs/contracts';
import { GeminiHttpError, createGeminiHttp, retryDelayMs, truncate, type GeminiHttp, type GeminiHttpOptions } from './http.js';

/**
 * Gemini 模型适配器（V6 §8 Agent Runtime 的模型端口实现，与 Anthropic 适配器并列；导演、视觉理解、风格撰写共用）。
 *
 * - generateContent：系统提示 → systemInstruction；工具 → functionDeclarations（`parametersJsonSchema` 直接用工具的 JSON Schema）；
 * - 思考签名（thoughtSignature）挂在模型返回的分片上，必须原样回放：转成紧挨在对应块前面的 `opaque` 块，
 *   回放时再挂回下一个分片；无法表示的分片（思考摘要、仅签名的空分片等）整片存成 `opaque`，原序回放；
 * - 工具结果 → functionResponse（按工具调用 id 找回工具名）；工具返回的图像作为同一轮的 inlineData 分片跟在后面；
 * - 限流 / 过载 / 5xx / 连接失败：有界重试（缺省 2 次，指数退避），仍失败则分类为可重试的 `AgentModelFailure` 交给工作流；
 *   `MALFORMED_FUNCTION_CALL`（模型写坏了工具调用）原样重发至多 2 次；
 * - 价格：本仓库没有可核对的 Gemini 公开价，用量照记、成本记为"未定价"（`agentModelCostMicros` 返回 null），不臆造。
 * 凭据由入口注入（业务包不读 process.env），只存在于服务端进程。
 */

export const GEMINI_PROVIDER_ID = 'gemini';

/** 别的供应商写的工具调用回放给 Gemini 时，用文档给出的占位签名跳过签名校验 */
const FOREIGN_CALL_SIGNATURE = 'skip_thought_signature_validator';
/** 模型没给调用 id 时本地生成的前缀（回放时不送给供应商） */
const LOCAL_CALL_PREFIX = 'gemini_call_';

export interface GeminiAgentModelOptions extends GeminiHttpOptions {
  model: string;
  /** 429 / 503 / 5xx / 连接失败的重试次数（缺省 2；付费调用有界重试） */
  maxRetries?: number;
  /** effort → thinkingLevel（Gemini 3 系列）；不支持思考档位的模型设为 false */
  thinkingLevels?: boolean;
  wait?: (ms: number) => Promise<void>;
}

type Part = Record<string, unknown> & {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name?: string; args?: unknown };
};

interface GenerateResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
    toolUsePromptTokenCount?: number;
  };
  modelVersion?: string;
}

type GeminiOpaque = { kind: 'signature'; thoughtSignature: string } | { kind: 'part'; part: Part };

const sleep = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

function thinkingLevel(effort: AgentEffort): 'low' | 'medium' | 'high' {
  if (effort === 'low') return 'low';
  if (effort === 'medium') return 'medium';
  return 'high';
}

/** 工具的 JSON Schema 去掉 Gemini 不接受的元字段（$schema 等），其余原样保留 */
export function toGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

export function toGeminiContents(messages: readonly AgentModelMessage[]): { role: 'user' | 'model'; parts: Part[] }[] {
  const toolNames = new Map<string, string>();
  for (const message of messages) {
    for (const block of message.content) if (block.type === 'tool_use') toolNames.set(block.id, block.name);
  }
  return messages.map((message) => {
    const parts: Part[] = [];
    const trailingImages: Part[] = [];
    let signature: string | null = null;
    let signedCall = false;
    const push = (part: Part) => {
      if (signature !== null) {
        parts.push({ ...part, thoughtSignature: signature });
        signature = null;
      } else {
        parts.push(part);
      }
    };
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          if (block.text.length > 0 || signature !== null) push({ text: block.text });
          break;
        case 'image':
          push({ inlineData: { mimeType: block.image.mediaType, data: block.image.data } });
          break;
        case 'tool_use': {
          const call = { ...(block.id.startsWith(LOCAL_CALL_PREFIX) ? {} : { id: block.id }), name: block.name, args: block.input ?? {} };
          if (signature === null && !signedCall && message.role === 'assistant') signature = FOREIGN_CALL_SIGNATURE;
          signedCall = true;
          push({ functionCall: call });
          break;
        }
        case 'tool_result':
          push({
            functionResponse: {
              ...(block.toolUseId.startsWith(LOCAL_CALL_PREFIX) ? {} : { id: block.toolUseId }),
              name: toolNames.get(block.toolUseId) ?? 'unknown_tool',
              response: block.isError ? { error: block.content } : { result: block.content },
            },
          });
          for (const image of block.images ?? []) trailingImages.push({ inlineData: { mimeType: image.mediaType, data: image.data } });
          break;
        case 'opaque': {
          if (block.provider !== GEMINI_PROVIDER_ID) {
            throw new AgentModelFailure('BAD_REQUEST', `cannot replay a ${block.provider} block to ${GEMINI_PROVIDER_ID}`);
          }
          const payload = block.payload as GeminiOpaque;
          if (payload.kind === 'signature') {
            signature = payload.thoughtSignature;
          } else {
            parts.push(payload.part);
            if (payload.part.functionCall !== undefined) signedCall = true;
          }
          break;
        }
      }
    }
    parts.push(...trailingImages);
    if (parts.length === 0) parts.push({ text: message.role === 'assistant' ? '(no reply)' : '(empty)' });
    return { role: message.role === 'assistant' ? 'model' as const : 'user' as const, parts };
  });
}

export function fromGeminiParts(parts: readonly Part[]): AgentContentBlock[] {
  const blocks: AgentContentBlock[] = [];
  let calls = 0;
  const opaque = (payload: GeminiOpaque): AgentContentBlock => ({ type: 'opaque', provider: GEMINI_PROVIDER_ID, payload });
  for (const part of parts) {
    const signature = typeof part.thoughtSignature === 'string' ? part.thoughtSignature : null;
    if (part.thought === true) {
      blocks.push(opaque({ kind: 'part', part }));
    } else if (part.functionCall !== undefined && typeof part.functionCall.name === 'string') {
      if (signature !== null) blocks.push(opaque({ kind: 'signature', thoughtSignature: signature }));
      calls += 1;
      const id = typeof part.functionCall.id === 'string' && part.functionCall.id.length > 0 ? part.functionCall.id : `${LOCAL_CALL_PREFIX}${String(calls)}`;
      blocks.push({ type: 'tool_use', id, name: part.functionCall.name, input: part.functionCall.args ?? {} });
    } else if (typeof part.text === 'string' && part.text.length > 0) {
      if (signature !== null) blocks.push(opaque({ kind: 'signature', thoughtSignature: signature }));
      blocks.push({ type: 'text', text: part.text });
    } else {
      blocks.push(opaque({ kind: 'part', part }));
    }
  }
  return blocks;
}

function stopReason(finishReason: string | undefined, blocks: readonly AgentContentBlock[], blocked: boolean): AgentStopReason {
  if (blocked) return 'refusal';
  if (blocks.some((block) => block.type === 'tool_use')) return 'tool_use';
  switch (finishReason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'refusal';
    default:
      return 'other';
  }
}

export function classifyGeminiError(error: unknown): AgentModelFailure {
  if (error instanceof AgentModelFailure) return error;
  if (error instanceof GeminiHttpError) {
    const status = error.status;
    if (status === null) return new AgentModelFailure('TRANSIENT', truncate(error.message));
    if (status === 429) return new AgentModelFailure('RATE_LIMITED', 'model rate limited or out of quota', 429);
    if (status === 503) return new AgentModelFailure('OVERLOADED', 'model overloaded', 503);
    // Google 对无效密钥回 400 INVALID_ARGUMENT（"API key not valid"），按鉴权失败处理（2026-10-14 真实回应）
    if (status === 401 || status === 403 || /API key not valid|API_KEY_INVALID/i.test(error.message)) return new AgentModelFailure('AUTH', 'model credentials rejected', status);
    if (status >= 500) return new AgentModelFailure('TRANSIENT', `model server error ${String(status)}`, status);
    if (/token count|too many tokens|exceeds the maximum number of tokens|context (window|length)/i.test(error.message)) {
      return new AgentModelFailure('CONTEXT_TOO_LONG', truncate(error.message), status);
    }
    return new AgentModelFailure('BAD_REQUEST', truncate(error.message), status);
  }
  return new AgentModelFailure('TRANSIENT', 'model response could not be parsed');
}

export class GeminiAgentModel implements AgentModelAdapter {
  readonly providerId = GEMINI_PROVIDER_ID;
  readonly implementation = 'REAL' as const;
  readonly model: string;
  private readonly http: GeminiHttp;
  private readonly maxRetries: number;
  private readonly thinkingLevels: boolean;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(options: GeminiAgentModelOptions) {
    this.model = options.model;
    this.http = createGeminiHttp(options);
    this.maxRetries = options.maxRetries ?? 2;
    this.thinkingLevels = options.thinkingLevels ?? true;
    this.wait = options.wait ?? sleep;
  }

  async respond(request: AgentModelRequest): Promise<AgentModelResponse> {
    const body = {
      systemInstruction: { parts: [{ text: request.system }] },
      contents: toGeminiContents(request.messages),
      ...(request.tools.length === 0 ? {} : {
        tools: [{ functionDeclarations: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parametersJsonSchema: toGeminiSchema(tool.inputSchema) })) }],
        toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      }),
      generationConfig: {
        maxOutputTokens: request.maxOutputTokens,
        ...(this.thinkingLevels ? { thinkingConfig: { thinkingLevel: thinkingLevel(request.effort) } } : {}),
      },
    };
    const signal = request.signal instanceof AbortSignal ? request.signal : undefined;
    let attempt = 0;
    let malformed = 0;
    for (;;) {
      let response: GenerateResponse;
      try {
        response = await this.http.postJson<GenerateResponse>(`/models/${encodeURIComponent(this.model)}:generateContent`, body, signal === undefined ? undefined : { signal });
      } catch (error) {
        const failure = classifyGeminiError(error);
        const delay = attempt < this.maxRetries && request.signal?.aborted !== true ? retryDelayMs(error, attempt) : null;
        if (failure.retryable && delay !== null) {
          attempt += 1;
          await this.wait(delay);
          continue;
        }
        throw failure;
      }
      const candidate = response.candidates?.[0];
      if (candidate?.finishReason === 'MALFORMED_FUNCTION_CALL' && malformed < 2 && request.signal?.aborted !== true) {
        malformed += 1;
        continue;
      }
      const blocks = fromGeminiParts(candidate?.content?.parts ?? []);
      const usage = response.usageMetadata ?? {};
      const cached = usage.cachedContentTokenCount ?? 0;
      return {
        model: response.modelVersion ?? this.model,
        content: blocks,
        stopReason: stopReason(candidate?.finishReason, blocks, candidate === undefined && response.promptFeedback?.blockReason !== undefined),
        usage: {
          inputTokens: Math.max(0, (usage.promptTokenCount ?? 0) + (usage.toolUsePromptTokenCount ?? 0) - cached),
          outputTokens: (usage.candidatesTokenCount ?? 0) + (usage.thoughtsTokenCount ?? 0),
          cacheReadInputTokens: cached,
          cacheCreationInputTokens: 0,
        },
      };
    }
  }
}
