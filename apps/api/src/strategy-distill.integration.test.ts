import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * V6-6 从参考视频学风格（HTTP + SDK + 真实数据库；不启动 Worker，只验证入口）：
 * - 编辑者发起 → 202 + 进行中的蒸馏（第一步"获取"），同一幂等键重放得到同一次；可读成员能查进度；
 * - VIEWER 不能发起、不能改风格（403）；别的工作区看不到这次蒸馏（404）；
 * - 上传的参考视频不存在 → 404；空参考列表被契约拒绝；内置预设不可改（409）。
 * 测量、链接抓取与撰写的端到端见 apps/worker/src/reference-distill.integration.test.ts 与 scripts/distill-browser-check.mjs。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'distill-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `distill-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: '学风格测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  expect((caught as AncsApiError).status).toBe(status);
  return caught as AncsApiError;
}

describe('V6-6 从参考视频学风格（HTTP + SDK）', () => {
  it('发起与查询、幂等重放、权限与跨工作区、输入校验、内置预设不可改', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `学风格-${randomUUID().slice(0, 8)}` });
    const request = { references: [{ url: 'https://media.example/reference.mp4' }], name: '参考', locale: 'zh-CN' as const };
    const key = `d-${randomUUID()}`;

    const run = await owner.agent.startDistill(workspace.id, request, { idempotencyKey: key });
    expect(run).toMatchObject({ status: 'RUNNING', step: 'fetch', packId: null, composer: null, error: null, references: [{ label: 'https://media.example/reference.mp4', url: 'https://media.example/reference.mp4', assetId: null }] });
    const replay = await owner.agent.startDistill(workspace.id, request, { idempotencyKey: key });
    expect(replay.runId).toBe(run.runId);
    expect((await owner.agent.getDistill(workspace.id, run.runId)).runId).toBe(run.runId);

    const viewerEmail = `distill-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.agent.getDistill(workspace.id, run.runId)).status).toBe('RUNNING');
    await expectApiError(viewer.agent.startDistill(workspace.id, request, { idempotencyKey: `d-${randomUUID()}` }), 403);
    await expectApiError(viewer.agent.updateStrategy(workspace.id, 'builtin:travel-beat', { agentGuidance: 'x' }, { idempotencyKey: `s-${randomUUID()}` }), 403);

    const stranger = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.agent.getDistill(strangerWorkspace.id, run.runId), 404);
    await expectApiError(stranger.agent.getDistill(workspace.id, run.runId), 404);

    await expectApiError(owner.agent.startDistill(workspace.id, { references: [{ assetId: `ast_${randomUUID()}` }], name: null, locale: 'en' }, { idempotencyKey: `d-${randomUUID()}` }), 404);
    await expect(owner.agent.startDistill(workspace.id, { references: [], name: null, locale: 'en' }, { idempotencyKey: `d-${randomUUID()}` })).rejects.toThrow();
    const builtin = await expectApiError(owner.agent.updateStrategy(workspace.id, 'builtin:travel-beat', { agentGuidance: 'Cut faster.' }, { idempotencyKey: `s-${randomUUID()}` }), 409);
    expect(JSON.stringify(builtin.details)).toContain('STRATEGY_PACK_NOT_EDITABLE');
  }, 60_000);
});
