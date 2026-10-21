import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { healthResponseSchema, readinessResponseSchema, type ReadinessResponse } from '@ancs/contracts';

/**
 * 探针：
 * - GET /health：存活（进程在、能响应）——不查依赖，给编排器判断要不要重启；
 * - GET /ready：就绪（能接流量）——逐项检查依赖（数据库能查询），退出排空时返回 503；
 *   每项检查有超时，不返回错误细节。没有装配检查的进程（测试）只看排空状态。
 */

export interface ReadinessDeps {
  /** 依赖检查：名称 → 返回 true 表示可用（抛错或 false 视为不可用） */
  checks?: Record<string, () => Promise<boolean>>;
  /** 正在退出排空 */
  draining?: () => boolean;
  /** 单项检查超时（毫秒，缺省 2000） */
  timeoutMs?: number;
}

async function runCheck(check: () => Promise<boolean>, timeoutMs: number): Promise<ReadinessResponse['checks'][string]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
  try {
    const result = await Promise.race([check().then((ok) => (ok ? 'ok' as const : 'error' as const), () => 'error' as const), timeout]);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export function registerHealthRoutes(app: FastifyInstance, readiness: ReadinessDeps = {}): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: '健康检查（存活）',
        response: { 200: healthResponseSchema },
      },
    },
    async () => ({
      status: 'ok' as const,
      service: 'ancs-api' as const,
      version: '0.0.0',
      now: new Date().toISOString(),
    }),
  );
  typed.get(
    '/ready',
    {
      schema: {
        tags: ['meta'],
        summary: '就绪检查（依赖可用、没有在退出）',
        response: { 200: readinessResponseSchema, 503: readinessResponseSchema },
      },
    },
    async (_request, reply) => {
      const draining = readiness.draining?.() === true;
      const entries = Object.entries(readiness.checks ?? {});
      const results = await Promise.all(entries.map(async ([name, check]) => [name, await runCheck(check, readiness.timeoutMs ?? 2000)] as const));
      const checks = Object.fromEntries(results);
      const ready = !draining && results.every(([, state]) => state === 'ok');
      const body: ReadinessResponse = { status: ready ? 'ready' : 'not_ready', service: 'ancs-api', draining, checks };
      return reply.code(ready ? 200 : 503).send(body);
    },
  );
}
