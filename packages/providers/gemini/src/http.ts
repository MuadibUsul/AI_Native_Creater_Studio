/**
 * Gemini API（https://ai.google.dev）的最小 HTTP 层：鉴权头、超时、错误归一。
 *
 * - 密钥只放在请求头 `x-goog-api-key`，不拼进 URL、不写日志、不进错误信息；
 * - 错误信息取供应商返回的 `error.message`（截断），状态码原样保留，由调用方分类（模型调用 / 付费生成各有规则）。
 */

import { requestNeverSent } from '@ancs/contracts';

export const GEMINI_DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiHttpOptions {
  apiKey: string;
  /** 缺省 https://generativelanguage.googleapis.com/v1beta（测试可指向本地替身） */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export class GeminiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly providerStatus: string | null = null,
    /** 供应商建议的等待时间（429 的 RetryInfo.retryDelay） */
    readonly retryAfterMs: number | null = null,
    /** 用完的是按天计的配额（等几十秒也不会恢复） */
    readonly dailyQuota = false,
    /** 请求确定没有发出去（DNS / 拒绝连接 / 出网代理拦截）：供应商不可能收到 */
    readonly neverSent = false,
  ) {
    super(message);
    this.name = 'GeminiHttpError';
  }
}

export interface GeminiHttp {
  readonly baseUrl: string;
  postJson<T>(path: string, body: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<T>;
  getJson<T>(path: string): Promise<T>;
  /** 下载供应商给的文件链接（Gemini 文件链接同样要求密钥头；只对同源链接带密钥） */
  download(uri: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
}

export function truncate(text: string, limit = 300): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

/**
 * 限流 / 过载时的等待：优先用供应商给的 retryDelay（最多 60 秒），否则指数退避；按天的配额用完不重试（返回 null）。
 */
export function retryDelayMs(error: unknown, attempt: number): number | null {
  if (!(error instanceof GeminiHttpError)) return null;
  const retryable = error.status === null || error.status === 429 || error.status >= 500;
  if (!retryable || error.dailyQuota) return null;
  if (error.retryAfterMs !== null) return error.retryAfterMs <= 60_000 ? error.retryAfterMs + 250 : null;
  return 2_000 * 2 ** attempt;
}

async function failure(response: Response): Promise<GeminiHttpError> {
  const raw = await response.text().catch(() => '');
  let message = raw.replace(/\s+/g, ' ').trim();
  let providerStatus: string | null = null;
  let retryAfterMs: number | null = null;
  let dailyQuota = false;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown; status?: unknown; details?: { '@type'?: unknown; retryDelay?: unknown; violations?: { quotaId?: unknown }[] }[] } };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.status === 'string') providerStatus = body.error.status;
    for (const detail of body.error?.details ?? []) {
      const delay = typeof detail.retryDelay === 'string' ? /^(\d+(?:\.\d+)?)s$/.exec(detail.retryDelay) : null;
      if (delay !== null) retryAfterMs = Math.ceil(Number(delay[1]) * 1000);
      if ((detail.violations ?? []).some((violation) => typeof violation.quotaId === 'string' && /PerDay/i.test(violation.quotaId))) dailyQuota = true;
    }
  } catch {
    // 非 JSON 错误体：保留压缩后的文本
  }
  const header = Number(response.headers.get('retry-after'));
  if (retryAfterMs === null && Number.isFinite(header) && header > 0) retryAfterMs = header * 1000;
  return new GeminiHttpError(truncate(message.length > 0 ? message : `HTTP ${String(response.status)}`), response.status, providerStatus, retryAfterMs, dailyQuota);
}

export function createGeminiHttp(options: GeminiHttpOptions): GeminiHttp {
  if (options.apiKey.trim().length === 0) throw new Error('Gemini API key is required');
  const baseUrl = (options.baseUrl ?? GEMINI_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const origin = new URL(baseUrl).origin;
  const doFetch = options.fetch ?? globalThis.fetch;
  const defaultTimeout = options.timeoutMs ?? 600_000;
  const key = { 'x-goog-api-key': options.apiKey };

  const send = async (url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> => {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: signal === undefined ? timeout : AbortSignal.any([timeout, signal]) });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const what = name === 'TimeoutError' ? `no response within ${String(Math.round(timeoutMs / 1000))} s` : name === 'AbortError' ? 'request aborted' : 'connection failed';
      // 带上主机名（不含路径与查询串）：下载跳转到的主机被网络策略拦下时，一眼看出要放行哪个域名
      const neverSent = requestNeverSent(error);
      throw new GeminiHttpError(`Gemini ${what} (${new URL(url).host}${neverSent ? '; the request was never sent' : ''})`, null, null, null, false, neverSent);
    }
    const redirected = init.redirect === 'manual' && response.status >= 300 && response.status < 400;
    if (!response.ok && !redirected) throw await failure(response);
    return response;
  };

  return {
    baseUrl,
    async postJson<T>(path: string, body: unknown, request?: { signal?: AbortSignal; timeoutMs?: number }) {
      const response = await send(`${baseUrl}${path}`, { method: 'POST', headers: { ...key, 'content-type': 'application/json' }, body: JSON.stringify(body) }, request?.timeoutMs ?? defaultTimeout, request?.signal);
      return await response.json() as T;
    },
    async getJson<T>(path: string) {
      const response = await send(`${baseUrl}${path}`, { method: 'GET', headers: key }, Math.min(defaultTimeout, 120_000));
      return await response.json() as T;
    },
    async download(uri, request) {
      // 只对 API 同源链接带密钥，且不自动跟随跳转：跳转目标（存储域名）不带密钥地另行请求，密钥不会被转发出去
      let response = await send(uri, { method: 'GET', headers: new URL(uri).origin === origin ? key : {}, redirect: 'manual' }, defaultTimeout);
      for (let hops = 0; response.status >= 300 && response.status < 400; hops += 1) {
        const location = response.headers.get('location');
        if (location === null || hops >= 5) throw new GeminiHttpError('the file link redirected without a usable target', response.status);
        const next = new URL(location, uri).toString();
        response = await send(next, { method: 'GET', headers: new URL(next).origin === origin ? key : {}, redirect: 'manual' }, defaultTimeout);
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (request?.maxBytes !== undefined && bytes.byteLength > request.maxBytes) throw new GeminiHttpError('the downloaded file is larger than allowed', response.status);
      return bytes;
    },
  };
}
