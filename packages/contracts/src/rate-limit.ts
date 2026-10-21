/**
 * 限流存储端口（V5 §15 边缘层）：按"端点类别 × 客户端"取令牌。
 * 内存实现每进程各算各的；共享实现（Redis）让多台 API 共用同一份额度。
 */

export interface RateLimitRule {
  /** 桶容量（突发上限） */
  capacity: number;
  /** 每分钟补充的令牌数 */
  perMinute: number;
}

export type RateLimitDecision = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export interface RateLimitStore {
  /** 'memory' | 'redis' */
  readonly kind: string;
  take(key: string, rule: RateLimitRule): Promise<RateLimitDecision>;
}

/** 令牌不足时还要等多少秒（至少 1 秒） */
export function retryAfterSeconds(tokens: number, rule: RateLimitRule): number {
  const refillPerSecond = rule.perMinute / 60;
  return Math.max(1, Math.ceil((1 - tokens) / refillPerSecond));
}
