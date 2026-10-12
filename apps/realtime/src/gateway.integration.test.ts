import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { REALTIME_CLOSE_CODES, REALTIME_VOICE_PATH, legacyMillisecondsToMediaTime, type RealtimePointerSample, type RealtimeServerMessage, type StreamingSpeechRecognizer } from '@ancs/contracts';
import { createDb, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
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
  await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(10_000) } });
  const created = await createVoiceSession(deps(), { workspaceId, projectId: project.id });
  return { workspaceId, projectId: project.id, sessionId: created.session.sessionId, token: created.credential.token };
}

async function gateway(input: { script?: FakeDeepgramStep[]; recognizer?: 'fake' | 'none'; holdMs?: number }) {
  const fake = await startFakeDeepgramLive({ apiKey: KEY, script: () => input.script ?? [] });
  cleanups.push(fake.close);
  const recognizer: StreamingSpeechRecognizer | undefined = input.recognizer === 'none' ? undefined : createDeepgramLiveRecognizer({ apiKey: KEY, baseUrl: fake.url });
  const instance = createRealtimeGateway({ deps: deps(), ...(recognizer === undefined ? {} : { recognizer }), allowedOrigins: [ORIGIN], ...(input.holdMs === undefined ? {} : { holdMs: input.holdMs }) });
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
  const closed = new Promise<{ code: number }>((done) => socket.on('close', (code) => done({ code })));
  const rejected = new Promise<number>((done) => socket.on('unexpected-response', (_request, response) => { done(response.statusCode ?? 0); response.resume(); }));
  socket.on('error', () => undefined);
  socket.on('message', (data) => messages.push(JSON.parse(data.toString()) as RealtimeServerMessage));
  const opened = new Promise<void>((done) => socket.on('open', () => done()));
  return { socket, messages, closed, rejected, opened, json: (value: unknown) => socket.send(JSON.stringify(value)) };
}

const pointer = (seconds: number, clipIds: string[], label: string): RealtimePointerSample => ({ atSample: Math.round(seconds * 16_000), pointer: { timeRange: null, clipIds }, playhead: null, label });
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
});
