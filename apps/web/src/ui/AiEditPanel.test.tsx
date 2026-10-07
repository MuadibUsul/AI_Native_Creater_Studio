import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { EditPlan } from '@ancs/contracts';
import { AiEditPanel } from './AiEditPanel';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/storyboard',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

/**
 * P05-06 Web 验收（AI Edit 面板）：
 * - 生成计划 → 展示 operations/差异/影响/理由/锁定告警；
 * - **Apply**：调用编辑协议（由页面接线；此处断言面板把完整 plan 交回）；成功后计划清空；
 * - **拒绝**：清空状态（无副作用，不调用 SDK）；
 * - 计划阶段零 Provider 成本（面板明确展示 costImpact=NONE）。
 */

const plan = (overrides: Partial<EditPlan> = {}): EditPlan =>
  ({
    schemaVersion: '0.1',
    planVersion: 'edit-plan-v1',
    planId: 'edp_test_1',
    projectId: 'prj_1',
    baseProjectRevision: 7,
    prompt: '把第一个场景延长 800ms',
    rationale: ['按用户意图延长开场'],
    operations: [
      {
        operation: { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 3300 } },
        summary: '修改场景 scn_1…：durationMs',
        sceneId: 'scn_1',
        before: { durationMs: 2500 },
        after: { durationMs: 3300 },
      },
    ],
    impact: { scenesAdded: 0, scenesRemoved: 0, scenesModified: 1, durationDeltaMs: 800, costImpact: 'NONE', notes: [] },
    warnings: [],
    generation: { method: 'LLM', providerId: 'mock.llm', modelVersion: null, promptVersion: 'ai-edit-v1', attempts: 1 },
    ...overrides,
  }) as EditPlan;

const baseProps = {
  plan: null,
  planPending: false,
  planError: null,
  onPlan: vi.fn(),
  onApply: vi.fn(),
  onReject: vi.fn(),
  applyPending: false,
  applyError: null,
};

describe('AiEditPanel（P05-06）', () => {
  it('生成计划：提交意图（不触发 Apply/SDK 之外的任何动作）', async () => {
    const onPlan = vi.fn();
    renderWithClient(<AiEditPanel {...baseProps} onPlan={onPlan} />, mockClient({}));
    await userEvent.type(screen.getByLabelText('AI Edit 意图'), '把第一个场景延长 800ms');
    await userEvent.click(screen.getByRole('button', { name: '生成计划' }));
    expect(onPlan).toHaveBeenCalledWith('把第一个场景延长 800ms');
  });

  it('计划展示：操作摘要 + before→after 差异 + 理由 + 影响 + 成本 NONE', () => {
    renderWithClient(<AiEditPanel {...baseProps} plan={plan()} />, mockClient({}));
    expect(screen.getByTestId('ai-edit-operations').textContent).toContain('update_scene');
    expect(screen.getByText('− durationMs: 2500')).toBeTruthy();
    expect(screen.getByText('+ durationMs: 3300')).toBeTruthy();
    expect(screen.getByText(/理由：按用户意图延长开场/)).toBeTruthy();
    expect(screen.getByTestId('ai-edit-impact').textContent).toContain('时长 +800ms');
    expect(screen.getByText('成本影响').parentElement?.textContent).toContain('无（计划阶段零 Provider 调用）');
  });

  it('锁定告警必须展示（AI 不得修改锁定场景）', () => {
    renderWithClient(
      <AiEditPanel {...baseProps} plan={plan({ warnings: ['已跳过对锁定场景 scn_locked… 的操作（update_scene）：AI 不得修改锁定场景（§4.7），如需修改请先显式解锁。'] })} />,
      mockClient({}),
    );
    expect(screen.getByTestId('ai-edit-warning').textContent).toContain('已跳过对锁定场景');
    expect(screen.getByTestId('ai-edit-warning').textContent).toContain('请先显式解锁');
  });

  it('Apply：把完整计划交回（由页面走编辑协议）；拒绝：清空且不调用 Apply', async () => {
    const onApply = vi.fn();
    const onReject = vi.fn();
    renderWithClient(<AiEditPanel {...baseProps} plan={plan()} onApply={onApply} onReject={onReject} />, mockClient({}));
    await userEvent.click(screen.getByRole('button', { name: '应用（1 项）' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect((onApply.mock.calls[0]?.[0] as EditPlan).planId).toBe('edp_test_1');
    await userEvent.click(screen.getByRole('button', { name: '拒绝计划' }));
    expect(onReject).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('失败重试预填原意图；应用期间禁用拒绝，避免把进行中的提交误当取消', async () => {
    const onReject = vi.fn();
    const view = renderWithClient(<AiEditPanel {...baseProps} initialPrompt="保留来源并缩短开场" plan={plan()} onReject={onReject} />, mockClient({}));
    await userEvent.click(screen.getByRole('button', { name: '修改意图并重新生成计划' }));
    expect((screen.getByLabelText('AI Edit 意图') as HTMLInputElement).value).toBe('保留来源并缩短开场');
    view.unmount();
    renderWithClient(<AiEditPanel {...baseProps} plan={plan()} applyPending onReject={onReject} />, mockClient({}));
    const reject = screen.getByRole('button', { name: '拒绝计划' });
    expect(reject.hasAttribute('disabled')).toBe(true);
    await userEvent.click(reject);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('错误展示：生成失败（422）与应用失败（409 冲突 → 明确刷新提示）；整批不提交的文案明确', () => {
    const { unmount } = renderWithClient(
      <AiEditPanel {...baseProps} planError={{ kind: 'validation', message: '计划引用了不存在的场景', code: 'VALIDATION_FAILED' }} />,
      mockClient({}),
    );
    expect(screen.getByTestId('ai-edit-plan-error').textContent).toContain('计划引用了不存在的场景');
    unmount();

    renderWithClient(
      <AiEditPanel {...baseProps} plan={plan()} applyError={{ kind: 'conflict', message: '场景已被更新', code: 'VERSION_CONFLICT' }} />,
      mockClient({}),
    );
    expect(screen.getByTestId('ai-edit-apply-error').textContent).toContain('请刷新后重新生成计划');
  });
});

describe('Storyboard × AI Edit（计划不落库 → Apply 走编辑协议）', () => {
  it('Apply 只在用户确认后发生，并以计划 operations + revision 条件提交', async () => {
    const { default: StoryboardPage } = await import('@/app/w/[workspaceId]/p/[projectId]/storyboard/page');

    const scene = {
      id: 'scn_1',
      revision: 3,
      position: 0,
      startMs: 0,
      durationMs: 2500,
      semanticType: 'TRANSITION',
      sceneType: 'CHAPTER_TITLE',
      narrationBlockIds: [],
      narration: '开场',
      visualIntent: '',
      componentId: null,
      componentVersion: null,
      props: { title: '开场', subtitle: null, index: 1 },
      providerRequirement: null,
      sourceBindings: [],
      dataBindings: [],
      assetBindings: [],
      transition: { in: null, out: null },
      locked: false,
      approved: false,
      needsReview: false,
      status: 'DRAFT',
    };
    const graphFn = vi.fn().mockResolvedValue({
      schemaVersion: '0.1',
      projectId: 'prj_1',
      projectRevision: 7,
      channelSnapshot: {},
      identitySnapshot: {},
      format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
      timeline: { durationMs: 2500, masterAudioAssetId: null },
      scenes: [scene],
      captions: [],
      audioTracks: [],
      overlays: [],
      sourceReferences: [],
    });
    const planFn = vi.fn().mockResolvedValue(plan());
    const editFn = vi.fn().mockResolvedValue({ project: { revision: 8 }, scenes: [], editEvents: [] });

    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      projects: { graph: graphFn, edit: editFn },
      narrative: { current: vi.fn().mockResolvedValue(null), aiEditPlan: planFn },
      assets: { downloadUrl: vi.fn().mockRejectedValue(new Error('none')) },
    });

    renderWithClient(<StoryboardPage />, client);
    await screen.findByRole('region', { name: '导演工作台' });
    await userEvent.type(screen.getByRole('textbox', { name: '修改当前分镜' }), '延长开场 800ms');
    await userEvent.click(screen.getByRole('button', { name: '生成修改建议' }));
    await waitFor(() => expect(planFn).toHaveBeenCalledTimes(1));
    // 仅生成计划：未 Apply，编辑协议未被调用
    expect(editFn).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole('button', { name: '应用（1 项）' }));
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    const [, request] = editFn.mock.calls[0] as [string, { baseProjectRevision: number; expectedSceneRevisions: Record<string, number>; operations: { op: string }[] }];
    expect(request.baseProjectRevision).toBe(7);
    expect(request.expectedSceneRevisions).toEqual({ scn_1: 3 });
    expect(request.operations[0]?.op).toBe('update_scene');
  });
});
