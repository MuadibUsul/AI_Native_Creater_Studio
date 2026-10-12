import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEW_ERROR_REASONS } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * V6-4 批注式审片（HTTP + SDK + 真实数据库；AI 轮次只验证发起与状态，执行由 Worker 负责，见领域集成测试）：
 * - 标记（201）→ 状态（最近一轮 + 批注）；没有时间范围的批注被契约拒绝；
 * - 讨论 = 带 reviewNoteId 的一轮（202，用途 DISCUSS_NOTE，指向取自批注）；批注的讨论可查询；
 * - 没有已确定的批注不能执行（422）；全部执行 202 → 轮次 APPLYING，批注锁定（409）；
 * - VIEWER 可读不可写（403）；跨工作区 404。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'review-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `review-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: '审片测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<void> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  expect((caught as AncsApiError).status).toBe(status);
  if (reason !== undefined) expect((caught as AncsApiError).details['reason']).toBe(reason);
}

const key = () => ({ idempotencyKey: `k-${randomUUID()}` });

describe('V6-4 批注式审片（HTTP + SDK）', () => {
  it('标记 → 讨论发起 → 确定 → 全部执行（202）→ 执行期间批注锁定；VIEWER 只读；跨工作区 404', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `审片-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: '海边一日', aspectRatio: '16:9', locale: 'zh-CN' }, key());

    expect(await owner.review.state(workspace.id, ref.projectId)).toEqual({ projectRevision: expect.any(Number), round: null, notes: [] });
    // 没有时间范围的批注：SDK 发送前按契约拒绝（服务端同一 schema 校验）
    await expect(owner.review.addNote(workspace.id, ref.projectId, { sequenceId: ref.sequenceId, pointer: { timeRange: null, clipIds: [] }, text: '没有位置' }, key())).rejects.toThrow(/time range/);

    const note = await owner.review.addNote(workspace.id, ref.projectId, {
      sequenceId: ref.sequenceId, pointer: { timeRange: { start: '1.2', end: '3.4' }, clipIds: [] }, region: { x: 0.2, y: 0.3, width: 0.4, height: 0.3 }, text: '这里太暗',
    }, key());
    expect(note).toMatchObject({ status: 'OPEN', text: '这里太暗', plan: null, region: { x: 0.2, y: 0.3, width: 0.4, height: 0.3 }, discussion: { turns: 0, lastReply: null, running: false } });
    const state = await owner.review.state(workspace.id, ref.projectId);
    expect(state.round).toMatchObject({ status: 'OPEN', sequenceId: ref.sequenceId, baseRevision: state.projectRevision });
    expect(state.notes.map((item) => item.id)).toEqual([note.id]);

    // 讨论：同一个会话、同一个 AI，指向取自批注
    const talk = await owner.agent.startTurn(workspace.id, ref.sessionId, { message: '怎么改？', reviewNoteId: note.id }, key());
    expect(talk).toMatchObject({ status: 'RUNNING', purpose: 'DISCUSS_NOTE', reviewNoteId: note.id, reviewRoundId: state.round!.id, pointer: { timeRange: { start: '1.2', end: '3.4' } } });
    expect((await owner.review.noteTurns(workspace.id, note.id)).map((turn) => turn.id)).toEqual([talk.id]);
    expect((await owner.review.state(workspace.id, ref.projectId)).notes[0]!.discussion).toEqual({ turns: 1, lastReply: null, running: true });

    const session = await owner.agent.createSession(workspace.id, ref.projectId, { sequenceId: ref.sequenceId, locale: 'en' }, key());
    await expectApiError(owner.review.apply(workspace.id, ref.projectId, { sessionId: session.id }, key()), 422, REVIEW_ERROR_REASONS.NOTHING_TO_APPLY);
    const agreed = await owner.review.updateNote(workspace.id, note.id, { status: 'AGREED', plan: '提亮一档' }, key());
    expect(agreed).toMatchObject({ status: 'AGREED', plan: '提亮一档' });

    const applied = await owner.review.apply(workspace.id, ref.projectId, { sessionId: session.id }, key());
    expect(applied.round).toMatchObject({ status: 'APPLYING', appliedNoteIds: [note.id], applyTurnId: applied.turn.id });
    expect(applied.turn).toMatchObject({ purpose: 'APPLY_REVIEW', message: 'Apply the review notes in one pass (1 note)', reviewRoundId: state.round!.id });
    await expectApiError(owner.review.updateNote(workspace.id, note.id, { status: 'OPEN' }, key()), 409, REVIEW_ERROR_REASONS.ROUND_LOCKED);
    await expectApiError(owner.review.deleteNote(workspace.id, note.id, key()), 409, REVIEW_ERROR_REASONS.ROUND_LOCKED);
    await expectApiError(owner.review.addNote(workspace.id, ref.projectId, { sequenceId: ref.sequenceId, pointer: { timeRange: { start: '0', end: '1' }, clipIds: [] }, text: '再一处' }, key()), 409, REVIEW_ERROR_REASONS.ROUND_LOCKED);
    await expectApiError(owner.review.apply(workspace.id, ref.projectId, { sessionId: session.id }, key()), 409, REVIEW_ERROR_REASONS.ROUND_LOCKED);

    // VIEWER：可读不可写
    const viewerEmail = `review-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.review.state(workspace.id, ref.projectId)).notes).toHaveLength(1);
    await expectApiError(viewer.review.addNote(workspace.id, ref.projectId, { sequenceId: ref.sequenceId, pointer: { timeRange: { start: '0', end: '1' }, clipIds: [] }, text: '看客' }, key()), 403);

    // 跨工作区
    const stranger = await signedIn();
    const other = await stranger.workspaces.create({ name: `别人-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.review.state(other.id, ref.projectId), 404);
    await expectApiError(stranger.review.updateNote(other.id, note.id, { status: 'DISMISSED' }, key()), 404, REVIEW_ERROR_REASONS.NOTE_NOT_FOUND);
  });

  it('删除批注；不改了 / 重新打开', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `审片-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: '城市夜景', aspectRatio: '9:16', locale: 'en' }, key());
    const add = (text: string) => owner.review.addNote(workspace.id, ref.projectId, { sequenceId: ref.sequenceId, pointer: { timeRange: { start: '0', end: '2' }, clipIds: [] }, text }, key());
    const first = await add('Too long');
    const second = await add('Music too loud');
    expect((await owner.review.updateNote(workspace.id, first.id, { status: 'DISMISSED' }, key())).status).toBe('DISMISSED');
    expect((await owner.review.updateNote(workspace.id, first.id, { status: 'OPEN', text: 'Still too long' }, key()))).toMatchObject({ status: 'OPEN', text: 'Still too long' });
    await owner.review.deleteNote(workspace.id, second.id, key());
    expect((await owner.review.state(workspace.id, ref.projectId)).notes.map((item) => item.text)).toEqual(['Still too long']);
    await expectApiError(owner.review.updateNote(workspace.id, second.id, { status: 'OPEN' }, key()), 404, REVIEW_ERROR_REASONS.NOTE_NOT_FOUND);
  });
});
