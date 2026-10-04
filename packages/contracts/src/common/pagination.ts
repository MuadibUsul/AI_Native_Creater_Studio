import { z } from 'zod';

/**
 * 分页契约（REQ-33-03）。游标式分页：游标为不透明字符串，
 * 与删除/插入并发时不保证稳定偏移（调用方以资源的 revision 字段做一致性判断）。
 */
export const pageRequestSchema = z.object({
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

/** 列表响应工厂：items + nextCursor（null 表示已到末页） */
export const pageResponseSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });

export type PageRequest = z.infer<typeof pageRequestSchema>;
