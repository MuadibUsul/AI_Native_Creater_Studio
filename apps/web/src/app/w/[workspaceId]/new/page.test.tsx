import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import NewProjectPage from './page';
import { apiError, mockClient, renderWithClient } from '@/test-utils';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1' }),
  useRouter: () => ({ push }),
}));

const parsed = {
  document: {
    id: 'doc_1', title: '原文标题', language: 'zh-CN',
    blocks: [{ id: 'block_1', type: 'paragraph', text: '这里是从真实输入解析的第一段。' }],
  },
  normalization: { blockCount: 1, claims: 1 },
};
const editableWorkspace = { workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) } };

describe('Quiet Frame 新建作品', () => {
  beforeEach(() => {
    push.mockReset();
    window.sessionStorage.clear();
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: vi.fn().mockReturnValue('12345678-1234-1234-1234-123456789abc') });
  });

  it('读取真实文章并在确认后生成脚本，复用同一项目', async () => {
    const createProject = vi.fn().mockResolvedValue({ id: 'prj_1' });
    const createContent = vi.fn().mockResolvedValue(parsed);
    const extract = vi.fn().mockResolvedValue({});
    const generate = vi.fn().mockResolvedValue({});
    const client = mockClient({
      ...editableWorkspace,
      channels: { list: vi.fn().mockResolvedValue([{ id: 'ch_1' }]) },
      projects: { create: createProject },
      content: { create: createContent },
      evidence: { extract },
      narrative: { generate },
    });
    renderWithClient(<NewProjectPage />, client);
    await waitFor(() => expect(screen.getByLabelText('作品名称')).not.toHaveProperty('disabled', true));
    await userEvent.type(screen.getByLabelText('作品名称'), '新作品');
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/article');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByText('原文标题')).toBeTruthy();
    expect(screen.getByText(/从真实输入解析的第一段/)).toBeTruthy();
    expect(createProject).toHaveBeenCalledWith('ws_1', expect.objectContaining({ title: '新作品', channelId: 'ch_1', sourceType: 'URL' }), expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(createContent).toHaveBeenCalledWith('ws_1', 'prj_1', { sourceType: 'URL_ARTICLE', url: 'https://example.com/article' }, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(JSON.parse(window.sessionStorage.getItem('ancs-new-project-progress:ws_1') ?? '{}')).toEqual({ projectId: 'prj_1', documentId: 'doc_1', sourceKind: 'url' });
    expect(generate).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: /生成脚本草稿/ }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith('ws_1', 'prj_1', 'doc_1', { targetDurationMs: 300000 }));
    expect(extract).toHaveBeenCalledWith('ws_1', 'prj_1', 'doc_1');
    expect(push).toHaveBeenCalledWith('/w/ws_1/p/prj_1/script');
    expect(window.sessionStorage.getItem('ancs-new-project-progress:ws_1')).toBeNull();
  });

  it('读取失败保留输入，重试不创建第二个项目', async () => {
    const createProject = vi.fn().mockResolvedValue({ id: 'prj_1' });
    const createContent = vi.fn().mockRejectedValueOnce(apiError(502, 'FETCH_FAILED', '源站暂不可用')).mockResolvedValue(parsed);
    const client = mockClient({
      ...editableWorkspace,
      channels: { list: vi.fn().mockResolvedValue([{ id: 'ch_1' }]) },
      projects: { create: createProject },
      content: { create: createContent },
    });
    renderWithClient(<NewProjectPage />, client);
    await waitFor(() => expect(screen.getByLabelText('作品名称')).not.toHaveProperty('disabled', true));
    await userEvent.type(screen.getByLabelText('作品名称'), '保留草稿');
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/article');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(JSON.parse(window.sessionStorage.getItem('ancs-new-project-progress:ws_1') ?? '{}')).toEqual({ projectId: 'prj_1', documentId: null, sourceKind: 'url' });
    expect((screen.getByLabelText('文章地址') as HTMLInputElement).value).toBe('https://example.com/article');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByText('原文标题')).toBeTruthy();
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createContent).toHaveBeenCalledTimes(2);
  });

  it('修正失败的来源后换用新幂等键，避免复用被拒绝的请求正文', async () => {
    let count = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: () => `00000000-0000-0000-0000-${String(++count).padStart(12, '0')}` });
    const createContent = vi.fn().mockRejectedValueOnce(apiError(400, 'VALIDATION_FAILED', '原地址不可读取')).mockResolvedValue(parsed);
    const client = mockClient({
      ...editableWorkspace,
      channels: { list: vi.fn().mockResolvedValue([{ id: 'ch_1' }]) },
      projects: { create: vi.fn().mockResolvedValue({ id: 'prj_1' }) },
      content: { create: createContent },
    });
    renderWithClient(<NewProjectPage />, client);
    await waitFor(() => expect(screen.getByLabelText('作品名称')).not.toHaveProperty('disabled', true));
    await userEvent.type(screen.getByLabelText('作品名称'), '来源修正');
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/bad');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.clear(screen.getByLabelText('文章地址'));
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/good');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByText('原文标题')).toBeTruthy();
    const firstKey = createContent.mock.calls[0]?.[3]?.idempotencyKey;
    const secondKey = createContent.mock.calls[1]?.[3]?.idempotencyKey;
    expect(firstKey).not.toBe(secondKey);
    expect(createContent.mock.calls[1]?.[2]).toEqual({ sourceType: 'URL_ARTICLE', url: 'https://example.com/good' });
  });

  it('URL 读取失败后可改用粘贴正文，同一作品使用新内容幂等键', async () => {
    let count = 0;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { configurable: true, value: () => `00000000-0000-0000-0000-${String(++count).padStart(12, '0')}` });
    const createProject = vi.fn().mockResolvedValue({ id: 'prj_1' });
    const createContent = vi.fn().mockRejectedValueOnce(apiError(502, 'FETCH_FAILED', '受限文章')).mockResolvedValue(parsed);
    renderWithClient(<NewProjectPage />, mockClient({
      ...editableWorkspace,
      channels: { list: vi.fn().mockResolvedValue([{ id: 'ch_1' }]) },
      projects: { create: createProject },
      content: { create: createContent },
    }));
    await waitFor(() => expect(screen.getByLabelText('作品名称')).not.toHaveProperty('disabled', true));
    await userEvent.type(screen.getByLabelText('作品名称'), '受限文章');
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/restricted');
    await userEvent.click(screen.getByRole('button', { name: /读取文章/ }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: '粘贴正文' }));
    await userEvent.type(screen.getByLabelText('原始内容'), '合法且真实的原文内容。');
    await userEvent.click(screen.getByRole('button', { name: /读取正文/ }));
    expect(await screen.findByText('原文标题')).toBeTruthy();
    expect(createProject).toHaveBeenCalledTimes(1);
    expect(createContent.mock.calls[1]?.[2]).toEqual({ sourceType: 'PASTED_TEXT', text: '合法且真实的原文内容。', title: '受限文章' });
    expect(createContent.mock.calls[0]?.[3]?.idempotencyKey).not.toBe(createContent.mock.calls[1]?.[3]?.idempotencyKey);
    expect(JSON.parse(window.sessionStorage.getItem('ancs-new-project-progress:ws_1') ?? '{}').sourceKind).toBe('text');
  });

  it('切换输入标签保留各自草稿，超限文档在创建作品前被拒绝', async () => {
    const createProject = vi.fn();
    const client = mockClient({ ...editableWorkspace, projects: { create: createProject } });
    renderWithClient(<NewProjectPage />, client);
    await waitFor(() => expect(screen.getByLabelText('文章地址')).not.toHaveProperty('disabled', true));
    await userEvent.type(screen.getByLabelText('文章地址'), 'https://example.com/article');
    await userEvent.click(screen.getByRole('tab', { name: '粘贴正文' }));
    await userEvent.type(screen.getByLabelText('原始内容'), '保留的正文草稿');
    await userEvent.click(screen.getByRole('tab', { name: '文章链接' }));
    expect((screen.getByLabelText('文章地址') as HTMLInputElement).value).toBe('https://example.com/article');
    await userEvent.click(screen.getByRole('tab', { name: '粘贴正文' }));
    expect((screen.getByLabelText('原始内容') as HTMLTextAreaElement).value).toBe('保留的正文草稿');
    await userEvent.click(screen.getByRole('tab', { name: '上传资料' }));
    const oversized = new File(['x'], 'oversized.pdf', { type: 'application/pdf' });
    Object.defineProperty(oversized, 'size', { value: 25 * 1024 * 1024 + 1 });
    fireEvent.change(document.getElementById('source-file') as HTMLInputElement, { target: { files: [oversized] } });
    await userEvent.type(screen.getByLabelText('作品名称'), '文档作品');
    await userEvent.click(screen.getByRole('button', { name: /读取文档/ }));
    expect((await screen.findByRole('alert')).textContent).toContain('不能超过 25 MiB');
    expect(createProject).not.toHaveBeenCalled();
  });

  it('刷新后从服务端核对项目归属并恢复文档快照，不重复创建作品', async () => {
    window.sessionStorage.setItem('ancs-new-project-progress:ws_1', JSON.stringify({ projectId: 'prj_1', documentId: 'doc_1' }));
    const createProject = vi.fn();
    const getProject = vi.fn().mockResolvedValue({ workspaceId: 'ws_1', title: '恢复的作品', sourceType: 'URL', targetDurationMs: 300000 });
    const getDocument = vi.fn().mockResolvedValue(parsed);
    const extract = vi.fn().mockResolvedValue({});
    const generate = vi.fn().mockResolvedValue({});
    const client = mockClient({
      ...editableWorkspace,
      projects: { get: getProject, create: createProject },
      content: { get: getDocument },
      evidence: { extract },
      narrative: { generate },
    });
    renderWithClient(<NewProjectPage />, client);
    expect(await screen.findByText(/内容快照已从服务器重新读取/)).toBeTruthy();
    expect(screen.getByText('原文标题')).toBeTruthy();
    expect(getProject).toHaveBeenCalledWith('prj_1');
    expect(getDocument).toHaveBeenCalledWith('ws_1', 'prj_1', 'doc_1');
    await userEvent.click(screen.getByRole('button', { name: /生成脚本草稿/ }));
    await waitFor(() => expect(generate).toHaveBeenCalledWith('ws_1', 'prj_1', 'doc_1', { targetDurationMs: 300000 }));
    expect(createProject).not.toHaveBeenCalled();
    expect(push).toHaveBeenCalledWith('/w/ws_1/p/prj_1/script');
  });

  it('恢复项目归属不匹配时禁止再次创建，并允许重试读取', async () => {
    window.sessionStorage.setItem('ancs-new-project-progress:ws_1', JSON.stringify({ projectId: 'prj_other', documentId: 'doc_1' }));
    const getProject = vi.fn().mockResolvedValueOnce({ workspaceId: 'ws_other', title: '其他作品', sourceType: 'URL', targetDurationMs: 300000 })
      .mockResolvedValueOnce({ workspaceId: 'ws_1', title: '恢复的作品', sourceType: 'URL', targetDurationMs: 300000 });
    const getDocument = vi.fn().mockResolvedValue(parsed);
    const createProject = vi.fn();
    renderWithClient(<NewProjectPage />, mockClient({ ...editableWorkspace, projects: { get: getProject, create: createProject }, content: { get: getDocument } }));
    expect((await screen.findByRole('alert')).textContent).toContain('不属于当前工作区');
    expect((screen.getByRole('button', { name: /读取文章/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(createProject).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '重试恢复' }));
    expect(await screen.findByText(/内容快照已从服务器重新读取/)).toBeTruthy();
    expect(getProject).toHaveBeenCalledTimes(2);
  });

  it('只读成员无法创建或导入作品', async () => {
    const createProject = vi.fn();
    renderWithClient(<NewProjectPage />, mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'VIEWER' }) },
      projects: { create: createProject },
    }));
    expect(await screen.findByText('当前角色可查看工作区，创建作品需要编辑权限。')).toBeTruthy();
    expect((screen.getByRole('button', { name: /读取文章/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('作品名称') as HTMLInputElement).disabled).toBe(true);
    expect(createProject).not.toHaveBeenCalled();
  });
});
