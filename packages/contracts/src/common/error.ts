import { z } from 'zod';

/**
 * 统一错误响应（规范 §33）。
 *
 * TODO(P01-01): 错误码表与 details 结构在此统一扩展。
 *   原因：P00-03 仅需验证"Zod→Fastify→OpenAPI→SDK"管线，错误码暂为最小集合。
 *   依赖：P01-01（公共契约：ID、错误、分页、金额、时间等）。
 *   预期接口：导出 ErrorCode 枚举与各错误码对应的 details schema；本文件为唯一权威来源。
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/** P00-03 建立的最小错误码集合（P01-01 扩展） */
export const ERROR_CODES = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
