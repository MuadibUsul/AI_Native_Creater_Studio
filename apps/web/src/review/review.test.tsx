import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { REVIEW_ERROR_REASONS } from '@ancs/contracts';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { ReviewRoom } from './ReviewRoom';

/**
 * V6-4 批注式审片（组件层，脚本化 SDK）：标记（位置 + 指向的片段 + 一句话）、逐条问 AI、确定方案、
 * 全部执行、试改就地播放并按哈希采用、已采用与英文界面、锁定时的说明。
 * 真实浏览器 + 真实服务（含手机尺寸）的证据见 scripts/review-browser-check.mjs。
 */

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver); }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  // jsdom 不实现媒体播放：标记时会暂停视频
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
});

const mt = (ticks: number, den = 30) => ({ ticks: String(ticks), timebase: { num: 1, den } });
const studioState = {
  project: { id: 'prj_1', title: '冰岛环岛', aspectRatio: '16:9', revision: 5 },
  sequenceId: 'seq_1',
  session: { id: 'ses_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', locale: 'zh-CN', createdBy: null, createdAt: '2026-10-12T00:00:00.000Z' },
  footage: [],
  cost: { projectId: 'prj_1', turns: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costMicros: 0, unpricedCalls: 0 },
};
const projectState = {
  document: {
    projectRevision: 5,
    composition: {
      sequences: [{ id: 'seq_1', duration: mt(180), frameRate: { num: 30, den: 1 } }],
      tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }, { id: 'trk_a', sequenceId: 'seq_1', kind: 'AUDIO', position: 1 }],
      clips: [
        { id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sequenceRange: { start: mt(0), end: mt(90) } },
        { id: 'clp_l', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_l', sequenceRange: { start: mt(90), end: mt(180) } },
      ],
    },
  },
};
const preview = (overrides: Record<string, unknown> = {}) => ({
  id: 'pvw_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', source: 'PROJECT', projectRevision: 5, proposalId: null,
  planHash: 'a'.repeat(64), status: 'READY', width: 960, height: 540, frameRate: { num: 30, den: 1 }, duration: mt(180),
  captions: [], playbackUrl: 'https://media.example/current.mp4', clips: [],
  segments: { total: 3, reused: 0, rendered: 3 }, renderMs: 900, error: null, createdAt: '2026-10-12T00:00:06.000Z', completedAt: '2026-10-12T00:00:07.000Z',
  ...overrides,
});
const round = (overrides: Record<string, unknown> = {}) => ({
  id: 'rvr_1', projectId: 'prj_1', sequenceId: 'seq_1', baseRevision: 5, status: 'OPEN', applyTurnId: null, proposalId: null,
  appliedNoteIds: [], appliedRevision: null, applyIssue: null, createdAt: '2026-10-12T00:00:00.000Z', ...overrides,
});
const note = (overrides: Record<string, unknown> = {}) => ({
  id: 'rvn_1', roundId: 'rvr_1', pointer: { timeRange: { start: '1.000', end: '3.000' }, clipIds: ['clp_g'] }, region: null,
  text: '开头太拖', status: 'OPEN', plan: null, discussion: { turns: 0, lastReply: null, running: false },
  createdBy: 'usr_1', createdAt: '2026-10-12T00:00:00.000Z', updatedAt: '2026-10-12T00:00:00.000Z', ...overrides,
});
const turn = (overrides: Record<string, unknown> = {}) => ({
  id: 'agt_d', sessionId: 'ses_1', workflowRunId: 'wfr_d', status: 'RUNNING', purpose: 'DISCUSS_NOTE', reviewNoteId: 'rvn_1', reviewRoundId: 'rvr_1',
  message: '这里怎么改比较好？', pointer: { timeRange: { start: '1.000', end: '3.000' }, clipIds: ['clp_g'] }, reply: null, proposalId: null, continuesProposalId: null,
  strategyPackId: null, strategyKnobs: {}, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costMicros: 0, error: null, createdAt: '2026-10-12T00:00:00.000Z', completedAt: null, ...overrides,
});
const proposal = { proposalId: 'prp_1', status: 'OPEN', operationsHash: 'b'.repeat(64), selectionFingerprint: null, committedRevision: null };

function client(reviewState: unknown, extra: { review?: Record<string, unknown>; previews?: Record<string, unknown> } = {}) {
  const review = {
    state: vi.fn().mockResolvedValue(reviewState),
    addNote: vi.fn().mockResolvedValue(note()),
    updateNote: vi.fn().mockResolvedValue(note({ status: 'AGREED' })),
    deleteNote: vi.fn().mockResolvedValue(undefined),
    noteTurns: vi.fn().mockResolvedValue([]),
    apply: vi.fn().mockResolvedValue({ round: round({ status: 'APPLYING' }), turn: turn({ purpose: 'APPLY_REVIEW', reviewNoteId: null }) }),
    ...extra.review,
  };
  const startTurn = vi.fn().mockResolvedValue(turn());
  const adoptProposal = vi.fn().mockResolvedValue({ proposal: { ...proposal, status: 'COMMITTED', committedRevision: 6 }, projectRevision: 6, adopted: true });
  const sdk = mockClient({
    auth: { session: vi.fn().mockResolvedValue({ user: { id: 'usr_1' } }) },
    workspaces: { get: vi.fn().mockResolvedValue({ id: 'ws_1', role: 'EDITOR' }) },
    studio: { state: vi.fn().mockResolvedValue(studioState) },
    projects: {
      state: vi.fn().mockResolvedValue(projectState),
      proposal: vi.fn().mockResolvedValue(proposal),
      adoptProposal,
      discardProposal: vi.fn().mockResolvedValue({ ...proposal, status: 'DISCARDED' }),
    },
    agent: { startTurn, createSession: vi.fn() },
    previews: { request: vi.fn().mockResolvedValue(preview()), get: vi.fn().mockResolvedValue(preview()), ...extra.previews },
    review,
  });
  return { sdk, review, startTurn, adoptProposal };
}

const state = (notes: unknown[], roundOverrides: Record<string, unknown> | null = {}) => ({ projectRevision: 5, round: roundOverrides === null ? null : round(roundOverrides), notes });

describe('V6-4 批注式审片', () => {
  it('标记：停在这一刻 → 写一句话 → 添加批注（带时间范围与这一刻画面上的片段）', async () => {
    const { sdk, review } = client(state([], null));
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('还没有批注。看到不满意的地方就标记下来。')).toBeTruthy();
    await userEvent.click(await screen.findByRole('button', { name: '在这里标记' }));
    expect(screen.getByText('位置 00:00.0–00:02.0')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: '往后 1 秒' }));
    expect(screen.getByText('位置 00:01.0–00:03.0')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('这里有什么问题？'), '开头太拖');
    await userEvent.click(screen.getByRole('button', { name: '添加批注' }));
    await waitFor(() => expect(review.addNote).toHaveBeenCalledWith('ws_1', 'prj_1', {
      sequenceId: 'seq_1', pointer: { timeRange: { start: '1.000', end: '3.000' }, clipIds: ['clp_g'] }, region: null, text: '开头太拖',
    }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('逐条问 AI：发起只给方案的讨论；AI 给出方案后"就按这个改"把它定为方案', async () => {
    const plan = '把开头剪掉 1 秒。';
    const { sdk, startTurn, review } = client(state([note()]));
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await userEvent.click(await screen.findByRole('button', { name: '问 AI 怎么改' }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '这里怎么改比较好？', reviewNoteId: 'rvn_1' }, expect.anything()));

    const discussed = client(state([note({ discussion: { turns: 1, lastReply: plan, running: false } })]));
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, discussed.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '就按这个改' }));
    await waitFor(() => expect(discussed.review.updateNote).toHaveBeenCalledWith('ws_1', 'rvn_1', { status: 'AGREED', plan }, expect.anything()));
    expect(review.updateNote).not.toHaveBeenCalled();
  });

  it('全部执行：只包含已确定的批注，提示未确定的会被略过', async () => {
    const { sdk, review } = client(state([note({ status: 'AGREED', plan: '剪掉 1 秒' }), note({ id: 'rvn_2', text: '颜色太暗', pointer: { timeRange: { start: '4.000', end: '5.000' }, clipIds: [] } })]));
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('方案：剪掉 1 秒')).toBeTruthy();
    expect(screen.getByText('还有 1 条没确定，这次不会包含。')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /全部执行（1 条）/ }));
    await waitFor(() => expect(review.apply).toHaveBeenCalledWith('ws_1', 'prj_1', { sessionId: 'ses_1' }, expect.anything()));
  });

  it('试改就地播放：只重渲改动的分段；"就这样"按看过的哈希采用', async () => {
    const trialPreview = preview({ id: 'pvw_2', source: 'PROPOSAL', proposalId: 'prp_1', playbackUrl: 'https://media.example/trial.mp4', segments: { total: 5, reused: 3, rendered: 2 } });
    const { sdk, adoptProposal } = client(state([note({ status: 'AGREED' })], { status: 'READY', applyTurnId: 'agt_a', proposalId: 'prp_1', appliedNoteIds: ['rvn_1'] }), {
      previews: { request: vi.fn().mockResolvedValue(trialPreview), get: vi.fn().mockResolvedValue(trialPreview) },
    });
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('按批注修改后的试改 · 还没采用')).toBeTruthy();
    expect(sdk.previews.request).toHaveBeenCalledWith('ws_1', 'prj_1', 'seq_1', { proposalId: 'prp_1' });
    expect(screen.getByText('只重渲了改动的部分（复用 3/5 段）')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '问 AI 怎么改' })).toBeNull(); // 等待采用时批注锁定
    await userEvent.click(screen.getByRole('button', { name: /就这样/ }));
    await waitFor(() => expect(adoptProposal).toHaveBeenCalledWith('ws_1', 'prj_1', 'prp_1', {
      expectedOperationsHash: 'b'.repeat(64), expectedSelectionFingerprint: null, idempotencyKey: expect.any(String),
    }));
  });

  it('已采用（英文界面）：说明新版本，新标记开始新一轮；锁定时的操作给出原因', async () => {
    const applied = client(state([note({ status: 'APPLIED', plan: 'Trim 1 s' })], { status: 'APPLIED', proposalId: 'prp_1', appliedRevision: 6, appliedNoteIds: ['rvn_1'] }));
    const view = renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, applied.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '切换为英文界面' }));
    expect(await screen.findByText('Kept as the new version (version 6). New marks start a new review round.')).toBeTruthy();
    expect(screen.getByText('Done')).toBeTruthy();
    expect(screen.getByText('Fix: Trim 1 s')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Switch the interface to Chinese' })); // 还原本设备的语言选择
    view.unmount();

    const locked = client(state([note()]), { review: { updateNote: vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', 'locked', { reason: REVIEW_ERROR_REASONS.ROUND_LOCKED })) } });
    renderWithClient(<ReviewRoom workspaceId="ws_1" projectId="prj_1" />, locked.sdk);
    const dismiss = await screen.findAllByRole('button', { name: '不改了' });
    await userEvent.click(dismiss.at(-1)!);
    expect(await screen.findByText('正在执行或等待采用，批注暂时不能改。')).toBeTruthy();
  });
});
