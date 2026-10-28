import type { AgentContentBlock, AgentModelMessage } from '@ancs/contracts';

/**
 * V7 B2（裁决 0022 第 3 条，借鉴 DSH `guard/repeat-tool-reminder`）：模型连续用完全相同的参数调用同一个工具时，
 * 在这一步的工具结果之后追加一句提醒。
 *
 * - 只提醒、不拦截：调用照常执行。
 * - 计数只由轮次日志决定：续跑后结果相同。提醒本身写进日志，之后原样重发，只追加、不改历史（裁决 0022 第 6 条）。
 * - 与供应商无关：对所有导演模型相同。
 */
export const REPEAT_REMINDER_THRESHOLDS: readonly number[] = [3, 5, 8];
const ARGUMENTS_PREVIEW_CHARS = 500;

const GENTLE = 'You are repeating the exact same tool call with identical arguments. Look carefully at the previous result before calling again: if the task is not done, try a different approach or different arguments instead of repeating the call.';

type ToolUse = Extract<AgentContentBlock, { type: 'tool_use' }>;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
  }
  return value;
}

/** 参数按键排序后比较：只是属性顺序不同的两次调用算同一次 */
const canonical = (input: unknown): string => JSON.stringify(sortJson(input)) ?? 'null';

function detailed(name: string, count: number, args: string): string {
  const preview = args.length <= ARGUMENTS_PREVIEW_CHARS ? args : `${args.slice(0, ARGUMENTS_PREVIEW_CHARS)}… (+${String(args.length - ARGUMENTS_PREVIEW_CHARS)} more chars)`;
  return `Repeated tool call detected: ${name} with the same arguments ${String(count)} times in a row (arguments: ${preview}). The repeated calls are not making progress. Do not call it with these arguments again: use the latest result and choose a different action or arguments, or finish if you have enough to go on.`;
}

/**
 * 按轮次日志计算这一步要追加的提醒；`log` 的最后一条是发出这些调用的模型回复。
 * 连续相同调用数达到阈值的那一次提醒：第一档温和，之后的档位点出工具与参数。没有要提醒的返回 null。
 */
export function repeatToolReminder(log: readonly AgentModelMessage[]): string | null {
  let key: string | null = null;
  let count = 0;
  const reminders: string[] = [];
  log.forEach((message, index) => {
    if (message.role !== 'assistant') return;
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue;
      const use: ToolUse = block;
      const args = canonical(use.input);
      const next = JSON.stringify([use.name, args]);
      count = next === key ? count + 1 : 1;
      key = next;
      if (index === log.length - 1 && REPEAT_REMINDER_THRESHOLDS.includes(count)) {
        reminders.push(count === REPEAT_REMINDER_THRESHOLDS[0] ? GENTLE : detailed(use.name, count, args));
      }
    }
  });
  return reminders.length === 0 ? null : reminders.join('\n');
}
