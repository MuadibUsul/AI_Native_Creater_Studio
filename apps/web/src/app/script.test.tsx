import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/script',
}));

const { default: ScriptPage } = await import('./w/[workspaceId]/p/[projectId]/script/page.js');

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
  it('空：导入文章 → 归一化 → 抽取 → 生成叙事（全部经 SDK）', async () => {
    const create = vi.fn().mockResolvedValue({ document: { id: 'doc_1' }, sourceId: 'src_1' });
    const extract = vi.fn().mockResolvedValue({ claims: [] });
    const generate = vi.fn().mockResolvedValue({ plan: plan([block()]), meta: {} });
    let current: unknown = null;
    const client = mockClient({
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

  it('正常：旁白块可见；锁定按钮调用 SDK；锁定后改文本 → 明确冲突提示', async () => {
    const updateBlock = vi
      .fn()
      .mockResolvedValueOnce(block({ locked: true }))
      .mockRejectedValueOnce(apiError(409, 'NARRATION_BLOCK_LOCKED', '旁白块已锁定'));
    let locked = false;
    const client = mockClient({
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

    // 锁定状态下尝试改文本：SDK 抛 409 → 界面显示冲突块（可关闭）
    await userEvent.click(screen.getByRole('button', { name: '编辑' }));
    const textarea = screen.getByLabelText('旁白文本 nbr_1');
    await userEvent.clear(textarea);
    await userEvent.type(textarea, '试图改写锁定旁白');
    await userEvent.click(screen.getByRole('button', { name: '保存文本' }));
    expect(await screen.findByText('旁白块操作被拒绝')).toBeTruthy();
    expect(screen.getByText(/请先解锁/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(screen.queryByText('旁白块操作被拒绝')).toBeNull();
  });

  it('失败：加载错误块可重试', async () => {
    const current = vi.fn().mockRejectedValueOnce(apiError(403, 'FORBIDDEN', '无权访问')).mockResolvedValue(plan([block()]));
    const client = mockClient({ narrative: { current } });
    renderWithClient(<ScriptPage />, client);
    expect(await screen.findByText('加载叙事计划失败')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(current).toHaveBeenCalledTimes(2));
  });
});
