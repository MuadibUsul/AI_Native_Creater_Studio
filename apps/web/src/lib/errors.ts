import { AncsApiError } from '@ancs/sdk';
import { MESSAGES } from '@/i18n/messages';

/**
 * 错误 → 界面状态判定（P05-03 状态矩阵：失败/无权限/冲突可操作）。
 * 只消费服务端 errorEnvelope（code/message/details）——UI 不做业务判断。
 */

export type UiErrorKind = 'unauthenticated' | 'forbidden' | 'notFound' | 'conflict' | 'validation' | 'rateLimited' | 'budget' | 'capability' | 'unavailable' | 'unknown';

export interface UiError {
  kind: UiErrorKind;
  message: string;
  code: string | null;
  status: number | null;
  details: Record<string, unknown>;
}

/** 本地兜底文案跟随界面语言（<html lang> 由服务端首屏与语言切换同步设置）；服务端返回的错误原样显示。 */
function fallbackText() {
  return MESSAGES[typeof document !== 'undefined' && document.documentElement.lang === 'en' ? 'en' : 'zh-CN'].common;
}

export function describeError(error: unknown): UiError {
  if (error instanceof AncsApiError) {
    const kind: UiErrorKind =
      error.status === 401
        ? 'unauthenticated'
        : error.status === 403
          ? 'forbidden'
          : error.status === 404
            ? 'notFound'
            : error.status === 409
              ? 'conflict'
              : error.status === 402
                ? 'budget'
                : error.status === 501
                  ? 'capability'
                  : error.status === 400 || error.status === 422
                    ? 'validation'
                    : error.status === 429
                      ? 'rateLimited'
                      : 'unknown';
    return { kind, message: error.message, code: error.code, status: error.status, details: error.details };
  }
  if (error instanceof Error && (error.name === 'TypeError' || error.message.includes('fetch'))) {
    return { kind: 'unavailable', message: fallbackText().apiUnavailable, code: null, status: null, details: {} };
  }
  return { kind: 'unknown', message: error instanceof Error ? error.message : fallbackText().unknownError, code: null, status: null, details: {} };
}

/** 冲突（409 VERSION_CONFLICT）需要"刷新后重试"的明确动作。 */
export const isVersionConflict = (error: UiError): boolean => error.kind === 'conflict' && error.code === 'VERSION_CONFLICT';
