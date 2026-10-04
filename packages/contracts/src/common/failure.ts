import type { ErrorCode } from './error.js';

/**
 * 服务层统一失败类型（P01-03 起）：
 * 领域/认证/授权层抛出 ApiFailure，API 层统一转换为错误信封（REQ-33-02）。
 * 之前的 AuthFailure（仅 400）由本类型取代——状态码不再限定 400。
 */
export class ApiFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly httpStatus: number = 400,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiFailure';
  }
}
