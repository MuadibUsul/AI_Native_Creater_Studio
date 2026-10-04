import type { FastifyInstance } from 'fastify';

/**
 * API 请求级指标（P08-03 / 规范 §44：API error rate 与 p50/p95 延迟）。
 *
 * 进程内累计（重启归零；导出面 = GET /api/v1/admin/metrics，Prometheus 文本格式）：
 * - 计数按状态类（2xx/3xx/4xx/5xx）；
 * - 延迟直方图（固定桶，秒）——p50/p95 由查询侧按桶估算（不引入外部指标后端）。
 *
 * 说明：多副本部署时各副本独立导出（Prometheus 侧按实例聚合）；外部指标后端接入随部署环境特化。
 */

export const DURATION_BUCKETS_SECONDS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10] as const;

export interface MetricsSnapshot {
  requestsTotal: number;
  byStatusClass: Record<string, number>;
  /** 每个桶的累计计数（le 语义）+ +Inf */
  durationBuckets: { le: number; count: number }[];
  durationSumSeconds: number;
  /** 由桶估算（§44 p50/p95 的最低证据；精确分位随外部后端） */
  durationP50Seconds: number;
  durationP95Seconds: number;
}

interface MetricsState {
  requestsTotal: number;
  byStatusClass: Record<string, number>;
  bucketCounts: Map<number, number>;
  durationSumSeconds: number;
}

export function createMetricsState(): MetricsState {
  return { requestsTotal: 0, byStatusClass: {}, bucketCounts: new Map(), durationSumSeconds: 0 };
}

export function snapshotMetrics(state: MetricsState): MetricsSnapshot {
  const buckets = DURATION_BUCKETS_SECONDS.map((le) => ({ le, count: state.bucketCounts.get(le) ?? 0 }));
  const estimate = (quantile: number): number => {
    const target = state.requestsTotal === 0 ? 0 : Math.ceil(quantile * state.requestsTotal);
    for (const bucket of buckets) {
      if (bucket.count >= target) return bucket.le;
    }
    return buckets.at(-1)?.le ?? 0;
  };
  return {
    requestsTotal: state.requestsTotal,
    byStatusClass: { ...state.byStatusClass },
    durationBuckets: buckets,
    durationSumSeconds: Number(state.durationSumSeconds.toFixed(6)),
    durationP50Seconds: estimate(0.5),
    durationP95Seconds: estimate(0.95),
  };
}

declare module 'fastify' {
  interface FastifyInstance {
    apiMetrics: MetricsState;
  }
}

export function registerMetrics(app: FastifyInstance): void {
  const state = createMetricsState();
  app.decorate('apiMetrics', state);

  app.addHook('onRequest', async (request) => {
    request.startTime = process.hrtime.bigint();
  });
  app.addHook('onResponse', async (request, reply) => {
    const startedAt = request.startTime;
    const durationSeconds = startedAt === undefined ? 0 : Number(process.hrtime.bigint() - startedAt) / 1e9;
    state.requestsTotal += 1;
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx`;
    state.byStatusClass[statusClass] = (state.byStatusClass[statusClass] ?? 0) + 1;
    state.durationSumSeconds += durationSeconds;
    for (const le of DURATION_BUCKETS_SECONDS) {
      if (durationSeconds <= le) state.bucketCounts.set(le, (state.bucketCounts.get(le) ?? 0) + 1);
    }
  });
}

declare module 'fastify' {
  interface FastifyRequest {
    startTime?: bigint;
  }
}
