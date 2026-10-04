import { z } from 'zod';
import { opaqueIdSchema } from './ids.js';
import { revisionSchema } from './revision.js';

/**
 * 统一错误响应（规范 §33 / 计划 §4.6）。
 * 所有错误路径返回 { error: { code, message, requestId, details } }；5xx 不向客户端泄漏内部信息。
 */

export const ERROR_CODES = {
  /** 请求体/参数未通过契约校验 */
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  /** 未认证或会话失效 */
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  /** 已认证但无权限（RBAC / Workspace 隔离） */
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  /** 乐观并发冲突：base revision 或 expected scene revision 不匹配（§4.6） */
  VERSION_CONFLICT: 'VERSION_CONFLICT',
  /** 同幂等键、不同请求体（§4.6） */
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  /** 预算/成本保护熔断（计划 §6.1 / §68） */
  BUDGET_EXCEEDED: 'BUDGET_EXCEEDED',
  /** 所需能力/Provider/Pack 不可用（§42 / §92：未安装能力明确返回不支持） */
  CAPABILITY_UNAVAILABLE: 'CAPABILITY_UNAVAILABLE',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string().min(1),
    requestId: z.string().min(1),
    details: z.record(z.string(), z.unknown()),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * VERSION_CONFLICT 的 details 结构（§4.6："冲突返回 409 VERSION_CONFLICT 和刷新所需信息"）。
 * 生产端在 details 中携带该结构，客户端据此刷新后重试。
 */
export const versionConflictDetailsSchema = z.object({
  currentProjectRevision: revisionSchema,
  /** sceneId → 当前服务端 revision（仅包含冲突相关的 Scene，可为空） */
  sceneRevisions: z.record(opaqueIdSchema, revisionSchema).default({}),
});

export type VersionConflictDetails = z.infer<typeof versionConflictDetailsSchema>;
