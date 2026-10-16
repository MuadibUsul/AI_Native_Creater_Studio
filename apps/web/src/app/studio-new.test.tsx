import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1' }),
  useRouter: () => ({ push }),
}));

const { default: NewStudioProjectPage } = await import('./w/[workspaceId]/studio/new/page.js');

/**
 * 新建（V6-1c / V6-5）：起点二选一——从素材开始（只要标题与画幅）；从文章开始（贴文章，可选 AI 配音讲述）。
 */
describe('新建作品', () => {
  it('从素材开始：只发标题、画幅与语言', async () => {
    const create = vi.fn().mockResolvedValue({ projectId: 'prj_1', sequenceId: 'seq_1', sessionId: 'ses_1' });
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create } }));
    expect(screen.getByRole('radio', { name: /从素材开始/ }).getAttribute('aria-checked')).toBe('true');
    await userEvent.type(screen.getByLabelText('作品名称'), '冰岛环岛');
    await userEvent.click(screen.getByRole('button', { name: '开始' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', { title: '冰岛环岛', aspectRatio: '16:9', locale: 'zh-CN' }, expect.anything()));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ws_1/studio/prj_1'));
  });

  it('从文章开始：必须贴文章；带上文章与"AI 配音讲述"的选择', async () => {
    const create = vi.fn().mockResolvedValue({ projectId: 'prj_2', sequenceId: 'seq_2', sessionId: 'ses_2' });
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create } }));
    await userEvent.type(screen.getByLabelText('作品名称'), '淡水');
    await userEvent.click(screen.getByRole('radio', { name: /从文章开始/ }));
    await userEvent.click(screen.getByRole('button', { name: '开始' }));
    expect(screen.getByRole('alert').textContent).toBe('请贴上文章');
    expect(create).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('文章或讲稿'), 'Water covers 71 percent of the Earth.');
    expect(screen.getByText('37 / 40,000 字')).toBeTruthy();
    const narration = screen.getByRole('checkbox', { name: 'AI 配音讲述' }) as HTMLInputElement;
    expect(narration.checked).toBe(true);
    await userEvent.click(narration);
    await userEvent.click(screen.getByRole('button', { name: '开始' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', {
      title: '淡水', aspectRatio: '16:9', locale: 'zh-CN', article: { title: '淡水', text: 'Water covers 71 percent of the Earth.' }, narration: false,
    }, expect.anything()));
  });
});
