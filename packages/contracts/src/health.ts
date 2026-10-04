import { z } from 'zod';

/** 健康检查响应（真实接口，长期保留）。时间戳为 UTC ISO 8601（规范 §4.1）。 */
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.literal('ancs-api'),
  version: z.string().min(1),
  now: z.string().min(1),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
