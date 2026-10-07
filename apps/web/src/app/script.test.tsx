import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/script',
}));

const { default: ScriptPage } = await import('./w/[workspaceId]/p/[projectId]/script/page.js');
const editableWorkspace = { workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) } };

/**
 * Script 状态矩阵（P05-03）：空（导入并生成）/ 正常（章节与旁白块）/ 锁定 409（明确提示、可解锁）/
 * 编辑文本（调用 SDK）/ 失败（可重试）。
 */

const block = (overrides: Record<string, unknown> = {}) => ({
  id: 'nbr_1',
  position: 0,
  text: '联邦基金利率维持在 5.25%。',
  chapterId: 'nch_1',
  claimIds: ['clm_1'],
  estimatedDurationMs: 4000,
  locked: false,
  status: 'DRAFT',
  ...overrides,
});
const plan = (blocks: unknown[]) => ({
  schemaVersion: '0.1',
  id: 'npl_1',
  revision: 1,
  title: '利率周报｜视频叙事',
  thesis: '围绕利率解释发生了什么。',
  hook: '开场',
  chapters: [{ id: 'nch_1', title: '开场与核心事实', intent: null, narrationBlockIds: ['nbr_1'] }],
  narrationBlocks: blocks,
  keyClaims: ['clm_1'],
  requiredVisualFacts: [],
  ending: '结尾',
  estimatedDurationMs: 4000,
  generation: { method: 'LLM', providerId: 'mock.llm', modelVersion: null, promptVersion: 'narrative-v1' },
});

describe('Script', () => {
  it('显示真实来源快照与事实引用，链接只来自已验证的网页协议', async () => {
    const source = {
      id: 'src_1', workspaceId: 'ws_1', projectId: 'prj_1', url: 'https://example.com/research',
      title: '研究原文', publisher: '研究机构', author: null, publishedAt: null,
      retrievedAt: '2026-10-07T00:00:00Z', contentHash: 'a'.repeat(64),
      excerpt: '已保存的来源摘录', snapshotKind: 'live_fetch', note: null,
    };
    const client = mockClient({
      ...editableWorkspace,
      narrative: { current: vi.fn().mockResolvedValue(plan([block()])) },
      content: { sources: vi.fn().mockResolvedValue([source]) },
      evidence: {
        claims: vi.fn().mockResolvedValue([{ id: 'clm_1', text: '可复核的事实', factuality: 'fact' }]),
        citations: vi.fn().mockResolvedValue([{ id: 'cit_1', sourceId: 'src_1', locator: 'blk_1:0-12', quotedText: '来源中的原句' }]),
      },
    });
    renderWithClient(<ScriptPage />, client);
    await screen.findByText('研究原文');
    const sourceTrigger = screen.getByRole('button', { name: '查看来源 →' });
    await userEvent.click(sourceTrigger);
    const sourceDialog = screen.getByRole('dialog', { name: '来源详情' });
    expect(within(sourceDialog).getByText('已保存的来源摘录')).toBeTruthy();
    expect(within(sourceDialog).getByRole('link', { name: '打开原始地址 →' }).getAttribute('href')).toBe('https://example.com/research');
    expect(document.activeElement).toBe(within(sourceDialog).getByRole('button', { name: '关闭' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(within(sourceDialog).getByRole('link', { name: '打开原始地址 →' }));
    await userEvent.tab();
    expect(document.activeElement).toBe(within(sourceDialog).getByRole('button', { name: '关闭' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '来源详情' })).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(sourceTrigger));
    await userEvent.click(screen.getByRole('button', { name: '查看事实引用 clm_1' }));
    const claimDialog = screen.getByRole('dialog', { name: '来源详情' });
    expect(await within(claimDialog).findByText('可复核的事实')).toBeTruthy();
    expect(within(claimDialog).getByText('来源中的原句')).toBeTruthy();
  });

  it('空：导入文章 → 归一化 → 抽取 → 生成叙事（全部经 SDK）', async () => {
    const create = vi.fn().mockResolvedValue({ document: { id: 'doc_1' }, sourceId: 'src_1' });
    const extract = vi.fn().mockResolvedValue({ claims: [] });
    const generate = vi.fn().mockResolvedValue({ plan: plan([block()]), meta: {} });
    let current: unknown = null;
    const client = mockClient({
      ...editableWorkspace,
      content: { create },
      evidence: { extract },
      narrative: {
        current: vi.fn().mockImplementation(() => Promise.resolve(current)),
        generate: vi.fn().mockImplementation(async () => {
          current = plan([block()]);
          return generate();
        }),
      },
    });
    renderWithClient(<ScriptPage />, client);
    expect(await screen.findByText('还没有叙事计划')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('文章链接'), 'https://news.example/a');
    await userEvent.click(screen.getByRole('button', { name: '导入并生成叙事' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('ws_1', 'prj_1', { sourceType: 'URL_ARTICLE', url: 'https://news.example/a' }));
    await waitFor(() => expect(extract).toHaveBeenCalledWith('ws_1', 'prj_1', 'doc_1'));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('开场与核心事实')).toBeTruthy();
  });

  it('锁定后编辑禁用；并发锁定导致保存 409 时保留文本草稿', async () => {
    const updateBlock = vi
      .fn()
      .mockResolvedValueOnce(block({ locked: true }))
      .mockResolvedValueOnce(block({ locked: false }))
      .mockRejectedValueOnce(apiError(409, 'NARRATION_BLOCK_LOCKED', '旁白块已锁定'));
    let locked = false;
    const client = mockClient({
      ...editableWorkspace,
      narrative: {
        current: vi.fn().mockImplementation(() => Promise.resolve(plan([block({ locked })]))),
        updateBlock: vi.fn().mockImplementation(async (_ws, _p, _plan, _blockId, input: { locked?: boolean; text?: string }) => {
          if (input.locked !== undefined) {
            locked = input.locked;
            return updateBlock(input);
          }
          return updateBlock(input);
        }),
      },
    });
    renderWithClient(<ScriptPage />, client);
    await screen.findByText('开场与核心事实');

    await userEvent.click(screen.getByRole('button', { name: '锁定' }));
    await waitFor(() => expect(updateBlock).toHaveBeenCalledWith({ locked: true }));

    // 本地已知锁定状态下不可编辑；解锁后仍需处理服务器并发锁定。
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' }).hasAttribute('disabled')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: '解锁' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '编辑' }).hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByLabelText('旁白文本 nbr_1');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '试图改写锁定旁白');
    await userEvent.click(screen.getByRole('button', { name: '保存文本' }));
    expect(await screen.findByText('旁白块操作被拒绝')).toBeTruthy();
    expect(screen.getByText(/旁白修改发生冲突/)).toBeTruthy();
    expect((textarea as HTMLTextAreaElement).value).toBe('试图改写锁定旁白');
    await userEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText('旁白块操作被拒绝')).toBeNull();
  });

  it('切换段落编辑时保留各段未提交草稿，取消仅放弃当前段', async () => {
    const updateBlock = vi.fn();
    const client = mockClient({ ...editableWorkspace, narrative: { current: vi.fn().mockResolvedValue(plan([block(), block({ id: 'nbr_2', position: 1, text: '第二段原文。' })])), updateBlock } });
    renderWithClient(<ScriptPage />, client);
    await screen.findByText('第二段原文。');
    await userEvent.click(screen.getAllByRole('button', { name: '编辑' })[0] as HTMLElement);
    const first = screen.getByLabelText('旁白文本 nbr_1');
    await userEvent.clear(first);
    await userEvent.type(first, '第一段未提交草稿');
    await userEvent.click(screen.getAllByRole('button', { name: '编辑' })[1] as HTMLElement);
    expect((screen.getByLabelText('旁白文本 nbr_2') as HTMLTextAreaElement).value).toBe('第二段原文。');
    await userEvent.click(screen.getAllByRole('button', { name: '编辑' })[0] as HTMLElement);
    expect((screen.getByLabelText('旁白文本 nbr_1') as HTMLTextAreaElement).value).toBe('第一段未提交草稿');
    expect(updateBlock).not.toHaveBeenCalled();
  });

  it('失败：加载错误块可重试', async () => {
    const current = vi.fn().mockRejectedValueOnce(apiError(403, 'FORBIDDEN', '无权访问')).mockResolvedValue(plan([block()]));
    const client = mockClient({ ...editableWorkspace, narrative: { current } });
    renderWithClient(<ScriptPage />, client);
    expect(await screen.findByText('加载叙事计划失败')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(current).toHaveBeenCalledTimes(2));
  });

  it('只读成员可阅读脚本和来源，不能锁定或编辑旁白', async () => {
    const updateBlock = vi.fn();
    renderWithClient(<ScriptPage />, mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'VIEWER' }) },
      narrative: { current: vi.fn().mockResolvedValue(plan([block()])), updateBlock },
      content: { sources: vi.fn().mockResolvedValue([]) },
    }));
    expect(await screen.findByText('当前角色只能查看脚本。')).toBeTruthy();
    expect((screen.getByRole('button', { name: '锁定' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(true);
    expect(updateBlock).not.toHaveBeenCalled();
  });
});
