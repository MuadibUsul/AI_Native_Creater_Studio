/**
 * 按顺序执行一组异步任务并保持元组类型。
 *
 * 事务内的查询必须串行：pg 客户端在同一连接上并发 `query()` 已弃用（pg@9 移除）。
 * 需要时以此替代 `Promise.all`（传入 thunk，保证上一条完成后才开始下一条）。
 */
export async function inOrder<T extends readonly (() => PromiseLike<unknown>)[]>(
  tasks: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const results: unknown[] = [];
  for (const task of tasks) results.push(await task());
  return results as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
