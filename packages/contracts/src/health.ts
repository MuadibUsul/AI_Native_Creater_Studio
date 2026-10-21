import { z } from 'zod';

/** 健康检查响应（真实接口，长期保留）。时间戳为 UTC ISO 8601（规范 §4.1）。 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('ancs-api'),
  version: z.string().min(1),
  now: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * 就绪探针（生产部署）：/health 只说明进程活着；/ready 说明可以接流量——数据库能查询、没有在退出排空。
 * 不返回错误细节（连接串、主机名等不出现在探针里）。
 */
export const READINESS_CHECK_STATES = ['ok', 'error', 'timeout'] as const;
export const readinessResponseSchema = z.object({
  status: z.enum(['ready', 'not_ready']),
  service: z.literal('ancs-api'),
  /** 正在退出：负载均衡应停止转发新请求，进行中的请求会处理完 */
  draining: z.boolean(),
  checks: z.record(z.string().max(40), z.enum(READINESS_CHECK_STATES)),
}).strict();
export type ReadinessResponse = z.infer<typeof readinessResponseSchema>;
