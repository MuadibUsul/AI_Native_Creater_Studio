import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentToolContext, AgentToolDefinition, AgentToolOutcome } from './agent-tools.js';
import { READ_TOOL_TIMEOUT_MS, mapLimited, runReadTool } from './agent-tool-exec.js';

const context = {} as AgentToolContext;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const readTool = (run: () => Promise<AgentToolOutcome>, timeoutMs?: number): AgentToolDefinition<unknown> => ({
  descriptor: { name: 'slow_read', capability: 'test.read', effect: 'READ', permission: 'project:read', metered: false, description: 'test' },
  input: z.unknown(),
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
  run,
});
const ok: AgentToolOutcome = { content: '{"ok":true}', isError: false, summary: 'ok' };

describe('V7 B3 只读工具的截止时间与并行（裁决 0022）', () => {
  it('按时完成的结果原样返回；超过截止时间 → 工具错误交给模型，放弃的读取之后失败也不成为未处理的拒绝', async () => {
    expect(await runReadTool(readTool(() => Promise.resolve(ok), 50), context, {})).toBe(ok);
    const started = Date.now();
    const late = await runReadTool(readTool(async () => { await sleep(300); throw new Error('late failure'); }, 40), context, {});
    expect(Date.now() - started).toBeLessThan(250);
    expect(late).toMatchObject({ isError: true, summary: 'timed out' });
    expect(JSON.parse(late.content)).toEqual({ error: 'slow_read did not finish within 0.04 s and was abandoned; try again, or ask for less (fewer frames, a shorter span)' });
    await sleep(350);
  });

  it('截止前抛错与串行执行时一样向上抛（由工作流分类重试）；缺省截止时间 30 s', async () => {
    await expect(runReadTool(readTool(() => Promise.reject(new Error('db down')), 50), context, {})).rejects.toThrow('db down');
    expect(READ_TOOL_TIMEOUT_MS).toBe(30_000);
  });

  it('mapLimited：结果按任务顺序，同时运行的任务不超过上限', async () => {
    let inFlight = 0;
    let max = 0;
    const task = (value: number, ms: number) => async () => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await sleep(ms);
      inFlight -= 1;
      return value;
    };
    expect(await mapLimited([task(1, 40), task(2, 5), task(3, 20), task(4, 5), task(5, 10), task(6, 1)], 4)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(max).toBe(4);
    expect(await mapLimited([], 4)).toEqual([]);
  });
});
