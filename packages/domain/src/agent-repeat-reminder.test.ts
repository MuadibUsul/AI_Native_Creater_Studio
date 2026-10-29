import { describe, expect, it } from 'vitest';
import type { AgentModelMessage } from '@ancs/contracts';
import { repeatToolReminder } from './agent-repeat-reminder.js';

const context: AgentModelMessage = { role: 'user', content: [{ type: 'text', text: 'turn context' }] };
let ids = 0;
const call = (...uses: [string, unknown][]): AgentModelMessage => ({ role: 'assistant', content: uses.map(([name, input]) => ({ type: 'tool_use' as const, id: `call_${String(++ids)}`, name, input })) });
const result: AgentModelMessage = { role: 'user', content: [{ type: 'tool_result', toolUseId: 'x', content: '{}', isError: false }] };
/** 日志：上下文 → (调用 → 结果)×n，最后一条是待执行的调用 */
const logOf = (...steps: AgentModelMessage[]): AgentModelMessage[] => [context, ...steps.flatMap((step, index) => index === steps.length - 1 ? [step] : [step, result])];

describe('V7 B2 重复调用提醒（裁决 0022）', () => {
  it('同一工具、同样参数连续第 3 次温和提醒；第 5、8 次点出工具与参数；其余次数不提醒', () => {
    const steps = Array.from({ length: 8 }, () => call(['get_timeline', {}]));
    const reminders = steps.map((_, index) => repeatToolReminder(logOf(...steps.slice(0, index + 1))));
    expect(reminders.map((text) => text === null ? null : text.startsWith('Repeated tool call detected') ? 'detailed' : 'gentle'))
      .toEqual([null, null, 'gentle', null, 'detailed', null, null, 'detailed']);
    expect(reminders[4]).toContain('get_timeline with the same arguments 5 times in a row (arguments: {})');
  });

  it('参数只是属性顺序不同算同一次；参数不同、或中间夹着别的调用（比如一次修改）就重新计数', () => {
    const a = call(['look_at_footage', { footageId: 'f1', count: 6 }]);
    const reordered = call(['look_at_footage', { count: 6, footageId: 'f1' }]);
    expect(repeatToolReminder(logOf(a, reordered, a))).not.toBeNull();
    expect(repeatToolReminder(logOf(a, a, call(['look_at_footage', { footageId: 'f2', count: 6 }])))).toBeNull();
    // 改了草稿之后再看时间线是正常的：中间的修改让计数从头开始
    const edit = call(['edit_timeline', { operations: [] }]);
    const look = call(['get_timeline', {}]);
    expect(repeatToolReminder(logOf(look, look, edit, look))).toBeNull();
  });

  it('同一步里的并行调用也按先后计数；提醒只针对本步的调用', () => {
    expect(repeatToolReminder(logOf(call(['review_draft', {}], ['review_draft', {}], ['review_draft', {}])))).not.toBeNull();
    // 前几步已经重复过 3 次，这一步换了工具：不再提醒
    const look = call(['get_timeline', {}]);
    expect(repeatToolReminder(logOf(look, look, look, call(['measure_pace', {}])))).toBeNull();
  });

  it('很长的参数在提醒里截断，计数仍比较完整参数；结果只由日志决定（同样的日志得到同样的提醒）', () => {
    const big = call(['edit_timeline', { operations: [{ op: 'place_clip', note: 'x'.repeat(2000) }] }]);
    const log = logOf(big, big, big, big, big);
    const text = repeatToolReminder(log);
    expect(text).toContain('more chars)');
    expect(text!.length).toBeLessThan(1000);
    expect(repeatToolReminder(structuredClone(log))).toBe(text);
  });
});
