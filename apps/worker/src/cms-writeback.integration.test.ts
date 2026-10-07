import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  CMS_WRITEBACK_DELIVERY_HEADER,
  CMS_WRITEBACK_SIGNATURE_HEADER,
  CMS_WRITEBACK_TIMESTAMP_HEADER,
  type CmsWritebackSender,
} from '@ancs/contracts';
import {
  cmsWritebackTargets,
  createDb,
  jobs,
  plans,
  redactDatabaseUrl,
  renders,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  claimJob,
  createChannel,
  createProject,
  ensureDefaultPlans,
  getCmsWritebackTarget,
  getRender,
  ingestCmsEvent,
  listCmsWritebackAttempts,
  promoteRetryableJobs,
  requeueExpiredLeases,
  retryCmsWriteback,
  transitionRender,
  upsertCmsWritebackTarget,
  type DomainDeps,
} from '@ancs/domain';
import { LocalCredentialVault } from '@ancs/providers-credential-vault-local';
import { JobHandlerRegistry } from './handlers.js';
import { cmsWritebackHandler } from './cms-writeback-handler.js';
import { executeJob } from './runner.js';

class ScriptedSender implements CmsWritebackSender {
  readonly kind = 'scripted';
  queue: Array<{ status: number; body?: string } | { error: Error }> = [];
  calls: Array<{ url: string; headers: Readonly<Record<string, string>>; body: string }> = [];
  async send(input: { url: string; headers: Readonly<Record<string, string>>; body: string }) {
    this.calls.push({ url: input.url, headers: input.headers, body: input.body });
    const response = this.queue.shift() ?? { status: 204 };
    if ('error' in response) throw response.error;
    return { status: response.status, headers: { 'content-type': 'application/json', 'set-cookie': 'must-not-persist' }, body: response.body ?? '', truncated: false };
  }
}

let handle: DbHandle;
let vault: LocalCredentialVault;
let sender: ScriptedSender;
const SIGNING_SECRET = 'cms-writeback-test-secret-1234'; // secrets:check-ignore：测试专用假密钥
const ROTATED_SIGNING_SECRET = 'cms-writeback-rotated-secret-6543'; // secrets:check-ignore：测试专用假密钥
const workerId = 'cms-writeback-test-worker';
const deps = (): DomainDeps => ({ db: handle.db, credentials: vault, cmsWritebackSender: sender, retryPolicy: { baseSeconds: 0, capSeconds: 0, jitterRatio: 0 } });

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
  vault = new LocalCredentialVault({ keys: `v1:${Buffer.alloc(32, 9).toString('base64')}` });
});

afterAll(async () => handle.close());

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans({ db: handle.db });
  sender = new ScriptedSender();
});

async function fixture(
  tag: string,
  options: { configureTarget?: boolean; enabled?: boolean } = {},
): Promise<{ workspaceId: string; projectId: string; renderId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: tag });
  const channel = await createChannel(deps(), { workspaceId, input: { name: 'CMS 栏目' } });
  const ingestion = await ingestCmsEvent(deps(), {
    workspaceId,
    source: 'CMS_WEBHOOK',
    externalId: `${tag}-article`,
    title: 'CMS 文章',
    channelId: channel.id,
    content: { kind: 'HTML', html: '<html><body><p>CMS writeback fixture</p></body></html>' },
  });
  if (options.configureTarget !== false) {
    await upsertCmsWritebackTarget(deps(), {
      workspaceId,
      request: { callbackUrl: 'https://cms.example/callback', signingSecret: SIGNING_SECRET, enabled: options.enabled },
    });
  }
  const renderId = `rnd_${randomUUID()}`;
  await handle.db.insert(renders).values({
    id: renderId,
    workspaceId,
    projectId: ingestion.projectId,
    profile: 'DRAFT_720',
    status: 'QA',
    input: { projectVersionId: `pv_${randomUUID()}`, masterNarrationId: null, assetVersionIds: [], format: { width: 1280, height: 720, fps: 30 } },
    manifestHash: 'a'.repeat(64),
    outputAssetIds: [`ast_${randomUUID()}`],
  });
  await transitionRender({ db: handle.db }, { workspaceId, renderId, to: 'READY', note: 'P13-07 fixture' });
  return { workspaceId, projectId: ingestion.projectId, renderId };
}

async function runNext() {
  const job = await claimJob(deps(), { workerId, leaseSeconds: 60, types: ['CMS_WRITEBACK'] });
  expect(job).not.toBeNull();
  await executeJob(deps(), new JobHandlerRegistry([cmsWritebackHandler]), { workerId, leaseSeconds: 60, heartbeatIntervalMs: 10_000 }, job as NonNullable<typeof job>);
  return job as NonNullable<typeof job>;
}

describe('CMS 回写（P13-07）', () => {
  it('READY 同事务调度；签名发送成功；Secret 不回显且密文落库', async () => {
    const { workspaceId, renderId } = await fixture('cms-writeback-success');
    const target = await getCmsWritebackTarget(deps(), { workspaceId });
    expect(target.maskedSecret).toBe(`••••${SIGNING_SECRET.slice(-4)}`);
    expect(target).not.toHaveProperty('signingSecret');
    const targetRow = (await handle.db.select().from(cmsWritebackTargets).where(eq(cmsWritebackTargets.workspaceId, workspaceId)))[0];
    expect(JSON.stringify(targetRow?.encryptedSigningSecret)).not.toContain(SIGNING_SECRET);

    const before = await listCmsWritebackAttempts(deps(), { workspaceId, renderId });
    expect(before).toHaveLength(1);
    await expect(transitionRender({ db: handle.db }, { workspaceId, renderId, to: 'READY' })).rejects.toMatchObject({ httpStatus: 409 });
    expect(await listCmsWritebackAttempts(deps(), { workspaceId, renderId })).toHaveLength(1);
    sender.queue.push({ status: 204 });
    await runNext();

    const call = sender.calls[0];
    const timestamp = call?.headers[CMS_WRITEBACK_TIMESTAMP_HEADER] ?? '';
    const expected = createHmac('sha256', SIGNING_SECRET).update(`${timestamp}.${call?.body ?? ''}`).digest('hex');
    expect(call?.headers[CMS_WRITEBACK_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);
    const changedBodySignature = createHmac('sha256', SIGNING_SECRET).update(`${timestamp}.${call?.body ?? ''}x`).digest('hex');
    const changedTimestampSignature = createHmac('sha256', SIGNING_SECRET).update(`${Number(timestamp) + 1}.${call?.body ?? ''}`).digest('hex');
    expect(call?.headers[CMS_WRITEBACK_SIGNATURE_HEADER]).not.toBe(`sha256=${changedBodySignature}`);
    expect(call?.headers[CMS_WRITEBACK_SIGNATURE_HEADER]).not.toBe(`sha256=${changedTimestampSignature}`);
    expect(call?.headers[CMS_WRITEBACK_DELIVERY_HEADER]).toBe(before[0]?.deliveryId);
    expect(JSON.parse(call?.body ?? '{}').artifact.renderStatus).toBe('READY');

    const after = await listCmsWritebackAttempts(deps(), { workspaceId, renderId });
    expect(after[0]?.status).toBe('SUCCEEDED');
    expect(after[0]?.responseHeaders).not.toHaveProperty('set-cookie');
    expect((await getRender(deps(), { workspaceId, renderId })).status).toBe('READY');
  });

  it('四次可重试失败后最终失败；人工重发复用 deliveryId 并成功', async () => {
    const { workspaceId, renderId } = await fixture('cms-writeback-retry');
    sender.queue.push({ status: 500 }, { status: 429 }, { error: new Error(`timeout ${SIGNING_SECRET}`) }, { status: 500 });
    for (let index = 0; index < 4; index += 1) {
      await runNext();
      await promoteRetryableJobs(deps(), { now: new Date(Date.now() + 60_000) });
    }
    const ordered = (await listCmsWritebackAttempts(deps(), { workspaceId, renderId })).sort((a, b) => a.attemptNumber - b.attemptNumber);
    expect(ordered.map((item) => item.status)).toEqual(['FAILED_RETRYABLE', 'FAILED_RETRYABLE', 'FAILED_RETRYABLE', 'FAILED_FINAL']);
    expect(ordered[2]?.errorMessage).toBe('CMS 回写网络请求失败');
    expect(JSON.stringify(ordered[2])).not.toContain(SIGNING_SECRET);
    expect(new Set(ordered.map((item) => item.deliveryId)).size).toBe(1);
    expect(new Set(ordered.map((item) => item.requestBodySha256)).size).toBe(1);
    expect((await getRender(deps(), { workspaceId, renderId })).status).toBe('READY');

    const rotated = await upsertCmsWritebackTarget(deps(), {
      workspaceId,
      request: { callbackUrl: 'https://cms-rotated.example/callback', signingSecret: ROTATED_SIGNING_SECRET },
    });
    sender.queue.push({ status: 204 });
    const retried = await retryCmsWriteback(deps(), { workspaceId, deliveryId: ordered[0]?.deliveryId ?? 'missing' });
    await runNext();
    const recovered = await listCmsWritebackAttempts(deps(), { workspaceId, deliveryId: retried.deliveryId });
    expect(recovered).toHaveLength(5);
    expect(recovered[0]?.status).toBe('SUCCEEDED');
    expect(recovered[0]?.requestUrl).toBe('https://cms-rotated.example/callback');
    expect(recovered[0]?.signatureKeyVersion).toBe(rotated.keyVersion);
    const retryCall = sender.calls.at(-1);
    const retryTimestamp = retryCall?.headers[CMS_WRITEBACK_TIMESTAMP_HEADER] ?? '';
    const retrySignature = createHmac('sha256', ROTATED_SIGNING_SECRET).update(`${retryTimestamp}.${retryCall?.body ?? ''}`).digest('hex');
    expect(retryCall?.url).toBe('https://cms-rotated.example/callback');
    expect(retryCall?.headers[CMS_WRITEBACK_SIGNATURE_HEADER]).toBe(`sha256=${retrySignature}`);
    await expect(retryCmsWriteback(deps(), { workspaceId, deliveryId: retried.deliveryId })).rejects.toMatchObject({ httpStatus: 409 });
  });

  it('3xx 为最终失败；非 CMS Render 不创建回写任务', async () => {
    const { workspaceId, renderId } = await fixture('cms-writeback-redirect');
    sender.queue.push({ status: 302, body: 'x'.repeat(20_000) });
    await runNext();
    const redirectAttempt = (await listCmsWritebackAttempts(deps(), { workspaceId, renderId }))[0];
    expect(redirectAttempt?.status).toBe('FAILED_FINAL');
    expect(redirectAttempt?.responseBodyPreview).toHaveLength(16_384);
    expect(redirectAttempt?.responseTruncated).toBe(true);

    const otherWorkspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: otherWorkspaceId, name: 'non-cms' });
    const channel = await createChannel(deps(), { workspaceId: otherWorkspaceId, input: { name: 'manual' } });
    const project = await createProject(deps(), { workspaceId: otherWorkspaceId, input: { title: 'manual', channelId: channel.id } });
    const otherRender = `rnd_${randomUUID()}`;
    await handle.db.insert(renders).values({
      id: otherRender,
      workspaceId: otherWorkspaceId,
      projectId: project.id,
      profile: 'DRAFT_720',
      status: 'QA',
      input: { projectVersionId: `pv_${randomUUID()}`, masterNarrationId: null, assetVersionIds: [], format: { width: 1280, height: 720, fps: 30 } },
      manifestHash: 'b'.repeat(64),
      outputAssetIds: [],
    });
    await transitionRender({ db: handle.db }, { workspaceId: otherWorkspaceId, renderId: otherRender, to: 'READY' });
    expect(await handle.db.select().from(jobs).where(and(eq(jobs.workspaceId, otherWorkspaceId), eq(jobs.type, 'CMS_WRITEBACK')))).toHaveLength(0);

    const noTarget = await fixture('cms-writeback-no-target', { configureTarget: false });
    expect(await handle.db.select().from(jobs).where(and(eq(jobs.workspaceId, noTarget.workspaceId), eq(jobs.type, 'CMS_WRITEBACK')))).toHaveLength(0);
    expect((await getRender(deps(), { workspaceId: noTarget.workspaceId, renderId: noTarget.renderId })).status).toBe('READY');

    const disabled = await fixture('cms-writeback-disabled', { enabled: false });
    expect(await handle.db.select().from(jobs).where(and(eq(jobs.workspaceId, disabled.workspaceId), eq(jobs.type, 'CMS_WRITEBACK')))).toHaveLength(0);
    expect((await getRender(deps(), { workspaceId: disabled.workspaceId, renderId: disabled.renderId })).status).toBe('READY');
  });

  it('Worker 完成前崩溃后重复发送仍复用 deliveryId', async () => {
    const { workspaceId, renderId } = await fixture('cms-writeback-crash');
    const firstJob = await claimJob(deps(), { workerId, leaseSeconds: 1, types: ['CMS_WRITEBACK'] });
    await expect(executeJob(deps(), new JobHandlerRegistry([cmsWritebackHandler]), {
      workerId,
      leaseSeconds: 1,
      heartbeatIntervalMs: 10_000,
      onPhase: (phase) => { if (phase === 'mid-handler') throw new Error('simulated-crash'); },
    }, firstJob as NonNullable<typeof firstJob>)).rejects.toThrow('simulated-crash');
    await requeueExpiredLeases(deps(), { now: new Date(Date.now() + 5_000) });
    await runNext();
    const attempts = await listCmsWritebackAttempts(deps(), { workspaceId, renderId });
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts.map((item) => item.deliveryId)).size).toBe(1);
    expect(sender.calls).toHaveLength(2);
    expect(new Set(sender.calls.map((call) => call.headers[CMS_WRITEBACK_DELIVERY_HEADER])).size).toBe(1);
  });
});
