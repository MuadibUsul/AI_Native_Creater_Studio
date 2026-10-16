import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GENERATION_ERROR_REASONS, IDENTITY_CONSENT_STATEMENTS, IDENTITY_CONSENT_STATEMENT_VERSION } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, generationRequests, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { upsertBudget } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * V6-7 / V6-8 验收（HTTP + SDK + 真实数据库）：
 * - 身份档案：新建、设参考照片（类型校验）、授权须为当前声明版本、撤回追加记录；VIEWER 只读（403），跨工作区 404；
 * - 付费生成：报价由 AI 建（这里直接写入一份报价），只有编辑者能确认；未设预算 409；确认 → 进行中 + 一轮"确认生成"；
 *   放弃；工作台状态里能看到报价与预算；跨工作区 404。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'generation-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `generation-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: '生成测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function apiError(promise: Promise<unknown>, status: number): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  expect((caught as AncsApiError).status).toBe(status);
  return caught as AncsApiError;
}

async function seedImage(workspaceId: string, mimeType = 'image/png'): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: null, assetType: 'SOURCE_IMAGE', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'KEEP_USER_SOURCE', license: { kind: 'OWNED' }, currentVersionId: versionId, metadata: { filename: 'me.png' } });
  await handle.db.insert(assetVersions).values({ id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `v6-7/${versionId}`, mimeType, sizeBytes: 100, checksumSha256: 'e'.repeat(64), durationMs: null, width: 256, height: 256, status: 'READY' });
  return assetId;
}

const frames = (count: number) => ({ ticks: String(count), timebase: { num: 1, den: 30 } });

async function seedQuote(input: { workspaceId: string; projectId: string; sessionId: string }): Promise<string> {
  const id = `gen_${randomUUID()}`;
  await handle.db.insert(generationRequests).values({
    id, workspaceId: input.workspaceId, projectId: input.projectId, sessionId: input.sessionId, kind: 'VIDEO_SHOT', status: 'QUOTED',
    request: { kind: 'VIDEO_SHOT', prompt: 'drone over a lake', at: frames(0), duration: frames(120) },
    summary: '开头加一个湖面航拍', providerId: 'vendor', providerImplementation: 'REAL', model: 'video-x', estimatedSeconds: '4',
    estimateMinMicros: 200_000, estimateMaxMicros: 1_600_000, reserveCredits: 160, expiresAt: new Date(Date.now() + 30 * 60_000),
  });
  return id;
}

describe('V6-7 / V6-8 HTTP：身份档案与付费生成确认', () => {
  it('身份档案：参考照片、授权（当前声明版本）与撤回；VIEWER 403；跨工作区 404', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `档案-${randomUUID().slice(0, 8)}` });
    const statement = await owner.identities.consentStatement(workspace.id);
    expect(statement).toEqual({ version: IDENTITY_CONSENT_STATEMENT_VERSION, statements: IDENTITY_CONSENT_STATEMENTS });

    const profile = await owner.identities.create(workspace.id, '我自己', { idempotencyKey: `i-${randomUUID()}` });
    expect(profile).toMatchObject({ name: '我自己', likeness: { reference: null, consent: null, ready: false }, history: [] });
    // 没有参考照片不能授权；声音参考不能用图片
    expect((await apiError(owner.identities.grantConsent(workspace.id, profile.id, { kind: 'LIKENESS', subject: 'SELF', statementVersion: statement.version, locale: 'zh-CN' }), 409)).details['reason']).toBe('IDENTITY_REFERENCE_INVALID');
    const image = await seedImage(workspace.id);
    expect((await apiError(owner.identities.setReference(workspace.id, profile.id, { kind: 'VOICE', assetId: image }), 422)).details['reason']).toBe('IDENTITY_REFERENCE_INVALID');
    const withPhoto = await owner.identities.setReference(workspace.id, profile.id, { kind: 'LIKENESS', assetId: image });
    expect(withPhoto.likeness.reference).toMatchObject({ assetId: image, filename: 'me.png', mimeType: 'image/png' });

    expect((await apiError(owner.identities.grantConsent(workspace.id, profile.id, { kind: 'LIKENESS', subject: 'SELF', statementVersion: 'v0', locale: 'zh-CN' }), 409)).details['reason']).toBe('IDENTITY_STATEMENT_OUTDATED');
    const granted = await owner.identities.grantConsent(workspace.id, profile.id, { kind: 'LIKENESS', subject: 'AUTHORIZED_OTHER', statementVersion: statement.version, locale: 'en' });
    expect(granted.likeness).toMatchObject({ consent: { subject: 'AUTHORIZED_OTHER', statementVersion: statement.version }, ready: true });
    expect(granted.history[0]).toMatchObject({ kind: 'LIKENESS', action: 'GRANT', locale: 'en', statementSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string });

    const viewerEmail = `generation-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.identities.list(workspace.id)).map((item) => item.id)).toEqual([profile.id]);
    await apiError(viewer.identities.revokeConsent(workspace.id, profile.id, 'LIKENESS'), 403);
    await apiError(viewer.identities.create(workspace.id, '别人'), 403);

    const revoked = await owner.identities.revokeConsent(workspace.id, profile.id, 'LIKENESS');
    expect(revoked.likeness).toMatchObject({ consent: null, ready: false });
    expect(revoked.history.map((record) => record.action)).toEqual(['REVOKE', 'GRANT']);
    expect((await apiError(owner.identities.revokeConsent(workspace.id, profile.id, 'LIKENESS'), 409)).details['reason']).toBe('IDENTITY_CONSENT_NOT_GRANTED');

    const stranger = await signedIn();
    await apiError(stranger.identities.list(workspace.id), 404);
  });

  it('付费生成确认：只有编辑者能确认；未设预算 409；确认 → 进行中 + "确认生成"一轮；放弃；跨工作区 404', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `生成-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: '湖', aspectRatio: '16:9', locale: 'zh-CN' }, { idempotencyKey: `s-${randomUUID()}` });
    await owner.studio.updateProductionPolicy(workspace.id, ref.projectId, { allowGeneratedVideo: true });
    const scope = { workspaceId: workspace.id, projectId: ref.projectId, sessionId: ref.sessionId };
    const quoteId = await seedQuote(scope);

    const state = await owner.studio.state(workspace.id, ref.projectId);
    expect(state.project.allowGeneratedVideo).toBe(true);
    expect(state.generations[0]).toMatchObject({ id: quoteId, status: 'QUOTED', estimate: { minMicros: 200_000, maxMicros: 1_600_000 } });
    expect(state.generationBudget).toMatchObject({ configured: false, limitMicros: null });

    const viewerEmail = `generation-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    await apiError(viewer.generations.accept(workspace.id, ref.projectId, quoteId, { expectedMaxMicros: 1_600_000 }), 403);

    expect((await apiError(owner.generations.accept(workspace.id, ref.projectId, quoteId, { expectedMaxMicros: 1_600_000 }), 409)).details['reason']).toBe(GENERATION_ERROR_REASONS.BUDGET_NOT_SET);
    await upsertBudget({ db: handle.db }, { workspaceId: workspace.id, input: { period: 'MONTHLY', limitCredits: 10_000, perJobMaxCredits: 0 } });
    expect((await apiError(owner.generations.accept(workspace.id, ref.projectId, quoteId, { expectedMaxMicros: 1 }), 409)).details['reason']).toBe(GENERATION_ERROR_REASONS.ESTIMATE_CHANGED);

    const accepted = await owner.generations.accept(workspace.id, ref.projectId, quoteId, { expectedMaxMicros: 1_600_000 }, { idempotencyKey: `g-${randomUUID()}` });
    expect(accepted).toMatchObject({ status: 'RUNNING', turnId: expect.any(String) as string });
    const turns = await owner.agent.listTurns(workspace.id, ref.sessionId);
    expect(turns[0]).toMatchObject({ id: accepted.turnId, purpose: 'GENERATE', status: 'RUNNING' });
    expect(turns[0]!.message).toContain('确认生成：开头加一个湖面航拍');
    const after = await owner.studio.state(workspace.id, ref.projectId);
    expect(after.generationBudget).toMatchObject({ configured: true, reservedMicros: 1_600_000 });

    const another = await seedQuote(scope);
    expect((await owner.generations.decline(workspace.id, ref.projectId, another)).status).toBe('DECLINED');
    expect((await owner.generations.list(workspace.id, ref.projectId)).map((item) => item.status)).toEqual(['DECLINED', 'RUNNING']);

    const stranger = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await apiError(stranger.generations.accept(workspace.id, ref.projectId, quoteId, { expectedMaxMicros: 1_600_000 }), 404);
    await apiError(stranger.generations.decline(strangerWorkspace.id, ref.projectId, another), 404);
  });
});
