import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils';

vi.mock('next/navigation', () => ({ useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }) }));

const { default: HistoryPage } = await import('./page');
const at = '2026-10-07T08:00:00.000Z';
const event = (seq: number, projectId: string) => ({
  seq, eventId: `evt_${seq}`, eventType: 'project.updated', workspaceId: 'ws_1', resourceId: projectId,
  resourceRevision: seq, occurredAt: at, payload: { projectId, operations: ['update_scene'] },
});

describe('Quiet Frame project history', () => {
  it('filters another project, pages by authoritative cursor, and reads real version summaries on demand', async () => {
    const list = vi.fn().mockImplementation((_workspaceId: string, options: { cursor: number }) =>
      Promise.resolve(options.cursor === 0
        ? { events: [event(1, 'prj_other'), event(2, 'prj_1')], headSeq: 3 }
        : { events: [event(3, 'prj_1')], headSeq: 3 }));
    const versions = vi.fn().mockResolvedValue([{ id: 'pv_1', workspaceId: 'ws_1', projectId: 'prj_1', versionNumber: 2, reason: 'MANUAL', note: null, createdBy: null, createdAt: at, sceneCount: 4 }]);
    const client = mockClient({ events: { list }, projects: { versions: { list: versions }, undo: vi.fn(), redo: vi.fn() } });
    renderWithClient(<HistoryPage />, client);
    await screen.findByText(/#2 project.updated/);
    expect(screen.queryByText(/#1 project.updated/)).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '加载更多事件' }));
    await screen.findByText(/#3 project.updated/);
    await waitFor(() => expect(list).toHaveBeenCalledWith('ws_1', { cursor: 2, limit: 100 }));
    await userEvent.click(screen.getByRole('button', { name: '查看版本' }));
    expect(await screen.findByText('版本 2')).toBeTruthy();
    expect(versions).toHaveBeenCalledWith('prj_1');
  });

  it('does not send redo while undo is still in flight', async () => {
    const undo = vi.fn().mockReturnValue(new Promise(() => undefined));
    const redo = vi.fn();
    const client = mockClient({
      events: { list: vi.fn().mockResolvedValue({ events: [], headSeq: 0 }) },
      projects: { versions: { list: vi.fn() }, undo, redo },
    });
    renderWithClient(<HistoryPage />, client);
    await screen.findByText('还没有编辑事件');
    await userEvent.click(screen.getByRole('button', { name: '撤销最近一次编辑' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '重做' }) as HTMLButtonElement).disabled).toBe(true));
    expect(undo).toHaveBeenCalledTimes(1);
    expect(redo).not.toHaveBeenCalled();
  });
});
