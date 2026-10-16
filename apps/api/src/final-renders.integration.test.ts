import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMPOSITION_FINAL_RENDER_WORKFLOW, ENTITLEMENT_ERROR_REASONS, legacyMillisecondsToMediaTime, WORKFLOW_ADVANCE_JOB_TYPE } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, jobs, resolveTestDatabaseUrl, runMigrations, workflowRuns, type DbHandle } from '@ancs/db';
import { assignWorkspacePlan, createProject, createSequence } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * V6-0 验收（HTTP + SDK + 真实数据库）：素材工程终渲染的发起与运行查询面。
 * - 发起 202：运行立即可查（RUNNING，推进任务已入队且 activeJobId 指向它）；同一幂等键 → 同一运行；
 * - 列表按工程过滤；详情与取消（CANCEL_REQUESTED → 步骤边界由 Worker 收尾）；已终态取消 → 409；
 * - 超 1080p 画布按 4K 权益判定（FREE → 422）；VIEWER 不可发起（403）；跨工作区 → 404；不存在的序列 → 404。
 * 执行链路（冻结/渲染/QA/补偿）由 apps/worker 的 composition-final-render 集成测试覆盖。
 */

const PASSWORD = 'password-1234';
const PROFILE = { width: 640, height: 360 };

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
    secret: 'final-renders-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function newSignedInClient(email = `final-render-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: '终渲染测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeFootageSequence(client: AncsClient): Promise<{ workspaceId: string; projectId: string; sequenceId: string }> {
  const workspace = await client.workspaces.create({ name: `终渲染-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id,
    input: { title: '旅行素材', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id,
    projectId: project.id,
    input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(2_000) },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('素材工程终渲染 HTTP 面（V6-0）', () => {
  it('发起 → 幂等回放同一运行 → 列表/详情 → 取消（CANCEL_REQUESTED）', async () => {
    const owner = await newSignedInClient();
    const target = await makeFootageSequence(owner);
    const idempotencyKey = `final-render-${randomUUID()}`;

    const run = await owner.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: PROFILE }, { idempotencyKey });
    expect(run.type).toBe(COMPOSITION_FINAL_RENDER_WORKFLOW);
    expect(run.status).toBe('RUNNING');
    expect(run.subjectRef).toBe(`sequence:${target.sequenceId}`);
    expect(run.steps).toEqual([]);

    // 推进任务与运行同一事务入队：activeJobId 指向一条 WORKFLOW_ADVANCE 任务
    const [row] = await handle.db.select().from(workflowRuns).where(eq(workflowRuns.id, run.id));
    expect(row?.activeJobId).toBeTruthy();
    const [job] = await handle.db.select().from(jobs).where(eq(jobs.id, row?.activeJobId ?? ''));
    expect(job?.type).toBe(WORKFLOW_ADVANCE_JOB_TYPE);
    expect(job?.workspaceId).toBe(target.workspaceId);

    const replay = await owner.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: PROFILE }, { idempotencyKey });
    expect(replay.id).toBe(run.id);

    const listed = await owner.finalRenders.list(target.workspaceId, target.projectId);
    expect(listed.map((item) => item.id)).toEqual([run.id]);
    expect((await owner.workflowRuns.get(target.workspaceId, run.id)).id).toBe(run.id);

    const cancelling = await owner.workflowRuns.cancel(target.workspaceId, run.id, { idempotencyKey: `cancel-${randomUUID()}` });
    expect(cancelling.status).toBe('CANCEL_REQUESTED');

    // 已终态（Worker 收尾后）不可再取消
    await handle.db.update(workflowRuns).set({ status: 'CANCELLED', activeJobId: null }).where(eq(workflowRuns.id, run.id));
    await expectApiError(owner.workflowRuns.cancel(target.workspaceId, run.id, { idempotencyKey: `cancel-${randomUUID()}` }), 409);
  }, 60_000);

  it('超 1080p 画布按 4K 权益判定：FREE → 422，且不创建运行', async () => {
    const owner = await newSignedInClient();
    const target = await makeFootageSequence(owner);
    await assignWorkspacePlan({ db: handle.db }, { workspaceId: target.workspaceId, planKey: 'FREE', note: '4K 权益验证', assignedBy: 'test-domain' });
    await expectApiError(
      owner.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: { width: 3840, height: 2160 } }, { idempotencyKey: `uhd-${randomUUID()}` }),
      422,
      ENTITLEMENT_ERROR_REASONS.RENDER_PROFILE_NOT_ALLOWED,
    );
    expect(await owner.finalRenders.list(target.workspaceId, target.projectId)).toEqual([]);
    // 1080p 不受 4K 权益约束
    const run = await owner.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: { width: 1920, height: 1080 } }, { idempotencyKey: `fhd-${randomUUID()}` });
    expect(run.status).toBe('RUNNING');
  }, 60_000);

  it('权限与隔离：VIEWER 可读不可发起（403）；跨工作区 404；不存在的序列 404', async () => {
    const owner = await newSignedInClient();
    const target = await makeFootageSequence(owner);
    const run = await owner.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: PROFILE }, { idempotencyKey: `own-${randomUUID()}` });

    const viewerEmail = `final-render-viewer-${randomUUID()}@test.local`;
    const viewer = await newSignedInClient(viewerEmail);
    await owner.workspaces.members.add(target.workspaceId, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.workflowRuns.get(target.workspaceId, run.id)).id).toBe(run.id);
    await expectApiError(viewer.finalRenders.start(target.workspaceId, target.projectId, target.sequenceId, { profile: PROFILE }, { idempotencyKey: `viewer-${randomUUID()}` }), 403);
    await expectApiError(viewer.workflowRuns.cancel(target.workspaceId, run.id, { idempotencyKey: `viewer-cancel-${randomUUID()}` }), 403);

    const stranger = await newSignedInClient();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.workflowRuns.get(target.workspaceId, run.id), 404);
    // 用自己的工作区去取别人的运行：同样 404（运行按工作区限定）
    await expectApiError(stranger.workflowRuns.get(strangerWorkspace.id, run.id), 404);
    await expectApiError(stranger.finalRenders.list(strangerWorkspace.id, target.projectId), 404);

    await expectApiError(
      owner.finalRenders.start(target.workspaceId, target.projectId, `seq_${randomUUID()}`, { profile: PROFILE }, { idempotencyKey: `missing-${randomUUID()}` }),
      404,
    );
  }, 60_000);
});
