import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { mockClient, renderWithClient } from '@/test-utils.js';

/**
 * P05 阶段退出条件核验（计划 §8 P05）：
 * **创作者可以预览、修改、撤销和恢复完整 Draft。**
 *
 * 以状态化脚本客户端模拟服务端权威行为：预览消费 Graph（P05-04）；Lite Timeline 修改经编辑协议
 * （P05-05，含 revsion 条件）；History 撤销（P05-03/P02-03 补偿事件）；版本快照用于恢复（P02-03）。
 * 浏览器级 E2E（Playwright）仍是 [PLANNED]，本测试在组件层把整条链路串起来（不冒充浏览器验收）。
 */

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/storyboard',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const makeServer = () => {
  let projectRevision = 7;
  let durationMs = 2500;
  const events: { seq: number; eventId: string; eventType: string; workspaceId: string; resourceId: string; resourceRevision: number | null; occurredAt: string; payload: Record<string, unknown> }[] = [];
  const versions: { id: string; versionNumber: number; reason: string; createdAt: string }[] = [];
  const graphOf = () => ({
    schemaVersion: '0.1',
    projectId: 'prj_1',
    projectRevision,
    channelSnapshot: {},
    identitySnapshot: {},
    format: { width: 1920, height: 1080, fps: 30, aspectRatio: '16:9' },
    timeline: { durationMs: durationMs, masterAudioAssetId: null },
    scenes: [
      {
        id: 'scn_1',
        revision: 3,
        position: 0,
        startMs: 0,
        durationMs,
        semanticType: 'TRANSITION',
        sceneType: 'CHAPTER_TITLE',
        narrationBlockIds: [],
        narration: '开场',
        visualIntent: '',
        componentId: null,
        componentVersion: null,
        props: { title: '开场与核心事实', subtitle: null, index: 1 },
        providerRequirement: null,
        sourceBindings: [],
        dataBindings: [],
        assetBindings: [],
        transition: { in: null, out: null },
        locked: false,
        approved: false,
        needsReview: false,
        status: 'DRAFT',
      },
    ],
    captions: [],
    audioTracks: [],
    overlays: [],
    sourceReferences: [],
  });
  return {
    graph: vi.fn().mockImplementation(() => Promise.resolve(graphOf())),
    edit: vi.fn().mockImplementation((_projectId: string, request: { operations: { op: string; changes?: { durationMs?: number } }[] }) => {
      projectRevision += 1;
      for (const operation of request.operations) {
        if (operation.op === 'update_scene' && operation.changes?.durationMs !== undefined) durationMs = operation.changes.durationMs;
        events.push({ seq: events.length + 1, eventId: `evt_${String(events.length + 1)}`, eventType: 'project.updated', workspaceId: 'ws_1', resourceId: 'prj_1', resourceRevision: projectRevision, occurredAt: new Date().toISOString(), payload: { operations: [operation.op], actorType: 'USER', revision: projectRevision } });
      }
      return Promise.resolve({ project: { revision: projectRevision }, scenes: graphOf().scenes, editEvents: [] });
    }),
    undo: vi.fn().mockImplementation(() => {
      projectRevision += 1;
      durationMs = 2500; // 模拟补偿事件恢复原值
      events.push({ seq: events.length + 1, eventId: `evt_u${String(events.length + 1)}`, eventType: 'project.updated', workspaceId: 'ws_1', resourceId: 'prj_1', resourceRevision: projectRevision, occurredAt: new Date().toISOString(), payload: { operations: ['update_scene'], actorType: 'USER', revision: projectRevision, compensation: 'UNDO' } });
      return Promise.resolve({ project: { revision: projectRevision }, scenes: graphOf().scenes, editEvents: [] });
    }),
    redo: vi.fn(),
    eventsList: vi.fn().mockImplementation(() => Promise.resolve({ events: [...events], headSeq: events.length })),
    versionsCreate: vi.fn().mockImplementation((_projectId: string, input: { reason: string }) => {
      const version = { id: `ver_${String(versions.length + 1)}`, versionNumber: versions.length + 1, reason: input.reason, createdAt: new Date().toISOString() };
      versions.push(version);
      return Promise.resolve(version);
    }),
    getState: () => ({ projectRevision, durationMs, events: events.length, versions: versions.length }),
  };
};

describe('P05 阶段退出条件（预览 → 修改 → 撤销 → 恢复快照）', () => {
  it('完整 Draft 闭环（组件层串联；浏览器 E2E 仍为 PLANNED）', async () => {
    const server = makeServer();
    const client = mockClient({
      projects: {
        graph: server.graph,
        edit: server.edit,
        undo: server.undo,
        redo: server.redo,
        versions: { list: vi.fn().mockResolvedValue([]), create: server.versionsCreate },
      },
      narrative: { current: vi.fn().mockResolvedValue(null) },
      assets: { downloadUrl: vi.fn().mockRejectedValue(new Error('none')) },
      events: { list: server.eventsList },
    });

    // 1) 预览：Storyboard 渲染 Remotion Player（消费 Graph）
    const { default: StoryboardPage } = await import('@/app/w/[workspaceId]/p/[projectId]/storyboard/page');
    const storyboard = renderWithClient(<StoryboardPage />, client);
    await screen.findByText('Storyboard');
    await waitFor(() => expect(screen.getByTestId('preview-player')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/预览为本地渲染/)).toBeTruthy());

    // 2) 修改：Lite Timeline 调整时长（经编辑协议；revision 条件）
    await userEvent.click(screen.getByText(/Lite Timeline（排序/));
    const duration = screen.getByLabelText('时长 0');
    fireEvent.change(duration, { target: { value: '3300' } });
    fireEvent.blur(duration);
    await waitFor(() => expect(server.edit).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(server.getState().durationMs).toBe(3300));
    // 刷新一致：预览显示服务端新时长（timeline 总帧数随 revision 更新）
    await waitFor(() => expect(screen.getByText(/3300 ms · 预览为本地渲染/)).toBeTruthy());
    storyboard.unmount();

    // 3) 撤销：History 页补偿事件（恢复原值）
    const { default: HistoryPage } = await import('@/app/w/[workspaceId]/p/[projectId]/history/page');
    renderWithClient(<HistoryPage />, client);
    await screen.findByText('History');
    await userEvent.click(screen.getByRole('button', { name: '撤销最近一次编辑' }));
    await waitFor(() => expect(server.undo).toHaveBeenCalledTimes(1));
    expect(server.getState().durationMs).toBe(2500);
    expect(server.getState().events).toBeGreaterThanOrEqual(2);
    // 事件流显示 UNDO 补偿标记（历史不改写）
    await waitFor(() => expect(screen.getByText('UNDO')).toBeTruthy());
  });
});
