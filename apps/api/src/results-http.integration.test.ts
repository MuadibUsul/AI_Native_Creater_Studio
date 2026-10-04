import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  errorEnvelopeSchema,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  type ResultFetcher,
  type WebhookVerifier,
} from '@ancs/contracts';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, jobs, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import {
  claimJob,
  createJob,
  NOOP_JOB_TYPE,
  registerProviderResultDescriptors,
  registerProviderResultPending,
  reserveCredits,
  transitionJob,
  upsertBudget,
  type DomainDeps,
} from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';

/**
 * P03-06 HTTP 验收：
 * - Webhook 端点（公开、仅凭验签信任）：有效签名 → 200 且回收生效；伪造 → 401 信封且无副作用；
 *   同 eventId 重复 → 幂等 ack（DUPLICATE）；
 * - 人工回收端点（generation:run）：与回调**共用同一回收服务**；跨租户 404、VIEWER 403。
 */

const WEBHOOK_SECRET = 'http-webhook-secret-0123456789'; // secrets:check-ignore：测试专用假密钥

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let rootDir: string;
let storage: LocalObjectStorage;

class ScriptedFetcher implements ResultFetcher {
  readonly kind = 'scripted';
  responses = new Map<string, { bytes: Uint8Array; contentType: string | null }>();
  async fetch(input: { url: string }): Promise<{ bytes: Uint8Array; contentType: string | null }> {
    const response = this.responses.get(input.url);
    if (response === undefined) throw new Error(`临时 URL 不可用：${input.url}`);
    return response;
  }
}
const fetcher = new ScriptedFetcher();
const deps = (): DomainDeps => ({ db: handle.db, storage, resultFetcher: fetcher });

function pngBytes(seed: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  bytes.set([0x00, 0x00, 0x02, 0x80], 16);
  bytes.set([0x00, 0x00, 0x01, 0x68], 20);
  bytes[24] = 8;
  bytes[25] = 2;
  bytes[26] = seed & 0xff;
  return bytes;
}

function verifyHmac(input: { headers: Record<string, string | undefined>; rawBody: string }): { ok: boolean; reason?: string } {
  const signature = input.headers[WEBHOOK_SIGNATURE_HEADER];
  const timestamp = input.headers[WEBHOOK_TIMESTAMP_HEADER];
  if (signature === undefined || timestamp === undefined) return { ok: false, reason: 'MISSING_SIGNATURE' };
  const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${timestamp}.${input.rawBody}`).digest('hex');
  return signature === expected ? { ok: true } : { ok: false, reason: 'INVALID_SIGNATURE' };
}

const verifiers: readonly WebhookVerifier[] = [{ providerId: 'mock.provider', verify: verifyHmac }];

function signedHeaders(body: string, secret = WEBHOOK_SECRET): Record<string, string> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    'content-type': 'application/json',
    [WEBHOOK_SIGNATURE_HEADER]: createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex'),
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
  };
}

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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-results-http-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'results-http-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
  auth = createAuth({
    db: handle.db,
    secret: 'results-http-auth-secret-0123456789', // secrets:check-ignore：测试专用假密钥
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: { adapter: storage },
    webhooks: { verifiers, resultFetcher: fetcher, storage },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

/** 建一个"已提交给 Provider 且登记了待回收结果"的任务 */
async function makeSubmitted(): Promise<{ workspaceId: string; jobId: string; providerJobId: string; url: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'HTTP 回收租户' });
  await upsertBudget(deps(), { workspaceId, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });
  const job = await createJob(deps(), {
    workspaceId,
    type: NOOP_JOB_TYPE,
    input: { modelId: 'mock-video-1', operation: 'video.generate', credentialMode: 'PLATFORM_MANAGED', inputHash: 'sha256:x', estimatedCredits: 10 },
  });
  await claimJob(deps(), { workerId: 'w', leaseSeconds: 60, types: [NOOP_JOB_TYPE] });
  await transitionJob(deps(), { workspaceId, jobId: job.id, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED', reason: 'SUBMITTED' });
  await reserveCredits(deps(), { workspaceId, jobId: job.id, estimatedCredits: 10 });
  const providerJobId = `pjob_${randomUUID()}`;
  await registerProviderResultPending(deps(), { workspaceId, jobId: job.id, providerId: 'mock.provider', providerJobId, attempt: 1 });
  const url = `https://provider.example/ephemeral/${providerJobId}.png`;
  fetcher.responses.set(url, { bytes: pngBytes(9), contentType: 'image/png' });
  return { workspaceId, jobId: job.id, providerJobId, url };
}

function callbackBody(providerJobId: string, url: string): string {
  return JSON.stringify({
    eventId: `evt_${randomUUID()}`,
    eventType: 'job.succeeded',
    providerJobId,
    attempt: 1,
    results: [{ url, contentType: 'image/png', sizeBytes: null, checksumSha256: null, assetType: 'GENERATED_IMAGE', expiresAt: null }],
    error: null,
  });
}

async function newClient(tag: string): Promise<{ client: AncsClient; email: string }> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: 'password-1234', name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: 'password-1234' });
  return { client, email };
}

async function cookieFor(email: string): Promise<string> {
  const signIn = await app.inject({ method: 'POST', url: '/api/v1/auth/sign-in', payload: { email, password: 'password-1234' } });
  const setCookie = signIn.headers['set-cookie'];
  const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (typeof header !== 'string') throw new Error('未取得会话 cookie');
  return header.split(';')[0] ?? '';
}

describe('Webhook 端点（P03-06 HTTP）', () => {
  it('有效签名 → 200 且回收生效；伪造签名 → 401 信封且无副作用；重复 eventId → 幂等 ack', async () => {
    const { jobId, providerJobId, url } = await makeSubmitted();
    const body = callbackBody(providerJobId, url);

    // 伪造签名：401 + 无副作用
    const forged = await fetch(`${baseUrl}/api/v1/providers/mock.provider/webhooks`, {
      method: 'POST',
      headers: signedHeaders(body, 'wrong-secret-00000000'), // secrets:check-ignore：测试专用假密钥
      body,
    });
    expect(forged.status).toBe(401);
    const envelope = errorEnvelopeSchema.parse(await forged.json());
    expect(envelope.error.code).toBe('UNAUTHENTICATED');
    expect(envelope.error.details['reason']).toBe('INVALID_SIGNATURE');
    const untouched = (await handle.db.select().from(jobs).where(eq(jobs.id, jobId)))[0];
    expect(untouched?.status).toBe('PROVIDER_QUEUED');

    // 有效签名：回收生效
    const accepted = await fetch(`${baseUrl}/api/v1/providers/mock.provider/webhooks`, { method: 'POST', headers: signedHeaders(body), body });
    expect(accepted.status).toBe(200);
    expect((await accepted.json()) as { status: string; jobId: string; collected: number }).toMatchObject({
      status: 'PROCESSED',
      jobId,
      collected: 1,
    });

    // 重复：幂等 ack，不重复处理
    const duplicate = await fetch(`${baseUrl}/api/v1/providers/mock.provider/webhooks`, { method: 'POST', headers: signedHeaders(body), body });
    expect(duplicate.status).toBe(200);
    expect(((await duplicate.json()) as { status: string }).status).toBe('DUPLICATE');

    const completed = (await handle.db.select().from(jobs).where(eq(jobs.id, jobId)))[0];
    expect(completed?.status).toBe('SUCCEEDED');
  });

  it('人工回收端点：与回调共用服务（generation:run）；跨租户 404；VIEWER 403', async () => {
    const owner = await newClient('collect-owner');
    const viewer = await newClient('collect-viewer');
    const stranger = await newClient('collect-stranger');
    const workspace = await owner.client.workspaces.create({ name: `回收-${randomUUID().slice(0, 8)}` });
    await owner.client.workspaces.members.add(workspace.id, { email: viewer.email, role: 'VIEWER' });

    await upsertBudget(deps(), { workspaceId: workspace.id, input: { period: 'MONTHLY', limitCredits: 100, perJobMaxCredits: 0 } });
    const job = await createJob(deps(), {
      workspaceId: workspace.id,
      type: NOOP_JOB_TYPE,
      input: { modelId: 'mock-video-1', operation: 'video.generate', credentialMode: 'PLATFORM_MANAGED', inputHash: 'sha256:y', estimatedCredits: 10 },
    });
    await claimJob(deps(), { workerId: 'w', leaseSeconds: 60, types: [NOOP_JOB_TYPE] });
    await transitionJob(deps(), { workspaceId: workspace.id, jobId: job.id, to: 'PROVIDER_QUEUED', submitState: 'SUBMITTED', reason: 'SUBMITTED' });
    await reserveCredits(deps(), { workspaceId: workspace.id, jobId: job.id, estimatedCredits: 10 });
    const providerJobId = `pjob_${randomUUID()}`;
    await registerProviderResultPending(deps(), { workspaceId: workspace.id, jobId: job.id, providerId: 'mock.provider', providerJobId, attempt: 1 });
    const resultUrl = `https://provider.example/ephemeral/${providerJobId}.png`;
    fetcher.responses.set(resultUrl, { bytes: pngBytes(10), contentType: 'image/png' });
    // 轮询补偿/人工恢复路径：结果描述符先登记（与回调路径共用同一 state 行）
    await registerProviderResultDescriptors(deps(), {
      workspaceId: workspace.id,
      jobId: job.id,
      attempt: 1,
      results: [
        { url: resultUrl, contentType: 'image/png', sizeBytes: null, checksumSha256: null, assetType: 'GENERATED_IMAGE', expiresAt: null },
      ],
    });

    const collect = async (cookie: string): Promise<Response> =>
      fetch(`${baseUrl}/api/v1/workspaces/${workspace.id}/jobs/${job.id}/collect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ providerJobId, results: [] }),
      });

    // 越权先测（避免回收后状态干扰）
    const strangerResponse = await collect(await cookieFor(stranger.email));
    expect(strangerResponse.status).toBe(404);
    const viewerResponse = await collect(await cookieFor(viewer.email));
    expect(viewerResponse.status).toBe(403);

    // 所有者（generation:run）：回收成功
    const ownerResponse = await collect(await cookieFor(owner.email));
    expect(ownerResponse.status).toBe(200);
    const body = (await ownerResponse.json()) as { collected: number; assets: { assetId: string }[] };
    expect(body.collected).toBe(1);
    expect(body.assets).toHaveLength(1);

    const jobRow = (await handle.db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    expect(jobRow?.status).toBe('SUCCEEDED');
  });
});
