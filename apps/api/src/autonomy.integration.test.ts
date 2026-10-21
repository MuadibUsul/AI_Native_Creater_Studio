import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, outboxEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * V6-9 自主制作授权（裁决 0020，AP-03；HTTP + SDK + 真实数据库）：
 * - 新工程默认逐项审批、没有预算、没有签署；
 * - 签署：预算必填，单次生成上限不得超过总预算（契约拒绝）；签署人与时间由服务端写入，版本逐次加一；写工作区事件；
 * - 工作台状态带出授权；撤回回到逐项审批（事件记录撤回前的授权）；
 * - VIEWER 可读不可签（403）；跨工作区 404。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'autonomy-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `autonomy-${randomUUID()}@test.local`): Promise<{ client: AncsClient; userId: string }> {
  const user = await createInternalUser(auth, { email, password: PASSWORD, name: '自主制作测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, userId: user.id };
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<void> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  expect((caught as AncsApiError).status).toBe(status);
}

describe('V6-9 自主制作授权（HTTP + SDK）', () => {
  it('默认逐项审批；签署写入签署人与版本；工作台状态带出；撤回回到逐项审批；事件可审计', async () => {
    const { client: owner, userId } = await signedIn();
    const workspace = await owner.workspaces.create({ name: `自主-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: 'Autonomy' }, { idempotencyKey: `s-${randomUUID()}` });

    const initial = await owner.autonomy.get(workspace.id, ref.projectId);
    expect(initial).toEqual({ approval: 'ASK_EACH', budgetMicros: null, perGenerationMicros: null, allowOwnLikeness: false, maxRetriesPerTask: 2, signature: null });
    expect((await owner.studio.state(workspace.id, ref.projectId)).project.autonomy.signature).toBeNull();

    const signed = await owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'AUTO_SAFE', budgetMicros: 5_000_000 }, { idempotencyKey: `a-${randomUUID()}` });
    expect(signed).toMatchObject({ approval: 'AUTO_SAFE', budgetMicros: 5_000_000, perGenerationMicros: null, allowOwnLikeness: false, maxRetriesPerTask: 2 });
    expect(signed.signature).toMatchObject({ userId, version: 1 });
    expect(Date.parse(signed.signature?.signedAt ?? '')).toBeGreaterThan(Date.now() - 60_000);

    const resigned = await owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'FULL', budgetMicros: 20_000_000, perGenerationMicros: 2_000_000, allowOwnLikeness: true }, { idempotencyKey: `a-${randomUUID()}` });
    expect(resigned.signature?.version).toBe(2);
    const state = await owner.studio.state(workspace.id, ref.projectId);
    expect(state.project.autonomy).toEqual(resigned);
    // 内容来源（工程模式）不受影响：工作方式与内容来源是两个独立维度
    expect(state.project.allowGeneratedVideo).toBe(false);

    const revoked = await owner.autonomy.revoke(workspace.id, ref.projectId, { idempotencyKey: `a-${randomUUID()}` });
    expect(revoked).toEqual(initial);

    const events = await handle.db.select({ type: outboxEvents.type, payload: outboxEvents.payload }).from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspace.id))).orderBy(outboxEvents.createdAt);
    const autonomyEvents = events.filter((event) => event.type.startsWith('project.autonomy.'));
    expect(autonomyEvents.map((event) => event.type)).toEqual(['project.autonomy.signed', 'project.autonomy.signed', 'project.autonomy.revoked']);
    expect(autonomyEvents[2]?.payload).toMatchObject({ projectId: ref.projectId, actorId: userId, before: { approval: 'FULL', budgetMicros: 20_000_000 } });
  }, 60_000);

  it('预算必填、单次上限不得超过总预算；VIEWER 403；跨工作区 404', async () => {
    const ownerEmail = `autonomy-owner-${randomUUID()}@test.local`;
    const { client: owner } = await signedIn(ownerEmail);
    const workspace = await owner.workspaces.create({ name: `自主-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: 'Autonomy limits' }, { idempotencyKey: `s-${randomUUID()}` });

    // 契约拒绝（SDK 发出前即按同一 schema 校验）
    await expect(owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'FULL', budgetMicros: 1_000_000, perGenerationMicros: 2_000_000 }, { idempotencyKey: `a-${randomUUID()}` }))
      .rejects.toThrow(/perGenerationMicros must not exceed budgetMicros/);
    await expect(owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'FULL' } as never, { idempotencyKey: `a-${randomUUID()}` })).rejects.toThrow();
    // 服务端同样拒绝（绕过 SDK 直接发请求，带同一会话；请求体不合契约 → 400）
    const login = await fetch(`${baseUrl}/api/v1/auth/sign-in`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: baseUrl, 'x-client-type': 'web', 'x-client-version': '0.1.0' }, body: JSON.stringify({ email: ownerEmail, password: PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() ?? []).map((value) => value.split(';')[0]).join('; ');
    for (const body of [{ approval: 'FULL', budgetMicros: 0 }, { approval: 'FULL' }, { approval: 'FULL', budgetMicros: 1_000_000, perGenerationMicros: 2_000_000 }, { approval: 'YOLO', budgetMicros: 1_000_000 }]) {
      const response = await fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}/projects/${ref.projectId}/autonomy`, {
        method: 'PUT', headers: { 'content-type': 'application/json', cookie, origin: baseUrl, 'x-client-type': 'web', 'x-client-version': '0.1.0' }, body: JSON.stringify(body),
      });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }

    const viewerEmail = `autonomy-viewer-${randomUUID()}@test.local`;
    const { client: viewer } = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.autonomy.get(workspace.id, ref.projectId)).approval).toBe('ASK_EACH');
    await expectApiError(viewer.autonomy.sign(workspace.id, ref.projectId, { approval: 'AUTO_SAFE', budgetMicros: 1_000_000 }, { idempotencyKey: `a-${randomUUID()}` }), 403);
    await expectApiError(viewer.autonomy.revoke(workspace.id, ref.projectId, { idempotencyKey: `a-${randomUUID()}` }), 403);

    const { client: stranger } = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.autonomy.get(strangerWorkspace.id, ref.projectId), 404);
    await expectApiError(stranger.autonomy.sign(strangerWorkspace.id, ref.projectId, { approval: 'FULL', budgetMicros: 1_000_000 }, { idempotencyKey: `a-${randomUUID()}` }), 404);
  }, 60_000);
});
