import { z } from 'zod';

/**
 * TODO(P01-05): 临时管线验证契约（P00-03 专用），随 P01-05 真实资源契约落地后删除。
 *   原因：P00-03 需要验证"Zod→Fastify→OpenAPI→SDK"端到端管线，此时尚无任何业务资源路由。
 *   依赖：P01-01（公共契约）、P01-05（API/SDK 基线）。
 *   预期接口：由 projects 等真实资源契约取代；不做兼容保留，直接删除。
 */
export const echoRequestSchema = z.object({
  message: z.string().min(1).max(200),
  count: z.number().int().min(1).max(10).default(1),
});

export const echoResponseSchema = z.object({
  message: z.string(),
  repeated: z.array(z.string()),
});

/** 客户端入参类型（z.input：带 default 的字段可省略，如 count） */
export type EchoRequest = z.input<typeof echoRequestSchema>;
/** 服务端出参类型（z.infer：default 已应用） */
export type EchoResponse = z.infer<typeof echoResponseSchema>;
