/**
 * 模拟一次 PostgreSQL jsonb 往返后的对象形状（键顺序：先按 UTF-8 字节长度、再按字节序；
 * 丢弃 undefined 值）。内存试改的行与"写库再读回"的行因此逐字节一致，
 * 依赖 `JSON.stringify` 的指纹（如已确认内容保护三轴指纹）在两条路径上相同。
 */
export function jsonbNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => (item === undefined ? null : jsonbNormalize(item)));
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    entries.sort(([left], [right]) => {
      const a = Buffer.from(left, 'utf8');
      const b = Buffer.from(right, 'utf8');
      return a.length - b.length || Buffer.compare(a, b);
    });
    return Object.fromEntries(entries.map(([key, item]) => [key, jsonbNormalize(item)]));
  }
  return value;
}
