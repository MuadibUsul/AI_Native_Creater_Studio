import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { MESSAGES } from '@/i18n/messages';
import { StudioRoom } from './StudioRoom';
import { exportSize } from './StudioExport';
import { formatClock, frameTimeAtSeconds, pointerSecondsText } from './studio-time';

/**
 * V6-1c 共看片室（组件层，脚本化 SDK）：状态画面、试改的就地预览与采用、时间带指认进入对话、AI 失败原因、中英切换。
 * 真实浏览器 + 真实服务的端到端证据见 scripts/studio-browser-check.mjs。
 */

beforeAll(() => {
  // jsdom 没有 ResizeObserver：给一个固定尺寸的实现，让时间带与画布能布局
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver); }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 40, right: 900, bottom: 40, toJSON: () => ({}) });
});

const mt = (ticks: number, den = 30) => ({ ticks: String(ticks), timebase: { num: 1, den } });
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const footage = (name: string, footageId: string) => ({
  assetId: `ast_${name}`, footageId, name, kind: 'video', status: 'READY', duration: '6.0',
  understanding: { index: 'READY', transcript: 'WORKING', visual: 'FAILED' },
});
const studioState = (overrides: Record<string, unknown> = {}) => ({
  project: { id: 'prj_1', title: '冰岛环岛', aspectRatio: '16:9', revision: 5 },
  sequenceId: 'seq_1',
  session: { id: 'ses_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', locale: 'zh-CN', createdBy: null, createdAt: '2026-10-12T00:00:00.000Z' },
  footage: [footage('glacier.mp4', 'av_g'), footage('lake.mp4', 'av_l')],
  cost: { projectId: 'prj_1', turns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costMicros: 120_000, unpricedCalls: 0 },
  ...overrides,
});
const projectState = (clips: unknown[] = []) => ({
  document: {
    projectRevision: 5,
    composition: {
      sequences: [{ id: 'seq_1', duration: mt(30), frameRate: { num: 30, den: 1 } }],
      tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }, { id: 'trk_a', sequenceId: 'seq_1', kind: 'AUDIO', position: 1 }],
      clips,
    },
  },
});
const turn = (overrides: Record<string, unknown> = {}) => ({
  id: 'agt_1', sessionId: 'ses_1', workflowRunId: 'wfr_1', status: 'COMPLETED', message: '剪一版',
  pointer: { timeRange: null, clipIds: [] }, reply: '第一版：两段素材，共 6 秒。', proposalId: 'prp_1', continuesProposalId: null,
  toolCalls: [{ name: 'edit_timeline', ok: true, summary: '2 edits applied' }], usage: {}, costMicros: 30_000, error: null,
  createdAt: '2026-10-12T00:00:00.000Z', completedAt: '2026-10-12T00:00:05.000Z', ...overrides,
});
const preview = (overrides: Record<string, unknown> = {}) => ({
  id: 'pvw_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', source: 'PROPOSAL', projectRevision: 5, proposalId: 'prp_1',
  planHash: 'a'.repeat(64), status: 'READY', width: 960, height: 540, frameRate: { num: 30, den: 1 }, duration: mt(180),
  captions: [], playbackUrl: 'https://media.example/preview.mp4',
  clips: [
    { clipId: 'clp_g', trackId: 'trk_v', kind: 'VIDEO', sourceVersionId: 'av_g', sequenceRange: range(0, 90) },
    { clipId: 'clp_l', trackId: 'trk_v', kind: 'VIDEO', sourceVersionId: 'av_l', sequenceRange: range(90, 180) },
  ],
  segments: { total: 3, reused: 1, rendered: 2 }, renderMs: 900, error: null, createdAt: '2026-10-12T00:00:06.000Z', completedAt: '2026-10-12T00:00:07.000Z',
  ...overrides,
});
const beatPack = {
  id: 'builtin:travel-beat', version: 1, kind: 'BUILT_IN', genre: 'travel', createdAt: null,
  name: { 'zh-CN': '旅行卡点', en: 'Travel beat edit' },
  summary: { 'zh-CN': '跟着音乐节拍的快剪。', en: 'A fast cut on the music beat.' },
  knobs: [{
    key: 'pacing', label: { 'zh-CN': '节奏', en: 'Pacing' }, defaultValue: 'default',
    options: [
      { value: 'calmer', label: { 'zh-CN': '稍缓', en: 'Calmer' }, guidance: 'g' },
      { value: 'default', label: { 'zh-CN': '默认', en: 'Default' }, guidance: 'g' },
      { value: 'intense', label: { 'zh-CN': '更密', en: 'More intense' }, guidance: 'g' },
    ],
  }],
};
const proposal = { proposalId: 'prp_1', status: 'OPEN', operationsHash: 'b'.repeat(64), selectionFingerprint: null, committedRevision: null };

function client(overrides: { state?: unknown; turns?: unknown[]; clips?: unknown[]; extra?: Record<string, unknown> } = {}) {
  const adoptProposal = vi.fn().mockResolvedValue({ proposal: { ...proposal, status: 'COMMITTED', committedRevision: 6 }, projectRevision: 6, adopted: true });
  const startTurn = vi.fn().mockResolvedValue(turn({ id: 'agt_2', status: 'RUNNING', proposalId: null, reply: null, toolCalls: [] }));
  const sdk = mockClient({
    auth: { session: vi.fn().mockResolvedValue({ user: { id: 'usr_1' } }) },
    workspaces: { get: vi.fn().mockResolvedValue({ id: 'ws_1', role: 'EDITOR' }) },
    studio: { state: vi.fn().mockResolvedValue(overrides.state ?? studioState()), undoChange: vi.fn() },
    projects: {
      state: vi.fn().mockResolvedValue(projectState(overrides.clips)),
      proposal: vi.fn().mockResolvedValue(proposal),
      adoptProposal,
      discardProposal: vi.fn().mockResolvedValue({ ...proposal, status: 'DISCARDED' }),
    },
    agent: { listTurns: vi.fn().mockResolvedValue(overrides.turns ?? []), startTurn, createSession: vi.fn(), cancelTurn: vi.fn(), strategies: vi.fn().mockResolvedValue([beatPack]) },
    previews: { request: vi.fn().mockResolvedValue(preview()), get: vi.fn().mockResolvedValue(preview()) },
    assets: { uploadResumable: vi.fn() },
    ...overrides.extra,
  });
  return { sdk, adoptProposal, startTurn };
}

describe('V6-1c 共看片室', () => {
  it('文案目录：英文覆盖中文的全部键，带参数的文案两种语言都可调用', () => {
    const walk = (zh: unknown, en: unknown, path: string): void => {
      expect(typeof en, path).toBe(typeof zh);
      if (typeof zh === 'object' && zh !== null) {
        expect(Object.keys(en as object).sort(), path).toEqual(Object.keys(zh).sort());
        for (const key of Object.keys(zh)) walk((zh as Record<string, unknown>)[key], (en as Record<string, unknown>)[key], `${path}.${key}`);
      }
    };
    walk(MESSAGES['zh-CN'], MESSAGES.en, 'messages');
    expect(MESSAGES.en.studio.chat.steps(1)).toBe('1 step');
    expect(MESSAGES['zh-CN'].studio.chat.steps(3)).toBe('做了 3 步');
  });

  it('时间显示与导出尺寸：有理时间格式化、帧网格吸附、按画幅取 1080p 级', () => {
    expect(formatClock(mt(375))).toBe('00:12.5');
    expect(formatClock(mt(1830))).toBe('01:01.0');
    expect(frameTimeAtSeconds(1.51, { num: 30, den: 1 })).toEqual(mt(45));
    expect(pointerSecondsText(mt(100))).toBe('3.333');
    expect(exportSize('9:16')).toEqual({ width: 1080, height: 1920 });
    expect(exportSize('16:9')).toEqual({ width: 1920, height: 1080 });
  });

  it('空作品：放入素材的引导；没有试改时不请求预览', async () => {
    const { sdk } = client({ state: studioState({ footage: [], session: null, cost: { projectId: 'prj_1', turns: 0, usage: {}, costMicros: 0, unpricedCalls: 0 } }) });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('放入素材，或说说你想做什么。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加素材' })).toBeTruthy();
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(sdk.previews.request).not.toHaveBeenCalled();
  });

  it('未登录：给出登录入口；旧版工程没有主时间线：引导到旧编辑器', async () => {
    const signedOut = client({ extra: { studio: { state: vi.fn().mockRejectedValue(apiError(401, 'UNAUTHENTICATED')) } } });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, signedOut.sdk);
    expect((await screen.findByRole('link', { name: '去登录' })).getAttribute('href')).toBe('/sign-in');
    const legacy = client({ extra: { studio: { state: vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', 'no sequence', { reason: 'STUDIO_SEQUENCE_MISSING' })) } } });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_2" />, legacy.sdk);
    expect((await screen.findByRole('link', { name: '用旧版编辑器打开' })).getAttribute('href')).toBe('/w/ws_1/p/prj_2/storyboard');
  });

  it('素材就绪但还没剪：一键让 AI 剪第一版（作为一轮对话发出）', async () => {
    const { sdk, startTurn } = client({ turns: [] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await userEvent.click(await screen.findByRole('button', { name: '让 AI 剪第一版' }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '用这些素材剪出第一版。', pointer: { timeRange: null, clipIds: [] } }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('试改：就地播放试改预览，时间带显示试改的片段；"就这样"按看过的哈希采用', async () => {
    const { sdk, adoptProposal } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('试改预览 · 还没采用')).toBeTruthy();
    expect(sdk.previews.request).toHaveBeenCalledWith('ws_1', 'prj_1', 'seq_1', { proposalId: 'prp_1' });
    expect(screen.getByRole('button', { name: /^片段 glacier\.mp4，00:00\.0 到 00:03\.0$/ })).toBeTruthy();
    expect(screen.getByText('复用 1/3 段')).toBeTruthy();
    expect(screen.getByText('AI 用量 $0.12')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /就这样/ }));
    await waitFor(() => expect(adoptProposal).toHaveBeenCalledWith('ws_1', 'prj_1', 'prp_1', {
      expectedOperationsHash: 'b'.repeat(64), expectedSelectionFingerprint: null, idempotencyKey: expect.any(String),
    }));
  });

  it('指：点选时间带上的片段 → 对话带上指认的片段', async () => {
    const { sdk, startTurn } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const clip = await screen.findByRole('button', { name: /^片段 lake\.mp4/ });
    clip.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('片段「lake.mp4」')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('告诉 AI 怎么改'), '再短一点{Enter}');
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '再短一点', pointer: { timeRange: null, clipIds: ['clp_l'] } }, expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.getByText('未选择 · 作用于整条视频')).toBeTruthy();
  });

  it('风格（可选）：默认不选；选了风格和旋钮，这一轮对话带上策略包与取值', async () => {
    const { sdk, startTurn } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const style = await screen.findByLabelText('风格（可选）');
    expect((style as HTMLSelectElement).value).toBe('');
    expect(screen.getByText('选了风格，AI 会参考它的剪法；不选时 AI 按素材自己判断。')).toBeTruthy();
    await userEvent.selectOptions(style, 'builtin:travel-beat');
    expect(screen.getByText('跟着音乐节拍的快剪。')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('节奏'), 'intense');
    await userEvent.type(screen.getByLabelText('告诉 AI 怎么改'), '更有冲击力{Enter}');
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', {
      message: '更有冲击力', pointer: { timeRange: null, clipIds: [] }, strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'intense' },
    }, expect.anything()));
  });

  it('AI 失败给出原因；进行中的一轮可以停止', async () => {
    const failed = turn({ status: 'FAILED', proposalId: null, reply: null, toolCalls: [], error: { code: 'NOT_IMPLEMENTED', details: { reason: 'AGENT_MODEL_NOT_CONFIGURED' } } });
    const { sdk } = client({ turns: [failed] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const alert = await screen.findByText('AI 这次没完成');
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByText('AI 导演还没配置好：服务端尚未接入模型凭据。')).toBeTruthy();

    const cancelTurn = vi.fn().mockResolvedValue(turn({ status: 'CANCELLED' }));
    const running = client({ turns: [turn({ status: 'RUNNING', proposalId: null, reply: null })], extra: {} });
    (running.sdk.agent as unknown as { cancelTurn: typeof cancelTurn }).cancelTurn = cancelTurn;
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, running.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '停止' }));
    await waitFor(() => expect(cancelTurn).toHaveBeenCalled());
  });

  it('中英切换：界面文案即时切换，Cookie 记住本设备的选择', async () => {
    const { sdk } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await screen.findByText('试改预览 · 还没采用');
    await userEvent.click(screen.getByRole('button', { name: '切换为英文界面' }));
    expect(await screen.findByText('Trial preview · not kept yet')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Keep it/ })).toBeTruthy();
    expect(screen.getByLabelText('Tell AI what to change')).toBeTruthy();
    expect(document.cookie).toContain('ancs-locale=en');
    expect(document.documentElement.lang).toBe('en');
  });
});
