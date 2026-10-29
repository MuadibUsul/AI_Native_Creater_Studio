import type { AgentToolContext, AgentToolDefinition, AgentToolOutcome } from './agent-tools.js';

/**
 * V7 B3（裁决 0022 第 3 条，借鉴 DSH 的并行只读工具与 `guard/timeout-policy`）：
 * - 同一步里相邻的只读（READ）调用并行执行，最多 `READ_TOOL_CONCURRENCY` 个，结果仍按模型给出的顺序；
 * - 只读调用有截止时间（工具可用 `timeoutMs` 声明更长的），超时作为工具错误交给模型，循环继续，也能及时响应取消。
 *   超时的读取被放弃而不是中止：ANCS 的工具不接收取消信号，只读工具没有副作用，放弃是安全的。
 *   会改草稿、建资产或报价的工具不设截止时间，仍一次一个执行。
 */
export const READ_TOOL_CONCURRENCY = 4;
export const READ_TOOL_TIMEOUT_MS = 30_000;

export async function runReadTool(tool: AgentToolDefinition<unknown>, context: AgentToolContext, input: unknown): Promise<AgentToolOutcome> {
  const limitMs = tool.timeoutMs ?? READ_TOOL_TIMEOUT_MS;
  const running = tool.run(context, input);
  // 超时之后才失败的读取不能成为未处理的拒绝
  running.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<AgentToolOutcome>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        content: JSON.stringify({ error: `${tool.descriptor.name} did not finish within ${String(limitMs / 1000)} s and was abandoned; try again, or ask for less (fewer frames, a shorter span)` }),
        isError: true,
        summary: 'timed out',
      });
    }, limitMs);
  });
  try {
    return await Promise.race([running, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** 按顺序返回结果，同时最多运行 `limit` 个任务；任一任务失败即整体失败（与串行执行时一样由上层分类重试）。 */
export async function mapLimited<T>(tasks: readonly (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]!();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}
