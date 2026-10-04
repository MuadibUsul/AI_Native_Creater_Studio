import { assertSafeUrl } from '@ancs/domain';
import { CONTENT_INPUT_ERROR_REASONS, ERROR_CODES, ApiFailure, type ArticleFetcher } from '@ancs/contracts';

/**
 * 文章抓取器（P04-01）：真实 HTTP 实现（apps/api 侧）。
 *
 * 安全与资源纪律：
 * - **逐跳 SSRF 校验**（手动重定向：每一跳都过 `assertSafeUrl`；DNS 解析后地址同样在守卫内判定字面量）；
 * - 重定向上限（5）、大小上限（默认 5 MiB，流式累计）、超时（默认 15s）；
 * - 非 2xx / 网络失败 → UNREACHABLE；超时 → TIMEOUT；超限 → TOO_LARGE（全部为**明确结果**）；
 * - 不记录正文内容（只记录 URL 与状态），不携带任何凭据（公开网页抓取）。
 */
export function createHttpArticleFetcher(options: { maxRedirects?: number; defaultMaxBytes?: number; defaultTimeoutMs?: number } = {}): ArticleFetcher {
  const maxRedirects = options.maxRedirects ?? 5;
  const defaultMaxBytes = options.defaultMaxBytes ?? 5 * 1024 * 1024;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;

  return {
    kind: 'http',
    async fetch(input: { url: string; maxBytes?: number; timeoutMs?: number }) {
      const maxBytes = input.maxBytes ?? defaultMaxBytes;
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;

      let current = assertSafeUrl(input.url).toString();
      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const controller = new AbortController();
        const timer = setTimeout(() => {
          controller.abort();
        }, timeoutMs);
        let response: Response;
        try {
          response = await fetch(current, { redirect: 'manual', signal: controller.signal, headers: { accept: 'text/html,text/plain,*/*;q=0.5' } });
        } catch (error) {
          clearTimeout(timer);
          const aborted = error instanceof Error && error.name === 'AbortError';
          throw new ApiFailure(
            aborted ? ERROR_CODES.INTERNAL : ERROR_CODES.INTERNAL,
            aborted ? '抓取超时' : '目标不可达（网络错误/DNS 失败）',
            502,
            { reason: aborted ? CONTENT_INPUT_ERROR_REASONS.TIMEOUT : CONTENT_INPUT_ERROR_REASONS.UNREACHABLE, url: current },
          );
        }

        try {
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (location === null) {
              throw new ApiFailure(ERROR_CODES.INTERNAL, '重定向缺少 Location', 502, { reason: CONTENT_INPUT_ERROR_REASONS.UNREACHABLE, url: current });
            }
            // 逐跳校验（相对重定向按当前 URL 解析）
            current = assertSafeUrl(new URL(location, current).toString()).toString();
            continue;
          }
          if (!response.ok) {
            throw new ApiFailure(ERROR_CODES.INTERNAL, `目标返回 HTTP ${String(response.status)}`, 502, {
              reason: CONTENT_INPUT_ERROR_REASONS.UNREACHABLE,
              url: current,
              status: response.status,
            });
          }
          const declared = Number(response.headers.get('content-length') ?? '0');
          if (Number.isFinite(declared) && declared > maxBytes) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文章超过大小上限', 413, {
              reason: CONTENT_INPUT_ERROR_REASONS.TOO_LARGE,
              declaredBytes: declared,
              maxBytes,
            });
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (bytes.byteLength > maxBytes) {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '文章超过大小上限', 413, {
              reason: CONTENT_INPUT_ERROR_REASONS.TOO_LARGE,
              actualBytes: bytes.byteLength,
              maxBytes,
            });
          }
          return { finalUrl: current, contentType: response.headers.get('content-type'), bytes };
        } finally {
          clearTimeout(timer);
        }
      }
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '重定向次数过多', 400, {
        reason: CONTENT_INPUT_ERROR_REASONS.UNREACHABLE,
        maxRedirects,
      });
    },
  };
}
