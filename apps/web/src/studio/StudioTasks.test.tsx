import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { AgentTurn, Generation, StudioState, WorkflowRun } from '@ancs/contracts';
import { MESSAGES } from '@/i18n/messages';
import { StudioTasks, finishedTasks, studioTaskRows, type TaskRow } from './StudioTasks';

/**
 * 任务中心：素材处理 / 付费生成 / 导出 / AI 这一轮——只读服务端状态整理成任务行（状态写成文字，不只靠颜色）；
 * 已放弃或已过期的报价、已取消的导出不算任务；就绪的素材合并成一行。
 */

const t = MESSAGES['zh-CN'].studio;
const footage = (name: string, status: StudioState['footage'][number]['status'], understanding: Record<string, string> = { index: 'READY', transcript: 'READY', visual: 'READY' }) =>
  ({ assetId: `ast_${name}`, footageId: `av_${name}`, name, kind: 'video', status, duration: '6.0', understanding }) as unknown as StudioState['footage'][number];
const generation = (id: string, status: string) => ({ id, kind: 'VIDEO_REGION', status, summary: '把天空换成晚霞' }) as unknown as Generation;
const run = (id: string, status: WorkflowRun['status']) => ({ id, status, createdAt: '2026-10-14T08:00:00.000Z' }) as unknown as WorkflowRun;

describe('任务中心', () => {
  it('把服务端状态整理成任务行', () => {
    const rows = studioTaskRows({
      footage: [footage('a.mp4', 'PROCESSING'), footage('b.mp4', 'FAILED'), footage('c.mp4', 'READY', { index: 'READY', transcript: 'WORKING', visual: 'READY' }), footage('d.mp4', 'READY'), footage('e.mp4', 'READY')],
      generations: [generation('g1', 'RUNNING'), generation('g2', 'QUOTED'), generation('g3', 'NEEDS_RECONCILIATION'), generation('g4', 'FAILED'), generation('g5', 'SUCCEEDED'), generation('g6', 'DECLINED'), generation('g7', 'EXPIRED')],
      exports: [run('r1', 'RUNNING'), run('r2', 'FAILED'), run('r3', 'SUCCEEDED'), run('r4', 'CANCELLED')],
      turn: { id: 'agt_1', status: 'FAILED', message: '再短一点' } as unknown as AgentTurn,
      t,
      formatTime: () => '10/14 16:00',
    });
    const summary = rows.map((row) => `${row.group}:${row.status}:${row.title}`);
    expect(summary).toEqual([
      'footage:running:a.mp4', 'footage:failed:b.mp4', 'footage:running:c.mp4', 'footage:done:3 段素材已就绪',
      'generation:running:重绘框出的区域 · 把天空换成晚霞', 'generation:attention:重绘框出的区域 · 把天空换成晚霞', 'generation:attention:重绘框出的区域 · 把天空换成晚霞',
      'generation:failed:重绘框出的区域 · 把天空换成晚霞', 'generation:done:重绘框出的区域 · 把天空换成晚霞',
      'export:running:导出 · 10/14 16:00', 'export:failed:导出 · 10/14 16:00', 'export:done:导出 · 10/14 16:00',
      'ai:failed:再短一点',
    ]);
    expect(rows.find((row) => row.key === 'f-ast_c.mp4')?.detail).toBe('正在理解语音与画面…');
  });

  it('抽屉按组列出，状态写成文字；Esc 与关闭按钮都能收起', async () => {
    const onClose = vi.fn();
    render(<StudioTasks rows={[
      { key: 'e1', group: 'export', title: '导出 · 10/14 16:00', status: 'failed', detail: t.tasks.exportFailed },
      { key: 'a1', group: 'ai', title: '再短一点', status: 'running', detail: t.tasks.aiRunning },
    ]} loadFailed={false} onClose={onClose} />);
    const panel = screen.getByRole('complementary', { name: '任务' });
    const ai = within(panel).getByRole('region', { name: 'AI 这一轮' });
    expect(within(ai).getByText('进行中')).toBeTruthy();
    const exports = within(panel).getByRole('region', { name: '导出' });
    expect(within(exports).getByText('没成功')).toBeTruthy();
    expect(within(exports).getByText('导出没有完成，可以在"导出"里重新开始。')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.click(within(panel).getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
  it('结束提醒：只提醒看着从进行中变为完成/没成功的任务；进行中的素材行消失算处理完；AI 这一轮不另提醒', () => {
    const row = (key: string, group: TaskRow['group'], status: TaskRow['status']): TaskRow => ({ key, group, title: key, status, detail: null });
    const before = [row('f-a', 'footage', 'running'), row('e-1', 'export', 'running'), row('g-1', 'generation', 'running'), row('a-1', 'ai', 'running'), row('e-0', 'export', 'done')];
    const after = [row('f-ready', 'footage', 'done'), row('e-1', 'export', 'failed'), row('g-1', 'generation', 'running'), row('e-0', 'export', 'done')];
    expect(finishedTasks(before, after).map((item) => `${item.key}:${item.status}`)).toEqual(['f-a:done', 'e-1:failed']);
    expect(finishedTasks([], after)).toEqual([]);
    expect(finishedTasks(after, after)).toEqual([]);
  });
});
