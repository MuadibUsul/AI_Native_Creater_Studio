import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/i18n/I18nProvider';
import { apiError, mockClient, renderWithClient } from '@/test-utils';

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

  it('renders the history page in English, with dates in the interface locale', async () => {
    const list = vi.fn().mockResolvedValue({ events: [event(2, 'prj_1'), { ...event(3, 'prj_1'), payload: { projectId: 'prj_1' } }], headSeq: 3 });
    const versions = vi.fn().mockResolvedValue([{ id: 'pv_1', workspaceId: 'ws_1', projectId: 'prj_1', versionNumber: 2, reason: 'MANUAL', note: null, createdBy: null, createdAt: at, sceneCount: 4 }]);
    const undo = vi.fn().mockRejectedValue(apiError(409, 'VERSION_CONFLICT', 'Nothing to undo'));
    const client = mockClient({ events: { list }, projects: { versions: { list: versions }, undo, redo: vi.fn() } });
    renderWithClient(<I18nProvider initialLocale="en"><HistoryPage /></I18nProvider>, client);
    expect(await screen.findByRole('heading', { name: 'Version history' })).toBeTruthy();
    expect(screen.getByText('2 records for this project loaded')).toBeTruthy();
    expect(screen.getByText(/Operations: update_scene · revision 2 · System/)).toBeTruthy();
    expect(screen.getByText(/No operation details · revision 3 · System/)).toBeTruthy();
    expect(screen.getAllByText(new Date(at).toLocaleString('en')).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'View versions' }));
    expect(await screen.findByText('Version 2')).toBeTruthy();
    expect(screen.getByText(`4 shots · ${new Date(at).toLocaleString('en')}`)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /Undo last edit/ }));
    expect(await screen.findByText('Could not undo or redo')).toBeTruthy();
    expect(screen.getByText('Conflict')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Refresh history' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/[一-鿿]/);
  });
});
