import type { ResultFetcher } from '@ancs/contracts';

/**
 * HTTP 结果拉取器（P03-06）：一次性下载 Provider 临时结果（§75 第 5 条：URL 不作永久标识）。
 *
 * - 大小上限（默认 512 MiB）：按 content-length 预检 + 流式累计（防止超大响应拖垮进程）；
 * - 超时（默认 60s）；非 2xx 一律失败（交由回收重试，不重新生成）；
 * - 不做重定向跟随以外的授权（Provider 签名 URL 自带权限）；响应体不写日志。
 */
export function createHttpResultFetcher(options: { timeoutMs?: number; defaultMaxBytes?: number } = {}): ResultFetcher {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const defaultMaxBytes = options.defaultMaxBytes ?? 512 * 1024 * 1024;
  return {
    kind: 'http',
    async fetch(input: { url: string; maxBytes?: number }) {
      const maxBytes = input.maxBytes ?? defaultMaxBytes;
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await fetch(input.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`结果下载失败：HTTP ${String(response.status)}`);
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (Number.isFinite(declared) && declared > maxBytes) {
          throw new Error(`结果超过大小上限：declared=${String(declared)} max=${String(maxBytes)}`);
        }
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > maxBytes) {
          throw new Error(`结果超过大小上限：actual=${String(bytes.byteLength)} max=${String(maxBytes)}`);
        }
        return { bytes, contentType: response.headers.get('content-type') };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
