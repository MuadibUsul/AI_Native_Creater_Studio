import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  type MediaRange,
  type VoiceEventEnvelope,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, editEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createProject, createSequence, createTrack } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N05-01 验收（HTTP + SDK + 真实数据库）：实时会话与短期凭证适配 + 流式协议状态机
 * - 会话只返回**短期凭证**：响应里没有 Provider Key/Secret（长期 Key 永不下发）；
 * - 无权限用户不能创建会话；过期/撤销会话不可继续执行项目操作；
 * - partial 转写只写会话草稿（**工程零变更**：不写 edit_events、不动 revision）；
 * - 代际隔离：旧代际事件被拒（晚到结果不得抢回新画面）；
 * - seal 把已修订转写封存为 IntentRevision（未解析指代不可封存）。
 */

const PASSWORD = 'password-1234';
const VOICE_SECRET = 'voice-session-test-secret-0123456789abcdef'; // secrets:check-ignore：测试专用假密钥（非真实凭据）

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error('无法连接测试数据库，请先运行：docker compose -f infra/docker-compose.dev.yml up -d', { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'voice-session-auth-secret-0123456789', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    voice: { sessionSecret: VOICE_SECRET },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });

async function newSignedInClient(): Promise<AncsClient> {
  const email = `voice-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '语音会话测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `语音-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '语音', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id };
}

/** 建一个最小规范锚点（封存 IntentRevision 必须绑定锚点）。 */
async function makeAnchor(client: AncsClient, fixture: Fixture): Promise<string> {
  const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
    anchor: {
      anchorId: `anch_${randomUUID()}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
      revision: 0,
      geometries: [{
        kind: 'RECT', role: 'TARGET', boundarySide: null, rawSamplesRef: null, stroke: null, geometryRevision: 1,
        coordinateSpaceRef: { kind: 'PREVIEW_FRAME', previewRevision: 1, viewport: { width: 1920, height: 1080 }, sequenceTime: mt(1_000), sourcePts: null },
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      }],
      orderedTargetRefs: [{ targetRef: 'pxr_1', targetKind: 'PIXEL_REGION', label: 'A', assetVersionId: null }],
      temporalSelection: { kind: 'RANGES', ranges: [range(1_000, 3_000)] },
      trackScope: { kind: 'ALL' }, propertyScope: [], regionMode: 'SCREEN_FIXED', timeBindingPolicy: 'SEQUENCE_FIXED',
      trackingRef: null, resolutionStatus: 'RESOLVED', evidenceRefs: [], remapHistory: [], fingerprintInput: 'placeholder',
      utteranceSequenceTime: mt(1_000),
    },
  });
  return saved.anchor.anchorId;
}

const envelopeOf = (sessionId: string, generation: number, clockEpoch: number, seq: number, utteranceId: string, text: string, kind: VoiceEventEnvelope['kind'] = 'TRANSCRIPT_PARTIAL'): VoiceEventEnvelope => ({
  eventId: `evt_${randomUUID()}`,
  kind,
  sessionId,
  clockEpoch,
  seq,
  generation,
  utteranceId,
  requestId: `req_${randomUUID()}`,
  intentRevision: null,
  producer: 'CLIENT',
  occurredAt: new Date().toISOString(),
  payloadSchemaVersion: '1.0',
  payload: { text, isFinal: kind === 'TRANSCRIPT_REVISED' },
});

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N05-01 实时语音会话（HTTP + SDK）', () => {
  it('创建会话：短期凭证 + 显式能力，响应不含任何 Provider Key/Secret；无权限用户不能创建', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);

    const anchorId = await makeAnchor(client, fixture);
    const created = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { selectionAnchorId: anchorId });
    expect(created.session.status).toBe('OPEN');
    expect(created.session.capabilities.transport).toBe('SERVER_RELAY');
    expect(created.credential).toMatchObject({ kind: 'EPHEMERAL_SESSION', scopes: ['voice:stream', 'voice:tools'] });
    expect(created.credential.token.length).toBeGreaterThan(20);
    // 凭证只在创建时返回一次：读取会话不再回带任何凭证材料
    const reread = await client.projects.voiceSession(fixture.workspaceId, fixture.projectId, created.session.sessionId);
    expect(JSON.stringify(reread)).not.toContain(created.credential.token);
    // 短期凭证有 TTL（不是长期 Key）
    const ttlMs = new Date(created.session.expiresAt).getTime() - new Date(created.session.issuedAt).getTime();
    expect(ttlMs).toBeGreaterThan(0);
    expect(ttlMs).toBeLessThanOrEqual(15 * 60 * 1_000);
    // 响应体里不得出现任何 Provider Key/Secret 形态的字段或值
    const serialized = JSON.stringify(created);
    expect(serialized).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
    expect(serialized).not.toMatch(/"(apiKey|api_key|providerKey|secret|clientSecret)"\s*:/i);
    // 未知传输方式由契约在发请求前拒绝（不得把未知能力当成支持）
    const unknown = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { preferredTransport: 'NONEXISTENT' as never })
      .then(() => null, (error: unknown) => error);
    expect((unknown as Error).name).toBe('ZodError');

    // 无权限用户（非成员）不能创建：跨租户 → 404（抗枚举）
    const stranger = await newSignedInClient();
    await expectApiFailure(
      stranger.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, {}),
      { status: 404 },
    );
  });

  it('partial 只写会话草稿：工程 revision 与 edit_events 全程不变；封存才产出 IntentRevision', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const anchorId = await makeAnchor(client, fixture);
    const created = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { selectionAnchorId: anchorId });
    const session = created.session;
    const revisionBefore = (await client.projects.state(fixture.projectId)).document.projectRevision;
    const eventsBefore = await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId));

    const utteranceId = `utt_${randomUUID()}`;
    const first = await client.projects.appendVoiceEvent(
      fixture.workspaceId, fixture.projectId, session.sessionId,
      envelopeOf(session.sessionId, session.generation, session.clockEpoch, 1, utteranceId, '把这条'),
    );
    expect(first.projectUntouched).toBe(true);
    expect(first.transcript).toMatchObject({ utteranceId, revision: 1, text: '把这条' });

    // 改口：产生新的转写修订并取代旧修订（同一流内序号前进）
    const second = await client.projects.appendVoiceEvent(
      fixture.workspaceId, fixture.projectId, session.sessionId,
      envelopeOf(session.sessionId, session.generation, session.clockEpoch, 2, utteranceId, '把这条线加粗', 'TRANSCRIPT_REVISED'),
    );
    expect(second.transcript).toMatchObject({ revision: 2, supersedesRevision: 1, text: '把这条线加粗' });

    // 工程零变更（partial/revision 不落工程）
    expect((await client.projects.state(fixture.projectId)).document.projectRevision).toBe(revisionBefore);
    expect(await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).toHaveLength(eventsBefore.length);

    // 旧修订已失效 → 不可封存
    await expectApiFailure(
      client.projects.sealVoiceUtterance(fixture.workspaceId, fixture.projectId, session.sessionId, {
        utteranceId, transcriptRevision: 1, interpretedAction: 'set_clip_opacity',
        targetBindings: [{ reference: '这条线', role: 'TARGET', resolvedTargetRefs: ['clp_x'], evidenceRefs: ['anch_evidence'] }],
        explicitConstraints: [], assumptions: [],
      }),
      { status: 409, reason: 'VOICE_UTTERANCE_NOT_SEALABLE' },
    );

    // 未解析指代不可封存（未完整语义不得进入正式编辑）
    await expectApiFailure(
      client.projects.sealVoiceUtterance(fixture.workspaceId, fixture.projectId, session.sessionId, {
        utteranceId, transcriptRevision: 2, interpretedAction: 'set_clip_opacity',
        targetBindings: [{ reference: '这条线', role: 'TARGET', resolvedTargetRefs: [], evidenceRefs: ['anch_evidence'] }],
        explicitConstraints: [], assumptions: [],
      }),
      { status: 422 },
    );

    const sealed = await client.projects.sealVoiceUtterance(fixture.workspaceId, fixture.projectId, session.sessionId, {
      utteranceId, transcriptRevision: 2, interpretedAction: 'set_clip_opacity',
      targetBindings: [{ reference: '这条线', role: 'TARGET', resolvedTargetRefs: ['clp_x'], evidenceRefs: ['anch_evidence'] }],
      explicitConstraints: [], assumptions: [],
    });
    expect(sealed.intentRevision).toMatchObject({ utteranceId, revision: 1, status: 'SEALED', transcriptRevision: 2, interpretedAction: 'set_clip_opacity' });
    expect(sealed.projectUntouched).toBe(true);
    // 封存也不改工程（正式变更必须走统一编辑协议）
    expect((await client.projects.state(fixture.projectId)).document.projectRevision).toBe(revisionBefore);
  });

  it('代际隔离与状态门：旧代际/序号倒退/过期/撤销的会话都不能继续执行项目操作', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const anchorId = await makeAnchor(client, fixture);
    const session = (await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { selectionAnchorId: anchorId })).session;

    // 旧代际（模拟重连后到来的旧连接事件）→ 409
    await expectApiFailure(
      client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, session.sessionId, {
        ...envelopeOf(session.sessionId, session.generation + 1, session.clockEpoch, 1, 'utt_old', '旧连接的话'),
      }),
      { status: 409, reason: 'VOICE_STALE_GENERATION' },
    );
    // 序号倒退（晚到/重复）→ 422
    await client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, session.sessionId,
      envelopeOf(session.sessionId, session.generation, session.clockEpoch, 5, 'utt_a', '第一句'));
    await expectApiFailure(
      client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, session.sessionId,
        envelopeOf(session.sessionId, session.generation, session.clockEpoch, 3, 'utt_a', '迟到事件')),
      { status: 422, reason: 'VOICE_STALE_GENERATION' },
    );

    // 撤销 → 事件与封存都被拒（撤销会话不可继续执行项目操作）
    await client.projects.revokeVoiceSession(fixture.workspaceId, fixture.projectId, session.sessionId);
    await expectApiFailure(
      client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, session.sessionId,
        envelopeOf(session.sessionId, session.generation, session.clockEpoch, 9, 'utt_b', '撤销后的话')),
      { status: 409, reason: 'VOICE_SESSION_REVOKED' },
    );
    await expectApiFailure(
      client.projects.sealVoiceUtterance(fixture.workspaceId, fixture.projectId, session.sessionId, {
        utteranceId: 'utt_a', transcriptRevision: 1, interpretedAction: 'trim_clip',
        targetBindings: [{ reference: '这个', role: 'TARGET', resolvedTargetRefs: ['clp_x'], evidenceRefs: ['anch_evidence'] }],
        explicitConstraints: [], assumptions: [],
      }),
      { status: 409, reason: 'VOICE_SESSION_REVOKED' },
    );

    // 结束采集幂等：重复 close 返回同一状态
    const fresh = (await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, {})).session;
    const closedOnce = await client.projects.closeVoiceSession(fixture.workspaceId, fixture.projectId, fresh.sessionId);
    const closedTwice = await client.projects.closeVoiceSession(fixture.workspaceId, fixture.projectId, fresh.sessionId);
    expect(closedOnce.status).toBe('CLOSED');
    expect(closedTwice.status).toBe('CLOSED');
    await expectApiFailure(
      client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, fresh.sessionId,
        envelopeOf(fresh.sessionId, fresh.generation, fresh.clockEpoch, 1, 'utt_c', '关闭后的话')),
      { status: 409, reason: 'VOICE_SESSION_NOT_OPEN' },
    );
  });

  it('过期会话不可继续：TTL 到期后读取标记 EXPIRED 且事件/封存被拒', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const anchorId = await makeAnchor(client, fixture);
    const session = (await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { selectionAnchorId: anchorId })).session;
    // 直接改库把过期时间置到过去（等价于 TTL 到期）
    await handle.db.execute(`update voice_sessions set expires_at = now() - interval '1 minute' where id = '${session.sessionId}'`);

    const read = await client.projects.voiceSession(fixture.workspaceId, fixture.projectId, session.sessionId);
    expect(read.status).toBe('EXPIRED');
    await expectApiFailure(
      client.projects.appendVoiceEvent(fixture.workspaceId, fixture.projectId, session.sessionId,
        envelopeOf(session.sessionId, session.generation, session.clockEpoch, 1, 'utt_exp', '过期后的话')),
      { status: 409, reason: 'VOICE_SESSION_EXPIRED' },
    );
    await expectApiFailure(
      client.projects.sealVoiceUtterance(fixture.workspaceId, fixture.projectId, session.sessionId, {
        utteranceId: 'utt_exp', transcriptRevision: 1, interpretedAction: 'trim_clip',
        targetBindings: [{ reference: '这个', role: 'TARGET', resolvedTargetRefs: ['clp_x'], evidenceRefs: ['anch_evidence'] }],
        explicitConstraints: [], assumptions: [],
      }),
      { status: 409, reason: 'VOICE_SESSION_EXPIRED' },
    );
  });

  it('V5-M3 短期凭证真正被校验：只有签发它的会话可用，伪造/串用 401，撤销 409；凭证不能用于其他端点', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const created = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, {});
    const other = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, {});
    const { session, credential } = created;
    // 实时通道不带用户 Cookie：只凭短期凭证
    const stream = (sessionId: string, token: string | null, seq: number) => fetch(`${baseUrl}/api/v1/voice-sessions/${sessionId}/stream-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { 'x-voice-session-token': token }) },
      body: JSON.stringify({ event: envelopeOf(sessionId, session.generation, session.clockEpoch, seq, 'utt_stream', `第${String(seq)}段`) }),
    });
    const reasonOf = async (response: Response) => ((await response.json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason;

    const accepted = await stream(session.sessionId, credential.token, 1);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ accepted: true, projectUntouched: true, transcript: { utteranceId: 'utt_stream', text: '第1段' } });

    for (const [sessionId, token] of [
      [session.sessionId, null],
      [session.sessionId, `${credential.token.slice(0, -2)}xx`],
      [other.session.sessionId, credential.token], // A 的凭证用于 B
      [`vsess_${randomUUID()}`, credential.token],
    ] as const) {
      const rejected = await stream(sessionId, token, 2);
      expect(rejected.status).toBe(401);
      expect(await reasonOf(rejected)).toBe('VOICE_CREDENTIAL_INVALID');
    }

    // 凭证不能代替用户身份：封存仍要求登录与 project:write
    const sealWithToken = await fetch(`${baseUrl}/api/v1/workspaces/${fixture.workspaceId}/projects/${fixture.projectId}/voice-sessions/${session.sessionId}/seal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-voice-session-token': credential.token },
      body: JSON.stringify({ utteranceId: 'utt_stream', transcriptRevision: 1, interpretedAction: 'trim_clip', targetBindings: [], explicitConstraints: [], assumptions: [] }),
    });
    expect(sealWithToken.status).toBe(401);

    await client.projects.revokeVoiceSession(fixture.workspaceId, fixture.projectId, session.sessionId);
    const revoked = await stream(session.sessionId, credential.token, 3);
    expect(revoked.status).toBe(409);
    expect(await reasonOf(revoked)).toBe('VOICE_SESSION_REVOKED');
  });

  it('V5-M3 凭证到期即失效：有效签名但 TTL 已过 → 409 VOICE_SESSION_EXPIRED', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const { session, credential } = await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, {});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(Date.parse(session.expiresAt) + 1_000));
      const response = await fetch(`${baseUrl}/api/v1/voice-sessions/${session.sessionId}/stream-events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-voice-session-token': credential.token },
        body: JSON.stringify({ event: envelopeOf(session.sessionId, session.generation, session.clockEpoch, 1, 'utt_late', '过期') }),
      });
      expect(response.status).toBe(409);
      expect(((await response.json()) as { error?: { details?: { reason?: string } } }).error?.details?.reason).toBe('VOICE_SESSION_EXPIRED');
    } finally {
      vi.useRealTimers();
    }
  });

  it('能力协商按真实适配器能力：浏览器回退路径明确不承诺服务端 VAD/逐词时间戳/工具', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const fallback = (await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { preferredTransport: 'BROWSER_SPEECH_FALLBACK' })).session;
    expect(fallback.capabilities.transport).toBe('BROWSER_SPEECH_FALLBACK');
    expect(fallback.capabilities.supported).toContain('STREAMING_PARTIALS');
    expect(fallback.capabilities.unsupported).toEqual(expect.arrayContaining(['SERVER_VAD', 'WORD_TIMESTAMPS', 'SERVER_SIDE_TOOLS', 'BARGE_IN']));

    const sideband = (await client.projects.createVoiceSession(fixture.workspaceId, fixture.projectId, { preferredTransport: 'PROVIDER_SIDEBAND' })).session;
    expect(sideband.capabilities.supported).toContain('SERVER_VAD');
    expect(sideband.capabilities.unsupported).toContain('WORD_TIMESTAMPS');
  });
});
