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
const editableWorkspace = { workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) } };

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

const directorPreview = (overrides: Record<string, unknown> = {}) => ({
  narrativePlanId: 'npl_1', narrativePlanRevision: 2,
  scenes: [{ sceneId: 'dsc_1', position: 0, sceneType: 'LINE_CHART', durationMs: 10_000, visualIntent: '先呈现数据趋势' }],
  assetPlan: [], providerJobs: [], estimatedDurationMs: 10_000,
  estimatedCost: { certainty: 'KNOWN', total: { amount: '0.00', currency: 'CNY' }, note: null },
  warnings: [], blocked: false, blockedReasons: [], decisionSummary: '先说明趋势，再展开分析。', ...overrides,
});

describe('Storyboard', () => {
  it('读取素材检索带入的真实源范围，明确不自动修改项目并允许取消', async () => {
    sessionStorage.setItem('ancs-media-selection:ws_1:prj_1', JSON.stringify({ assetId: 'ast_phone', label: '举起手机', sourceStartPts: '200', sourceEndPts: '800', timeBase: { numerator: 1, denominator: 1000 } }));
    renderWithClient(<StoryboardPage />, mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene()])) } }));
    expect(await screen.findByText('已选择真实片段：举起手机')).toBeTruthy();
    expect(screen.getByText(/项目尚未自动修改/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(screen.queryByText('已选择真实片段：举起手机')).toBeNull();
    expect(sessionStorage.getItem('ancs-media-selection:ws_1:prj_1')).toBeNull();
  });

  it('空分镜时同样显示带入的真实片段与源范围（不因空项目丢失选区），取消后不写入任何编辑', async () => {
    sessionStorage.setItem('ancs-media-selection:ws_1:prj_1', JSON.stringify({ assetId: 'ast_phone', label: '举起手机', sourceStartPts: '200', sourceEndPts: '800', timeBase: { numerator: 1, denominator: 1000 } }));
    const edit = vi.fn();
    renderWithClient(<StoryboardPage />, mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([])), edit } }));
    expect(await screen.findByText('分镜还是空的')).toBeTruthy();
    expect(screen.getByText('已选择真实片段：举起手机')).toBeTruthy();
    expect(screen.getByText(/源范围 200–800/)).toBeTruthy();
    expect(screen.getByText(/项目尚未自动修改/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '取消选择' }));
    expect(screen.queryByText('已选择真实片段：举起手机')).toBeNull();
    expect(sessionStorage.getItem('ancs-media-selection:ws_1:prj_1')).toBeNull();
    expect(edit).not.toHaveBeenCalled();
  });

  it('场景选择更新画布和检查器；AI 计划在确认前不写入，确认后走编辑协议', async () => {
    const edit = vi.fn().mockResolvedValue({ project: { revision: 6 }, scenes: [], editEvents: [] });
    const aiEditPlan = vi.fn().mockResolvedValue({
      schemaVersion: '0.1', planVersion: 'edit-plan-v1', planId: 'epl_1', projectId: 'prj_1',
      baseProjectRevision: 5, prompt: '缩短当前旁白', rationale: ['保持节奏'],
      operations: [{ operation: { op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 5000 } }, summary: '缩短 1 秒', sceneId: 'scn_1', before: { durationMs: 6000 }, after: { durationMs: 5000 } }],
      impact: { scenesAdded: 0, scenesRemoved: 0, scenesModified: 1, durationDeltaMs: -1000, costImpact: 'NONE', notes: [] },
      warnings: [], generation: { method: 'LLM', providerId: 'mock.llm', modelVersion: null, promptVersion: null, attempts: 1 },
    });
    const client = mockClient({
      ...editableWorkspace,
      projects: { graph: vi.fn().mockResolvedValue(graph([scene(), scene({ id: 'scn_2', position: 1, props: { ...scene().props, title: '第二个场景' } })])), edit },
      narrative: { current: vi.fn().mockResolvedValue(null), aiEditPlan },
    });
    renderWithClient(<StoryboardPage />, client);
    await screen.findByRole('region', { name: '导演工作台' });
    const cards = document.querySelectorAll('.scene-card');
    expect(cards).toHaveLength(2);
    await userEvent.click(cards[1] as HTMLElement);
    expect(cards[1]?.getAttribute('aria-pressed')).toBe('true');
    expect((document.querySelector('.qf-inspector-forms > div:not([hidden]) input[name="title"]') as HTMLInputElement | null)?.value).toBe('第二个场景');
    await userEvent.click(screen.getByRole('button', { name: '缩短当前旁白' }));
    expect(await screen.findByRole('dialog', { name: 'AI 修改差异' })).toBeTruthy();
    await waitFor(() => expect(aiEditPlan).toHaveBeenCalledTimes(1));
    const scopedPrompt = aiEditPlan.mock.calls[0]?.[2]?.prompt as string;
    expect(scopedPrompt).toContain('sceneId: scn_2');
    expect(scopedPrompt).toContain('第二个场景');
    expect(scopedPrompt).toContain('缩短当前旁白');
    expect(screen.getByText('请求分镜：第二个场景（scn_2）')).toBeTruthy();
    expect(screen.getByText('计划实际目标：scn_1')).toBeTruthy();
    expect(screen.getByText('计划还涉及其他分镜或项目级操作，请核对目标后再应用。')).toBeTruthy();
    expect(edit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '应用（1 项）' }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    const request = edit.mock.calls[0]?.[1] as { baseProjectRevision: number; expectedSceneRevisions: Record<string, number>; operations: { op: string }[] };
    expect(request.baseProjectRevision).toBe(5);
    expect(request.expectedSceneRevisions).toEqual({ scn_1: 2 });
    expect(request.operations[0]?.op).toBe('update_scene');
  });

  it('空：先预览 Director 场景和费用，确认后才应用', async () => {
    let calls = 0;
    const apply = vi.fn().mockResolvedValue({ scenes: [scene()], project: { revision: 6 } });
    const preview = vi.fn().mockResolvedValue(directorPreview());
    const client = mockClient({
      ...editableWorkspace,
      projects: {
        graph: vi.fn().mockImplementation(() => {
          calls += 1;
          return Promise.resolve(calls === 1 ? graph([]) : graph([scene()], 6));
        }),
      },
      narrative: {
        current: vi.fn().mockResolvedValue({ id: 'npl_1', revision: 2 }),
        directorPlan: preview,
        applyDirectorPlan: apply,
      },
    });
    renderWithClient(<StoryboardPage />, client);
    expect(await screen.findByText('分镜还是空的')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '预览 Director 计划' }));
    expect(await screen.findByText('先说明趋势，再展开分析。')).toBeTruthy();
    expect(screen.getByText(/0.00 CNY/)).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '确认应用计划' }));
    expect(preview).toHaveBeenCalledWith('ws_1', 'prj_1', 'npl_1');
    await waitFor(() => expect(apply).toHaveBeenCalledWith('ws_1', 'prj_1', 'npl_1', { idempotencyKey: 'idem_web_director_npl_1_2' }));
    await waitFor(() => expect(document.querySelector('.scene-card.active [data-scene-type="LINE_CHART"]')).toBeTruthy());
    expect(screen.getByRole('region', { name: '导演工作台' })).toBeTruthy();
  });

  it('空 + Director 应用 409（项目已有场景）：冲突状态明确提示', async () => {
    const client = mockClient({
      ...editableWorkspace,
      projects: { graph: vi.fn().mockResolvedValue(graph([])) },
      narrative: {
        current: vi.fn().mockResolvedValue({ id: 'npl_1', revision: 2 }),
        directorPlan: vi.fn().mockResolvedValue(directorPreview()),
        applyDirectorPlan: vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', '项目已有场景', { reason: 'SCENES_EXIST' })),
      },
    });
    renderWithClient(<StoryboardPage />, client);
    await screen.findByText('分镜还是空的');
    // 等待叙事计划加载完成（否则按钮处于 disabled：缺计划）
    await waitFor(() => expect(screen.getByRole('button', { name: '预览 Director 计划' })).not.toHaveProperty('disabled', true));
    await userEvent.click(screen.getByRole('button', { name: '预览 Director 计划' }));
    await userEvent.click(await screen.findByRole('button', { name: '确认应用计划' }));
    expect(await screen.findByText('项目已有场景')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-state="conflict"]')).toBeTruthy());
  });

  it('空：费用未知的 Director 计划不得应用', async () => {
    const apply = vi.fn();
    const client = mockClient({
      ...editableWorkspace,
      projects: { graph: vi.fn().mockResolvedValue(graph([])) },
      narrative: {
        current: vi.fn().mockResolvedValue({ id: 'npl_1', revision: 2 }),
        directorPlan: vi.fn().mockResolvedValue(directorPreview({ estimatedCost: { certainty: 'UNKNOWN', total: null, note: '缺少可核验价格' } })),
        applyDirectorPlan: apply,
      },
    });
    renderWithClient(<StoryboardPage />, client);
    await userEvent.click(await screen.findByRole('button', { name: '预览 Director 计划' }));
    const confirm = await screen.findByRole('button', { name: '确认应用计划' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('缺少可核验价格')).toBeTruthy();
    expect(apply).not.toHaveBeenCalled();
  });

  it('正常：场景卡渲染同源组件预览与来源/数据绑定信息', async () => {
    const client = mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene()])) } });
    renderWithClient(<StoryboardPage />, client);
    expect(await screen.findByRole('region', { name: '导演工作台' })).toBeTruthy();
    const preview = document.querySelector('[data-state="rendered"][data-scene-type="LINE_CHART"]');
    expect(preview).toBeTruthy();
    expect(preview?.innerHTML).toContain('联邦基金利率路径');
    await userEvent.click(screen.getByRole('tab', { name: '来源' }));
    expect(screen.getByText(/事实 1 · 数据集 1/)).toBeTruthy();
    expect(screen.getByText(/当前场景绑定数据 1 项/)).toBeTruthy();
  });

  it('锁定开关附带场景 revision，经统一编辑协议提交', async () => {
    const edit = vi.fn().mockResolvedValue({ project: { revision: 6 }, scenes: [], editEvents: [] });
    const client = mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit } });
    renderWithClient(<StoryboardPage />, client);
    await screen.findByRole('region', { name: '导演工作台' });
    await userEvent.click(screen.getByRole('switch', { name: '锁定当前分镜' }));
    await waitFor(() => expect(edit).toHaveBeenCalledTimes(1));
    const request = edit.mock.calls[0]?.[1] as { expectedSceneRevisions: Record<string, number>; operations: unknown[] };
    expect(request.expectedSceneRevisions).toEqual({ scn_1: 2 });
    expect(request.operations).toEqual([{ op: 'set_scene_lock', sceneId: 'scn_1', locked: true }]);
  });

  it('只读成员可预览分镜，但不能提交属性、锁定、复制或 AI 修改', async () => {
    const edit = vi.fn();
    const aiEditPlan = vi.fn();
    renderWithClient(<StoryboardPage />, mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'VIEWER' }) },
      projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit },
      narrative: { aiEditPlan },
    }));
    expect(await screen.findByRole('region', { name: '导演工作台' })).toBeTruthy();
    expect(await screen.findByText('当前角色只能查看分镜。')).toBeTruthy();
    expect((screen.getByRole('switch', { name: '锁定当前分镜' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /复制当前分镜/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '生成修改建议' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '保存属性' }) as HTMLButtonElement).disabled).toBe(true);
    expect(edit).not.toHaveBeenCalled();
    expect(aiEditPlan).not.toHaveBeenCalled();
  });

  it('过期的素材签名 URL 不进入媒体预览', async () => {
    const downloadUrl = vi.fn().mockResolvedValue({ url: 'https://example.com/expired.png', expiresAt: '2000-01-01T00:00:00.000Z' });
    const media = scene({ sceneType: 'IMAGE_FULL', props: { assetId: null, assetUrl: null, headline: '真实素材' }, assetBindings: [{ assetId: 'ast_1', role: 'visual' }] });
    renderWithClient(<StoryboardPage />, mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([media])) }, assets: { downloadUrl } }));
    await screen.findByRole('region', { name: '导演工作台' });
    await waitFor(() => expect(downloadUrl).toHaveBeenCalledWith('ws_1', 'ast_1'));
    expect(document.querySelector('img[src="https://example.com/expired.png"]')).toBeNull();
  });
});

describe('Scene Editor', () => {
  it('props 表单由组件协议驱动；保存经编辑协议（base + scene revision）；成功提示', async () => {
    const edit = vi.fn().mockResolvedValue({ project: { revision: 6 }, scenes: [scene({ revision: 3 })], editEvents: [] });
    const client = mockClient({
      ...editableWorkspace,
      projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit },
    });
    renderWithClient(<SceneEditorPage />, client);
    expect(await screen.findByTestId('propform')).toBeTruthy();
    expect(screen.getByText('标题')).toBeTruthy();
    expect(screen.getByText('数据序列')).toBeTruthy();
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
    const client = mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit } });
    renderWithClient(<SceneEditorPage />, client);
    await screen.findByTestId('propform');
    await userEvent.click(screen.getByRole('button', { name: '保存属性' }));
    expect(await screen.findByText(/保存冲突/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新场景图' })).toBeTruthy();
  });

  it('props 非法（组件 schema 拒绝）→ 不调用 SDK，表单给出原因', async () => {
    const edit = vi.fn();
    const client = mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene()])), edit } });
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
    const client = mockClient({ ...editableWorkspace, projects: { graph: vi.fn().mockResolvedValue(graph([scene({ id: 'scn_other' })])) } });
    renderWithClient(<SceneEditorPage />, client);
    expect(await screen.findByText('场景不存在')).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新场景图' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '返回当前分镜' }).getAttribute('href')).toBe('/w/ws_1/p/prj_1/storyboard');
  });
});
