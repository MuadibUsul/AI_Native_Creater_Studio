import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiFailure, errorEnvelope, ERROR_CODES, type ErrorCode } from '@ancs/contracts';

interface ValidationIssue {
  message?: string;
}

/** HTTP 状态码 → 契约错误码（P01-01 错误码表；其余 4xx 归为 VALIDATION_FAILED） */
function codeForStatus(status: number, isValidation: boolean): ErrorCode {
  if (isValidation) return ERROR_CODES.VALIDATION_FAILED;
  switch (status) {
    case 401:
      return ERROR_CODES.UNAUTHENTICATED;
    case 403:
      return ERROR_CODES.FORBIDDEN;
    case 404:
      return ERROR_CODES.NOT_FOUND;
    case 409:
      return ERROR_CODES.VERSION_CONFLICT;
    case 429:
      return ERROR_CODES.RATE_LIMITED;
    default:
      return status < 500 ? ERROR_CODES.VALIDATION_FAILED : ERROR_CODES.INTERNAL;
  }
}

function envelope(
  code: ErrorCode,
  message: string,
  requestId: string,
  details: Record<string, unknown> = {},
): { error: { code: ErrorCode; message: string; requestId: string; details: Record<string, unknown> } } {
  return { error: { code, message, requestId, details } };
}

/**
 * 统一错误信封（规范 §33）：所有错误路径返回 { error: { code, message, requestId, details } }。
 * 5xx 不向客户端泄漏内部错误信息。
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setNotFoundHandler((request: FastifyRequest, reply: FastifyReply) => {
    void reply
      .status(404)
      .send(envelope(ERROR_CODES.NOT_FOUND, `Route ${request.method} ${request.url} not found`, String(request.id)));
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // 服务层显式失败（ApiFailure，P01-03 起统一）：按其 code/status 直接转换为错误信封
    if (error instanceof ApiFailure) {
      const status = Math.min(Math.max(error.httpStatus, 400), 599);
      if (status >= 500) request.log.error({ err: error }, 'service failure');
      void reply.status(status).send(errorEnvelope(error.code, error.message, String(request.id), error.details));
      return;
    }

    const validation = Array.isArray(error.validation) ? error.validation : null;
    const status = typeof error.statusCode === 'number' && error.statusCode >= 400 ? error.statusCode : 500;

    const code: ErrorCode = codeForStatus(status, validation !== null);

    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    }

    const message = validation
      ? 'Request validation failed'
      : status >= 500
        ? 'Internal server error'
        : error.message;
    const details: Record<string, unknown> = validation
      ? { issues: validation.map((issue: ValidationIssue) => issue.message ?? 'invalid') }
      : {};

    void reply.status(status).send(envelope(code, message, String(request.id), details));
  });
}
