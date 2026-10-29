import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { autonomousChapters, autonomousRuns, createDb, outboxEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { saveProductionPlan } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * V6-9 自主制作授权（裁决 0020，AP-03；HTTP + SDK + 真实数据库）：
 * - 新工程默认逐项审批、没有预算、没有签署；
 * - 签署：预算必填，单次生成上限不得超过总预算（契约拒绝）；签署人与时间由服务端写入，版本逐次加一；写工作区事件；
 * - 工作台状态带出授权；撤回回到逐项审批（事件记录撤回前的授权）；
 * - VIEWER 可读不可签（403）；跨工作区 404。
 * - V6-10 S5：只重做没剪成的那一章（新的一次运行，带上 redoOf；只能重做没剪成的章）。
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

    // 制作计划（AP-04）：没有时为 null；导演写过之后读到最新一版（带制定时与当前的工程版本号）
    expect(await owner.autonomy.latestPlan(workspace.id, ref.projectId)).toBeNull();
    await saveProductionPlan({ db: handle.db }, { workspaceId: workspace.id, projectId: ref.projectId, turnId: null, baseRevision: state.project.revision, plan: {
      blueprint: { logline: '冰川', structure: '钩子 → 结尾' },
      scenes: [{ id: 'scene_1', title: '开场', goal: '抓人', intents: [{ id: 'i1', type: 'HOOK', targetFeeling: '惊叹', reason: '最亮的镜头' }] }],
    } });
    expect(await owner.autonomy.latestPlan(workspace.id, ref.projectId)).toMatchObject({ version: 1, baseRevision: state.project.revision, currentRevision: state.project.revision, scenes: [{ id: 'scene_1', intents: [{ type: 'HOOK' }] }] });

    const revoked = await owner.autonomy.revoke(workspace.id, ref.projectId, { idempotencyKey: `a-${randomUUID()}` });
    expect(revoked).toEqual(initial);

    const events = await handle.db.select({ type: outboxEvents.type, payload: outboxEvents.payload }).from(outboxEvents)
      .where(and(eq(outboxEvents.workspaceId, workspace.id))).orderBy(outboxEvents.createdAt);
    const autonomyEvents = events.filter((event) => event.type.startsWith('project.autonomy.'));
    expect(autonomyEvents.map((event) => event.type)).toEqual(['project.autonomy.signed', 'project.autonomy.signed', 'project.autonomy.revoked']);
    expect(autonomyEvents[2]?.payload).toMatchObject({ projectId: ref.projectId, actorId: userId, before: { approval: 'FULL', budgetMicros: 20_000_000 } });
  }, 60_000);

  it('自主制作运行：未签署 409；开始 202（等素材）、幂等、同一工程只有一个进行中的运行；列表、单个、停止；工作台状态带出；VIEWER 不能开始；跨工作区 404', async () => {
    const { client: owner } = await signedIn();
    const workspace = await owner.workspaces.create({ name: `自主运行-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: 'Autonomous' }, { idempotencyKey: `s-${randomUUID()}` });
    const brief = { goal: '把素材剪成 30 秒的旅行短片', targetDurationSeconds: 30 };
    await expectApiError(owner.autonomy.startRun(workspace.id, ref.projectId, brief, { idempotencyKey: `r-${randomUUID()}` }), 409);
    await owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'AUTO_SAFE', budgetMicros: 3_000_000 }, { idempotencyKey: `a-${randomUUID()}` });

    const key = `r-${randomUUID()}`;
    const run = await owner.autonomy.startRun(workspace.id, ref.projectId, brief, { idempotencyKey: key });
    expect(run).toMatchObject({ status: 'WAITING_FOR_FOOTAGE', goal: brief.goal, targetDurationSeconds: 30, approval: 'AUTO_SAFE', policyVersion: 1, budgetMicros: 3_000_000, locale: 'zh-CN', report: null, progress: { steps: 0 } });
    expect(run.workflowRunId).not.toBeNull();
    expect((await owner.autonomy.startRun(workspace.id, ref.projectId, brief, { idempotencyKey: key })).id).toBe(run.id);
    await expectApiError(owner.autonomy.startRun(workspace.id, ref.projectId, brief, { idempotencyKey: `r-${randomUUID()}` }), 409);
    expect((await owner.autonomy.listRuns(workspace.id, ref.projectId)).map((item) => item.id)).toEqual([run.id]);
    expect((await owner.autonomy.getRun(workspace.id, ref.projectId, run.id)).id).toBe(run.id);
    expect((await owner.studio.state(workspace.id, ref.projectId)).autonomousRun).toMatchObject({ id: run.id, status: 'WAITING_FOR_FOOTAGE' });

    const viewerEmail = `autonomy-run-viewer-${randomUUID()}@test.local`;
    const { client: viewer } = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.autonomy.getRun(workspace.id, ref.projectId, run.id)).id).toBe(run.id);
    await expectApiError(viewer.autonomy.cancelRun(workspace.id, ref.projectId, run.id, { idempotencyKey: `c-${randomUUID()}` }), 403);
    const { client: stranger } = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.autonomy.getRun(strangerWorkspace.id, ref.projectId, run.id), 404);

    // 停止：在步骤边界生效（没有 Worker 推进时运行记录保持原状态，工作流已请求取消）
    expect((await owner.autonomy.cancelRun(workspace.id, ref.projectId, run.id, { idempotencyKey: `c-${randomUUID()}` })).id).toBe(run.id);
  }, 60_000);

  it('V6-10 S5 重做没剪成的那一章：202 新运行（redoOf、只有这一章）、幂等；完成的章 409；进行中再重做 409；VIEWER 403；跨工作区 404', async () => {
    const { client: owner, userId } = await signedIn();
    const workspace = await owner.workspaces.create({ name: `重做-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: 'Redo' }, { idempotencyKey: `s-${randomUUID()}` });
    await owner.autonomy.sign(workspace.id, ref.projectId, { approval: 'AUTO_SAFE', budgetMicros: 3_000_000 }, { idempotencyKey: `a-${randomUUID()}` });
    const state = await owner.studio.state(workspace.id, ref.projectId);
    await saveProductionPlan({ db: handle.db }, { workspaceId: workspace.id, projectId: ref.projectId, turnId: null, baseRevision: state.project.revision, plan: {
      blueprint: { logline: '冰岛一日', structure: '出发 → 路上' },
      scenes: [{ id: 'scene_1', title: '出发', goal: '出门' }, { id: 'scene_2', title: '路上', goal: '在路上' }],
    } });
    // 一次已经交付的分章运行：第 2 章没剪成（这里不跑 Worker，直接写下交付后的样子）
    const runId = `aut_${randomUUID()}`;
    await handle.db.insert(autonomousRuns).values({
      id: runId, workspaceId: workspace.id, projectId: ref.projectId, status: 'DELIVERED', mode: 'CHAPTERS', goal: '剪一条冰岛一日', approval: 'AUTO_SAFE',
      policyVersion: 1, budgetMicros: 3_000_000, locale: 'zh-CN', createdBy: userId, completedAt: new Date(),
    });
    await handle.db.insert(autonomousChapters).values([
      { id: `ach_${randomUUID()}`, workspaceId: workspace.id, runId, index: 0, sceneId: 'scene_1', title: '出发', status: 'SUCCEEDED', attempts: 1, budgetMicros: 500_000 },
      { id: `ach_${randomUUID()}`, workspaceId: workspace.id, runId, index: 1, sceneId: 'scene_2', title: '路上', status: 'FAILED', attempts: 2, budgetMicros: 500_000, error: { reason: 'CHAPTER_FAILED', message: 'model error' } },
    ]);
    const original = await owner.autonomy.getRun(workspace.id, ref.projectId, runId);
    const [done, failed] = original.chapters;

    const key = `redo-${randomUUID()}`;
    const redo = await owner.autonomy.redoChapter(workspace.id, ref.projectId, runId, failed!.id, { idempotencyKey: key });
    expect(redo).toMatchObject({ status: 'CUTTING_CHAPTERS', mode: 'CHAPTERS', redoOf: { runId, chapterId: failed!.id, index: 1, title: '路上' }, chapters: [{ index: 1, title: '路上', status: 'PENDING', budgetMicros: 500_000 }] });
    expect(redo.workflowRunId).not.toBeNull();
    expect((await owner.autonomy.redoChapter(workspace.id, ref.projectId, runId, failed!.id, { idempotencyKey: key })).id).toBe(redo.id);
    expect((await owner.studio.state(workspace.id, ref.projectId)).autonomousRun).toMatchObject({ id: redo.id, redoOf: { chapterId: failed!.id } });
    await expectApiError(owner.autonomy.redoChapter(workspace.id, ref.projectId, runId, done!.id, { idempotencyKey: `redo-${randomUUID()}` }), 409);
    await expectApiError(owner.autonomy.redoChapter(workspace.id, ref.projectId, runId, failed!.id, { idempotencyKey: `redo-${randomUUID()}` }), 409);

    const viewerEmail = `autonomy-redo-viewer-${randomUUID()}@test.local`;
    const { client: viewer } = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    await expectApiError(viewer.autonomy.redoChapter(workspace.id, ref.projectId, runId, failed!.id, { idempotencyKey: `redo-${randomUUID()}` }), 403);
    const { client: stranger } = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.autonomy.redoChapter(strangerWorkspace.id, ref.projectId, runId, failed!.id, { idempotencyKey: `redo-${randomUUID()}` }), 404);
    await owner.autonomy.cancelRun(workspace.id, ref.projectId, redo.id, { idempotencyKey: `c-${randomUUID()}` });
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
