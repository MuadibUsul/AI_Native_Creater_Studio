/**
 * 火山方舟（Volcengine Ark，https://ark.cn-beijing.volces.com/api/v3）：当前接入 Seedance 视频生成任务。
 *
 * - 鉴权：`Authorization: Bearer <ARK_API_KEY>`，只放请求头；不写日志、不进错误信息；
 * - 生成任务：POST /contents/generations/tasks（model + content[文字提示] + ratio / duration / generate_audio / watermark），
 *   GET /contents/generations/tasks/{id} 轮询 queued → running → succeeded / failed / cancelled；
 * - 成片链接是对象存储的临时签名链接：下载时**从不带密钥**（与 API 不同源），并限制大小；
 * - 计费与重试规则在调用方（付费生成执行器）：这里只做 HTTP 与格式。
 */

export const ARK_DEFAULT_BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

export class ArkHttpError extends Error {
  constructor(message: string, readonly status: number | null, readonly code: string | null = null) {
    super(message);
    this.name = 'ArkHttpError';
  }
}

export interface ArkHttpOptions {
  apiKey: string;
  /** 缺省北京区域；海外（BytePlus ModelArk）或测试替身可改 */
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const truncate = (text: string, limit = 300): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

async function failure(response: Response): Promise<ArkHttpError> {
  const raw = await response.text().catch(() => '');
  let message = raw.replace(/\s+/g, ' ').trim();
  let code: string | null = null;
  try {
    const body = JSON.parse(raw) as { error?: { message?: unknown; code?: unknown } };
    if (typeof body.error?.message === 'string') message = body.error.message;
    if (typeof body.error?.code === 'string') code = body.error.code;
  } catch {
    // 非 JSON 错误体：保留压缩后的文本
  }
  return new ArkHttpError(truncate(`${code === null ? '' : `${code}: `}${message.length > 0 ? message : `HTTP ${String(response.status)}`}`), response.status, code);
}

export interface ArkHttp {
  readonly baseUrl: string;
  postJson<T>(path: string, body: unknown): Promise<T>;
  getJson<T>(path: string): Promise<T>;
  /** 下载成片（对象存储签名链接）：不带密钥，最多跟随 5 次跳转 */
  download(uri: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
}

export function createArkHttp(options: ArkHttpOptions): ArkHttp {
  if (options.apiKey.trim().length === 0) throw new Error('Ark API key is required');
  const baseUrl = (options.baseUrl ?? ARK_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const auth = { authorization: `Bearer ${options.apiKey}` };
  const send = async (url: string, init: RequestInit, ms: number): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      throw new ArkHttpError(`Ark ${name === 'TimeoutError' ? `gave no response within ${String(Math.round(ms / 1000))} s` : 'connection failed'} (${new URL(url).host})`, null);
    }
    if (!response.ok) throw await failure(response);
    return response;
  };
  return {
    baseUrl,
    async postJson<T>(path: string, body: unknown) {
      const response = await send(`${baseUrl}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
      return await response.json() as T;
    },
    async getJson<T>(path: string) {
      const response = await send(`${baseUrl}${path}`, { method: 'GET', headers: auth }, timeoutMs);
      return await response.json() as T;
    },
    async download(uri, request) {
      if (!/^https?:\/\//.test(uri)) throw new ArkHttpError('unexpected video link', null);
      const response = await send(uri, { method: 'GET', redirect: 'follow' }, 600_000);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (request?.maxBytes !== undefined && bytes.byteLength > request.maxBytes) throw new ArkHttpError('the downloaded file is larger than allowed', response.status);
      return bytes;
    },
  };
}

// ---------------------------------------------------------------------------
// Seedance 视频生成
// ---------------------------------------------------------------------------

/** Seedance 支持的画面比例 */
export const SEEDANCE_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export type SeedanceRatio = (typeof SEEDANCE_RATIOS)[number];

/** 按画布宽高取最接近的比例（对数距离） */
export function nearestSeedanceRatio(width: number, height: number): SeedanceRatio {
  const target = Math.log(width / height);
  let best: SeedanceRatio = '16:9';
  let distance = Number.POSITIVE_INFINITY;
  for (const ratio of SEEDANCE_RATIOS) {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    const d = Math.abs(Math.log(w / h) - target);
    if (d < distance) { distance = d; best = ratio; }
  }
  return best;
}

export interface SeedanceRequest {
  prompt: string;
  /** 整数秒（报价依据的档位之一） */
  durationSeconds: number;
  ratio: SeedanceRatio;
  generateAudio: boolean;
  /** 不传则用模型缺省分辨率 */
  resolution?: string;
}

export type SeedanceTaskState =
  | { done: false; status: string }
  | { done: true; videoUri: string; error: null; filtered: null; tokens: number | null }
  | { done: true; videoUri: null; error: string | null; filtered: string | null; tokens: number | null };

interface TaskResponse {
  id?: string;
  status?: string;
  content?: { video_url?: string };
  error?: { code?: string; message?: string } | null;
  usage?: { completion_tokens?: number; total_tokens?: number };
}

export interface Seedance {
  readonly model: string;
  start(request: SeedanceRequest): Promise<string>;
  poll(taskId: string): Promise<SeedanceTaskState>;
  download(uri: string): Promise<Uint8Array>;
}

export function createSeedance(options: ArkHttpOptions & { model: string; http?: ArkHttp }): Seedance {
  const http = options.http ?? createArkHttp(options);
  return {
    model: options.model,
    async start(request) {
      if (!Number.isInteger(request.durationSeconds) || request.durationSeconds < 1) throw new ArkHttpError('Seedance needs a whole number of seconds', null);
      const response = await http.postJson<TaskResponse>('/contents/generations/tasks', {
        model: options.model,
        content: [{ type: 'text', text: request.prompt }],
        ratio: request.ratio,
        duration: request.durationSeconds,
        generate_audio: request.generateAudio,
        watermark: false,
        ...(request.resolution === undefined ? {} : { resolution: request.resolution }),
      });
      if (typeof response.id !== 'string' || response.id.length === 0) throw new ArkHttpError('Seedance did not return a task id', null);
      return response.id;
    },
    async poll(taskId) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw new ArkHttpError('unexpected Seedance task id', null);
      const task = await http.getJson<TaskResponse>(`/contents/generations/tasks/${taskId}`);
      const status = task.status ?? 'unknown';
      const tokens = typeof task.usage?.completion_tokens === 'number' ? task.usage.completion_tokens : null;
      if (status === 'queued' || status === 'running') return { done: false, status };
      if (status === 'succeeded') {
        const uri = task.content?.video_url;
        if (typeof uri === 'string' && uri.length > 0) return { done: true, videoUri: uri, error: null, filtered: null, tokens };
        return { done: true, videoUri: null, error: 'the task succeeded without a video link', filtered: null, tokens };
      }
      const code = task.error?.code ?? null;
      const message = truncate(`${code === null ? '' : `${code}: `}${task.error?.message ?? status}`);
      // 内容审核拦下（输入或输出含敏感内容）单独标出
      if (code !== null && /Sensitive|Risk|Moderation/i.test(code)) return { done: true, videoUri: null, error: null, filtered: message, tokens };
      return { done: true, videoUri: null, error: message, filtered: null, tokens };
    },
    download(uri) {
      return http.download(uri, { maxBytes: 512 * 1024 * 1024 });
    },
  };
}
