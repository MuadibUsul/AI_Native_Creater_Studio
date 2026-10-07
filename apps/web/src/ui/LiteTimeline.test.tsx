import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LiteTimeline } from './LiteTimeline';
import { mockClient, renderWithClient } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/storyboard',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

/**
 * P05-05 验收（Lite Timeline）：
 * - 操作 → **统一编辑协议** payload（operation + expected revisions + 幂等键由页面接线）；
 * - reorder/move/trim/split/duplicate/delete/替换素材/转场/缩放-位移/音量/字幕 逐项映射；
 * - 锁定场景的编辑由服务端拒绝（409）→ 明确提示（此处验证页面错误展示路径）；
 * - 刷新后状态一致：编辑成功后 graph 查询失效并重新读取（以服务端权威数据为准）。
 */

const scene = (overrides: Record<string, unknown> = {}) => ({
  id: 'scn_1',
  revision: 1,
  position: 0,
  startMs: 0,
  durationMs: 4000,
  semanticType: 'PRICE_SERIES',
  sceneType: 'LINE_CHART',
  narrationBlockIds: [],
  narration: '',
  visualIntent: '',
  componentId: null,
  componentVersion: null,
  props: { title: '', unit: '', series: [], sourceLabel: null },
  providerRequirement: null,
  sourceBindings: [],
  dataBindings: [],
  assetBindings: [],
  transition: { in: null, out: null },
  locked: false,
  approved: false,
  needsReview: false,
  status: 'DRAFT',
  ...overrides,
});

const mediaScene = (overrides: Record<string, unknown> = {}) =>
  scene({
    id: 'scn_media',
    position: 1,
    startMs: 4000,
    sceneType: 'IMAGE_FULL',
    semanticType: 'IMAGE_EVIDENCE',
    props: { assetId: 'ast_1', assetUrl: null, caption: null, sourceLabel: null, scale: 1, offsetX: 0, offsetY: 0, headline: null },
    assetBindings: [{ assetId: 'ast_1', role: 'visual' }],
    ...overrides,
  });

const graph = (overrides: Record<string, unknown> = {}) => ({
  projectRevision: 7,
  scenes: [scene(), mediaScene()],
  captions: [],
  audioTracks: [],
  ...overrides,
});

describe('LiteTimeline（统一操作协议）', () => {
  it('上移/下移 → reorder_scenes（完整顺序 + 涉及场景的 expected revision）', async () => {
    const onEdit = vi.fn();
    renderWithClient(<LiteTimeline graph={graph() as never} onEdit={onEdit} />, mockClient({}));
    await userEvent.click(screen.getAllByRole('button', { name: '↓' })[0] ?? screen.getByRole('button', { name: '↓' }));
    expect(onEdit).toHaveBeenCalledWith({
      operations: [{ op: 'reorder_scenes', orderedSceneIds: ['scn_media', 'scn_1'] }],
      expectedSceneRevisions: { scn_1: 1 },
    });
  });

  it('时长（trim）→ update_scene.durationMs（不改 startMs：由服务端绝对定位）', async () => {
    const onEdit = vi.fn();
    renderWithClient(<LiteTimeline graph={graph() as never} onEdit={onEdit} />, mockClient({}));
    const duration = screen.getByLabelText('时长 0');
    fireEvent.change(duration, { target: { value: '6500' } });
    fireEvent.blur(duration);
    expect(onEdit).toHaveBeenCalledWith({
      operations: [{ op: 'update_scene', sceneId: 'scn_1', changes: { durationMs: 6500 } }],
      expectedSceneRevisions: { scn_1: 1 },
    });
  });

  it('拆分 / 复制 / 删除 逐项映射到协议操作', async () => {
    const onEdit = vi.fn();
    renderWithClient(<LiteTimeline graph={graph() as never} onEdit={onEdit} />, mockClient({}));

    const splitInput = screen.getByLabelText('拆分位置 0');
    fireEvent.change(splitInput, { target: { value: '1500' } });
    await userEvent.click(screen.getAllByRole('button', { name: '拆分' })[0] ?? screen.getByRole('button', { name: '拆分' }));
    expect(onEdit).toHaveBeenLastCalledWith({ operations: [{ op: 'split_scene', sceneId: 'scn_1', atMs: 1500 }], expectedSceneRevisions: { scn_1: 1 } });

    await userEvent.click(screen.getAllByRole('button', { name: '复制' })[0] ?? screen.getByRole('button', { name: '复制' }));
    expect(onEdit).toHaveBeenLastCalledWith({ operations: [{ op: 'duplicate_scene', sceneId: 'scn_1', afterSceneId: null }], expectedSceneRevisions: {} });

    await userEvent.click(screen.getAllByRole('button', { name: '删除' })[0] ?? screen.getByRole('button', { name: '删除' }));
    expect(onEdit).toHaveBeenLastCalledWith({ operations: [{ op: 'delete_scene', sceneId: 'scn_1' }], expectedSceneRevisions: { scn_1: 1 } });
  });

  it('转场 / 媒体缩放与位移（props 经组件 schema 后整体合并提交）/ 替换素材', async () => {
    const onEdit = vi.fn();
    renderWithClient(
      <LiteTimeline graph={graph() as never} assets={[{ id: 'ast_9', assetType: 'SOURCE_IMAGE' }]} onEdit={onEdit} />,
      mockClient({}),
    );

    const transition = screen.getByLabelText('转场 1');
    fireEvent.change(transition, { target: { value: 'fade/' } });
    fireEvent.blur(transition);
    expect(onEdit).toHaveBeenLastCalledWith({
      operations: [{ op: 'update_scene', sceneId: 'scn_media', changes: { transition: { in: 'fade', out: null } } }],
      expectedSceneRevisions: { scn_media: 1 },
    });

    const scale = screen.getByLabelText('缩放 1');
    fireEvent.change(scale, { target: { value: '1.4' } });
    fireEvent.blur(scale);
    const scaleCall = onEdit.mock.calls.at(-1)?.[0] as { operations: { op: string; changes: { props: Record<string, unknown> } }[] };
    expect(scaleCall.operations[0]?.op).toBe('update_scene');
    expect(scaleCall.operations[0]?.changes.props).toMatchObject({ scale: 1.4, assetId: 'ast_1' });

    await userEvent.selectOptions(screen.getByLabelText('替换素材 1'), 'ast_9');
    expect(onEdit).toHaveBeenLastCalledWith({
      operations: [{ op: 'replace_asset', sceneId: 'scn_media', role: 'visual', newAssetId: 'ast_9' }],
      expectedSceneRevisions: { scn_media: 1 },
    });
  });

  it('非法缩放值被组件 schema 拒绝：不提交（不写坏数据）', async () => {
    const onEdit = vi.fn();
    renderWithClient(<LiteTimeline graph={graph() as never} onEdit={onEdit} />, mockClient({}));
    const scale = screen.getByLabelText('缩放 1');
    fireEvent.change(scale, { target: { value: '9' } }); // 超出 [0.1, 4]
    fireEvent.blur(scale);
    expect(onEdit).not.toHaveBeenCalled();
  });

  it('音量与字幕：有数据时映射到协议操作；无数据时诚实空态', async () => {
    const onEdit = vi.fn();
    const withTracks = graph({
      audioTracks: [{ id: 'trk_1', kind: 'NARRATION', assetId: null, volume: 1, fadeInMs: 0, fadeOutMs: 0, ducking: false }],
      captions: [{ id: 'cap_1', sceneId: 'scn_1', startMs: 0, durationMs: 2000, text: '原文', words: [] }],
    });
    const { unmount } = renderWithClient(<LiteTimeline graph={withTracks as never} onEdit={onEdit} />, mockClient({}));
    const volume = screen.getByLabelText('音量 trk_1');
    fireEvent.change(volume, { target: { value: '0.6' } });
    fireEvent.blur(volume);
    expect(onEdit).toHaveBeenLastCalledWith({ operations: [{ op: 'update_audio_track', trackId: 'trk_1', changes: { volume: 0.6 } }], expectedSceneRevisions: {} });
    const caption = screen.getByLabelText('字幕文本 cap_1');
    fireEvent.change(caption, { target: { value: '修正后字幕' } });
    fireEvent.blur(caption);
    expect(onEdit).toHaveBeenLastCalledWith({ operations: [{ op: 'update_caption', captionId: 'cap_1', changes: { text: '修正后字幕' } }], expectedSceneRevisions: {} });
    unmount();

    renderWithClient(<LiteTimeline graph={graph() as never} onEdit={onEdit} />, mockClient({}));
    expect(screen.getByText(/暂无音轨/)).toBeTruthy();
    expect(screen.getByText(/暂无字幕/)).toBeTruthy();
  });

  it('错误展示：409 冲突明确提示刷新（不自动重试/不解锁）', () => {
    renderWithClient(
      <LiteTimeline graph={graph() as never} onEdit={vi.fn()} error={{ kind: 'conflict', message: '场景已被其他编辑更新', code: 'VERSION_CONFLICT' }} />,
      mockClient({}),
    );
    expect(screen.getByTestId('timeline-error').textContent).toContain('编辑冲突（服务端状态已变化）：请刷新后重试');
    expect(screen.getByTestId('timeline-error').textContent).toContain('VERSION_CONFLICT');
  });
});

describe('Storyboard × Lite Timeline（刷新后一致）', () => {
  it('编辑成功后失效并重新查询 graph（以服务端权威数据渲染）', async () => {
    const { default: StoryboardPage } = await import('@/app/w/[workspaceId]/p/[projectId]/storyboard/page');

    let projectRevision = 7;
    let durationMs = 4000;
    const graphFn = vi.fn().mockImplementation(() =>
      Promise.resolve({
        schemaVersion: '0.1',
        projectId: 'prj_1',
        projectRevision,
        channelSnapshot: {},
        identitySnapshot: {},
        format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
        timeline: { durationMs: 4000, masterAudioAssetId: null },
        scenes: [scene({ durationMs })],
        captions: [],
        audioTracks: [],
        overlays: [],
        sourceReferences: [],
      }),
    );
    const editFn = vi.fn().mockImplementation(async () => {
      projectRevision = 8;
      durationMs = 6500;
      return { project: { revision: 8 }, scenes: [], editEvents: [] };
    });
    const client = mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      projects: { graph: graphFn, edit: editFn },
      assets: { list: vi.fn().mockResolvedValue([]), downloadUrl: vi.fn().mockRejectedValue(new Error('no asset')) },
    });

    const { renderWithClient: render } = await import('@/test-utils.js');
    render(<StoryboardPage />, client);
    await screen.findByRole('region', { name: '导演工作台' });
    await userEvent.click(screen.getByRole('button', { name: '展开轻时间线' }));
    await waitFor(() => expect(graphFn).toHaveBeenCalledTimes(1));

    const duration = screen.getByLabelText('时长 0');
    fireEvent.change(duration, { target: { value: '6500' } });
    fireEvent.blur(duration);

    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    // 刷新：graph 重新查询，且服务端返回的新时长进入界面（不一致时不冒充一致）
    await waitFor(() => expect(graphFn).toHaveBeenCalledTimes(2));
    await waitFor(() => expect((screen.getByLabelText('时长 0') as HTMLInputElement).defaultValue).toBe('6500'));
  });

  it('项目新上传且未绑定的 READY 素材可替换空绑定媒体场景', async () => {
    const { default: StoryboardPage } = await import('@/app/w/[workspaceId]/p/[projectId]/storyboard/page');
    const graphFn = vi.fn().mockResolvedValue({
      schemaVersion: '0.1', projectId: 'prj_1', projectRevision: 7,
      channelSnapshot: {}, identitySnapshot: {},
      format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
      timeline: { durationMs: 4000, masterAudioAssetId: null },
      scenes: [mediaScene({ position: 0, assetBindings: [], props: { assetId: null, assetUrl: null, headline: '待替换' } })],
      captions: [], audioTracks: [], overlays: [], sourceReferences: [],
    });
    const editFn = vi.fn().mockResolvedValue({ project: { revision: 8 }, scenes: [], editEvents: [] });
    const listAssets = vi.fn().mockResolvedValue([
      { id: 'ast_fresh', assetType: 'SOURCE_IMAGE', status: 'READY', currentVersionId: 'av_fresh' },
      { id: 'ast_pending', assetType: 'SOURCE_IMAGE', status: 'PROCESSING', currentVersionId: null },
    ]);
    renderWithClient(<StoryboardPage />, mockClient({
      workspaces: { get: vi.fn().mockResolvedValue({ role: 'EDITOR' }) },
      projects: { graph: graphFn, edit: editFn },
      assets: { list: listAssets },
    }));
    await screen.findByRole('region', { name: '导演工作台' });
    await userEvent.click(screen.getByRole('button', { name: '展开轻时间线' }));
    await waitFor(() => expect(listAssets).toHaveBeenCalledWith('ws_1', { projectId: 'prj_1' }));
    const selector = screen.getByLabelText('替换素材 0') as HTMLSelectElement;
    await waitFor(() => expect(selector.disabled).toBe(false));
    expect(selector.querySelector('option[value="ast_fresh"]')).toBeTruthy();
    expect(selector.querySelector('option[value="ast_pending"]')).toBeNull();
    await userEvent.selectOptions(selector, 'ast_fresh');
    await waitFor(() => expect(editFn).toHaveBeenCalledTimes(1));
    expect(editFn.mock.calls[0]?.[1]).toEqual(expect.objectContaining({
      baseProjectRevision: 7,
      expectedSceneRevisions: { scn_media: 1 },
      operations: [{ op: 'replace_asset', sceneId: 'scn_media', role: 'visual', newAssetId: 'ast_fresh' }],
    }));
  });
});
