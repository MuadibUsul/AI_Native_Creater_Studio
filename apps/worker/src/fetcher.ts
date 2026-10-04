import type { ResultFetcher } from '@ancs/contracts';

/**
 * HTTP 结果拉取器（P03-06）：Worker 侧实现（apps 之间不得互相依赖，R1）。
 * 语义与 apps/api 的同名实现一致：一次性下载、大小上限、超时、非 2xx 失败。
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
        if (!response.ok) throw new Error(`结果下载失败：HTTP ${String(response.status)}`);
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
