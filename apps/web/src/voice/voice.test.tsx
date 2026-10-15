import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { StudioRoom } from '@/studio/StudioRoom';

/**
 * V6-2 / Issue #9 实时语音（浏览器侧，组件层）：用假麦克风、假 AudioWorklet、假 Web Audio 与假 WebSocket 固定线协议——
 * 开麦 → 申请语音会话（短期凭证）→ 连网关并发 start → ready 后一直送音频（音频时钟 = 采样数）；选择变化带时钟发指向样本；
 * 画布底部的悬浮语音条按阶段互斥显示（在听 / 正在听你说 / AI 思考中 / AI 正在说 / 出错 / 已结束）；一句话说完带绑定指向发出一轮，
 * AI 忙时排队、按句子 id 做幂等键；服务端语音回应可被开口打断；停止说话 / 停止这一轮 / 结束语音分开；断线、过期、未配置如实说明并可重连。
 * 真实浏览器 + 真实网关 + 真实识别 / 合成 / 导演的证据见 scripts/voice-live-check.mjs。
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static readonly OPEN = 1;
  readonly sent: (string | ArrayBuffer)[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  /** 服务端（或网络）关闭连接 */
  drop(code: number) { this.readyState = 3; this.onclose?.({ code }); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  audio(bytes: number) { this.onmessage?.({ data: new ArrayBuffer(bytes) }); }
  json() { return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item) as Record<string, unknown>); }
}

let workletPort: { onmessage: ((event: { data: { pcm: ArrayBuffer; level: number } }) => void) | null };
const speak = vi.fn();
const cancelSpeech = vi.fn();
/** 假 Web Audio：记录排进去播放的音频块与被停掉的块 */
const played: { started: number; stopped: boolean }[] = [];

beforeAll(() => {
  globalThis.ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(): void { this.callback([], this as unknown as ResizeObserver); }
    unobserve(): void {}
    disconnect(): void {}
  } as unknown as typeof ResizeObserver;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 900, height: 40, right: 900, bottom: 40, toJSON: () => ({}) });
});

beforeEach(() => {
  FakeSocket.instances = [];
  played.length = 0;
  speak.mockReset();
  cancelSpeech.mockReset();
  vi.stubGlobal('WebSocket', FakeSocket);
  workletPort = { onmessage: null };
  vi.stubGlobal('AudioWorkletNode', class { port = workletPort; disconnect() {} });
  vi.stubGlobal('AudioContext', class {
    currentTime = 0;
    destination = {};
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource() { return { connect: () => undefined }; }
    createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, copyToChannel: () => undefined }; }
    createBufferSource() {
      const record = { started: -1, stopped: false };
      played.push(record);
      return { buffer: null, onended: null, connect: () => undefined, disconnect: () => undefined, start: (at: number) => { record.started = at; }, stop: () => { record.stopped = true; } };
    }
    close() { return Promise.resolve(); }
  });
  vi.stubGlobal('SpeechSynthesisUtterance', class { lang = ''; onend: (() => void) | null = null; onerror: (() => void) | null = null; constructor(readonly text: string) {} });
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak, cancel: cancelSpeech } });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
});
afterEach(() => { vi.unstubAllGlobals(); });

const mt = (ticks: number) => ({ ticks: String(ticks), timebase: { num: 1, den: 30 } });
const clip = (id: string, version: string, start: number, end: number) => ({ id, sequenceId: 'seq_1', trackId: 'trk_v', assetVersionId: version, sequenceRange: { start: mt(start), end: mt(end) } });
const turn = (overrides: Record<string, unknown> = {}) => ({
  id: 'agt_v', sessionId: 'ses_1', workflowRunId: 'wfr_v', status: 'RUNNING', purpose: 'EDIT', reviewNoteId: null, reviewRoundId: null,
  message: '把这里剪短一点', pointer: { timeRange: null, clipIds: [] }, reply: null, proposalId: null, continuesProposalId: null,
  strategyPackId: null, strategyKnobs: {}, toolCalls: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
  costMicros: 0, error: null, createdAt: '2026-10-12T00:00:00.000Z', completedAt: null, ...overrides,
});

function client(overrides: { createVoiceSession?: ReturnType<typeof vi.fn>; startTurn?: ReturnType<typeof vi.fn> } = {}) {
  const startTurn = overrides.startTurn ?? vi.fn().mockResolvedValue(turn());
  const listTurns = vi.fn().mockResolvedValue([]);
  const createVoiceSession = overrides.createVoiceSession ?? vi.fn().mockResolvedValue({
    session: { sessionId: 'vsess_1' }, credential: { kind: 'EPHEMERAL_SESSION', token: 'short-lived-token-0123456789', scopes: ['voice:stream'], expiresAt: '2026-10-12T00:15:00.000Z' }, // secrets:check-ignore：测试专用假短期凭证（非真实凭据）
  });
  const sdk = mockClient({
    auth: { session: vi.fn().mockResolvedValue({ user: { id: 'usr_1' } }) },
    workspaces: { get: vi.fn().mockResolvedValue({ id: 'ws_1', role: 'EDITOR' }) },
    studio: { state: vi.fn().mockResolvedValue({
      project: { id: 'prj_1', title: '冰岛环岛', aspectRatio: '16:9', revision: 5 }, sequenceId: 'seq_1',
      session: { id: 'ses_1', workspaceId: 'ws_1', projectId: 'prj_1', sequenceId: 'seq_1', locale: 'zh-CN', createdBy: null, createdAt: '2026-10-12T00:00:00.000Z' },
      footage: [{ assetId: 'ast_g', footageId: 'av_g', name: 'glacier.mp4', kind: 'video', status: 'READY', duration: '6.0', understanding: { index: 'READY', transcript: 'NOT_CONFIGURED', visual: 'NOT_CONFIGURED' } },
        { assetId: 'ast_l', footageId: 'av_l', name: 'lake.mp4', kind: 'video', status: 'READY', duration: '6.0', understanding: { index: 'READY', transcript: 'NOT_CONFIGURED', visual: 'NOT_CONFIGURED' } }],
      cost: { projectId: 'prj_1', turns: 0, usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costMicros: 0, unpricedCalls: 0 },
      generations: [],
      generationBudget: { configured: false, period: null, limitMicros: null, spentMicros: 0, reservedMicros: 0 },
    }) },
    projects: {
      state: vi.fn().mockResolvedValue({ document: { projectRevision: 5, composition: {
        sequences: [{ id: 'seq_1', duration: mt(180), frameRate: { num: 30, den: 1 } }],
        tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }],
        clips: [clip('clp_g', 'av_g', 0, 90), clip('clp_l', 'av_l', 90, 180)],
      } } }),
      createVoiceSession,
    },
    agent: { listTurns, startTurn, createSession: vi.fn(), cancelTurn: vi.fn().mockResolvedValue(turn({ status: 'CANCELLED' })), strategies: vi.fn().mockResolvedValue([]) },
    previews: { request: vi.fn().mockResolvedValue({ id: 'pvw_1', status: 'RENDERING', proposalId: null, playbackUrl: null, segments: { total: 1, reused: 0, rendered: 0 }, captions: [], clips: [] }), get: vi.fn().mockResolvedValue({ id: 'pvw_1', status: 'RENDERING', proposalId: null, playbackUrl: null, segments: { total: 1, reused: 0, rendered: 0 }, captions: [], clips: [] }) },
  });
  return { sdk, startTurn, listTurns, createVoiceSession, cancelTurn: (sdk.agent as unknown as { cancelTurn: ReturnType<typeof vi.fn> }).cancelTurn };
}

const dock = () => document.querySelector<HTMLElement>('[data-voice-dock]');
const phase = () => dock()?.dataset['phase'] ?? 'off';
const caption = () => document.querySelector('[data-voice-caption]')?.textContent ?? '';
const attentionAt = (clipId: string) => ({ pointer: { timeRange: null, clipIds: [clipId], frameRegion: null }, evidence: 'DEICTIC_WORD', word: '这里', atSeconds: 0.6, label: null });

async function openVoice(sdkClient: ReturnType<typeof client>, ready: Record<string, unknown> = { type: 'ready', asr: { providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-transcribe' }, tts: null }) {
  await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
  await waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(0));
  const socket = FakeSocket.instances.at(-1)!;
  act(() => socket.open());
  act(() => socket.receive(ready));
  await waitFor(() => expect(phase()).toBe('listening'));
  return socket;
}

describe('V6-2 / Issue #9 连续语音（浏览器侧）', () => {
  it('一直开着：边说边出 → 一句话说完带着绑定指向发出 → AI 忙时第二句排队 → 服务端语音念回应 → 开口打断 → 停止这一轮 → 结束', async () => {
    const startTurn = vi.fn()
      .mockResolvedValueOnce(turn())
      .mockResolvedValueOnce(turn({ id: 'agt_v2', message: '音乐小一点' }));
    const sdkClient = client({ startTurn });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdkClient.sdk);
    // 先在时间带上指着 lake.mp4
    const lake = await screen.findByRole('button', { name: /^片段 lake\.mp4/ });
    lake.focus();
    await userEvent.keyboard('{Enter}');
    expect(phase()).toBe('off');
    const socket = await openVoice(sdkClient, {
      type: 'ready',
      asr: { providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-transcribe' },
      tts: { providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-mini-tts', voices: [{ id: 'coral', name: 'Coral' }, { id: 'onyx', name: 'Onyx' }] },
    });
    expect(sdkClient.createVoiceSession).toHaveBeenCalledWith('ws_1', 'prj_1', {}, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    expect(socket.url).toBe('ws://localhost:3000/realtime/v1/voice?session=vsess_1&token=short-lived-token-0123456789');
    expect(socket.json()[0]).toEqual({ type: 'start', locale: 'zh-CN', sampleRate: 16000 });
    // 悬浮语音条：状态 + 声音（真实可用的才列出）+ 结束；画布让出底边
    const bar = within(dock()!);
    expect(bar.getByText('在听')).toBeTruthy();
    expect(bar.getByRole('combobox', { name: 'AI 的声音' })).toBeTruthy();
    expect(bar.getAllByRole('option').map((option) => option.textContent)).toEqual(['Coral', 'Onyx']);
    expect(document.querySelector('[data-voice="on"]')).not.toBeNull();
    expect(caption()).toContain('说吧');
    // 音频时钟：指向样本带当时的采样数
    await waitFor(() => expect(socket.json().some((message) => message['type'] === 'pointer')).toBe(true));
    expect(socket.json().find((message) => message['type'] === 'pointer')).toMatchObject({ sample: { atSample: 0, pointer: { timeRange: null, clipIds: ['clp_l'] }, label: '片段「lake.mp4」' } });
    act(() => workletPort.onmessage?.({ data: { pcm: new Int16Array(320).buffer, level: 0.1 } }));
    expect(socket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(1);

    // 开口 → 正在听你说；边说边出的转写可修订；理解的指向
    act(() => socket.receive({ type: 'speech-start', atSeconds: 0.4 }));
    expect(phase()).toBe('recognizing');
    expect(cancelSpeech).toHaveBeenCalled();
    act(() => socket.receive({ type: 'transcript', utteranceId: 'utt_1', revision: 1, text: '把这', isFinal: false }));
    act(() => socket.receive({ type: 'transcript', utteranceId: 'utt_1', revision: 2, text: '把这里', isFinal: false }));
    act(() => socket.receive({ type: 'attention', utteranceId: 'utt_1', attention: attentionAt('clp_l') }));
    expect(caption()).toContain('把这里');
    expect(caption()).toContain('指的是：片段「lake.mp4」（说"这里"时）');
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_1', text: '把这里剪短一点', attention: attentionAt('clp_l') }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '把这里剪短一点', pointer: { timeRange: null, clipIds: ['clp_l'], frameRegion: null } }, { idempotencyKey: 'voice-turn-utt_1' }));
    await waitFor(() => expect(phase()).toBe('thinking'));
    expect(caption()).toContain('「把这里剪短一点」');

    // AI 还在处理：第二句先排队，不并发发出
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_2', text: '音乐小一点', attention: { ...attentionAt('clp_g'), evidence: 'SELECTION_AT_START', word: null } }));
    await waitFor(() => expect(caption()).toContain('还有 1 句排队'));
    expect(startTurn).toHaveBeenCalledTimes(1);
    expect(within(dock()!).getByRole('button', { name: '停止这一轮' })).toBeTruthy();

    // 第一轮结束 → 排队的一句按自己的幂等键发出；第一轮的回应交给网关念（只给 id 和声音）
    sdkClient.listTurns.mockResolvedValue([turn({ status: 'COMPLETED', reply: '已把这段剪短 1 秒。', completedAt: '2026-10-12T00:00:05.000Z' })]);
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(startTurn.mock.calls[1]![3]).toEqual({ idempotencyKey: 'voice-turn-utt_2' });
    await waitFor(() => expect(socket.json().filter((message) => message['type'] === 'speak')).toEqual([{ type: 'speak', turnId: 'agt_v', voiceId: 'coral' }]));
    expect(speak).not.toHaveBeenCalled(); // 有服务端合成就不用浏览器朗读

    // 回应开始出声 → AI 正在说（优先于"思考中"）
    act(() => socket.receive({ type: 'reply-start', turnId: 'agt_v', sampleRate: 24000, voiceId: 'coral' }));
    act(() => socket.audio(4800));
    act(() => socket.audio(4800));
    await waitFor(() => expect(phase()).toBe('speaking'));
    expect(played).toHaveLength(2);
    expect(within(dock()!).getByRole('button', { name: '停止说话' })).toBeTruthy();
    // 用户开口 → 立刻停播（不等转写），丢弃之后到的旧音频
    act(() => socket.receive({ type: 'speech-start', atSeconds: 6.1 }));
    expect(played.every((item) => item.stopped)).toBe(true);
    expect(phase()).toBe('recognizing');
    act(() => socket.audio(4800));
    expect(played).toHaveLength(2);
    // 新的一句：不再显示上一句绑定的指向（实测发现的回归）
    act(() => socket.receive({ type: 'transcript', utteranceId: 'utt_3', revision: 1, text: '再', isFinal: false }));
    expect(caption()).toBe('再');
    act(() => socket.receive({ type: 'transcript', utteranceId: 'utt_3', revision: 2, text: '', isFinal: true }));

    // 停止这一轮：让 AI 停下正在跑的第二轮（不是结束语音）
    await waitFor(() => expect(phase()).toBe('thinking'));
    await userEvent.click(within(dock()!).getByRole('button', { name: '停止这一轮' }));
    await waitFor(() => expect(sdkClient.cancelTurn).toHaveBeenCalledWith('ws_1', 'agt_v2', expect.anything()));
    expect(caption()).toContain('已让 AI 停下这一轮');

    // 结束语音：发 end，网关收尾后关闭 → 已结束
    await userEvent.click(within(dock()!).getByRole('button', { name: '结束语音' }));
    expect(socket.json().at(-1)).toEqual({ type: 'end' });
    expect(phase()).toBe('finishing');
    act(() => socket.drop(1000));
    expect(phase()).toBe('ended');
    expect(within(dock()!).getByText('语音已结束')).toBeTruthy();
  });

  it('键盘：V 开始 / 结束语音；没有服务端合成时用浏览器朗读并如实标注', async () => {
    const sdkClient = client();
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdkClient.sdk);
    await screen.findByRole('button', { name: '开始语音' });
    await userEvent.keyboard('v');
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.receive({ type: 'ready', asr: { providerId: 'deepgram', implementation: 'SCRIPTED', model: null }, tts: null }));
    await waitFor(() => expect(phase()).toBe('listening'));
    const bar = within(dock()!);
    expect(bar.getByText('浏览器朗读')).toBeTruthy();
    expect(bar.getByText('语音识别：测试替身')).toBeTruthy();
    expect(bar.queryByRole('combobox')).toBeNull();
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_b', text: '整体快一点', attention: { pointer: { timeRange: null, clipIds: [], frameRegion: null }, evidence: 'NONE', word: null, atSeconds: null, label: null } }));
    await waitFor(() => expect(sdkClient.startTurn).toHaveBeenCalledTimes(1));
    sdkClient.listTurns.mockResolvedValue([turn({ status: 'COMPLETED', reply: '整体节奏加快了。' })]);
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(1), { timeout: 4000 });
    expect(socket.json().some((message) => message['type'] === 'speak')).toBe(false);
    await userEvent.keyboard('v');
    expect(socket.json().at(-1)).toEqual({ type: 'end' });
  });

  it('一句发失败：停在队首如实说明，重试用同一个幂等键（不会重复执行），也可以不要了', async () => {
    const startTurn = vi.fn()
      .mockRejectedValueOnce(apiError(503, 'UPSTREAM_UNAVAILABLE', 'temporarily unavailable'))
      .mockResolvedValueOnce(turn());
    const sdkClient = client({ startTurn });
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdkClient.sdk);
    const socket = await openVoice(sdkClient);
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_f', text: '把结尾淡出', attention: { pointer: { timeRange: null, clipIds: [], frameRegion: null }, evidence: 'NONE', word: null, atSeconds: null, label: null } }));
    await waitFor(() => expect(caption()).toContain('「把结尾淡出」没发出去。'));
    expect(startTurn).toHaveBeenCalledTimes(1);
    await userEvent.click(within(dock()!).getByRole('button', { name: '重试' }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledTimes(2));
    expect(startTurn.mock.calls.map((call) => call[3])).toEqual([{ idempotencyKey: 'voice-turn-utt_f' }, { idempotencyKey: 'voice-turn-utt_f' }]);
  });

  it('没有麦克风权限 / 服务端未配置语音 / 识别未配置：如实说明；能恢复的给"重新连接"', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
    const denied = client();
    const first = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, denied.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    await waitFor(() => expect(phase()).toBe('error'));
    expect(caption()).toBe('没有麦克风权限。请在浏览器里允许使用麦克风后重新连接。');
    expect(within(dock()!).getByRole('button', { name: '重新连接' })).toBeTruthy();
    first.unmount();

    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
    const unsigned = client({ createVoiceSession: vi.fn().mockRejectedValue(apiError(501, 'CAPABILITY_UNAVAILABLE', 'voice session signing secret is not configured')) });
    const second = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, unsigned.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    await waitFor(() => expect(caption()).toBe('语音还没配置好：服务端尚未接入语音识别。'));
    expect(within(dock()!).queryByRole('button', { name: '重新连接' })).toBeNull(); // 未配置：重连也没用
    await userEvent.click(within(dock()!).getByRole('button', { name: '关闭' }));
    expect(phase()).toBe('off');
    second.unmount();

    const noAsr = client();
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, noAsr.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.receive({ type: 'error', code: 'ASR_NOT_CONFIGURED', message: 'speech recognition is not configured on the server', retryable: false }));
    await waitFor(() => expect(caption()).toBe('语音还没配置好：服务端尚未接入语音识别。'));
  });

  it('断线 / 会话过期 / 识别服务密钥失效 / 暂时识别失败：分别说明；重新连接开新会话，已发出的话不重发', async () => {
    const sdkClient = client();
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdkClient.sdk);
    let socket = await openVoice(sdkClient);
    // 暂时失败（可重试）：只提示再说一遍，会话继续
    act(() => socket.receive({ type: 'error', code: 'ASR_FAILED', message: 'speech service HTTP 429', retryable: true }));
    expect(caption()).toBe('这一句没听清（识别服务暂时出错），请再说一遍。');
    expect(phase()).toBe('listening');
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_once', text: '把开头剪掉', attention: { pointer: { timeRange: null, clipIds: [], frameRegion: null }, evidence: 'NONE', word: null, atSeconds: null, label: null } }));
    await waitFor(() => expect(sdkClient.startTurn).toHaveBeenCalledTimes(1));
    // 网络断了（就绪后非正常关闭）
    act(() => socket.drop(1006));
    await waitFor(() => expect(phase()).toBe('error'));
    expect(caption()).toBe('语音连接断了。已经交给 AI 的话不会重复执行；点"重新连接"继续。');
    await userEvent.click(within(dock()!).getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(sdkClient.createVoiceSession).toHaveBeenCalledTimes(2);
    socket = FakeSocket.instances[1]!;
    act(() => socket.open());
    act(() => socket.receive({ type: 'ready', asr: { providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-transcribe' }, tts: null }));
    await waitFor(() => expect(phase()).toBe('listening'));
    expect(sdkClient.startTurn).toHaveBeenCalledTimes(1); // 重连不重发
    // 会话过期：网关报 SESSION_EXPIRED 并以 4401 关闭
    act(() => socket.receive({ type: 'error', code: 'SESSION_EXPIRED', message: 'the voice session has expired or was closed; reconnect to continue', retryable: false }));
    await waitFor(() => expect(caption()).toBe('语音会话已过期。点"重新连接"开一个新的会话继续。'));
    expect(within(dock()!).getByRole('button', { name: '重新连接' })).toBeTruthy();
    // 服务端识别密钥失效：重连没用，只能找管理员
    await userEvent.click(within(dock()!).getByRole('button', { name: '重新连接' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(3));
    socket = FakeSocket.instances[2]!;
    act(() => socket.open());
    act(() => socket.receive({ type: 'ready', asr: { providerId: 'openai', implementation: 'REAL', model: 'gpt-4o-transcribe' }, tts: null }));
    await waitFor(() => expect(phase()).toBe('listening'));
    act(() => socket.receive({ type: 'error', code: 'ASR_AUTH_FAILED', message: 'speech service HTTP 401', retryable: false }));
    await waitFor(() => expect(caption()).toBe('语音识别服务的密钥无效或已过期，请联系管理员更新配置。'));
    expect(within(dock()!).queryByRole('button', { name: '重新连接' })).toBeNull();
  });
});
