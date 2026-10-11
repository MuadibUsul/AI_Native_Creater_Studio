/**
 * Postgres 错误判定（P09-04 修复）：
 * drizzle 0.45 将驱动错误包装为 `DrizzleQueryError`（原始 pg 错误在 `cause`），
 * 直接读 `error.code` 永远取不到——必须解包 cause 链。
 * 覆盖 drizzle 直接抛原始错误的旧版本/直连场景（顶层即带 code）。
 */
function hasPgErrorCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth += 1) {
    if ((current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function isUniqueViolation(error: unknown): boolean {
  return hasPgErrorCode(error, '23505');
}

/** 外键约束违约（23503）：例如仍被 `restrict` 外键引用的行被删除。 */
export function isForeignKeyViolation(error: unknown): boolean {
  return hasPgErrorCode(error, '23503');
}
