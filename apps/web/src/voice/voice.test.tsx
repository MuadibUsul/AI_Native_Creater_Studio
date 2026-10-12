import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiError, mockClient, renderWithClient } from '@/test-utils';
import { StudioRoom } from '@/studio/StudioRoom';

/**
 * V6-2 实时语音（浏览器侧，组件层）：用假麦克风、假 AudioWorklet 与假 WebSocket 固定线协议——
 * 开麦 → 申请语音会话（短期凭证）→ 连网关并发 start → ready 后开始送音频（音频时钟 = 采样数）；
 * 选择变化带时钟发指向样本；边说边出的转写、理解的指向；一句话说完 → 带绑定指向发出一轮；
 * 开口即停止朗读；未配置 / 没有麦克风权限的说明。真实浏览器 + 网关 + 识别协议的证据见 scripts/voice-browser-check.mjs。
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
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.instances.push(this); }
  send(data: string | ArrayBuffer) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  open() { this.readyState = 1; this.onopen?.(); }
  receive(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  json() { return this.sent.filter((item): item is string => typeof item === 'string').map((item) => JSON.parse(item) as Record<string, unknown>); }
}

let workletPort: { onmessage: ((event: { data: { pcm: ArrayBuffer; level: number } }) => void) | null };
const speak = vi.fn();
const cancelSpeech = vi.fn();

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
  speak.mockReset();
  cancelSpeech.mockReset();
  vi.stubGlobal('WebSocket', FakeSocket);
  workletPort = { onmessage: null };
  vi.stubGlobal('AudioWorkletNode', class { port = workletPort; disconnect() {} });
  vi.stubGlobal('AudioContext', class {
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createMediaStreamSource() { return { connect: () => undefined }; }
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

function client(overrides: { createVoiceSession?: ReturnType<typeof vi.fn> } = {}) {
  const startTurn = vi.fn().mockResolvedValue(turn());
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
    }) },
    projects: {
      state: vi.fn().mockResolvedValue({ document: { projectRevision: 5, composition: {
        sequences: [{ id: 'seq_1', duration: mt(180), frameRate: { num: 30, den: 1 } }],
        tracks: [{ id: 'trk_v', sequenceId: 'seq_1', kind: 'VIDEO', position: 0 }],
        clips: [clip('clp_g', 'av_g', 0, 90), clip('clp_l', 'av_l', 90, 180)],
      } } }),
      createVoiceSession,
    },
    agent: { listTurns, startTurn, createSession: vi.fn(), cancelTurn: vi.fn(), strategies: vi.fn().mockResolvedValue([]) },
    previews: { request: vi.fn().mockResolvedValue({ id: 'pvw_1', status: 'RENDERING', proposalId: null, playbackUrl: null, segments: { total: 1, reused: 0, rendered: 0 }, captions: [], clips: [] }), get: vi.fn().mockResolvedValue({ id: 'pvw_1', status: 'RENDERING', proposalId: null, playbackUrl: null, segments: { total: 1, reused: 0, rendered: 0 }, captions: [], clips: [] }) },
  });
  return { sdk, startTurn, listTurns, createVoiceSession };
}

describe('V6-2 实时语音（浏览器侧）', () => {
  it('开麦 → 短期凭证连网关 → 送音频与指向样本 → 边说边出 → 一句话说完带着绑定的指向发出；开口停止朗读', async () => {
    const { sdk, startTurn, createVoiceSession } = client();
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, sdk);
    // 先在时间带上指着 lake.mp4
    const lake = await screen.findByRole('button', { name: /^片段 lake\.mp4/ });
    lake.focus();
    await userEvent.keyboard('{Enter}');
    await userEvent.click(screen.getByRole('button', { name: '开始语音' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    expect(createVoiceSession).toHaveBeenCalledWith('ws_1', 'prj_1', {}, expect.objectContaining({ idempotencyKey: expect.any(String) }));
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('ws://localhost:3000/realtime/v1/voice?session=vsess_1&token=short-lived-token-0123456789');
    act(() => socket.open());
    expect(socket.json()[0]).toEqual({ type: 'start', locale: 'zh-CN', sampleRate: 16000 });
    act(() => socket.receive({ type: 'ready', asr: { providerId: 'deepgram', implementation: 'REAL', model: 'nova-2/nova-3' } }));
    expect(await screen.findByText('正在听，边看边说')).toBeTruthy();
    // 音频时钟：送出 320 个采样后，指向样本的时钟随之前进
    await waitFor(() => expect(socket.json().some((message) => message['type'] === 'pointer')).toBe(true));
    expect(socket.json().find((message) => message['type'] === 'pointer')).toMatchObject({ sample: { atSample: 0, pointer: { timeRange: null, clipIds: ['clp_l'] }, label: '片段「lake.mp4」' } });
    act(() => workletPort.onmessage?.({ data: { pcm: new Int16Array(320).buffer, level: 0.1 } }));
    expect(socket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(1);

    act(() => socket.receive({ type: 'transcript', utteranceId: 'utt_1', revision: 1, text: '把这里', isFinal: false }));
    act(() => socket.receive({ type: 'attention', utteranceId: 'utt_1', attention: { pointer: { timeRange: null, clipIds: ['clp_l'] }, evidence: 'DEICTIC_WORD', word: '这里', atSeconds: 0.6, label: null } }));
    expect(cancelSpeech).toHaveBeenCalled(); // 开口即打断朗读
    expect(screen.getByText('把这里')).toBeTruthy();
    expect(screen.getByText('指的是：片段「lake.mp4」（说"这里"时）')).toBeTruthy();
    act(() => socket.receive({ type: 'utterance', utteranceId: 'utt_1', text: '把这里剪短一点', attention: { pointer: { timeRange: null, clipIds: ['clp_l'] }, evidence: 'DEICTIC_WORD', word: '这里', atSeconds: 0.6, label: null } }));
    await waitFor(() => expect(startTurn).toHaveBeenCalledWith('ws_1', 'ses_1', { message: '把这里剪短一点', pointer: { timeRange: null, clipIds: ['clp_l'] } }, expect.anything()));

    await userEvent.click(screen.getByRole('button', { name: '结束语音' }));
    expect(socket.json().at(-1)).toEqual({ type: 'end' });
  });

  it('没有麦克风权限 / 服务端未配置语音 / 识别未配置：如实说明', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockRejectedValue(new Error('NotAllowedError')) } });
    const denied = client();
    const first = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, denied.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    expect(await screen.findByText('没有麦克风权限。请在浏览器里允许使用麦克风。')).toBeTruthy();
    first.unmount();

    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
    const unsigned = client({ createVoiceSession: vi.fn().mockRejectedValue(apiError(501, 'CAPABILITY_UNAVAILABLE', 'voice session signing secret is not configured')) });
    const second = renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, unsigned.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    expect(await screen.findByText('语音还没配置好：服务端尚未接入语音识别。')).toBeTruthy();
    second.unmount();

    const noAsr = client();
    renderWithClient(<StudioRoom workspaceId="ws_1" projectId="prj_1" />, noAsr.sdk);
    await userEvent.click(await screen.findByRole('button', { name: '开始语音' }));
    await waitFor(() => expect(FakeSocket.instances).toHaveLength(1));
    const socket = FakeSocket.instances[0]!;
    act(() => socket.open());
    act(() => socket.receive({ type: 'error', code: 'ASR_NOT_CONFIGURED', message: 'speech recognition is not configured on the server', retryable: false }));
    expect(await screen.findByText('语音还没配置好：服务端尚未接入语音识别。')).toBeTruthy();
  });
});
