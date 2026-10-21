import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

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

  it('从链接导入：服务端抓到的正文填进文章框给人核对；建工程时带上来源；抓不到时说明原因', async () => {
    const create = vi.fn().mockResolvedValue({ projectId: 'prj_3', sequenceId: 'seq_3', sessionId: 'ses_3' });
    const fetchArticle = vi.fn()
      .mockRejectedValueOnce(apiError(403, 'FORBIDDEN', 'blocked', { reason: 'BLOCKED_TARGET' }))
      .mockResolvedValue({ title: '中美谈判背后潜藏的机会', text: '第一段正文。\n\n第二段正文。', sourceUrl: 'https://news.example/a', publisher: 'news.example', paragraphs: 2, truncated: false });
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create, fetchArticle } }));
    await userEvent.click(screen.getByRole('radio', { name: /从文章开始/ }));
    await userEvent.type(screen.getByLabelText('从链接导入'), 'http://10.0.0.1/a');
    await userEvent.click(screen.getByRole('button', { name: '导入正文' }));
    expect((await screen.findByRole('alert')).textContent).toBe('这个地址不能访问（内网地址或被安全规则拦下）。');
    await userEvent.clear(screen.getByLabelText('从链接导入'));
    await userEvent.type(screen.getByLabelText('从链接导入'), 'https://news.example/a{Enter}');
    await waitFor(() => expect((screen.getByLabelText('文章或讲稿') as HTMLTextAreaElement).value).toBe('第一段正文。\n\n第二段正文。'));
    expect(fetchArticle).toHaveBeenLastCalledWith('ws_1', { url: 'https://news.example/a' });
    expect((screen.getByLabelText('作品名称') as HTMLInputElement).value).toBe('中美谈判背后潜藏的机会');
    expect(screen.getByText('已从 news.example 导入 2 段正文。请核对，AI 只会用这里的内容。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '开始' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', {
      title: '中美谈判背后潜藏的机会', aspectRatio: '16:9', locale: 'zh-CN',
      article: { title: '中美谈判背后潜藏的机会', text: '第一段正文。\n\n第二段正文。', sourceUrl: 'https://news.example/a' }, narration: true,
    }, expect.anything()));
  });

  it('首页"链接导入"带来的链接：进入即抓取正文（只读一次草稿）', async () => {
    window.sessionStorage.setItem('ancs-studio-draft', JSON.stringify({ start: 'link', url: 'https://news.example/b' }));
    const fetchArticle = vi.fn().mockResolvedValue({ title: '标题', text: '正文。', sourceUrl: 'https://news.example/b', publisher: 'news.example', paragraphs: 1, truncated: true });
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create: vi.fn(), fetchArticle } }));
    await waitFor(() => expect(fetchArticle).toHaveBeenCalledWith('ws_1', { url: 'https://news.example/b' }));
    expect(screen.getByRole('radio', { name: /从文章开始/ }).getAttribute('aria-checked')).toBe('true');
    expect(await screen.findByText(/文章太长，只导入了前面的部分。/)).toBeTruthy();
    expect(window.sessionStorage.getItem('ancs-studio-draft')).toBeNull();
  });

  it('V6-9 交给 AI 剪完：勾上后需求与上限必填；建好工程即签署授权并开始运行，再进入共看片室', async () => {
    push.mockClear();
    const create = vi.fn().mockResolvedValue({ projectId: 'prj_4', sequenceId: 'seq_4', sessionId: 'ses_4' });
    const sign = vi.fn().mockResolvedValue({});
    const startRun = vi.fn().mockResolvedValue({ id: 'aut_1' });
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create }, autonomy: { sign, startRun } }));
    await userEvent.type(screen.getByLabelText('作品名称'), '冰岛环岛');
    await userEvent.click(screen.getByRole('checkbox', { name: '交给 AI 自己剪完' }));
    await userEvent.click(screen.getByRole('button', { name: '交给 AI' }));
    expect(screen.getByText('请写一句你想要的效果')).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText('你想要一条什么样的视频'), '90 秒的冰岛自驾，节奏轻快');
    await userEvent.selectOptions(screen.getByLabelText('目标时长'), '90');
    await userEvent.click(screen.getByRole('radio', { name: /自检通过就直接用/ }));
    await userEvent.click(screen.getByRole('button', { name: '交给 AI' }));
    await waitFor(() => expect(push).toHaveBeenCalledWith('/w/ws_1/studio/prj_4'));
    expect(sign).toHaveBeenCalledWith('ws_1', 'prj_4', { approval: 'AUTO_SAFE', budgetMicros: 2_000_000 }, expect.anything());
    expect(startRun).toHaveBeenCalledWith('ws_1', 'prj_4', { goal: '90 秒的冰岛自驾，节奏轻快', targetDurationSeconds: 90, strategyPackId: null, strategyKnobs: {}, locale: 'zh-CN' }, expect.anything());
  });

  it('V6-9 作品建好但没能交给 AI：说明原因，给出进入共看片室的入口（不重复建工程）', async () => {
    push.mockClear();
    const create = vi.fn().mockResolvedValue({ projectId: 'prj_5', sequenceId: 'seq_5', sessionId: 'ses_5' });
    const sign = vi.fn().mockRejectedValue(apiError(503, 'UNAVAILABLE'));
    renderWithClient(<NewStudioProjectPage />, mockClient({ studio: { create }, autonomy: { sign, startRun: vi.fn() } }));
    await userEvent.type(screen.getByLabelText('作品名称'), '冰岛');
    await userEvent.click(screen.getByRole('checkbox', { name: '交给 AI 自己剪完' }));
    await userEvent.type(screen.getByLabelText('你想要一条什么样的视频'), '剪一条 vlog');
    await userEvent.click(screen.getByRole('button', { name: '交给 AI' }));
    expect(await screen.findByText('作品已经建好，但没能交给 AI。')).toBeTruthy();
    expect(screen.getByRole('link', { name: '先进入共看片室' }).getAttribute('href')).toBe('/w/ws_1/studio/prj_5');
    expect((screen.getByRole('button', { name: '交给 AI' }) as HTMLButtonElement).disabled).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
