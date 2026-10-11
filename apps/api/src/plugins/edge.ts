import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiFailure, ERROR_CODES } from '@ancs/contracts';

/**
 * Edge 安全层（V5 §15 边缘层；代码审查 0010 遗留：限流 / CORS / Origin / 安全头）。
 *
 * - **安全头**：所有响应 `nosniff`、`no-referrer`、`DENY` 与 `default-src 'none'; frame-ancestors 'none'`
 *   （API 只返回 JSON 与下载文件，从不需要被嵌入或执行脚本）；生产开启 HSTS；
 * - **CORS 白名单**：只对白名单内的 Origin 回显 `Access-Control-Allow-Origin`（带凭据）并应答预检；
 *   其他 Origin 不给任何 CORS 头（浏览器拦截），预检 403；
 * - **Origin 校验（CSRF 纵深防御）**：携带 Cookie 的写请求若带 `Origin` 且既不在白名单也不是本服务自身 → 403；
 *   无 `Origin` 的请求（服务端/原生客户端/Provider 回调）不受影响；
 * - **限流**：按"端点类别 × 客户端 IP"令牌桶（每进程内存；多实例部署时为每实例上限）。
 *   客户端 IP 取决于 `trustProxyHops`：未经可信代理时用连接地址，避免伪造 `X-Forwarded-For` 绕过。
 *   超限 → 429 `RATE_LIMITED` + `Retry-After`。
 */

export type RateLimitClass = 'auth' | 'expensive' | 'write' | 'read';

export interface RateLimitRule {
  /** 桶容量（突发上限） */
  capacity: number;
  /** 每分钟补充的令牌数 */
  perMinute: number;
}

export const DEFAULT_RATE_LIMITS: Readonly<Record<RateLimitClass, RateLimitRule>> = {
  auth: { capacity: 20, perMinute: 20 },
  expensive: { capacity: 60, perMinute: 60 },
  write: { capacity: 600, perMinute: 600 },
  read: { capacity: 3000, perMinute: 3000 },
};

export interface EdgeOptions {
  /** 允许的浏览器来源（完整 origin，如 https://app.example.com） */
  allowedOrigins: readonly string[];
  /** 限流规则；false = 关闭（仅非生产） */
  rateLimits?: Readonly<Record<RateLimitClass, RateLimitRule>> | false;
  /** 生产开启 HSTS */
  hsts?: boolean;
  /** 时钟注入（测试） */
  now?: () => number;
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** 会调用付费 Provider 或重计算的端点（按路径片段识别；新增此类路由时在此登记） */
const EXPENSIVE_SEGMENTS = /\/(narrative|narratives|ai-edit|director|scene-generation|narration-audio|multilingual|voice-clones|stock|speech-plan|renders|mixdown|output-enhancements)(\/|$)/;
const EXEMPT_PREFIXES = ['/api/v1/health', '/api/v1/webhooks/'];
const ALLOWED_REQUEST_HEADERS = ['content-type', 'idempotency-key', 'x-client-type', 'x-client-version', 'x-request-id', 'authorization', 'x-voice-session-token'];
const MAX_BUCKETS = 50_000;

export function classifyRequest(method: string, url: string): RateLimitClass | null {
  const path = url.split('?')[0] ?? url;
  if (method === 'OPTIONS' || EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) return null;
  if (path.startsWith('/api/v1/auth/') && MUTATING.has(method)) return 'auth';
  if (!MUTATING.has(method)) return 'read';
  return EXPENSIVE_SEGMENTS.test(path) ? 'expensive' : 'write';
}

/** 令牌桶（纯逻辑，便于单测）。 */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; updatedAt: number }>();

  take(key: string, rule: RateLimitRule, now: number): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
    const refillPerMs = rule.perMinute / 60_000;
    const existing = this.buckets.get(key);
    const tokens = existing === undefined
      ? rule.capacity
      : Math.min(rule.capacity, existing.tokens + (now - existing.updatedAt) * refillPerMs);
    if (tokens >= 1) {
      this.touch(key, { tokens: tokens - 1, updatedAt: now });
      return { allowed: true };
    }
    this.touch(key, { tokens, updatedAt: now });
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((1 - tokens) / refillPerMs / 1000)) };
  }

  private touch(key: string, value: { tokens: number; updatedAt: number }): void {
    this.buckets.delete(key);
    this.buckets.set(key, value);
    // 内存上限：淘汰最久未使用的桶（Map 按插入顺序迭代）
    while (this.buckets.size > MAX_BUCKETS) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
  }
}

const normalizeOrigin = (value: string): string | null => {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
};

const selfOrigin = (request: FastifyRequest): string | null => normalizeOrigin(`${request.protocol}://${request.host}`);

export function registerEdge(app: FastifyInstance, options: EdgeOptions): void {
  const allowed = new Set(options.allowedOrigins.map(normalizeOrigin).filter((origin): origin is string => origin !== null));
  const buckets = new TokenBuckets();
  const now = options.now ?? Date.now;

  app.addHook('onRequest', async (request, reply) => {
    const originHeader = request.headers.origin;
    const origin = typeof originHeader === 'string' ? normalizeOrigin(originHeader) : null;
    const originAllowed = origin !== null && allowed.has(origin);

    if (originAllowed) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-credentials', 'true');
      reply.header('access-control-expose-headers', 'x-request-id, retry-after');
    }
    if (origin !== null) reply.header('vary', 'Origin');

    // 预检：只为白名单来源应答
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method'] !== undefined) {
      if (!originAllowed) {
        throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'origin is not allowed', 403, { reason: 'ORIGIN_NOT_ALLOWED' });
      }
      const requested = String(request.headers['access-control-request-headers'] ?? '')
        .split(',').map((header) => header.trim().toLowerCase()).filter((header) => ALLOWED_REQUEST_HEADERS.includes(header));
      await reply
        .header('access-control-allow-methods', 'GET, POST, PUT, PATCH, DELETE')
        .header('access-control-allow-headers', requested.join(', '))
        .header('access-control-max-age', '600')
        .code(204)
        .send();
      return reply;
    }

    // CSRF 纵深防御：带 Cookie 的写请求必须来自白名单或本服务自身
    if (MUTATING.has(request.method) && request.headers.cookie !== undefined && typeof originHeader === 'string'
      && !originAllowed && origin !== selfOrigin(request)) {
      throw new ApiFailure(ERROR_CODES.FORBIDDEN, 'origin is not allowed for credentialed writes', 403, { reason: 'ORIGIN_NOT_ALLOWED' });
    }

    if (options.rateLimits !== false) {
      const limits = options.rateLimits ?? DEFAULT_RATE_LIMITS;
      const limitClass = classifyRequest(request.method, request.url);
      if (limitClass !== null) {
        const outcome = buckets.take(`${limitClass}:${request.ip}`, limits[limitClass], now());
        if (!outcome.allowed) {
          reply.header('retry-after', String(outcome.retryAfterSeconds));
          throw new ApiFailure(ERROR_CODES.RATE_LIMITED, 'rate limit exceeded', 429, {
            reason: 'RATE_LIMITED', limitClass, retryAfterSeconds: outcome.retryAfterSeconds,
          });
        }
      }
    }
    return undefined;
  });

  registerSecurityHeaders(app, { hsts: options.hsts === true });
}

/** 安全头（任何装配下都开启；buildServer 未配置 Edge 时也注册）。 */
export function registerSecurityHeaders(app: FastifyInstance, options: { hsts: boolean }): void {
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    if (options.hsts) reply.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    return payload;
  });
}
