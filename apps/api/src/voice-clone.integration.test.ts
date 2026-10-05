import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { createDb, plans, redactDatabaseUrl, resolveTestDatabaseUrl, runMigrations, voiceClones, voiceConsents, workspaces, type DbHandle } from '@ancs/db';
import { encodeWavPcm16, ensureDefaultPlans, type DomainDeps } from '@ancs/domain';
import { MockVoiceCloneProvider } from '@ancs/providers-mock-tts';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * P10-02 验收（真实 DB + HTTP/SDK + 真实存储 + Mock 克隆 Provider 同构 seam）：
 * - **音质检测**：PASS（清晰语音）/ FAIL（过短、削波）/ 非 WAV → 422（**不伪造检测**）；
 * - **未授权不提交**：无 Consent → 422 且 **Provider 零调用**；撤销后同样拒绝；
 * - **Instant → READY 绑定 VoiceIdentity**；**Professional：SUBMITTED → TRAINING → FAILED(retryable) → retry → READY**；
 * - **退休 / 平台解绑 / Provider 删除可区分**（三个独立时间戳与状态）；
 * - **字段不得混同**（§14.3）：样本 / Consent / provider_voice_id / retention / ownership 各自独立落库；
 * - BYOK 无连接 → 422。
 */

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let rootDir: string;
let storage: LocalObjectStorage;
let cloneProvider: MockVoiceCloneProvider;
const PASSWORD = 'password-1234';

const deps = (): DomainDeps => ({ db: handle.db, storage });

/** 干净语音样本：正弦"人声"（16kHz，给定秒数；幅度 0.3 无削波）。 */
function speakWav(seconds: number, amplitude = 0.3, sampleRate = 16_000): Uint8Array {
  const samples = new Float32Array(Math.round(seconds * sampleRate));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 220 * index) / sampleRate) * amplitude;
  }
  return encodeWavPcm16(samples, sampleRate);
}

/** 削波样本：幅度 1.5（编码 clamp 到满幅 → 大量 |x| ≥ 0.99）。 */
function clippedWav(seconds: number): Uint8Array {
  const samples = new Float32Array(Math.round(seconds * 16_000));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = Math.sin((2 * Math.PI * 220 * index) / 16_000) * 1.5;
  }
  return encodeWavPcm16(samples, 16_000);
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
  rootDir = await mkdtemp(join(tmpdir(), 'ancs-voice-clone-'));
  storage = new LocalObjectStorage({ rootDir, publicBaseUrl: 'http://127.0.0.1:0', signingSecret: 'voice-clone-storage-secret-0123456789' }); // secrets:check-ignore：测试专用假密钥
  auth = createAuth({ db: handle.db, secret: 'voice-clone-secret-0123456789', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥
  cloneProvider = new MockVoiceCloneProvider();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
    voiceClone: { provider: cloneProvider },
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
  await rm(rootDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
  await handle.db.delete(plans);
  await ensureDefaultPlans(deps());
  cloneProvider.instantCalls.length = 0;
  cloneProvider.professionalCalls.length = 0;
  cloneProvider.deletedVoiceIds.length = 0;
});

async function newClient(tag: string): Promise<AncsClient> {
  const email = `${tag}-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: tag });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function makeIdentity(client: AncsClient): Promise<{ workspaceId: string; creatorIdentityId: string }> {
  const workspace = await client.workspaces.create({ name: `声音-${randomUUID().slice(0, 8)}` });
  const identity = await client.creatorIdentities.create(workspace.id, { displayName: '主播' });
  return { workspaceId: workspace.id, creatorIdentityId: identity.id };
}

async function uploadSample(client: AncsClient, workspaceId: string, bytes: Uint8Array, filename = 'sample.wav', contentType = 'audio/wav'): Promise<{ assetId: string; assetVersionId: string }> {
  const asset = await client.assets.upload(workspaceId, { assetType: 'VOICE_AUDIO', filename, contentType, data: bytes });
  const versionId = (asset as unknown as { currentVersionId: string | null }).currentVersionId;
  if (versionId === null) throw new Error('asset 无 currentVersionId');
  return { assetId: asset.id, assetVersionId: versionId };
}

async function expectApiError(promise: Promise<unknown>, status: number, reason?: string): Promise<AncsApiError> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(AncsApiError);
  const apiError = error as AncsApiError;
  expect(apiError.status).toBe(status);
  if (reason !== undefined) expect((apiError.details as { reason?: string }).reason).toBe(reason);
  return apiError;
}

describe('Voice Clone（P10-02）', () => {
  it('音质检测：干净样本 PASS；过短/削波 FAIL（保留可复核）；非 WAV → 422（不伪造检测）', async () => {
    const client = await newClient('vc-quality');
    const { workspaceId, creatorIdentityId } = await makeIdentity(client);

    // 干净 12s → PASS（时长/静音/削波/有效语音全指标）
    const good = await uploadSample(client, workspaceId, speakWav(12));
    const sample = await client.voiceClone.addSample(workspaceId, creatorIdentityId, good);
    expect(sample.quality.verdict).toBe('PASS');
    expect(sample.quality.durationMs).toBeGreaterThanOrEqual(11_500);
    expect(sample.quality.sampleRateHz).toBe(16_000);
    expect(sample.quality.silenceRatio).toBeLessThan(0.1);
    expect(sample.quality.effectiveSpeechRatio).toBeGreaterThan(0.9);
    expect(sample.quality.clippingRatio).toBe(0);

    // 过短 3s → FAIL（TOO_SHORT；样本保留，可复核）
    const short = await uploadSample(client, workspaceId, speakWav(3), 'short.wav');
    const shortSample = await client.voiceClone.addSample(workspaceId, creatorIdentityId, short);
    expect(shortSample.quality.verdict).toBe('FAIL');
    expect(shortSample.quality.findings.some((finding) => finding.code === 'TOO_SHORT')).toBe(true);

    // 削波 → FAIL（CLIPPING）
    const clipped = await uploadSample(client, workspaceId, clippedWav(12), 'clipped.wav');
    const clippedSample = await client.voiceClone.addSample(workspaceId, creatorIdentityId, clipped);
    expect(clippedSample.quality.verdict).toBe('FAIL');
    expect(clippedSample.quality.findings.some((finding) => finding.code === 'CLIPPING')).toBe(true);

    // 非 WAV（伪 mp3 字节）→ 422（明确"不做假检测"，样本不落库）
    const fakeMp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0, 0, 0, 0, 1, 2, 3]); // ID3 头（嗅探为 audio/mpeg）
    const bad = await uploadSample(client, workspaceId, fakeMp3, 'voice.mp3', 'audio/mpeg');
    await expectApiError(client.voiceClone.addSample(workspaceId, creatorIdentityId, bad), 422, 'QUALITY_UNSUPPORTED_FORMAT');
    const listed = await client.voiceClone.samples(workspaceId, creatorIdentityId);
    expect(listed).toHaveLength(3); // 仅三条已登记（伪 mp3 未落库）
  }, 120_000);

  it('未授权不提交：无 Consent → 422 且 **Provider 零调用**；Consent 确认后 Instant → READY 绑定身份；撤销后再次拒绝', async () => {
    const client = await newClient('vc-consent');
    const { workspaceId, creatorIdentityId } = await makeIdentity(client);
    const good = await uploadSample(client, workspaceId, speakWav(12));
    await client.voiceClone.addSample(workspaceId, creatorIdentityId, good);

    // 无 Consent → 422 + Provider 零调用（未授权不提交的硬证明）
    await expectApiError(
      client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'MANAGED' }),
      422,
      'CONSENT_REQUIRED',
    );
    expect(cloneProvider.instantCalls).toHaveLength(0);
    expect(cloneProvider.professionalCalls).toHaveLength(0);

    // 声明文本可展示（版本 + 哈希）
    const statement = await client.voiceClone.consentStatement(workspaceId, creatorIdentityId);
    expect(statement.statement).toContain('授权声明');
    expect(statement.statementHash).toMatch(/^[a-f0-9]{64}$/);

    // Consent 确认 → 提交 INSTANT → READY + 绑定
    const consent = await client.voiceClone.confirmConsent(workspaceId, creatorIdentityId, { subjectType: 'SELF' });
    expect(consent.statementHash).toBe(statement.statementHash);
    const clone = await client.voiceClone.submit(workspaceId, creatorIdentityId, {
      kind: 'INSTANT',
      provider: 'mock-voice',
      mode: 'MANAGED',
      retentionPolicy: '平台保留 30 天（可申请删除）',
      ownershipMetadata: { author: '主播本人', licenseNote: '自有声音' },
    });
    expect(clone.status).toBe('READY');
    expect(clone.providerVoiceId).toMatch(/^mockv_/);
    expect(cloneProvider.instantCalls).toHaveLength(1);
    const state = await client.voiceClone.state(workspaceId, creatorIdentityId);
    expect(state.boundToIdentity).toBe(true);

    // 字段不得混同（§14.3）：独立落库（Consent 独立行；clone 引用 consentId；retention/ownership 独立字段）
    const cloneRows = await handle.db.select().from(voiceClones);
    expect(cloneRows).toHaveLength(1);
    expect(cloneRows[0]?.consentId).toBe(consent.id);
    expect(cloneRows[0]?.retentionPolicy).toBe('平台保留 30 天（可申请删除）');
    expect(cloneRows[0]?.ownershipMetadata).toMatchObject({ author: '主播本人' });
    const consentRows = await handle.db.select().from(voiceConsents);
    expect(consentRows).toHaveLength(1);
    expect(consentRows[0]?.statementHash).toBe(statement.statementHash);

    // 撤销后不可再提交
    await client.voiceClone.revokeConsent(workspaceId, creatorIdentityId);
    await expectApiError(
      client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'MANAGED' }),
      422,
      'CONSENT_REQUIRED',
    );
    expect(cloneProvider.instantCalls).toHaveLength(1); // 仍只有一次（撤销后零新调用）
  }, 120_000);

  it('Professional 训练失败可恢复：SUBMITTED → TRAINING → FAILED(retryable) → retry → READY', async () => {
    const client = await newClient('vc-pro');
    const { workspaceId, creatorIdentityId } = await makeIdentity(client);
    const good = await uploadSample(client, workspaceId, speakWav(65)); // ≥ Professional 建议时长
    await client.voiceClone.addSample(workspaceId, creatorIdentityId, good);
    await client.voiceClone.confirmConsent(workspaceId, creatorIdentityId, { subjectType: 'SELF' });

    // 脚本化训练状态：TRAINING → FAILED（可重试）→ READY
    cloneProvider.queueStatuses('TRAINING', 'FAILED', 'READY');

    const submitted = await client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'PROFESSIONAL', provider: 'mock-voice', mode: 'MANAGED' });
    expect(submitted.status).toBe('SUBMITTED');
    expect(submitted.providerJobId).toMatch(/^mockjob_/);

    const training = await client.voiceClone.refresh(workspaceId, creatorIdentityId);
    expect(training.status).toBe('TRAINING');

    const failed = await client.voiceClone.refresh(workspaceId, creatorIdentityId);
    expect(failed.status).toBe('FAILED');
    expect(failed.failure?.retryable).toBe(true);
    expect(failed.failure?.code).toBe('TRAINING_FAILED');

    // 重试（样本与 Consent 保留）→ READY
    const retried = await client.voiceClone.retry(workspaceId, creatorIdentityId);
    expect(retried.status).toBe('SUBMITTED');
    const ready = await client.voiceClone.refresh(workspaceId, creatorIdentityId);
    expect(ready.status).toBe('READY');
    expect(ready.providerVoiceId).toMatch(/^mockv_/);
    expect((await client.voiceClone.state(workspaceId, creatorIdentityId)).boundToIdentity).toBe(true);
  }, 120_000);

  it('生命周期三态可区分：退休（本地保留）→ 平台解绑（Provider 保留）→ Provider 删除（不可恢复）', async () => {
    const client = await newClient('vc-lifecycle');
    const { workspaceId, creatorIdentityId } = await makeIdentity(client);
    const good = await uploadSample(client, workspaceId, speakWav(12));
    await client.voiceClone.addSample(workspaceId, creatorIdentityId, good);
    await client.voiceClone.confirmConsent(workspaceId, creatorIdentityId, { subjectType: 'SELF' });
    const ready = await client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'MANAGED' });
    const voiceId = ready.providerVoiceId;

    // 退休：本地状态 RETIRED + retiredAt；**Provider 侧未删除**
    const retired = await client.voiceClone.retire(workspaceId, creatorIdentityId);
    expect(retired.status).toBe('RETIRED');
    expect(retired.retiredAt).not.toBeNull();
    expect(retired.providerDeletedAt).toBeNull();
    expect(cloneProvider.deletedVoiceIds).toHaveLength(0);

    // 平台解绑：UNLINKED + unlinkedAt（独立于退休时间）；身份解除绑定；Provider 侧仍未删除
    const unlinked = await client.voiceClone.unlink(workspaceId, creatorIdentityId);
    expect(unlinked.status).toBe('UNLINKED');
    expect(unlinked.unlinkedAt).not.toBeNull();
    expect(unlinked.retiredAt).not.toBeNull(); // 退休时间保留（历史）
    expect(unlinked.unlinkedAt).not.toBe(unlinked.retiredAt);
    expect(cloneProvider.deletedVoiceIds).toHaveLength(0);
    expect((await client.voiceClone.state(workspaceId, creatorIdentityId)).boundToIdentity).toBe(false);

    // Provider 删除：PROVIDER_DELETED + providerDeletedAt；真实调用 deleteVoice；重复删除 409
    const deleted = await client.voiceClone.deleteProviderVoice(workspaceId, creatorIdentityId);
    expect(deleted.status).toBe('PROVIDER_DELETED');
    expect(deleted.providerDeletedAt).not.toBeNull();
    expect(cloneProvider.deletedVoiceIds).toEqual([voiceId]);
    await expectApiError(client.voiceClone.deleteProviderVoice(workspaceId, creatorIdentityId), 409);
    // 删除后不得再退休/解绑（状态明确）
    await expectApiError(client.voiceClone.retire(workspaceId, creatorIdentityId), 409);
  }, 120_000);

  it('门槛与边界：无合格样本 422；BYOK 无连接 422；非法样本引用 404', async () => {
    const client = await newClient('vc-gates');
    const { workspaceId, creatorIdentityId } = await makeIdentity(client);
    await client.voiceClone.confirmConsent(workspaceId, creatorIdentityId, { subjectType: 'AUTHORIZED_OTHER', notes: '持授权书' });

    // 无样本 → SAMPLES_REQUIRED
    await expectApiError(
      client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'MANAGED' }),
      422,
      'SAMPLES_REQUIRED',
    );

    // 仅 FAIL 样本 → 仍 SAMPLES_REQUIRED（不合格样本不提交）
    const short = await uploadSample(client, workspaceId, speakWav(3), 'short.wav');
    await client.voiceClone.addSample(workspaceId, creatorIdentityId, short);
    await expectApiError(
      client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'MANAGED' }),
      422,
      'SAMPLES_REQUIRED',
    );

    // 合格样本 + BYOK 无连接 → BYOK_CONNECTION_REQUIRED
    const good = await uploadSample(client, workspaceId, speakWav(12));
    await client.voiceClone.addSample(workspaceId, creatorIdentityId, good);
    await expectApiError(
      client.voiceClone.submit(workspaceId, creatorIdentityId, { kind: 'INSTANT', provider: 'mock-voice', mode: 'BYOK' }),
      422,
      'BYOK_CONNECTION_REQUIRED',
    );

    // 非法样本引用（跨工作区/不存在）→ 404
    await expectApiError(
      client.voiceClone.addSample(workspaceId, creatorIdentityId, { assetId: 'ast_missing', assetVersionId: 'asv_missing' }),
      404,
    );
  }, 120_000);
});
