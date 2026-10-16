/**
 * Runway（https://dev.runwayml.com）：当前接入 gen4_aleph 视频转视频，用于"选区重绘"——把被重绘的那一段原片连同一句话交给
 * Runway 改写，平台再只取框内（框外保持原片并测量供应商是否改了框外）。
 *
 * - 鉴权：`Authorization: Bearer <RUNWAYML_API_SECRET>` + `X-Runway-Version`，只放请求头；不写日志、不进错误信息；
 * - 提交：POST /video_to_video（model、videoUri、promptText、ratio）→ 任务 id；轮询 GET /tasks/{id}：
 *   PENDING / THROTTLED / RUNNING → SUCCEEDED（output 为成片链接）/ FAILED（failure、failureCode）/ CANCELLED；
 * - 免费的只读检查：GET /organization（剩余额度）；
 * - 成片链接是临时链接：下载时**从不带密钥**；
 * - 计费与重试规则在调用方（付费生成执行器）：这里只做 HTTP 与格式。
 * 接口形状按 Runway 公开文档编写，已用本地替身测试；真实服务待网络放行后验证（见 docs/verification/provider-network-report.md）。
 */
import { requestNeverSent } from '@ancs/contracts';

export const RUNWAY_DEFAULT_BASE_URL = 'https://api.dev.runwayml.com/v1';
export const RUNWAY_API_VERSION = '2024-11-06';

export class RunwayHttpError extends Error {
  /** neverSent：请求确定没有发出去（DNS / 拒绝连接 / 出网代理拦截，或本地就拒绝发送），供应商不可能收到 */
  constructor(message: string, readonly status: number | null, readonly code: string | null = null, readonly neverSent = false) {
    super(message);
    this.name = 'RunwayHttpError';
  }
}

export interface RunwayHttpOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

const truncate = (text: string, limit = 300): string => (text.length <= limit ? text : `${text.slice(0, limit)}…`);

async function failure(response: Response): Promise<RunwayHttpError> {
  const raw = await response.text().catch(() => '');
  let message = raw.replace(/\s+/g, ' ').trim();
  let code: string | null = null;
  try {
    const body = JSON.parse(raw) as { error?: unknown; code?: unknown; message?: unknown };
    if (typeof body.error === 'string') message = body.error;
    else if (typeof (body.error as { message?: unknown } | undefined)?.message === 'string') message = String((body.error as { message: string }).message);
    else if (typeof body.message === 'string') message = body.message;
    if (typeof body.code === 'string') code = body.code;
  } catch {
    // 非 JSON 错误体：保留压缩后的文本
  }
  return new RunwayHttpError(truncate(message.length > 0 ? message : `HTTP ${String(response.status)}`), response.status, code);
}

export interface RunwayHttp {
  postJson<T>(path: string, body: unknown): Promise<T>;
  getJson<T>(path: string): Promise<T>;
  download(uri: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
}

export function createRunwayHttp(options: RunwayHttpOptions): RunwayHttp {
  if (options.apiKey.trim().length === 0) throw new Error('Runway API key is required');
  const baseUrl = (options.baseUrl ?? RUNWAY_DEFAULT_BASE_URL).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 300_000;
  const headers = { authorization: `Bearer ${options.apiKey}`, 'x-runway-version': RUNWAY_API_VERSION };
  const send = async (url: string, init: RequestInit, ms: number): Promise<Response> => {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(ms) });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      const neverSent = requestNeverSent(error);
      throw new RunwayHttpError(`Runway ${name === 'TimeoutError' ? `gave no response within ${String(Math.round(ms / 1000))} s` : 'connection failed'} (${new URL(url).host}${neverSent ? '; the request was never sent' : ''})`, null, null, neverSent);
    }
    if (!response.ok) throw await failure(response);
    return response;
  };
  return {
    async postJson<T>(path: string, body: unknown) {
      const response = await send(`${baseUrl}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
      return await response.json() as T;
    },
    async getJson<T>(path: string) {
      const response = await send(`${baseUrl}${path}`, { method: 'GET', headers }, 120_000);
      return await response.json() as T;
    },
    async download(uri, request) {
      if (!/^https?:\/\//.test(uri)) throw new RunwayHttpError('unexpected video link', null);
      const response = await send(uri, { method: 'GET', redirect: 'follow' }, 600_000);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (request?.maxBytes !== undefined && bytes.byteLength > request.maxBytes) throw new RunwayHttpError('the downloaded file is larger than allowed', response.status);
      return bytes;
    },
  };
}

/** 剩余额度（免费的只读检查，验证网络与鉴权） */
export async function runwayOrganization(http: RunwayHttp): Promise<{ creditBalance: number | null }> {
  const body = await http.getJson<{ creditBalance?: unknown }>('/organization');
  return { creditBalance: typeof body.creditBalance === 'number' ? body.creditBalance : null };
}

// ---------------------------------------------------------------------------
// gen4_aleph 视频转视频
// ---------------------------------------------------------------------------

/** gen4_aleph 支持的输出比例（宽:高 像素） */
export const RUNWAY_ALEPH_RATIOS = ['1280:720', '720:1280', '1104:832', '960:960', '832:1104', '1584:672', '848:480', '640:480'] as const;
export type RunwayRatio = (typeof RUNWAY_ALEPH_RATIOS)[number];

/** 按画布宽高取最接近的比例；相差不到 1% 的几档视为一样接近，取像素多的（4:3 取 1104:832 而不是 640:480） */
export function nearestRunwayRatio(width: number, height: number): RunwayRatio {
  const target = Math.log(width / height);
  const scored = RUNWAY_ALEPH_RATIOS.map((ratio) => {
    const [w, h] = ratio.split(':').map(Number) as [number, number];
    return { ratio, distance: Math.abs(Math.log(w / h) - target), pixels: w * h };
  });
  const closest = Math.min(...scored.map((item) => item.distance));
  return scored.filter((item) => item.distance <= closest + 0.01).sort((left, right) => right.pixels - left.pixels)[0]!.ratio;
}

export type RunwayTaskState =
  | { done: false; status: string }
  | { done: true; videoUri: string; error: null; filtered: null }
  | { done: true; videoUri: null; error: string | null; filtered: string | null };

interface TaskResponse { id?: string; status?: string; output?: unknown; failure?: string; failureCode?: string }

export interface RunwayAleph {
  readonly model: string;
  /** videoUri：https 链接或 data:video/mp4;base64,… */
  start(request: { promptText: string; videoUri: string; ratio: RunwayRatio; seed?: number }): Promise<string>;
  poll(taskId: string): Promise<RunwayTaskState>;
  download(uri: string): Promise<Uint8Array>;
}

export function createRunwayAleph(options: RunwayHttpOptions & { model?: string; http?: RunwayHttp }): RunwayAleph {
  const http = options.http ?? createRunwayHttp(options);
  const model = options.model ?? 'gen4_aleph';
  return {
    model,
    async start(request) {
      const response = await http.postJson<TaskResponse>('/video_to_video', {
        model,
        videoUri: request.videoUri,
        promptText: request.promptText,
        ratio: request.ratio,
        ...(request.seed === undefined ? {} : { seed: request.seed }),
      });
      if (typeof response.id !== 'string' || response.id.length === 0) throw new RunwayHttpError('Runway did not return a task id', null);
      return response.id;
    },
    async poll(taskId) {
      if (!/^[A-Za-z0-9-]{1,128}$/.test(taskId)) throw new RunwayHttpError('unexpected Runway task id', null);
      const task = await http.getJson<TaskResponse>(`/tasks/${taskId}`);
      const status = task.status ?? 'UNKNOWN';
      if (status === 'PENDING' || status === 'THROTTLED' || status === 'RUNNING') return { done: false, status };
      if (status === 'SUCCEEDED') {
        const first = Array.isArray(task.output) ? task.output.find((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
        return first === undefined
          ? { done: true, videoUri: null, error: 'the task succeeded without a video link', filtered: null }
          : { done: true, videoUri: first, error: null, filtered: null };
      }
      const code = task.failureCode ?? null;
      const message = truncate(`${code === null ? '' : `${code}: `}${task.failure ?? status}`);
      // 内容审核拦下（SAFETY.*）单独标出
      if (code !== null && /^SAFETY/i.test(code)) return { done: true, videoUri: null, error: null, filtered: message };
      return { done: true, videoUri: null, error: message, filtered: null };
    },
    download(uri) {
      return http.download(uri, { maxBytes: 512 * 1024 * 1024 });
    },
  };
}
