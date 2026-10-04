import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1', sceneId: 'scn_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/storyboard',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: StoryboardPage } = await import('./w/[workspaceId]/p/[projectId]/storyboard/page.js');
const { default: SceneEditorPage } = await import('./w/[workspaceId]/p/[projectId]/editor/[sceneId]/page.js');

/**
 * Storyboard / Scene Editor 状态矩阵（P05-03）：
 * 空（可应用 Director 计划；已有场景 409 明确提示）/ 正常（场景卡 + 同源组件预览 + 编辑入口）/
 * 编辑器（props 表单由组件协议驱动；提交经编辑协议；409 → 冲突块可刷新）/ 场景不存在（明确说明）。
 */

const scene = (overrides: Record<string, unknown> = {}) => ({
  id: 'scn_1',
  revision: 2,
  position: 0,
  startMs: 0,
  durationMs: 6000,
  semanticType: 'PRICE_SERIES',
  sceneType: 'LINE_CHART',
  narrationBlockIds: ['nbr_1'],
  narration: '联邦基金利率维持在 5.25%。',
  visualIntent: '',
  componentId: null,
  componentVersion: null,
  props: {
    title: '联邦基金利率路径',
    unit: '%',
    series: [{ name: '利率', points: [{ t: '2023', v: 4.5 }, { t: '2024', v: 5.25 }, { t: '2025', v: 4.0 }] }],
    sourceLabel: '示例数据集',
  },
  providerRequirement: null,
  sourceBindings: [{ sourceId: 'src_1', datasetIds: ['dst_1'], claimIds: ['clm_1'] }],
  dataBindings: [{ datasetId: 'dst_1', seriesId: null }],
  assetBindings: [],
  transition: { in: null, out: null },
  locked: false,
  approved: false,
  needsReview: false,
  status: 'DRAFT',
  ...overrides,
});
const graph = (scenes: unknown[], projectRevision = 5) => ({
  schemaVersion: '0.1',
  projectId: 'prj_1',
  projectRevision,
  channelSnapshot: {},
  identitySnapshot: {},
  format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
  timeline: { durationMs: 6000 },
  scenes,
  captions: [],
  audioTracks: [],
  overlays: [],
  sourceReferences: [],
});

describe('Storyboard', () => {
  it('空：应用 Director 计划（调用 SDK；成功后刷新）', async () => {
    let calls = 0;
    const apply = vi.fn().mockResolvedValue({ scenes: [scene()], project: { revision: 6 } });
    const client = mockClient({
      projects: {
        graph: vi.fn().mockImplementation(() => {
          calls += 1;
          return Promise.resolve(calls === 1 ? graph([]) : graph([scene()], 6));
        }),
      },
      narrative: {
        current: vi.fn().mockResolvedValue({ id: 'npl_1', revision: 2 }),
        applyDirectorPlan: apply,
      },
    });
    renderWithClient(<StoryboardPage />, client);
    expect(await screen.findByText('分镜还是空的')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '应用 Director 计划' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('ws_1', 'prj_1', 'npl_1', { idempotencyKey: 'idem_web_director_npl_1_2' }));
    expect(await screen.findByText(/#0 LINE_CHART/)).toBeTruthy();
  });

  it('空 + Director 应用 409（项目已有场景）：冲突状态明确提示', async () => {
    const client = mockClient({
      projects: { graph: vi.fn().mockResolvedValue(graph([])) },
      narrative: {
        current: vi.fn().mockResolvedValue({ id: 'npl_1', revision: 2 }),
        applyDirectorPlan: vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', '项目已有场景', { reason: 'SCENES_EXIST' })),
      },
    });
    renderWithClient(<StoryboardPage />, client);
    await screen.findByText('分镜还是空的');
    // 等待叙事计划加载完成（否则按钮处于 disabled：缺计划）
    await waitFor(() => expect(screen.getByRole('button', { name: '应用 Director 计划' })).not.toHaveProperty('disabled', true));
    await userEvent.click(screen.getByRole('button', { name: '应用 Director 计划' }));
    expect(await screen.findByText('项目已有场景')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-state="conflict"]')).toBeTruthy());
  });

  it('正常：场景卡渲染同源组件预览与来源/数据绑定信息', async () => {
    const client = mockClient({ projects: { graph: vi.fn().mockResolvedValue(graph([scene()])) } });
    renderWithClient(<StoryboardPage />, client);
    expect(await screen.findByText('Storyboard')).toBeTruthy();
    const preview = document.querySelector('[data-state="rendered"][data-scene-type="LINE_CHART"]');
    expect(preview).toBeTruthy();
    expect(preview?.innerHTML).toContain('联邦基金利率路径');
    expect(screen.getByText(/数据绑定 1 · 来源绑定 1/)).toBeTruthy();
  });
});

describe('Scene Editor', () => {
  it('props 表单由组件协议驱动；保存经编辑协议（base + scene revision）；成功提示', async () => {
    const edit = vi.fn().mockResolvedValue({ project: { revision: 6 }, scenes: [scene({ revision: 3 })], editEvents: [] });
    const client = mockClient({
      projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit },
    });
    renderWithClient(<SceneEditorPage />, client);
    expect(await screen.findByTestId('propform')).toBeTruthy();
    const titleInput = screen.getByLabelText(/title/);
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, '利率路径（修订）');
    await userEvent.click(screen.getByRole('button', { name: '保存属性' }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    const [projectId, request] = edit.mock.calls[0] as [string, { baseProjectRevision: number; expectedSceneRevisions: Record<string, number>; operations: { op: string }[] }];
    expect(projectId).toBe('prj_1');
    expect(request.baseProjectRevision).toBe(5);
    expect(request.expectedSceneRevisions).toEqual({ scn_1: 2 });
    expect(request.operations[0]?.op).toBe('update_scene');
    expect(await screen.findByText('已保存')).toBeTruthy();
  });

  it('保存 409 VERSION_CONFLICT → 冲突块（提供"刷新场景图"动作）', async () => {
    const edit = vi.fn().mockRejectedValue(apiError(409, 'VERSION_CONFLICT', '场景已被其他编辑更新'));
    const client = mockClient({ projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit } });
    renderWithClient(<SceneEditorPage />, client);
    await screen.findByTestId('propform');
    await userEvent.click(screen.getByRole('button', { name: '保存属性' }));
    expect(await screen.findByText(/保存冲突/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新场景图' })).toBeTruthy();
  });

  it('props 非法（组件 schema 拒绝）→ 不调用 SDK，表单给出原因', async () => {
    const edit = vi.fn();
    const client = mockClient({ projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit } });
    renderWithClient(<SceneEditorPage />, client);
    await screen.findByTestId('propform');
    const seriesField = screen.getByLabelText(/series/);
    await userEvent.clear(seriesField);
    await userEvent.type(seriesField, '{{{{not json');
    // 直接提交（JSON 解析失败）
    await userEvent.click(screen.getByRole('button', { name: '保存属性' }));
    expect(await screen.findByTestId('propform-feedback')).toBeTruthy();
    expect(edit).not.toHaveBeenCalled();
  });

  it('场景不存在（并发删除）→ 明确说明并可刷新', async () => {
    const client = mockClient({ projects: { graph: vi.fn().mockResolvedValue(graph([scene({ id: 'scn_other' })])) } });
    renderWithClient(<SceneEditorPage />, client);
    expect(await screen.findByText('场景不存在')).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新场景图' })).toBeTruthy();
  });
});
