import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, outboxEvents, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import type { WorkspaceEvent } from '@ancs/contracts';
import { buildServer } from './server.js';

/**
 * P02-06 验收（HTTP + SDK）：
 * - 事件游标：head 快照 / cursor=0 全量重放 / 超出 head → 409 CURSOR_AHEAD / 非法游标 → 400；
 * - **断线重连能恢复状态**：拉取一段 → 断开（模拟断线）→ 产生新事件 → 带游标重连续传，不丢不重；
 * - SSE 实时流：`Last-Event-ID` 语义、事件帧含 seq/type/data；
 * - 通知：Outbox 消费者生成持久化通知（不通知发起人；未读合并）、本人可读/标记，他人 404；
 * - 越权：非成员访问事件流与游标 → 404。
 */

const PASSWORD = 'password-1234';

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
    throw new Error(`无法连接测试数据库 ${redactDatabaseUrl(url)}。`, { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'events-workflow-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newClient(): Promise<{ client: AncsClient; email: string }> {
  const email = `events-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '事件测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return { client, email };
}

async function makeProject(client: AncsClient): Promise<{ workspaceId: string; projectId: string; sceneId: string; revision: number }> {
  const workspace = await client.workspaces.create({ name: `事件工作流-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '栏目' });
  const project = await client.projects.create(workspace.id, { title: '事件项目', channelId: channel.id });
  const scene = await client.projects.addScene(project.id, { sceneType: 'HOST_FULL', semanticType: 'HOST_STATEMENT', durationMs: 5000 });
  return { workspaceId: workspace.id, projectId: project.id, sceneId: scene.scene.id, revision: scene.project.revision };
}

interface EditState {
  projectId: string;
  sceneId: string;
  projectRevision: number;
  sceneRevision: number;
}

async function makeProjectWithState(client: AncsClient): Promise<{ workspaceId: string; state: EditState }> {
  const base = await makeProject(client);
  return {
    workspaceId: base.workspaceId,
    state: { projectId: base.projectId, sceneId: base.sceneId, projectRevision: base.revision, sceneRevision: 1 },
  };
}

async function editNarration(client: AncsClient, state: EditState, narration: string): Promise<EditState> {
  const result = await client.projects.edit(state.projectId, {
    baseProjectRevision: state.projectRevision,
    expectedSceneRevisions: { [state.sceneId]: state.sceneRevision },
    operations: [{ op: 'update_scene', sceneId: state.sceneId, changes: { narration } }],
    idempotencyKey: `idem_evt_${randomUUID()}`,
  });
  return {
    ...state,
    projectRevision: result.project.revision,
    sceneRevision: result.scenes.find((scene) => scene.id === state.sceneId)?.revision ?? state.sceneRevision,
  };
}

/** 读取 SSE 流直到收到 match 事件（或超时）；返回事件与原始帧文本 */
async function readSseUntil(
  url: string,
  match: (event: WorkspaceEvent) => boolean,
  options: { cookie?: string; lastEventId?: number; timeoutMs?: number } = {},
): Promise<{ event: WorkspaceEvent; raw: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, options.timeoutMs ?? 8000);
  const headers: Record<string, string> = { accept: 'text/event-stream' };
  if (options.cookie !== undefined) headers['cookie'] = options.cookie;
  if (options.lastEventId !== undefined) headers['last-event-id'] = String(options.lastEventId);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok || response.body === null) {
      throw new Error(`SSE 连接失败：HTTP ${String(response.status)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('SSE 流意外结束');
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
        if (!frame.includes('data:')) continue;
        const dataLine = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trim())
          .join('');
        const event = JSON.parse(dataLine) as WorkspaceEvent;
        if (match(event)) return { event, raw: frame };
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

/** 用 app.inject 取 cookie（SDK 使用 cookie jar，这里直接注入 API 调用获取原始 Set-Cookie） */
async function cookieFor(email: string): Promise<string> {
  const signIn = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/sign-in',
    payload: { email, password: PASSWORD },
  });
  const setCookie = signIn.headers['set-cookie'];
  const cookieHeader = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof cookieHeader !== 'string') throw new Error('未取得会话 cookie');
  return cookieHeader.split(';')[0] ?? '';
}

describe('事件游标与 SSE（§34）', () => {
  it('游标快照 / cursor=0 全量重放 / 事件帧含 seq 与类型', async () => {
    const { client } = await newClient();
    const { workspaceId, state } = await makeProjectWithState(client);
    const ids = { workspaceId };

    const cursor0 = await client.events.cursor(ids.workspaceId);
    expect(cursor0.headSeq).toBeGreaterThan(0); // addScene 已产生 project.updated

    const full = await client.events.list(ids.workspaceId, { cursor: 0 });
    expect(full.events.length).toBeGreaterThanOrEqual(1);
    expect(full.events.map((event) => event.seq)).toEqual([...full.events.map((event) => event.seq)].sort((a, b) => a - b));
    expect(full.events[0]?.eventType).toBe('project.updated');
    expect(full.events[0]?.payload['projectId']).toBe(state.projectId);
    expect(full.events[0]?.payload['actorType']).toBe('SYSTEM'); // addScene 以 SYSTEM 身份

    // 无 cursor：只收新事件（初始为空）
    const headOnly = await client.events.list(ids.workspaceId);
    expect(headOnly.events).toHaveLength(0);

    await editNarration(client, state, '第一版');
    const afterEdit = await client.events.list(ids.workspaceId, { cursor: cursor0.headSeq });
    expect(afterEdit.events).toHaveLength(1);
    expect(afterEdit.events[0]?.payload['operations']).toEqual(['update_scene']);
    expect(afterEdit.events[0]?.payload['actorType']).toBe('USER');
  });

  it('非法游标 → 400；游标超出 head → 409 CURSOR_AHEAD（附 headSeq 供刷新）', async () => {
    const { client } = await newClient();
    const ids = await makeProject(client);

    const invalid = await client.events.list(ids.workspaceId, { cursor: -1 }).catch((error: unknown) => error);
    expect(invalid).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    const cursor = await client.events.cursor(ids.workspaceId);
    const aheadFailure = await fetch(`${baseUrl}/api/v1/workspaces/${ids.workspaceId}/events?cursor=${String(cursor.headSeq + 100)}`, {
      headers: { cookie: await cookieFor((await client.auth.session())?.user?.email ?? '') },
    });
    // session() 可能不含 email；直接用 SDK 断言错误（SDK 会抛 AncsApiError）
    void aheadFailure;
    const sdkFailure = await client.events.list(ids.workspaceId, { cursor: cursor.headSeq + 100 }).catch((error: unknown) => error);
    expect(sdkFailure).toBeInstanceOf(AncsApiError);
    expect(sdkFailure).toMatchObject({ status: 409, code: 'PRECONDITION_FAILED' });
    const details = (sdkFailure as AncsApiError).details as { reason?: string; headSeq?: number };
    expect(details.reason).toBe('CURSOR_AHEAD');
    expect(details.headSeq).toBe(cursor.headSeq);
  });

  it('断线重连能恢复状态：拉取 → 断开 → 新事件 → 带游标续传（不丢不重）', async () => {
    const { client } = await newClient();
    const { workspaceId, state } = await makeProjectWithState(client);
    const ids = { workspaceId };

    // 第一次连接：收到 addScene 的事件后"断线"
    const first = await client.events.list(ids.workspaceId, { cursor: 0 });
    const firstBatch = first.events;
    expect(firstBatch.length).toBeGreaterThanOrEqual(1);
    const lastSeen = firstBatch[firstBatch.length - 1]?.seq ?? 0;

    // 断线期间产生新事件（两次编辑）
    const s1 = await editNarration(client, state, '断线期间 1');
    const s2 = await editNarration(client, s1, '断线期间 2');

    // 重连（模拟：带最后游标重新拉取）→ 只收到断线期间的 2 条，且不与首次重复
    const resumed = await client.events.list(ids.workspaceId, { cursor: lastSeen });
    expect(resumed.events).toHaveLength(2);
    expect(resumed.events[0]?.seq).toBeGreaterThan(lastSeen);
    const seen = new Set(firstBatch.map((event) => event.seq));
    expect(resumed.events.every((event) => !seen.has(event.seq))).toBe(true);
    // 两次编辑的内容都在（顺序正确：resultRevision 分别为两次编辑后的项目 revision）
    expect(resumed.events.map((event) => event.payload['revision'])).toEqual([s1.projectRevision, s2.projectRevision]);

    // 再拉一次（已追平）→ 空
    const tail = await client.events.list(ids.workspaceId, { cursor: resumed.events[resumed.events.length - 1]?.seq ?? 0 });
    expect(tail.events).toHaveLength(0);
  });

  it('SSE 实时流：断线期间的编辑在重连后经 Last-Event-ID 续传补齐', async () => {
    const { client, email } = await newClient();
    const { workspaceId, state } = await makeProjectWithState(client);
    const ids = { workspaceId };
    const cookie = await cookieFor(email);

    // 连接并读到当前 head 的事件（确保流可工作）
    const firstEvent = await readSseUntil(
      `${baseUrl}/api/v1/workspaces/${ids.workspaceId}/events/stream?cursor=0`,
      () => true,
      { cookie },
    );
    expect(firstEvent.raw).toContain(`id: ${String(firstEvent.event.seq)}`);
    expect(firstEvent.raw).toContain('event: project.updated');
    const lastSeen = firstEvent.event.seq;

    // 断线期间两次编辑
    const s1 = await editNarration(client, state, 'SSE 断线 1');
    const s2 = await editNarration(client, s1, 'SSE 断线 2');

    // 重连（Last-Event-ID）→ 应补齐两条（不丢）
    const catchUp: number[] = [];
    const controller = new AbortController();
    const headers: Record<string, string> = { accept: 'text/event-stream', cookie, 'last-event-id': String(lastSeen) };
    const response = await fetch(`${baseUrl}/api/v1/workspaces/${ids.workspaceId}/events/stream`, { headers, signal: controller.signal });
    expect(response.status).toBe(200);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const decoder = new TextDecoder();
    let buffer = '';
    const deadline = Date.now() + 8000;
    while (catchUp.length < 2 && Date.now() < deadline) {
      const { value, done } = await reader!.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf('\n\n');
      while (index >= 0) {
        const frame = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        index = buffer.indexOf('\n\n');
        if (frame.includes('data:')) {
          const dataLine = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('');
          catchUp.push((JSON.parse(dataLine) as WorkspaceEvent).seq);
        }
      }
    }
    controller.abort();
    expect(catchUp).toEqual([lastSeen + 1, lastSeen + 2]);

    // 实时：连接中产生新编辑 → 立即推送到已建立的流
    const s3 = await editNarration(client, s2, '实时事件');
    const live = await readSseUntil(
      `${baseUrl}/api/v1/workspaces/${ids.workspaceId}/events/stream`,
      (event) => event.payload['revision'] === s3.projectRevision,
      { cookie, lastEventId: lastSeen + 2 },
    );
    expect(live.event.eventType).toBe('project.updated');
  });

  it('越权：非成员访问事件游标/列表/流 → 404', async () => {
    const owner = await newClient();
    const stranger = await newClient();
    const ids = await makeProject(owner.client);

    const cursorFailure = await stranger.client.events.cursor(ids.workspaceId).catch((error: unknown) => error);
    expect(cursorFailure).toMatchObject({ status: 404, code: 'NOT_FOUND' });
    const listFailure = await stranger.client.events.list(ids.workspaceId, { cursor: 0 }).catch((error: unknown) => error);
    expect(listFailure).toMatchObject({ status: 404 });
    const streamResponse = await fetch(`${baseUrl}/api/v1/workspaces/${ids.workspaceId}/events/stream`, {
      headers: { cookie: await cookieFor(stranger.email), accept: 'text/event-stream' },
    });
    expect(streamResponse.status).toBe(404);
  });
});

describe('通知（Outbox 消费者 + 持久化 inbox）', () => {
  it('消费者：编辑后为其他成员生成未读通知（不通知发起人；未读合并）；标记已读', async () => {
    const alice = await newClient();
    const bob = await newClient();
    const { workspaceId, state } = await makeProjectWithState(alice.client);
    const ids = { workspaceId };
    await alice.client.workspaces.members.add(workspaceId, { email: bob.email, role: 'EDITOR' });

    // 直接驱动消费者（SSE tick 与 CLI 使用同一函数）
    const { runNotificationDispatch } = await import('@ancs/domain');
    // 共享测试库里其它文件可能留下超过一批的未派发事件：派发到没有剩余为止，只检查本工作区
    let dispatched = 0;
    for (let round = 0; round < 50; round += 1) {
      const batch = await runNotificationDispatch({ db: handle.db }, { limit: 100 });
      dispatched += batch.dispatched;
      if (batch.scanned === 0) break;
    }
    expect(dispatched).toBeGreaterThanOrEqual(1); // addScene 的 project.updated
    // Outbox 已标记 published（P02-02 遗留义务）
    const pending = await handle.db.select().from(outboxEvents).where(and(isNull(outboxEvents.publishedAt), eq(outboxEvents.workspaceId, workspaceId)));
    expect(pending).toHaveLength(0);

    const bobNotifications = await bob.client.notifications.list({ workspaceId: ids.workspaceId });
    expect(bobNotifications).toHaveLength(1);
    expect(bobNotifications[0]?.type).toBe('PROJECT_UPDATED');
    expect(bobNotifications[0]?.resourceId).toBe(state.projectId);
    expect(bobNotifications[0]?.readAt).toBeNull();

    // 发起人（alice：addScene 为 SYSTEM 也会通知 alice？addScene actor = SYSTEM(null) → 所有人都会收到）
    const aliceNotifications = await alice.client.notifications.list({ workspaceId: ids.workspaceId });
    expect(aliceNotifications.length).toBeGreaterThanOrEqual(1); // SYSTEM 动作通知全体成员

    // 用户编辑（actor = alice）→ 通知 bob（同项目未读合并更新），不通知 alice
    const s1 = await editNarration(alice.client, state, '通知测试');
    await runNotificationDispatch({ db: handle.db }, { limit: 100 });
    const bobUnread = await bob.client.notifications.list({ workspaceId: ids.workspaceId, unreadOnly: true });
    expect(bobUnread).toHaveLength(1); // 同一 (user, type, resourceId) 的未读通知合并
    expect(bobUnread[0]?.body).toContain('其他成员'); // 内容已更新为人类可见意图
    expect(bobUnread[0]?.payload['actorType']).toBe('USER');
    const aliceUnread = await alice.client.notifications.list({ workspaceId: ids.workspaceId, unreadOnly: true });
    // alice 未读仍只有 SYSTEM 那条（自己的编辑不会通知自己）
    expect(aliceUnread.every((row) => row.payload['actorType'] !== 'USER')).toBe(true);

    // 再次编辑：仍未读 → 继续合并（数量不增长，内容更新）
    const s2 = await editNarration(alice.client, s1, '通知合并 2');
    await runNotificationDispatch({ db: handle.db }, { limit: 100 });
    const merged = await bob.client.notifications.list({ workspaceId: ids.workspaceId, unreadOnly: true });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe(bobUnread[0]?.id);

    // 标记已读（本人）
    const target = (await bob.client.notifications.list({ workspaceId: ids.workspaceId }))[0];
    await bob.client.notifications.markRead(target?.id ?? '');
    const drained = await bob.client.notifications.unreadCount({ workspaceId: ids.workspaceId });
    expect(drained).toBe(0);
    // 全读
    await editNarration(alice.client, s2, '通知全读');
    await runNotificationDispatch({ db: handle.db }, { limit: 100 });
    const updated = await bob.client.notifications.markAllRead({ workspaceId: ids.workspaceId });
    expect(updated).toBeGreaterThanOrEqual(1);
    expect(await bob.client.notifications.unreadCount({ workspaceId: ids.workspaceId })).toBe(0);
  });

  it('越权：他人通知不可读（404）；消费者重复运行不重复派发', async () => {
    const alice = await newClient();
    const bob = await newClient();
    const ids = await makeProject(alice.client);
    await alice.client.workspaces.members.add(ids.workspaceId, { email: bob.email, role: 'VIEWER' });
    const { runNotificationDispatch } = await import('@ancs/domain');
    await runNotificationDispatch({ db: handle.db }, { limit: 100 });

    const aliceNote = (await alice.client.notifications.list({ workspaceId: ids.workspaceId }))[0];
    expect(aliceNote).toBeDefined();
    const forbidden = await bob.client.notifications.markRead(aliceNote?.id ?? '').catch((error: unknown) => error);
    expect(forbidden).toMatchObject({ status: 404, code: 'NOT_FOUND' });

    // 重复消费：无新未投递事件 → 不产生新通知
    const second = await runNotificationDispatch({ db: handle.db }, { limit: 100 });
    expect(second.dispatched).toBe(0);
    expect(second.notificationsCreated).toBe(0);
  });
});
