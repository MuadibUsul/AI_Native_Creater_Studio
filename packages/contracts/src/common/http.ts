import { z } from 'zod';

/**
 * HTTP 传输层约定（规范 §29.3、§33 / P01-05）：
 * - 客户端标头：X-Client-Type + X-Client-Version；
 * - 请求追踪：X-Request-Id（客户端可提供；服务端回显并用于错误信封）；
 * - 写请求幂等：Idempotency-Key（同键同请求返回原结果；同键不同请求 409 IDEMPOTENCY_CONFLICT）。
 */

export const CLIENT_TYPES = ['web', 'desktop', 'ios', 'android'] as const;

export const clientTypeSchema = z.enum(CLIENT_TYPES);
export type ClientType = z.infer<typeof clientTypeSchema>;

export const clientVersionSchema = z.string().min(1).max(64);

/** 请求 ID：客户端可提供（受限字符集），否则服务端生成 */
export const requestIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/, 'requestId 仅允许字母数字与 . _ : -');

/**
 * 幂等键（写请求）；语义见计划 §4.6。
 * 限定 ASCII 可打印字符：该值经 Idempotency-Key 请求头传输（HTTP 头为 ByteString 语义，
 * 非 Latin-1 字符会在客户端 Headers 设置或代理层引发错误）。
 */
export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7E]+$/, 'idempotencyKey 仅允许 ASCII 可打印字符（经请求头传输）');
