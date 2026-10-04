import type { ZodType } from 'zod';
import {
  echoRequestSchema,
  echoResponseSchema,
  errorEnvelopeSchema,
  healthResponseSchema,
  type EchoRequest,
  type EchoResponse,
  type HealthResponse,
} from '@ancs/contracts';

/** API 返回统一错误信封时抛出的错误（规范 §33）。 */
export class AncsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: Record<string, unknown>;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'AncsApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.details = params.details;
  }
}

export interface ClientOptions {
  /** 例：https://api.example.com（无尾斜杠处理） */
  baseUrl: string;
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch;
}

export interface AncsClient {
  health(): Promise<HealthResponse>;
  echo(input: EchoRequest): Promise<EchoResponse>;
}

/**
 * 最小 SDK 基线（P00-03）。P01-05 将扩展为完整客户端：
 * 认证头、X-Client-Type/X-Client-Version、重试与超时策略。
 */
export function createClient(options: ClientOptions): AncsClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;

  async function request<T>(method: 'GET' | 'POST', path: string, schema: ZodType<T>, body?: unknown): Promise<T> {
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const parsed = errorEnvelopeSchema.safeParse(payload);
      if (parsed.success) {
        throw new AncsApiError({ status: response.status, ...parsed.data.error });
      }
      throw new AncsApiError({
        status: response.status,
        code: 'UNPARSEABLE_ERROR',
        message: `HTTP ${response.status}（响应不符合统一错误信封）`,
        requestId: '',
        details: {},
      });
    }

    return schema.parse(payload);
  }

  return {
    health: () => request('GET', '/api/v1/health', healthResponseSchema),
    // async 包装：客户端校验失败也以 Promise rejection 形式抛出（而不是同步抛出）
    echo: async (input) => request('POST', '/api/v1/echo', echoResponseSchema, echoRequestSchema.parse(input)),
  };
}
