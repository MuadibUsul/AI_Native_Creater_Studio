import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { MESSAGES } from '@/i18n/messages';
import { StudioRoom } from './StudioRoom';
import { exportSize } from './StudioExport';
import { studioTaskRows } from './StudioTasks';
import { formatClock, frameTimeAtSeconds, framesPerSecond, pointerSecondsText } from './studio-time';

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
  // jsdom 没有媒体播放：键盘逐帧会先暂停视频
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 40, right: 900, bottom: 40, toJSON: () => ({}) });
  // jsdom 没有 PointerEvent：用带坐标的鼠标事件代替（与浏览器同样带 clientX/clientY、pointerId 与 pointerType）
  if (!('PointerEvent' in globalThis)) {
    globalThis.PointerEvent = class extends MouseEvent {
      readonly pointerId: number;
      readonly pointerType: string;
      readonly isPrimary: boolean;
      constructor(type: string, init: PointerEventInit = {}) { super(type, init); this.pointerId = init.pointerId ?? 1; this.pointerType = init.pointerType ?? 'mouse'; this.isPrimary = init.isPrimary ?? true; }
    } as unknown as typeof PointerEvent;
  }
});

const mt = (ticks: number, den = 30) => ({ ticks: String(ticks), timebase: { num: 1, den } });
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const footage = (name: string, footageId: string) => ({
  assetId: `ast_${name}`, footageId, name, kind: 'video', status: 'READY', duration: '6.0',
  understanding: { index: 'READY', transcript: 'WORKING', visual: 'FAILED' },
});
const studioState = (overrides: Record<string, unknown> = {}) => ({
  project: { id: 'prj_1', title: '冰岛环岛', aspectRatio: '16:9', revision: 5, allowEffects: false, allowNarration: false, allowGeneratedVideo: false, article: null },
  sequenceId: 'seq_1',
  session: { id: 'ses_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', locale: 'zh-CN', createdBy: null, createdAt: '2026-10-12T00:00:00.000Z' },
  footage: [footage('glacier.mp4', 'av_g'), footage('lake.mp4', 'av_l')],
  effects: [],
  narration: [],
  generations: [],
  generationBudget: { configured: false, period: null, limitMicros: null, spentMicros: 0, reservedMicros: 0 },
  aiSpend: { period: '2026-10', capMicros: null, capSource: null, spentMicros: 0, unpricedCalls: 0, reached: false, resetsAt: '2026-11-01T00:00:00.000Z' },
  cost: { projectId: 'prj_1', turns: 1, usage: { inputTokens: 1, outputTokens: 1, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costMicros: 120_000, unpricedCalls: 0 },
  ...overrides,
});
const projectState = (clips: unknown[] = [], extraTracks: unknown[] = []) => ({
  document: {
    projectRevision: 5,
    composition: {
      sequences: [{ id: 'seq_1', duration: mt(30), frameRate: { num: 30, den: 1 } }],
      tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }, { id: 'trk_a', sequenceId: 'seq_1', kind: 'AUDIO', position: 1 }, ...extraTracks],
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
const clipDiff = (objectId: string, change: string, after: ReturnType<typeof range> | null) => ({
  objectKind: 'CLIP', objectId, label: null, change, axes: ['CONTENT'], beforeAssetVersionId: null, afterAssetVersionId: null,
  beforeTrackId: 'trk_v', afterTrackId: 'trk_v', beforeSequenceRange: after, afterSequenceRange: after, alignedBy: 'CLIP_ID',
});
const compareReport = {
  proposalId: 'prp_1', workspaceId: 'ws_1', projectId: 'prj_1', comparedAgainst: { kind: 'CURRENT', ref: null }, leftLabel: 'r5', rightLabel: 'prp_1', alignment: 'CLIP_ID',
  diffs: [clipDiff('clp_g', 'UNCHANGED', range(0, 90)), clipDiff('clp_l', 'CHANGED', range(90, 150)), clipDiff('clp_x', 'REMOVED', null)],
  unchangedCount: 1, addedCount: 0, removedCount: 1, changedCount: 1, anchorMatchedCount: 0, unmatchedAnchors: [], assetVersionIds: [],
};

function client(overrides: { state?: unknown; turns?: unknown[]; clips?: unknown[]; extra?: Record<string, unknown> } = {}) {
  const adoptProposal = vi.fn().mockResolvedValue({ proposal: { ...proposal, status: 'COMMITTED', committedRevision: 6 }, projectRevision: 6, adopted: true });
  const startTurn = vi.fn().mockResolvedValue(turn({ id: 'agt_2', status: 'RUNNING', proposalId: null, reply: null, toolCalls: [] }));
  const sdk = mockClient({
    auth: { session: vi.fn().mockResolvedValue({ user: { id: 'usr_1' } }) },
    workspaces: { get: vi.fn().mockResolvedValue({ id: 'ws_1', role: 'EDITOR' }) },
    studio: { state: vi.fn().mockResolvedValue(overrides.state ?? studioState()), undoChange: vi.fn(), updateProductionPolicy: vi.fn().mockResolvedValue({ allowProceduralGraphics: true }) },
    projects: {
      state: vi.fn().mockResolvedValue(projectState(overrides.clips)),
      proposal: vi.fn().mockResolvedValue(proposal),
      adoptProposal,
      discardProposal: vi.fn().mockResolvedValue({ ...proposal, status: 'DISCARDED' }),
      compareProposal: vi.fn().mockResolvedValue(compareReport),
    },
    agent: { listTurns: vi.fn().mockResolvedValue(overrides.turns ?? []), startTurn, createSession: vi.fn(), cancelTurn: vi.fn(), strategies: vi.fn().mockResolvedValue([beatPack]) },
    previews: { request: vi.fn().mockResolvedValue(preview()), get: vi.fn().mockResolvedValue(preview()) },
    finalRenders: { list: vi.fn().mockResolvedValue([{ id: 'wfr_1', status: 'SUCCEEDED', createdAt: '2026-10-14T08:00:00.000Z' }]) },
    assets: { uploadResumable: vi.fn(), mediaIndex: vi.fn().mockResolvedValue({ runId: null, sourceAssetVersionId: 'av_none', processorVersion: 'source-index-v1', status: 'EMPTY', coveragePermille: 0, checkpointMs: 0, errorSummary: null, items: [], nextCursor: null }) },
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

  it('按秒移动：一秒约合的帧数（29.97 取 30）', () => {
    expect(framesPerSecond({ num: 30, den: 1 })).toBe(30);
    expect(framesPerSecond({ num: 30000, den: 1001 })).toBe(30);
    expect(framesPerSecond({ num: 24000, den: 1001 })).toBe(24);
  });

  it('空作品：放入素材的引导；没有试改时不请求预览', async () => {
    const { sdk } = client({ state: studioState({ footage: [], session: null, cost: { projectId: 'prj_1', turns: 0, usage: {}, costMicros: 0, unpricedCalls: 0 } }) });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('放入素材，或说说你想做什么。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '添加素材' })).toBeTruthy();
    expect(screen.getByText('已保存')).toBeTruthy();
    expect(sdk.previews.request).not.toHaveBeenCalled();
  });

  it('Stitch 布局：左侧 AI 对话栏（规则开关与上传在输入框旁）+ 画布工具条（框选 / 素材 / 快捷键）；首页带来的想法预填在输入框、不自动发送', async () => {
    window.sessionStorage.setItem('ancs-studio-brief:prj_1', '冰岛自驾 Vlog，60 秒，节奏轻快');
    const { sdk, startTurn } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const chat = await screen.findByRole('region', { name: '和 AI 说' });
    await waitFor(() => expect((within(chat).getByRole('textbox', { name: '告诉 AI 怎么改' }) as HTMLTextAreaElement).value).toBe('冰岛自驾 Vlog，60 秒，节奏轻快'));
    expect(window.sessionStorage.getItem('ancs-studio-brief:prj_1')).toBeNull();
    expect(startTurn).not.toHaveBeenCalled();
    const settings = within(chat).getByRole('group', { name: '这一轮的风格与规则' });
    expect(within(settings).getByRole('group', { name: '制作规则：这条视频允许 AI 做什么' })).toBeTruthy();
    expect(within(chat).getByRole('button', { name: '上传素材' })).toBeTruthy();
    expect(within(chat).getByText('第一版：两段素材，共 6 秒。')).toBeTruthy();
    const rail = screen.getByRole('toolbar', { name: '画布工具' });
    expect((await within(rail).findByRole('button', { name: '框选画面' })).getAttribute('aria-pressed')).toBe('false');
    expect(within(rail).getByRole('button', { name: '素材 2' }).getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(within(rail).getByRole('button', { name: '素材 2' }));
    expect(screen.getByRole('complementary', { name: '素材' })).toBeTruthy();
    expect(within(rail).getByRole('button', { name: '快捷键' })).toBeTruthy();
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
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '用这些素材剪出第一版。', pointer: { timeRange: null, clipIds: [], frameRegion: null } }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
  });

  it('无限画布：成片屏幕旁边并排素材与制作计划（场景、剪辑意图）画框；视图按钮切换看全部 / 只看成片；画框里打开素材面板', async () => {
    const plan = {
      id: 'ppl_1', projectId: 'prj_1', version: 2, baseRevision: 4, currentRevision: 5, changedSincePlan: true, turnId: 'agt_1', createdAt: '2026-10-21T00:00:00.000Z',
      blueprint: { logline: '冰川在后退', audience: '', openingPromise: '', structure: '钩子 → 出发 → 冰川', emotionArc: '', pacing: '', styleNotes: '', targetDurationSeconds: 30, paceTarget: null, mustKeep: [], avoid: [] },
      scenes: [{ id: 'scene_hook', title: '开场', goal: '先给最好看的画面', window: { start: '0', end: '4' }, sources: [{ footageId: 'av_g', from: '6', to: '9.5' }], needs: [], acceptance: [],
        intents: [{ id: 'intent_hook', type: 'HOOK', targetFeeling: '一眼想看下去', reason: '冰川航拍最抓人', timeRange: null, evidence: [], rejectedAlternatives: [] }] }],
    };
    const { sdk } = client({ turns: [turn()], extra: { autonomy: { latestPlan: vi.fn().mockResolvedValue(plan) } } });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const canvas = await screen.findByRole('region', { name: '作品画面' });
    const footageFrame = await within(canvas).findByRole('region', { name: '素材 2' });
    expect(within(footageFrame).getByText('glacier.mp4')).toBeTruthy();
    const planFrame = await within(canvas).findByRole('region', { name: '制作计划 · 第 2 版' });
    expect(within(planFrame).getByText('冰川在后退')).toBeTruthy();
    expect(within(planFrame).getByText('结构：钩子 → 出发 → 冰川 · 目标约 30 秒')).toBeTruthy();
    expect(within(planFrame).getByText('计划之后作品又改过')).toBeTruthy();
    expect(within(planFrame).getByText('钩子').closest('li')?.getAttribute('title')).toBe('冰川航拍最抓人');
    const view = within(canvas).getByRole('toolbar', { name: '画布视图' });
    expect(within(view).getByRole('button', { name: '看全部' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(view).getByRole('button', { name: '只看成片' }));
    expect(within(view).getByRole('button', { name: '只看成片' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.click(within(view).getByRole('button', { name: '放大' }));
    expect(within(view).getByRole('button', { name: '只看成片' }).getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(within(footageFrame).getByRole('button', { name: '素材面板' }));
    expect(screen.getByRole('complementary', { name: '素材' })).toBeTruthy();
  });

  it('剪辑师在场：开场按工程事实打招呼；这一轮进行中显示"第 N 步 · 在做什么"，画布上的剪辑师光标移到对应画框；没开语音时画布上有"和剪辑师说话"', async () => {
    const idle = client({ turns: [] });
    const { unmount } = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, idle.sdk);
    expect(await screen.findByText('2 段素材已就绪，共约 12 秒。')).toBeTruthy();
    expect(screen.getByRole('button', { name: '和剪辑师说话' })).toBeTruthy();
    expect(document.querySelector('[data-target]')).toBeNull();
    unmount();

    const working = turn({ id: 'agt_3', status: 'RUNNING', reply: null, proposalId: null, completedAt: null,
      toolCalls: [{ name: 'look_at_footage', ok: true, summary: 'looked at glacier.mp4' }, { name: 'edit_timeline', ok: true, summary: '3 edits applied' }] });
    const busy = client({ turns: [working] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, busy.sdk);
    expect(await screen.findByText('第 2 步 · 在剪')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[data-target="monitor"]')?.textContent).toBe('剪辑师 · 在剪'));
  });

  it('V6-9 交给 AI 剪完：还没剪时画布给出入口，打开设置签署并开始；进行中时进度卡在对话里、可停下，画布不再给入口', async () => {
    const policy = { approval: 'ASK_EACH', budgetMicros: null, perGenerationMicros: null, allowOwnLikeness: false, maxRetriesPerTask: 2, signature: null };
    const active = {
      id: 'aut_1', projectId: 'prj_1', status: 'DIRECTING', goal: '60 秒冰岛自驾', targetDurationSeconds: 60, strategyPackId: null, approval: 'ASK_EACH', policyVersion: 1,
      budgetMicros: 2_000_000, modelCapMicros: 1_800_000, locale: 'zh-CN', turnId: 'agt_9', workflowRunId: 'wfr_9', proposalId: null, adoptedRevision: null,
      progress: { steps: 3, lastStep: '计划：4 场', lastTool: 'plan_production' }, report: null, error: null,
      createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z', completedAt: null,
    };
    const sign = vi.fn().mockResolvedValue({ ...policy, budgetMicros: 2_000_000, signature: { userId: 'usr_1', signedAt: '2026-10-21T00:00:00.000Z', version: 1 } });
    const startRun = vi.fn().mockResolvedValue({ ...active, status: 'WAITING_FOR_FOOTAGE' });
    const idle = client({ turns: [], state: studioState({ project: { ...studioState().project, autonomy: policy }, autonomousRun: null }), extra: { autonomy: { sign, startRun, revoke: vi.fn(), cancelRun: vi.fn() } } });
    const { unmount } = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, idle.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '交给 AI 剪完…' }));
    const dialog = screen.getByRole('dialog', { name: '交给 AI 剪完' });
    await userEvent.type(within(dialog).getByLabelText('你想要一条什么样的视频'), '60 秒冰岛自驾');
    await userEvent.click(within(dialog).getByRole('button', { name: '交给 AI' }));
    await waitFor(() => expect(startRun).toHaveBeenCalledWith('ws_1', 'prj_1', expect.objectContaining({ goal: '60 秒冰岛自驾', locale: 'zh-CN' }), expect.anything()));
    expect(sign).toHaveBeenCalledWith('ws_1', 'prj_1', { approval: 'ASK_EACH', budgetMicros: 2_000_000 }, expect.anything());
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    unmount();

    const cancelRun = vi.fn().mockResolvedValue({ ...active, status: 'CANCELLED' });
    const running = client({ turns: [], state: studioState({ project: { ...studioState().project, autonomy: policy }, autonomousRun: active }), extra: { autonomy: { cancelRun } } });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, running.sdk);
    const chat = await screen.findByRole('region', { name: '和 AI 说' });
    const card = await within(chat).findByRole('article', { name: 'AI 自己剪' });
    expect(within(card).getByText('已做 3 步')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '交给 AI 剪完…' })).toBeNull();
    expect((screen.getByRole('button', { name: '让 AI 剪第一版' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(card).getByRole('button', { name: '停下' }));
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('ws_1', 'prj_1', 'aut_1', { idempotencyKey: 'autonomy-cancel-aut_1' }));
  });

  it('V6-9 交给 AI 剪完：看到试改后 AI 按授权自己采用 → 版本变化时重读提案，画面换成当前版本（不再为已采用的提案请求预览）', async () => {
    const run = {
      id: 'aut_1', projectId: 'prj_1', status: 'CHECKING', goal: '12 秒冰岛预告', targetDurationSeconds: 15, strategyPackId: null, approval: 'AUTO_SAFE', policyVersion: 1,
      budgetMicros: 2_000_000, modelCapMicros: 1_800_000, locale: 'zh-CN', turnId: 'agt_1', workflowRunId: 'wfr_1', proposalId: 'prp_1', adoptedRevision: null,
      progress: { steps: 4, lastStep: '自检', lastTool: 'review_draft' }, report: null, error: null,
      createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:01:00.000Z', completedAt: null,
    };
    const checking = studioState({ autonomousRun: run });
    const adopted = studioState({ project: { ...studioState().project, revision: 6 }, autonomousRun: { ...run, status: 'DELIVERED', adoptedRevision: 6, completedAt: '2026-10-21T00:01:30.000Z' } });
    const { sdk } = client({ turns: [turn()], state: checking });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('试改预览 · 还没采用')).toBeTruthy();
    expect(sdk.previews.request).toHaveBeenCalledWith('ws_1', 'prj_1', 'seq_1', { proposalId: 'prp_1' });
    // AI 自检通过、按"自检通过就直接用"采用：服务端的提案已提交、工程到了第 6 版；之后再为这个提案请求预览会被拒绝
    vi.mocked(sdk.studio.state).mockResolvedValue(adopted as never);
    const adoptedDocument = projectState([{ id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sequenceRange: range(0, 90) }]);
    vi.mocked(sdk.projects.state).mockResolvedValue({ document: { ...adoptedDocument.document, projectRevision: 6 } } as never);
    vi.mocked(sdk.projects.proposal).mockResolvedValue({ ...proposal, status: 'COMMITTED', committedRevision: 6 } as never);
    vi.mocked(sdk.previews.request).mockImplementation((_ws, _project, _sequence, input) => (input.proposalId === null
      ? Promise.resolve(preview({ id: 'pvw_2', source: 'CURRENT', projectRevision: 6, proposalId: null }) as never)
      : Promise.reject(apiError(409, 'CONFLICT', 'proposal is not open'))));
    vi.mocked(sdk.previews.get).mockResolvedValue(preview({ id: 'pvw_2', source: 'CURRENT', projectRevision: 6, proposalId: null }) as never);
    expect(await screen.findByText('当前版本', undefined, { timeout: 6_000 })).toBeTruthy();
    expect(sdk.previews.request).toHaveBeenLastCalledWith('ws_1', 'prj_1', 'seq_1', { proposalId: null });
    expect(screen.queryByText('试改预览 · 还没采用')).toBeNull();
    expect(screen.queryByText('预览失败')).toBeNull();
  }, 10_000);

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

  it('快捷键：方向键逐帧 / Shift 按秒、Home/End、M 框选、/ 跟 AI 说、? 与按住 Ctrl 显示列表、Esc 收起；输入框里不接管', async () => {
    const { sdk } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('试改预览 · 还没采用')).toBeTruthy();
    const clock = () => screen.getByLabelText('播放位置').textContent ?? '';
    expect(clock()).toMatch(/^00:00\.0/);
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(clock()).toMatch(/^00:01\.0/);
    for (let index = 0; index < 3; index += 1) await userEvent.keyboard('{ArrowRight}');
    expect(clock()).toMatch(/^00:01\.1/);
    await userEvent.keyboard('{End}');
    expect(clock()).toMatch(/^00:06\.0 \/ 00:06\.0/);
    await userEvent.keyboard('{Home}');
    expect(clock()).toMatch(/^00:00\.0/);

    const mark = screen.getByRole('button', { name: '框选画面' });
    expect(mark.getAttribute('aria-keyshortcuts')).toBe('M');
    await userEvent.keyboard('m');
    expect(screen.getByRole('button', { name: '拖动框选…' }).getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: '框选画面' }).getAttribute('aria-pressed')).toBe('false');

    const composer = screen.getByLabelText('告诉 AI 怎么改') as HTMLTextAreaElement;
    await userEvent.keyboard('/');
    expect(document.activeElement).toBe(composer);
    expect(composer.value).toBe('');
    // 输入框里打字时方向键与问号不接管
    await userEvent.keyboard('{ArrowRight}?');
    expect(composer.value).toBe('?');
    expect(clock()).toMatch(/^00:00\.0/);
    expect(screen.queryByRole('region', { name: '快捷键' })).toBeNull();
    composer.blur();

    await userEvent.keyboard('?');
    const list = screen.getByRole('region', { name: '快捷键' });
    expect(within(list).getByText('后退 / 前进一帧')).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: '快捷键' })).toBeNull();

    fireEvent.keyDown(window, { key: 'Control' });
    expect(await screen.findByRole('region', { name: '快捷键' }, { timeout: 1500 })).toBeTruthy();
    expect(screen.getByText('松开 Ctrl / ⌘ 即收起')).toBeTruthy();
    fireEvent.keyUp(window, { key: 'Control' });
    expect(screen.queryByRole('region', { name: '快捷键' })).toBeNull();
  });

  it('时间带：试改改动的位置来自服务端对照（只标内容有改动的片段）；缩放按钮与 + / - / 0', async () => {
    const { sdk } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('试改改了 1 处')).toBeTruthy();
    expect(sdk.projects.compareProposal).toHaveBeenCalledWith('ws_1', 'prj_1', 'prp_1', { againstProposalId: null, axes: ['CONTENT', 'ASSET', 'DURATION'] });
    expect(screen.getAllByTitle('试改在这里改了内容')).toHaveLength(1);

    const zoom = screen.getByRole('group', { name: '时间带缩放' });
    expect(within(zoom).getByText('1×')).toBeTruthy();
    expect((within(zoom).getByRole('button', { name: '缩小时间带' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(within(zoom).getByRole('button', { name: '放大时间带' }));
    expect(within(zoom).getByText('1.5×')).toBeTruthy();
    expect(screen.getByRole('group', { name: '时间带' }).getAttribute('data-zoomed')).toBe('true');
    await userEvent.keyboard('++');
    expect(within(zoom).getByText('3×')).toBeTruthy();
    await userEvent.keyboard('-');
    expect(within(zoom).getByText('2×')).toBeTruthy();
    await userEvent.keyboard('0');
    expect(within(zoom).getByText('1×')).toBeTruthy();
    expect(screen.getByRole('group', { name: '时间带' }).getAttribute('data-zoomed')).toBeNull();
  });

  it('任务中心：顶栏按钮写明进行中数量；抽屉按组列出素材、导出与 AI 这一轮（只读服务端状态）', async () => {
    const { sdk } = client({ turns: [turn({ status: 'RUNNING', proposalId: null, reply: null, toolCalls: [] })] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    // 两段素材仍在理解语音（transcript WORKING）+ AI 这一轮进行中 = 3 项
    const button = await screen.findByRole('button', { name: '任务：3 项进行中' });
    expect(button.textContent).toContain('任务 3');
    await userEvent.click(button);
    const panel = screen.getByRole('complementary', { name: '任务' });
    expect(within(within(panel).getByRole('region', { name: 'AI 这一轮' })).getByText('进行中')).toBeTruthy();
    expect(within(within(panel).getByRole('region', { name: '素材处理' })).getByText('2 段素材已就绪')).toBeTruthy();
    expect(within(within(panel).getByRole('region', { name: '导出' })).getByText('完成')).toBeTruthy();
    expect(sdk.finalRenders.list).toHaveBeenCalledWith('ws_1', 'prj_1');
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('complementary', { name: '任务' })).toBeNull();
  });

  it('指：点选时间带上的片段 → 对话带上指认的片段', async () => {
    const { sdk, startTurn } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const clip = await screen.findByRole('button', { name: /^片段 lake\.mp4/ });
    clip.focus();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByText('片段「lake.mp4」')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('告诉 AI 怎么改'), '再短一点{Enter}');
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '再短一点', pointer: { timeRange: null, clipIds: ['clp_l'], frameRegion: null } }, expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.getByText('未选择 · 作用于整条视频')).toBeTruthy();
  });

  it('V6-3 指画面与特效：特效开关显式修改项目规则；框出画面区域随对话发出；特效轨与特效片段单独标名', async () => {
    HTMLElement.prototype.setPointerCapture = vi.fn();
    const withEffect = preview({ clips: [...preview().clips as unknown[], { clipId: 'clp_fx', trackId: 'trk_fx', kind: 'VIDEO', sourceVersionId: 'av_fx', sequenceRange: range(15, 60) }] });
    const { sdk, startTurn } = client({
      turns: [turn()],
      state: studioState({ effects: [{ footageId: 'av_fx', name: 'Glow', templateId: 'glow', source: 'TEMPLATE', params: { color: '#ffffff' } }] }),
      extra: { previews: { request: vi.fn().mockResolvedValue(withEffect), get: vi.fn().mockResolvedValue(withEffect) } },
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByRole('button', { name: /^片段 特效 Glow，00:00\.5 到 00:02\.0$/ })).toBeTruthy();
    expect(screen.getByText('特效', { selector: 'span' })).toBeTruthy();

    const toggle = screen.getByRole('button', { name: /特效：关/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    await waitFor(() => expect(sdk.studio.updateProductionPolicy).toHaveBeenCalledWith('ws_1', 'prj_1', { allowProceduralGraphics: true }, expect.objectContaining({ idempotencyKey: expect.any(String) })));

    await userEvent.click(screen.getByRole('button', { name: /框选画面/ }));
    const layer = screen.getByRole('application', { name: /在画面上拖动/ });
    fireEvent.pointerDown(layer, { clientX: 450, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(layer, { clientX: 700, clientY: 25, pointerId: 1 });
    fireEvent.pointerUp(layer, { clientX: 810, clientY: 30, pointerId: 1 });
    expect(screen.queryByRole('application')).toBeNull();
    expect(screen.getByRole('img', { name: '框出的画面区域' })).toBeTruthy();
    expect(screen.getByText('画面区域 · 00:00.0')).toBeTruthy();
    await userEvent.type(screen.getByLabelText('告诉 AI 怎么改'), '这里加个光效{Enter}');
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', {
      // 没选时间：以框选时那一帧起的 1 秒为"这里"的时间
      message: '这里加个光效', pointer: { timeRange: { start: pointerSecondsText(mt(0)), end: pointerSecondsText(mt(30)) }, clipIds: [], frameRegion: { x: 0.5, y: 0.25, width: 0.4, height: 0.5 } },
    }, expect.anything()));
    await userEvent.click(screen.getByRole('button', { name: '清除选择' }));
    expect(screen.queryByRole('img', { name: '框出的画面区域' })).toBeNull();
  });

  it('V6-3 已采用的特效：工程里特效轨上的片段也上时间带并标名', async () => {
    const clips = [
      { id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sequenceRange: range(0, 30) },
      { id: 'clp_fx', sequenceId: 'seq_1', trackId: 'trk_fx', assetVersionId: 'av_fx', sequenceRange: range(6, 21) },
    ];
    const { sdk } = client({
      turns: [],
      state: studioState({ effects: [{ footageId: 'av_fx', name: 'Sparkles', templateId: 'sparkles', source: 'TEMPLATE', params: {} }] }),
      extra: { projects: { state: vi.fn().mockResolvedValue(projectState(clips, [{ id: 'trk_fx', sequenceId: 'seq_1', kind: 'VIDEO', position: 2 }])), proposal: vi.fn().mockResolvedValue(proposal) } },
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByRole('button', { name: /^片段 特效 Sparkles，00:00\.2 到 00:00\.7$/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^片段 glacier\.mp4/ })).toBeTruthy();
  });

  it('V6-5 从文章开始：还没剪时显示文章已就绪，一键让 AI 讲成视频；配音开关显式修改项目规则', async () => {
    const { sdk, startTurn } = client({ state: studioState({ footage: [], project: { id: 'prj_1', title: '淡水', aspectRatio: '16:9', revision: 1, allowEffects: true, allowNarration: false, allowGeneratedVideo: false, article: { title: '淡水', characters: 120, paragraphs: 3 } } }) });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByText('文章已就绪（3 段）')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /配音：关/ });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await userEvent.click(toggle);
    await waitFor(() => expect(sdk.studio.updateProductionPolicy).toHaveBeenCalledWith('ws_1', 'prj_1', { allowGeneratedSpeech: true }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await userEvent.click(screen.getByRole('button', { name: '让 AI 讲成视频' }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', expect.objectContaining({ message: '根据文章做出第一版解说视频。' }), expect.anything()));
  });

  it('V6-5 讲述轨：讲述片段标出讲述稿开头，排在画面下面', async () => {
    const narrationText = 'Water covers about 71 percent of the surface of the Earth, and most of it is salt water.';
    const { sdk } = client({
      turns: [],
      state: studioState({ narration: [{ footageId: 'av_vo', text: narrationText, voice: 'flite-slt', engine: 'flite' }] }),
      clips: [
        { id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sequenceRange: range(0, 90) },
        { id: 'clp_vo', sequenceId: 'seq_1', trackId: 'trk_vo', assetVersionId: 'av_vo', sequenceRange: range(0, 150) },
      ],
      extra: {
        projects: {
          state: vi.fn().mockResolvedValue({
            document: {
              projectRevision: 5,
              composition: {
                sequences: [{ id: 'seq_1', duration: mt(150), frameRate: { num: 30, den: 1 } }],
                tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }, { id: 'trk_a', sequenceId: 'seq_1', kind: 'AUDIO', position: 1 }, { id: 'trk_vo', sequenceId: 'seq_1', kind: 'AUDIO', position: 2 }],
                clips: [
                  { id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sequenceRange: range(0, 90) },
                  { id: 'clp_vo', sequenceId: 'seq_1', trackId: 'trk_vo', assetVersionId: 'av_vo', sequenceRange: range(0, 150) },
                ],
              },
            },
          }),
          proposal: vi.fn().mockResolvedValue(proposal),
          adoptProposal: vi.fn(),
          discardProposal: vi.fn(),
        },
      },
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const clip = await screen.findByRole('button', { name: /^片段 讲述「Water covers about 71 percent of the su…」，00:00\.0 到 00:05\.0$/ });
    expect(clip.textContent).toBe('Water covers about 71 percent of the su…');
    expect(screen.getByText('讲述')).toBeTruthy();
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
      message: '更有冲击力', pointer: { timeRange: null, clipIds: [], frameRegion: null }, strategyPackId: 'builtin:travel-beat', strategyKnobs: { pacing: 'intense' },
    }, expect.anything()));
  });

  it('V6-6 从参考视频学风格：上传文件 + 粘贴链接 → 进度 → 测量结果卡（只列真实测量）→ 改说明 → 选用', async () => {
    const distilled = {
      ...beatPack, id: 'stp_ref1', kind: 'DISTILLED', genre: 'reference', version: 1,
      name: { 'zh-CN': '「a.mp4」等 2 条视频的风格', en: 'Style of “a.mp4” and 1 more' },
      summary: { 'zh-CN': '镜头很短、卡在节拍上。', en: 'Short shots cut on the beat.' },
      knobs: [{ ...beatPack.knobs[0], defaultValue: 'calmer' }],
      agentGuidance: 'Cut on the beat.',
      editingDna: {
        shotSeconds: { typical: { min: 0.5, max: 0.8 }, median: 0.5 }, beatCutRatio: 1, shotScaleVariety: null, transitionsPerMinute: 7.5,
        speedRampsPerMinute: null, zoomsPerMinute: null, hookSeconds: 0.5, captionStyle: null, soundHabits: 'steady beat around 120 BPM', colorTendency: 'a warm cast',
        cutsPerMinute: 65, pacing: [120, 120, 120, 120, 120, 30, 20, 20, 20, 20], measured: { references: 2, analyzedSeconds: 24, shots: 28 },
      },
    };
    const run = (overrides: Record<string, unknown>) => ({ runId: 'wfr_ref1', status: 'RUNNING', step: 'analyze', references: [], packId: null, composer: null, error: null, createdAt: '2026-10-12T00:00:00.000Z', ...overrides });
    const uploadResumable = vi.fn().mockResolvedValue({ id: 'ast_ref' });
    const startDistill = vi.fn().mockResolvedValue(run({ step: 'fetch' }));
    const getDistill = vi.fn().mockResolvedValueOnce(run({})).mockResolvedValue(run({ status: 'SUCCEEDED', step: 'save', packId: 'stp_ref1', composer: 'RULES' }));
    const updateStrategy = vi.fn().mockImplementation((_ws: string, _id: string, changes: { summary: Record<string, string> }) => Promise.resolve({ ...distilled, version: 2, summary: changes.summary }));
    const strategies = vi.fn().mockResolvedValueOnce([beatPack]).mockResolvedValue([beatPack, distilled]);
    const { sdk, startTurn } = client({ turns: [turn()] });
    const agent = (sdk as unknown as { agent: Record<string, unknown> }).agent;
    Object.assign(agent, { strategies, startDistill, getDistill, updateStrategy, strategy: vi.fn().mockResolvedValue(distilled) });
    Object.assign((sdk as unknown as { assets: Record<string, unknown> }).assets, { uploadResumable });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);

    await userEvent.click(await screen.findByRole('button', { name: '从参考视频学风格' }));
    const drawer = screen.getByRole('complementary', { name: '从参考视频学风格' });
    expect(within(drawer).getByText(/版权由你负责/)).toBeTruthy();
    const start = within(drawer).getByRole('button', { name: '开始学习' });
    expect((start as HTMLButtonElement).disabled).toBe(true);

    const fileInput = drawer.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [new File(['x'], 'a.mp4', { type: 'video/mp4' })] } });
    await waitFor(() => expect(uploadResumable).toHaveBeenCalledWith('ws_1', expect.objectContaining({ assetType: 'USER_UPLOAD', filename: 'a.mp4', contentType: 'video/mp4' }), expect.anything()));
    expect(await within(drawer).findByText('文件')).toBeTruthy();

    const link = within(drawer).getByLabelText('视频链接');
    await userEvent.type(link, 'not a link{Enter}');
    expect(within(drawer).getByRole('alert').textContent).toContain('http://');
    await userEvent.clear(link);
    await userEvent.type(link, 'https://www.youtube.com/watch?v=4uQskImIBIY');
    await userEvent.click(within(drawer).getByRole('button', { name: '添加链接' }));
    expect(within(drawer).getByText('https://www.youtube.com/watch?v=4uQskImIBIY')).toBeTruthy();

    await userEvent.click(start);
    await waitFor(() => expect(startDistill).toHaveBeenCalledWith('ws_1', {
      references: [{ assetId: 'ast_ref' }, { url: 'https://www.youtube.com/watch?v=4uQskImIBIY' }], name: null, locale: 'zh-CN',
    }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    expect(await within(drawer).findByText('测量剪辑手法')).toBeTruthy();
    expect(within(drawer).getByText('测量剪辑手法').getAttribute('aria-current')).toBe('step');

    expect(await within(drawer).findByText('「a.mp4」等 2 条视频的风格', {}, { timeout: 4000 })).toBeTruthy();
    expect(within(drawer).getByText('按测量统计自动写的说明（没有 AI 看片）')).toBeTruthy();
    expect(within(drawer).getByText('中位 0.5 秒（多在 0.5–0.8 秒）')).toBeTruthy();
    expect(within(drawer).getByText('每分钟 65 次')).toBeTruthy();
    expect(within(drawer).getByText('100% 的剪点在节拍上')).toBeTruthy();
    expect(within(drawer).getByText('测量依据：2 条视频，共 0.4 分钟，28 个镜头')).toBeTruthy();
    expect(within(drawer).getByText(/还没测：.*景别.*推拉缩放.*变速.*字幕样式/)).toBeTruthy();
    expect(within(drawer).queryByText(/卡点（没有稳定的节拍）/)).toBeNull();
    expect(within(drawer).getByRole('img', { name: /节奏曲线.*120, 120, 120, 120, 120, 30, 20, 20, 20, 20/ })).toBeTruthy();

    await userEvent.click(within(drawer).getByRole('button', { name: '改说明' }));
    const summary = within(drawer).getByLabelText('说明');
    await userEvent.clear(summary);
    await userEvent.type(summary, '短镜头，全部卡点。');
    await userEvent.click(within(drawer).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(updateStrategy).toHaveBeenCalledWith('ws_1', 'stp_ref1', {
      summary: { 'zh-CN': '短镜头，全部卡点。', en: 'Short shots cut on the beat.' }, agentGuidance: 'Cut on the beat.',
    }, expect.anything()));
    expect(await within(drawer).findByText('已保存。')).toBeTruthy();

    await userEvent.click(within(drawer).getByRole('button', { name: '用这个风格' }));
    await waitFor(() => expect(screen.queryByRole('complementary', { name: '从参考视频学风格' })).toBeNull());
    await waitFor(() => expect((screen.getByLabelText('风格（可选）') as HTMLSelectElement).value).toBe('stp_ref1'));
    await userEvent.type(screen.getByLabelText('告诉 AI 怎么改'), '照这个风格剪{Enter}');
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', expect.objectContaining({ strategyPackId: 'stp_ref1', strategyKnobs: { pacing: 'calmer' } }), expect.anything()));
  });

  it('V6-6 学风格失败：按原因说明（平台链接未配置下载工具 → 提示下载后上传）', async () => {
    const { sdk } = client({ turns: [turn()] });
    Object.assign((sdk as unknown as { agent: Record<string, unknown> }).agent, {
      startDistill: vi.fn().mockResolvedValue({ runId: 'wfr_ref2', status: 'RUNNING', step: 'fetch', references: [], packId: null, composer: null, error: null, createdAt: '2026-10-12T00:00:00.000Z' }),
      getDistill: vi.fn().mockResolvedValue({ runId: 'wfr_ref2', status: 'FAILED', step: 'fetch', references: [], packId: null, composer: null, error: { reason: 'REFERENCE_FETCH_NOT_CONFIGURED', message: 'x' }, createdAt: '2026-10-12T00:00:00.000Z' }),
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await userEvent.click(await screen.findByRole('button', { name: '从参考视频学风格' }));
    const drawer = screen.getByRole('complementary', { name: '从参考视频学风格' });
    await userEvent.type(within(drawer).getByLabelText('视频链接'), 'https://www.youtube.com/watch?v=AMCUqgu_cTM{Enter}');
    await userEvent.click(within(drawer).getByRole('button', { name: '开始学习' }));
    const alert = await within(drawer).findByRole('alert');
    expect(alert.textContent).toContain('没能学成这个风格');
    expect(alert.textContent).toContain('请先把视频下载下来');
    await userEvent.click(within(alert).getByRole('button', { name: '重新开始' }));
    expect(within(drawer).getByRole('button', { name: '开始学习' })).toBeTruthy();
    await userEvent.click(within(drawer).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('complementary', { name: '从参考视频学风格' })).toBeNull();
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

  it('工作区本月 AI 额度用完：输入框上方说明额度与恢复日期、发送不可用；读面未刷新时服务端 402 也说明同一原因；英文同样', async () => {
    const reached = { period: '2026-10', capMicros: 20_000_000, capSource: 'DEPLOYMENT', spentMicros: 20_400_000, unpricedCalls: 0, reached: true, resetsAt: '2026-11-01T00:00:00.000Z' };
    const limited = client({ state: studioState({ aiSpend: reached }) });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, limited.sdk);
    const notice = await screen.findByText('这个工作区本月的 AI 额度（$20.00）已用完，11月1日恢复。');
    expect(notice.getAttribute('role')).toBe('status');
    await userEvent.type(screen.getByRole('textbox', { name: '告诉 AI 怎么改' }), '剪一版');
    expect((screen.getByRole('button', { name: '发送' }) as HTMLButtonElement).disabled).toBe(true);
    expect(limited.startTurn).not.toHaveBeenCalled();
    expect(MESSAGES.en.studio.chat.errors.monthlyCap('$20.00', reached.resetsAt)).toBe('This workspace has used its AI allowance for this month ($20.00). It resets on November 1.');
  });

  it('画面理解因本月 AI 额度暂停：素材面板标出"AI 额度已用完"，可再理解一次；额度仍用完时说明原因；任务中心列出暂停', async () => {
    const paused = { ...footage('glacier.mp4', 'av_g'), understanding: { index: 'READY', transcript: 'READY', visual: 'LIMIT_REACHED' } };
    const retryVisualAnalysis = vi.fn()
      .mockRejectedValueOnce(apiError(402, 'BUDGET_EXCEEDED', 'this workspace has used its AI allowance for this month', { reason: 'AI_MONTHLY_CAP_REACHED', capMicros: 20_000_000, spentMicros: 20_100_000, resetsAt: '2026-11-01T00:00:00.000Z' }))
      .mockResolvedValueOnce({ status: 'QUEUED' });
    const { sdk } = client({ state: studioState({ footage: [paused] }) });
    (sdk.assets as unknown as { retryVisualAnalysis: typeof retryVisualAnalysis }).retryVisualAnalysis = retryVisualAnalysis;
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const rail = await screen.findByRole('toolbar', { name: '画布工具' });
    await userEvent.click(within(rail).getByRole('button', { name: '素材 1' }));
    const drawer = screen.getByRole('complementary', { name: '素材' });
    expect(within(drawer).getByText('AI 额度已用完')).toBeTruthy();
    const retry = within(drawer).getByRole('button', { name: '重新理解「glacier.mp4」的画面' });
    await userEvent.click(retry);
    expect(await within(drawer).findByText('这个工作区本月的 AI 额度（$20.00）已用完，11月1日恢复。')).toBeTruthy();
    await userEvent.click(retry);
    await waitFor(() => expect(retryVisualAnalysis).toHaveBeenCalledTimes(2));
    expect(retryVisualAnalysis).toHaveBeenLastCalledWith('ws_1', 'ast_glacier.mp4');
    await waitFor(() => expect(within(drawer).queryByRole('alert')).toBeNull());
    const rows = studioTaskRows({ footage: [paused] as never, generations: [], exports: [], turn: undefined, t: MESSAGES['zh-CN'].studio, formatTime: (iso) => iso });
    expect(rows.find((row) => row.key === 'f-ast_glacier.mp4')).toMatchObject({ status: 'failed', detail: MESSAGES['zh-CN'].studio.tasks.understandingPaused });
  });

  it('额度在两次刷新之间用完：发送被服务端 402 拒绝，说明额度与恢复日期', async () => {
    const stale = client();
    stale.startTurn.mockRejectedValueOnce(apiError(402, 'BUDGET_EXCEEDED', 'this workspace has used its AI allowance for this month', { reason: 'AI_MONTHLY_CAP_REACHED', capMicros: 5_000_000, spentMicros: 5_100_000, resetsAt: '2026-11-01T00:00:00.000Z' }));
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, stale.sdk);
    await userEvent.type(await screen.findByRole('textbox', { name: '告诉 AI 怎么改' }), '剪一版');
    await userEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(await screen.findByText('这个工作区本月的 AI 额度（$5.00）已用完，11月1日恢复。')).toBeTruthy();
  });

  const quote = (overrides: Record<string, unknown> = {}) => ({
    id: 'gen_1', projectId: 'prj_1', sessionId: 'ses_1', kind: 'VIDEO_REGION', status: 'QUOTED',
    request: { kind: 'VIDEO_REGION', prompt: 'sunset sky', clipId: 'clp_g', start: mt(30), end: mt(90), region: { x: 0.5, y: 0, width: 0.5, height: 0.5 } },
    summary: '把右上角的天空换成晚霞', providerId: 'vendor', implementation: 'REAL', model: 'video-x', estimatedSeconds: '2',
    estimate: { minMicros: 100_000, maxMicros: 800_000 }, reserveCredits: 80, expiresAt: '2099-01-01T00:00:00.000Z', createdAt: '2026-10-14T00:00:00.000Z',
    acceptedAt: null, completedAt: null, chargedMicros: null, costSource: null, quoteTurnId: 'agt_1', turnId: null, proposalId: null, footageId: null,
    outsideRegionChange: null, error: null, ...overrides,
  });

  it('V6-7/V6-8 报价卡：说明价格与预算；确认时带上看到的报价上限；放弃；生成开关显式修改项目规则', async () => {
    const accept = vi.fn().mockResolvedValue(quote({ status: 'RUNNING', turnId: 'agt_9', acceptedAt: '2026-10-14T00:01:00.000Z' }));
    const decline = vi.fn().mockResolvedValue(quote({ status: 'DECLINED' }));
    const { sdk } = client({
      turns: [turn({ proposalId: null, reply: '重绘这块约 2 秒，预计 $0.10–$0.80，确认后开始。' })],
      state: studioState({ generations: [quote()], generationBudget: { configured: true, period: 'MONTHLY', limitMicros: 5_000_000, spentMicros: 1_000_000, reservedMicros: 0 } }),
      extra: { generations: { accept, decline, list: vi.fn() } },
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const card = await screen.findByRole('article', { name: '重绘框出的区域 · 把右上角的天空换成晚霞' });
    expect(within(card).getByText('约 2 秒 · 预计 $0.10–$0.80 · 供应商模型 video-x')).toBeTruthy();
    expect(within(card).getByText('确认后先从生成预算预留上限；本期还剩 $4.00')).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: '确认生成（最多 $0.80）' }));
    await waitFor(() => expect(accept).toHaveBeenCalledWith('ws_1', 'prj_1', 'gen_1', { expectedMaxMicros: 800_000 }, expect.objectContaining({ idempotencyKey: expect.any(String) })));
    await userEvent.click(within(card).getByRole('button', { name: '不要了' }));
    await waitFor(() => expect(decline).toHaveBeenCalledWith('ws_1', 'prj_1', 'gen_1', expect.anything()));

    const toggle = screen.getByRole('button', { name: /生成：关/ });
    await userEvent.click(toggle);
    await waitFor(() => expect(sdk.studio.updateProductionPolicy).toHaveBeenCalledWith('ws_1', 'prj_1', { allowGeneratedVideo: true }, expect.anything()));
  });

  it('V6-7/V6-8 报价卡：没设预算如实提示；确认被拒说明原因；进行中、待对账、测试替身都标明', async () => {
    const accept = vi.fn().mockRejectedValue(apiError(409, 'PRECONDITION_FAILED', 'no budget', { reason: 'GENERATION_BUDGET_NOT_SET' }));
    const { sdk } = client({
      state: studioState({ generations: [
        quote({ implementation: 'SCRIPTED' }),
        quote({ id: 'gen_2', kind: 'AVATAR_CLIP', summary: '我出镜说开场白', status: 'RUNNING', request: { kind: 'AVATAR_CLIP', identityId: 'cid_1', script: 'Hi', language: 'en', at: mt(0), framing: 'CORNER' } }),
        quote({ id: 'gen_3', summary: '换天空', status: 'NEEDS_RECONCILIATION' }),
      ] }),
      extra: { generations: { accept, decline: vi.fn(), list: vi.fn() } },
    });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    const card = await screen.findByRole('article', { name: '重绘框出的区域 · 把右上角的天空换成晚霞' });
    expect(within(card).getByText('测试替身')).toBeTruthy();
    expect(within(card).getByText(/工作区还没有设置生成预算/)).toBeTruthy();
    await userEvent.click(within(card).getByRole('button', { name: /确认生成/ }));
    expect(await screen.findByText('工作区还没有设置生成预算，不能确认。')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: '数字人出镜 · 我出镜说开场白' })).getByText('正在生成…只调用一次，不会自动重试。')).toBeTruthy();
    expect(within(screen.getByRole('article', { name: '重绘框出的区域 · 换天空' })).getByRole('alert').textContent).toContain('结果不明');
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
  it('时间带波形：声音片段画出所用源区间的实测峰值（媒体索引）；索引属于别的版本时不画', async () => {
    const linear = { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true };
    // 源 0–6 秒：1–2 秒响（峰值 800），其余静音
    const peaks = Array.from({ length: 600 }, (_, index) => (index >= 100 && index < 200 ? 800 : 0));
    const mediaIndex = vi.fn().mockImplementation((_workspaceId: string, assetId: string) => Promise.resolve({
      runId: 'mix_1', sourceAssetVersionId: assetId === 'ast_glacier.mp4' ? 'av_g' : 'av_older', processorVersion: 'source-index-v1', status: 'READY', coveragePermille: 1000, checkpointMs: 6000, errorSummary: null,
      items: [{ id: 'mie_1', kind: 'WAVEFORM', ordinal: 0, sourceStartPts: '0', sourceEndPts: '6000', timeBase: { numerator: 1, denominator: 1000 }, streamId: 'audio:1', confidencePermille: 1000, payload: { sourceStartMs: 0, sourceEndMs: 6000, sampleIntervalMs: 10, peaks }, previewUrl: null, previewExpiresAt: null }],
      nextCursor: null,
    }));
    const clips = [
      { id: 'clp_g', sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: 'av_g', sourceRange: range(30, 90), sequenceRange: range(0, 60), timeMapping: linear },
      // 声音片段用源 1–3 秒：前一半响、后一半静音
      { id: 'clp_ga', sequenceId: 'seq_1', trackId: 'trk_a', assetVersionId: 'av_g', sourceRange: range(30, 90), sequenceRange: range(0, 60), timeMapping: linear },
      { id: 'clp_la', sequenceId: 'seq_1', trackId: 'trk_a', assetVersionId: 'av_l', sourceRange: range(0, 60), sequenceRange: range(60, 120), timeMapping: linear },
    ];
    const { sdk } = client({
      turns: [],
      extra: {
        assets: { uploadResumable: vi.fn(), mediaIndex },
        projects: {
          state: vi.fn().mockResolvedValue({ document: { projectRevision: 5, composition: { sequences: [{ id: 'seq_1', duration: mt(120), frameRate: { num: 30, den: 1 } }], tracks: projectState().document.composition.tracks, clips } } }),
          proposal: vi.fn().mockResolvedValue(proposal), adoptProposal: vi.fn(), discardProposal: vi.fn(),
        },
      },
    });
    const { container } = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await waitFor(() => expect(container.querySelectorAll('[data-waveform]')).toHaveLength(1));
    expect(mediaIndex).toHaveBeenCalledWith('ws_1', 'ast_glacier.mp4', { kind: 'WAVEFORM', limit: 100 });
    expect(mediaIndex).toHaveBeenCalledWith('ws_1', 'ast_lake.mp4', { kind: 'WAVEFORM', limit: 100 });
    const svg = container.querySelector('[data-waveform]') as SVGElement;
    const bars = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
    const drawn = (svg.querySelector('path')?.getAttribute('d') ?? '').match(/M/g)?.length ?? 0;
    expect(bars).toBeGreaterThan(50);
    expect(drawn / bars).toBeGreaterThan(0.45);
    expect(drawn / bars).toBeLessThan(0.56);
    // 声音片段在声音轨里（不是画面轨）
    expect(svg.closest('button')?.getAttribute('aria-label')).toMatch(/^片段 glacier\.mp4，00:00\.0 到 00:02\.0$/);
  });

  it('时间带触屏：两指捏合按档位缩放；第二根手指落下时取消单指选择（不跳播放头、不选区）', async () => {
    const { sdk } = client({ turns: [turn()] });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    await screen.findByText('试改改了 1 处');
    const zoom = screen.getByRole('group', { name: '时间带缩放' });
    const lanes = screen.getByLabelText('片段区：拖动选择一段时间，点击选中片段');
    const touch = (pointerId: number, clientX: number) => ({ pointerId, pointerType: 'touch', clientX, clientY: 10, button: 0, isPrimary: pointerId === 1 });
    fireEvent.pointerDown(lanes, touch(1, 300));
    fireEvent.pointerDown(lanes, touch(2, 400));
    fireEvent.pointerMove(lanes, touch(2, 500));
    expect(within(zoom).getByText('2×')).toBeTruthy();
    fireEvent.pointerMove(lanes, touch(2, 1100));
    expect(within(zoom).getByText('8×')).toBeTruthy();
    fireEvent.pointerUp(lanes, touch(2, 1100));
    fireEvent.pointerUp(lanes, touch(1, 300));
    // 单指那一下被取消：播放头仍在开头，没有出现选区
    expect(screen.getByRole('slider', { name: '时间标尺：拖动定位播放位置' }).getAttribute('aria-valuetext')).toBe('00:00.0');
    expect(screen.queryByRole('button', { name: '清除选择' })).toBeNull();
  });

  it('任务结束就近提醒：看着进行中的素材处理完，任务按钮下方提示"完成"，点一下打开任务', async () => {
    const processing = studioState({ footage: [{ ...footage('glacier.mp4', 'av_g'), status: 'PROCESSING', understanding: { index: 'NONE', transcript: 'NONE', visual: 'NONE' } }] });
    const ready = studioState({ footage: [{ ...footage('glacier.mp4', 'av_g'), understanding: { index: 'READY', transcript: 'READY', visual: 'READY' } }] });
    const { sdk } = client({ turns: [] });
    (sdk.studio.state as ReturnType<typeof vi.fn>).mockResolvedValueOnce(processing).mockResolvedValue(ready);
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    expect(await screen.findByRole('button', { name: '任务：1 项进行中' })).toBeTruthy();
    const notice = await screen.findByRole('button', { name: 'glacier.mp4 · 完成。打开任务' }, { timeout: 6000 });
    expect(notice.closest('[role="status"]')).toBeTruthy();
    await userEvent.click(notice);
    expect(screen.getByRole('complementary', { name: '任务' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'glacier.mp4 · 完成。打开任务' })).toBeNull();
  });
});
