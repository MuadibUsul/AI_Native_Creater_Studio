import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { REALTIME_CLOSE_CODES, REALTIME_VOICE_PATH, legacyMillisecondsToMediaTime, type RealtimePointerSample, type RealtimeServerMessage, type StreamingAsrEvents, type StreamingSpeechRecognizer, type StreamingSpeechSynthesizer } from '@ancs/contracts';
import { agentSessions, agentTurns, createDb, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { closeVoiceSession, createChannel, createProject, createSequence, createVoiceSession, type DomainDeps } from '@ancs/domain';
import { createDeepgramLiveRecognizer } from './deepgram-live.js';
import { deepgramResult, deepgramUtteranceEnd, startFakeDeepgramLive, type FakeDeepgramStep } from './fake-deepgram-live.js';
import { createRealtimeGateway } from './gateway.js';

/**
 * V6-2 Realtime Gateway（真实 PostgreSQL 语音会话 + 真实 Deepgram 适配器 × 本地同协议假服务；不是真实 Provider 验证）：
 * - 只认 API 签发的短期凭证；浏览器来源白名单；关闭的会话不能再连；
 * - 边说边出的转写（修订号递增）+ 指向随时更新；一句话说完 → utterance；
 * - "这里"绑定说出那一刻的选择（不是开口时、也不是句末）；
 * - 以"但是"结尾先保留（held），后半句来了合成一句；等不到后半句则到时交出；
 * - 没配置流式识别 → 明确报错并关闭；非法消息 → 协议错误关闭；关麦 → 收尾后正常关闭。
 */

const SECRET = 'voice-session-secret-for-tests-0123456789'; // secrets:check-ignore：测试专用假密钥（非真实凭据）
const KEY = 'dg-test-key-0123456789'; // secrets:check-ignore：测试专用假密钥（非真实凭据）
const ORIGIN = 'http://127.0.0.1:3000';
let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db, voiceSessionSecret: SECRET });
const cleanups: (() => Promise<void>)[] = [];

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
afterAll(async () => { await handle.close(); });

async function voiceSession() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V6-2 语音' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '旅行' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '海边一日', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(10_000) } });
  const created = await createVoiceSession(deps(), { workspaceId, projectId: project.id });
  return { workspaceId, projectId: project.id, sequenceId: sequence.id, sessionId: created.session.sessionId, token: created.credential.token };
}

async function gateway(input: { script?: FakeDeepgramStep[]; recognizer?: 'fake' | 'none' | StreamingSpeechRecognizer; synthesizer?: StreamingSpeechSynthesizer; holdMs?: number }) {
  const fake = await startFakeDeepgramLive({ apiKey: KEY, script: () => input.script ?? [] });
  cleanups.push(fake.close);
  const recognizer: StreamingSpeechRecognizer | undefined = input.recognizer === 'none' ? undefined : typeof input.recognizer === 'object' ? input.recognizer : createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: fake.url });
  const instance = createRealtimeGateway({ deps: deps(), ...(recognizer === undefined ? {} : { recognizer }), ...(input.synthesizer === undefined ? {} : { synthesizer: input.synthesizer }), allowedOrigins: [ORIGIN], ...(input.holdMs === undefined ? {} : { holdMs: input.holdMs }) });
  const server: Server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  instance.attach(server, { exclusive: true });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanups.push(async () => { await instance.close(); await new Promise<void>((done) => server.close(() => done())); });
  const address = server.address();
  return { base: `ws://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}`, fake };
}

function connect(base: string, query: { session: string; token: string }, origin = ORIGIN) {
  const socket = new WebSocket(`${base}${REALTIME_VOICE_PATH}?session=${encodeURIComponent(query.session)}&token=${encodeURIComponent(query.token)}`, { headers: { origin } });
  const messages: RealtimeServerMessage[] = [];
  const audioFrames: Buffer[] = [];
  const closed = new Promise<{ code: number }>((done) => socket.on('close', (code) => done({ code })));
  const rejected = new Promise<number>((done) => socket.on('unexpected-response', (_request, response) => { done(response.statusCode ?? 0); response.resume(); }));
  socket.on('error', () => undefined);
  socket.on('message', (data, isBinary) => {
    if (isBinary) audioFrames.push(data as Buffer);
    else messages.push(JSON.parse(data.toString()) as RealtimeServerMessage);
  });
  const opened = new Promise<void>((done) => socket.on('open', () => done()));
  return { socket, messages, audioFrames, closed, rejected, opened, json: (value: unknown) => socket.send(JSON.stringify(value)) };
}

const pointer = (seconds: number, clipIds: string[], label: string): RealtimePointerSample => ({ atSample: Math.round(seconds * 16_000), pointer: { timeRange: null, clipIds, frameRegion: null }, playhead: null, label });
const audio = (seconds: number) => new Uint8Array(Math.round(seconds * 16_000) * 2);
const ofType = <T extends RealtimeServerMessage['type']>(messages: RealtimeServerMessage[], type: T) => messages.filter((message): message is Extract<RealtimeServerMessage, { type: T }> => message.type === type);

describe('V6-2 Realtime Gateway', () => {
  it('边说边出 → "这里"绑定说出那一刻的选择 → 一句话说完交出；未闭合先保留，后半句合成一句；关麦正常关闭', async () => {
    const voice = await voiceSession();
    const { base, fake } = await gateway({ holdMs: 10_000, script: [
      { atSeconds: 0.8, message: deepgramResult({ words: [['把', 0.1, 0.2], ['这里', 0.6, 0.75]], isFinal: false }) },
      { atSeconds: 1.4, message: deepgramResult({ words: [['把', 0.1, 0.2], ['这里', 0.6, 0.75], ['剪短', 0.9, 1.1], ['一点', 1.1, 1.3]], isFinal: true, speechFinal: true }) },
      { atSeconds: 2.6, message: deepgramResult({ words: [['音乐', 2.0, 2.2], ['小一点，', 2.2, 2.4], ['但是', 2.4, 2.55]], isFinal: true, speechFinal: true }) },
      { atSeconds: 3.4, message: deepgramResult({ words: [['人声', 3.0, 3.15], ['别动', 3.15, 3.3]], isFinal: true, speechFinal: true }) },
      { atSeconds: 4.0, message: deepgramUtteranceEnd(3.3) },
    ] });
    const client = connect(base, { session: voice.sessionId, token: voice.token });
    await client.opened;
    client.json({ type: 'start', locale: 'zh-CN', sampleRate: 16_000 });
    await expect.poll(() => ofType(client.messages, 'ready').length).toBe(1);
    expect(ofType(client.messages, 'ready')[0]!.asr).toEqual({ providerId: 'deepgram', implementation: 'REAL', model: 'nova-2/nova-3' });
    // 开口时指着 a，说"这里"时（0.6 s）已换成 b，句末换成 c
    client.json({ type: 'pointer', sample: pointer(0, ['clp_a'], '片段 a') });
    client.json({ type: 'pointer', sample: pointer(0.5, ['clp_b'], '片段 b') });
    client.json({ type: 'pointer', sample: pointer(1.2, ['clp_c'], '片段 c') });
    for (let index = 0; index < 9; index += 1) client.socket.send(audio(0.5));
    await expect.poll(() => ofType(client.messages, 'utterance').length, { timeout: 5000 }).toBe(2);

    const transcripts = ofType(client.messages, 'transcript');
    const first = ofType(client.messages, 'utterance')[0]!;
    expect(transcripts.filter((message) => message.utteranceId === first.utteranceId).map((message) => [message.revision, message.text, message.isFinal]))
      .toEqual([[1, '把这里', false], [2, '把这里剪短一点', false], [3, '把这里剪短一点', true]]);
    expect(first).toMatchObject({ text: '把这里剪短一点', attention: { pointer: { clipIds: ['clp_b'] }, evidence: 'DEICTIC_WORD', word: '这里', atSeconds: 0.6, label: '片段 b' } });
    const held = ofType(client.messages, 'held');
    expect(held.map((message) => message.text)).toEqual(['音乐小一点，但是']);
    const second = ofType(client.messages, 'utterance')[1]!;
    expect(second.utteranceId).toBe(held[0]!.utteranceId);
    expect(second.text).toBe('音乐小一点，但是人声别动');
    expect(second.attention.evidence).toBe('SELECTION_AT_START'); // 没有指代词：开口时（2.0 s）的明确选择
    expect(second.attention.pointer.clipIds).toEqual(['clp_c']);

    client.json({ type: 'end' });
    expect((await client.closed).code).toBe(1000);
    expect(fake.connections[0]).toMatchObject({ closeStream: true });
  });

  it('等不到后半句：到时交出；关麦时还在说的一句也交出', async () => {
    const voice = await voiceSession();
    const { base } = await gateway({ holdMs: 200, script: [
      { atSeconds: 0.6, message: deepgramResult({ words: [['make', 0.1, 0.2], ['it', 0.2, 0.3], ['shorter', 0.3, 0.5], ['but', 0.5, 0.6]], isFinal: true, speechFinal: true }) },
      { atSeconds: 1.6, message: deepgramResult({ words: [['louder', 1.2, 1.5]], isFinal: true }) },
    ] });
    const client = connect(base, { session: voice.sessionId, token: voice.token });
    await client.opened;
    client.json({ type: 'start', locale: 'en', sampleRate: 16_000 });
    await expect.poll(() => ofType(client.messages, 'ready').length).toBe(1);
    client.socket.send(audio(1));
    await expect.poll(() => ofType(client.messages, 'utterance').length, { timeout: 3000 }).toBe(1);
    expect(ofType(client.messages, 'held')[0]!.text).toBe('make it shorter but');
    expect(ofType(client.messages, 'utterance')[0]!).toMatchObject({ text: 'make it shorter but', attention: { evidence: 'NONE' } });
    client.socket.send(audio(1));
    await expect.poll(() => ofType(client.messages, 'transcript').some((message) => message.text === 'louder')).toBe(true);
    client.json({ type: 'end' });
    expect((await client.closed).code).toBe(1000);
    expect(ofType(client.messages, 'utterance').map((message) => message.text)).toEqual(['make it shorter but', 'louder']);
  });

  it('凭证错误 401；来源不在白名单 403；会话已关闭 409；没配置识别 → 报错并关闭；非法消息 → 协议错误', async () => {
    const voice = await voiceSession();
    const configured = await gateway({});
    const forged = connect(configured.base, { session: voice.sessionId, token: 'x'.repeat(43) });
    expect(await forged.rejected).toBe(401);
    const foreign = connect(configured.base, { session: voice.sessionId, token: voice.token }, 'https://evil.example');
    expect(await foreign.rejected).toBe(403);

    const garbage = connect(configured.base, { session: voice.sessionId, token: voice.token });
    await garbage.opened;
    garbage.socket.send('{"type":"start","locale":"fr"}');
    expect((await garbage.closed).code).toBe(REALTIME_CLOSE_CODES.PROTOCOL_ERROR);

    const unconfigured = await gateway({ recognizer: 'none' });
    const client = connect(unconfigured.base, { session: voice.sessionId, token: voice.token });
    await client.opened;
    client.json({ type: 'start', locale: 'zh-CN', sampleRate: 16_000 });
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.ASR_UNAVAILABLE);
    expect(client.messages).toEqual([{ type: 'error', code: 'ASR_NOT_CONFIGURED', message: 'speech recognition is not configured on the server', retryable: false }]);

    await closeVoiceSession(deps(), { workspaceId: voice.workspaceId, projectId: voice.projectId, sessionId: voice.sessionId });
    const late = connect(configured.base, { session: voice.sessionId, token: voice.token });
    expect(await late.rejected).toBe(409);
  });

  it('AI 语音回应（Issue #9）：只按 id 念本作品这一轮的回应；边合成边下发；用户开口立即中止；stop-speaking 中止；别的作品的轮次不念', async () => {
    const voice = await voiceSession();
    const other = await voiceSession();
    const turn = async (scope: { workspaceId: string; projectId: string; sequenceId: string }, reply: string) => {
      const sessionId = `ags_${randomUUID()}`;
      await handle.db.insert(agentSessions).values({ id: sessionId, workspaceId: scope.workspaceId, projectId: scope.projectId, sequenceId: scope.sequenceId, locale: 'zh-CN' });
      const id = `agt_${randomUUID()}`;
      await handle.db.insert(agentTurns).values({ id, sessionId, workspaceId: scope.workspaceId, projectId: scope.projectId, status: 'COMPLETED', message: '剪短一点', pointer: {}, baseRevision: 1, reply, usage: {} });
      return id;
    };
    const mine = await turn(voice, '把这一段剪短了 1 秒。后面的内容跟着前移。');
    const foreign = await turn(other, '别的作品的回应');
    // 合成替身：每 20 ms 下发一块（奇数长度的块由真实适配器负责拼齐，这里直接给偶数块），直到中止
    const spoken: { text: string; voiceId: string; stoppedAfter: number | null }[] = [];
    const synthesizer: StreamingSpeechSynthesizer = {
      providerId: 'test-tts', implementation: 'SCRIPTED', model: 'scripted', sampleRate: 24_000,
      voices: [{ id: 'coral', name: 'Coral' }, { id: 'onyx', name: 'Onyx' }],
      async synthesize(input, onChunk) {
        const record = { text: input.text, voiceId: input.voiceId, stoppedAfter: null as number | null };
        spoken.push(record);
        for (let index = 0; index < 50; index += 1) {
          if (input.signal.aborted) { record.stoppedAfter = index; throw new Error('aborted'); }
          onChunk(new Uint8Array(960));
          await new Promise((done) => setTimeout(done, 20));
        }
        return { characters: input.text.length };
      },
    };
    // 识别替身：收到第 2 块音频时报"开口"
    let events: StreamingAsrEvents | null = null;
    let chunks = 0;
    const recognizer: StreamingSpeechRecognizer = {
      providerId: 'test-asr', implementation: 'SCRIPTED', model: null,
      open: async (_options, handlers) => {
        events = handlers;
        return { sendAudio: () => { chunks += 1; if (chunks === 2) events?.onSpeechStart?.(1.25); }, finish: () => events?.onClose(), close: () => undefined };
      },
    };
    const { base } = await gateway({ recognizer, synthesizer });
    const client = connect(base, { session: voice.sessionId, token: voice.token });
    await client.opened;
    client.json({ type: 'start', locale: 'zh-CN', sampleRate: 16_000 });
    await expect.poll(() => ofType(client.messages, 'ready').length).toBe(1);
    expect(ofType(client.messages, 'ready')[0]!.tts).toEqual({ providerId: 'test-tts', implementation: 'SCRIPTED', model: 'scripted', voices: [{ id: 'coral', name: 'Coral' }, { id: 'onyx', name: 'Onyx' }] });

    // 1) 念本作品这一轮：选了 onyx；收到几块后用户开口 → 立即中止
    client.json({ type: 'speak', turnId: mine, voiceId: 'onyx' });
    await expect.poll(() => client.audioFrames.length, { timeout: 3000 }).toBeGreaterThanOrEqual(3);
    expect(ofType(client.messages, 'reply-start')[0]).toEqual({ type: 'reply-start', turnId: mine, sampleRate: 24_000, voiceId: 'onyx' });
    client.socket.send(audio(0.1));
    client.socket.send(audio(0.1));
    await expect.poll(() => ofType(client.messages, 'reply-end').length, { timeout: 3000 }).toBe(1);
    expect(ofType(client.messages, 'speech-start')).toEqual([{ type: 'speech-start', atSeconds: 1.25 }]);
    expect(ofType(client.messages, 'reply-end')[0]).toEqual({ type: 'reply-end', turnId: mine, reason: 'stopped', message: null });
    expect(spoken[0]).toMatchObject({ text: '把这一段剪短了 1 秒。后面的内容跟着前移。', voiceId: 'onyx' });
    expect(spoken[0]!.stoppedAfter).not.toBeNull();
    const framesAtStop = client.audioFrames.length;
    await new Promise((done) => setTimeout(done, 120));
    expect(client.audioFrames.length).toBe(framesAtStop); // 中止后不再下发

    // 2) 再念一次（未知声音退回第一个可用声音）→ stop-speaking 中止
    client.json({ type: 'speak', turnId: mine, voiceId: 'nonexistent' });
    await expect.poll(() => ofType(client.messages, 'reply-start').length, { timeout: 3000 }).toBe(2);
    expect(ofType(client.messages, 'reply-start')[1]!.voiceId).toBe('coral');
    client.json({ type: 'stop-speaking' });
    await expect.poll(() => ofType(client.messages, 'reply-end').length, { timeout: 3000 }).toBe(2);
    expect(ofType(client.messages, 'reply-end')[1]!.reason).toBe('stopped');

    // 3) 别的作品的轮次：不念、不合成
    client.json({ type: 'speak', turnId: foreign, voiceId: null });
    await expect.poll(() => ofType(client.messages, 'reply-end').length, { timeout: 3000 }).toBe(3);
    expect(ofType(client.messages, 'reply-end')[2]).toEqual({ type: 'reply-end', turnId: foreign, reason: 'failed', message: 'no reply to read for this turn' });
    expect(spoken).toHaveLength(2);

    client.json({ type: 'end' });
    expect((await client.closed).code).toBe(1000);
  });

  it('会话门（Issue #9）：连接期间会话失效（过期/撤销/关闭）→ 这一句不交给 AI，报 SESSION_EXPIRED 并以 4401 关闭', async () => {
    const voice = await voiceSession();
    let events: StreamingAsrEvents | null = null;
    const recognizer: StreamingSpeechRecognizer = {
      providerId: 'test-asr', implementation: 'SCRIPTED', model: null,
      open: async (_options, handlers) => { events = handlers; return { sendAudio: () => undefined, finish: () => events?.onClose(), close: () => undefined }; },
    };
    const { base } = await gateway({ recognizer });
    const client = connect(base, { session: voice.sessionId, token: voice.token });
    await client.opened;
    client.json({ type: 'start', locale: 'zh-CN', sampleRate: 16_000 });
    await expect.poll(() => ofType(client.messages, 'ready').length).toBe(1);
    const say = (text: string, at: number) => {
      events!.onResult({ start: at, duration: 0.5, text, words: [{ text, start: at, end: at + 0.5 }], isFinal: true, speechFinal: true });
    };
    say('第一句。', 0.2);
    await expect.poll(() => ofType(client.messages, 'utterance').length).toBe(1);
    // 会话在连接期间失效（到期 / 被撤销 / 在别处关闭走同一道门）
    await closeVoiceSession(deps(), { workspaceId: voice.workspaceId, projectId: voice.projectId, sessionId: voice.sessionId });
    say('第二句。', 1.2);
    expect((await client.closed).code).toBe(REALTIME_CLOSE_CODES.CREDENTIAL_INVALID);
    expect(ofType(client.messages, 'utterance').map((message) => message.text)).toEqual(['第一句。']);
    expect(ofType(client.messages, 'error')).toEqual([{ type: 'error', code: 'SESSION_EXPIRED', message: 'the voice session has expired or was closed; reconnect to continue', retryable: false }]);
  });
});
