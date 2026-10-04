import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient, testFile } from '@/test-utils.js';

vi.mock('next/navigation', () => ({
  useParams: () => ({ workspaceId: 'ws_1', projectId: 'prj_1' }),
  usePathname: () => '/w/ws_1/p/prj_1/assets',
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a>,
}));

const { default: AssetsPage } = await import('./w/[workspaceId]/p/[projectId]/assets/page.js');
const { default: HistoryPage } = await import('./w/[workspaceId]/p/[projectId]/history/page.js');
const { default: RenderPage } = await import('./w/[workspaceId]/p/[projectId]/render/page.js');

/**
 * Assets / History / Render 状态矩阵（P05-03）：
 * Assets：空（可上传）/ 上传调用 SDK（直传三要素）/ 验证失败明确原因 / 正常列表；
 * History：空 / 事件时间线 / 撤销 409（无可撤销）冲突块；
 * Render：**诚实占位**（未接线，不给假按钮）+ 可渲染快照列表。
 */

describe('Assets', () => {
  it('空：上传表单可用；提交调用 SDK 一体化上传（含 projectId）', async () => {
    const upload = vi.fn().mockResolvedValue({ id: 'ast_1', status: 'READY' });
    const client = mockClient({
      assets: { list: vi.fn().mockResolvedValue([]), upload },
    });
    renderWithClient(<AssetsPage />, client);
    expect(await screen.findByText('还没有资产')).toBeTruthy();
    const file = testFile('cover.png', 'hello', 'image/png');
    // jsdom 下 file input 用 fireEvent 注入 FileList（userEvent.upload 在此组合下不触发 React onChange）
    const fileInput = screen.getByLabelText('选择文件');
    Object.defineProperty(fileInput, 'files', { value: [file], configurable: true });
    fireEvent.change(fileInput);
    await userEvent.click(screen.getByRole('button', { name: '上传（直传签名 URL）' }));
    await waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
    const [, uploadInput] = upload.mock.calls[0] as [string, { assetType: string; filename: string; projectId: string; contentType: string }];
    expect(uploadInput.assetType).toBe('SOURCE_IMAGE');
    expect(uploadInput.filename).toBe('cover.png');
    expect(uploadInput.projectId).toBe('prj_1');
  });

  it('上传失败（服务端校验）：明确原因与重试动作', async () => {
    const upload = vi.fn().mockRejectedValue(apiError(415, 'UNSUPPORTED_MEDIA_TYPE', '实际内容与声明不符'));
    const client = mockClient({ assets: { list: vi.fn().mockResolvedValue([]), upload } });
    renderWithClient(<AssetsPage />, client);
    await screen.findByText('还没有资产');
    const fileInput = screen.getByLabelText('选择文件');
    Object.defineProperty(fileInput, 'files', { value: [testFile('evil.png', 'x', 'image/png')], configurable: true });
    fireEvent.change(fileInput);
    await userEvent.click(screen.getByRole('button', { name: '上传（直传签名 URL）' }));
    expect(await screen.findByText('上传失败')).toBeTruthy();
    expect(screen.getByText('实际内容与声明不符')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试' })).toBeTruthy();
  });

  it('正常：资产列表展示类型/状态/来源', async () => {
    const client = mockClient({
      assets: {
        list: vi.fn().mockResolvedValue([
          { id: 'ast_1', assetType: 'SOURCE_IMAGE', status: 'READY', origin: 'USER_UPLOAD', retentionClass: 'KEEP_DRAFT' },
        ]),
      },
    });
    renderWithClient(<AssetsPage />, client);
    expect(await screen.findByText('SOURCE_IMAGE')).toBeTruthy();
    expect(screen.getByText('READY')).toBeTruthy();
  });
});

describe('History', () => {
  it('空：说明事件流的意义', async () => {
    const client = mockClient({ events: { list: vi.fn().mockResolvedValue({ events: [], headSeq: 0 }) } });
    renderWithClient(<HistoryPage />, client);
    expect(await screen.findByText('还没有编辑事件')).toBeTruthy();
  });

  it('正常：事件时间线（含补偿标记）与撤销动作', async () => {
    const client = mockClient({
      events: {
        list: vi.fn().mockResolvedValue({
          headSeq: 2,
          events: [
            { seq: 1, eventId: 'evt_1', eventType: 'project.updated', workspaceId: 'ws_1', resourceId: 'prj_1', resourceRevision: 1, occurredAt: '2026-10-04T10:00:00.000Z', payload: { operations: ['insert_scene'], actorType: 'USER', revision: 1 } },
            { seq: 2, eventId: 'evt_2', eventType: 'project.updated', workspaceId: 'ws_1', resourceId: 'prj_1', resourceRevision: 2, occurredAt: '2026-10-04T10:01:00.000Z', payload: { operations: ['update_scene'], actorType: 'USER', revision: 2, compensation: 'UNDO' } },
          ],
        }),
      },
      projects: { undo: vi.fn().mockResolvedValue({ project: { revision: 3 }, scenes: [], editEvents: [] }), redo: vi.fn() },
    });
    renderWithClient(<HistoryPage />, client);
    expect((await screen.findAllByText(/project\.updated/)).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('UNDO')).toBeTruthy();
    expect(screen.getByText(/insert_scene/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '撤销最近一次编辑' }));
    await waitFor(() => expect((client as unknown as { projects: { undo: ReturnType<typeof vi.fn> } }).projects.undo).toHaveBeenCalledTimes(1));
  });

  it('撤销冲突（无可撤销）：冲突块给出刷新动作', async () => {
    const client = mockClient({
      events: { list: vi.fn().mockResolvedValue({ headSeq: 1, events: [{ seq: 1, eventId: 'evt_1', eventType: 'project.updated', workspaceId: 'ws_1', resourceId: 'prj_1', resourceRevision: 1, occurredAt: '2026-10-04T10:00:00.000Z', payload: {} }] }) },
      projects: { undo: vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', '没有可撤销的编辑')), redo: vi.fn() },
    });
    renderWithClient(<HistoryPage />, client);
    await screen.findAllByText(/project\.updated/);
    await userEvent.click(screen.getByRole('button', { name: '撤销最近一次编辑' }));
    expect(await screen.findByText('无法撤销/重做')).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新历史' })).toBeTruthy();
  });
});

describe('Render', () => {
  it('诚实占位：明确"未接线"（不提供假按钮）+ 展示可渲染快照', async () => {
    const client = mockClient({
      projects: { versions: { list: vi.fn().mockResolvedValue([{ id: 'ver_1', versionNumber: 3, reason: 'AUTO', createdAt: '2026-10-04T10:00:00.000Z' }]) } },
    });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/成片渲染将在 P07 接线（尚未实现）/)).toBeTruthy();
    expect(await screen.findByText(/v3 · AUTO/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /渲染/ })).toBeNull();
  });

  it('无版本：提示可渲染快照的产生方式（History 链接）', async () => {
    const client = mockClient({ projects: { versions: { list: vi.fn().mockResolvedValue([]) } } });
    renderWithClient(<RenderPage />, client);
    expect(await screen.findByText(/还没有版本快照/)).toBeTruthy();
  });
});
