import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MEDIA_INDEX_JOB_TYPE, MEDIA_INDEX_PROCESSOR_VERSION, MEDIA_PROBE_JOB_TYPE, MEDIA_PROXY_JOB_TYPE, mapProxyPtsToSourcePts, mapSourcePtsToProxyPts, type SourceMediaIndexer } from '@ancs/contracts';
import { claimJob, confirmUpload, createAssetPlaybackUrl, createUploadIntent, getAsset, listAssets, listMediaIndex, rebuildMediaIndex, rebuildMediaProxy, searchMediaSegments, type DomainDeps } from '@ancs/domain';
import {
  assetVersions,
  mediaDerivatives,
  mediaIndexEntries,
  mediaIndexRuns,
  createDb,
  jobs,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { createDefaultRegistry } from './handlers.js';
import { executeJob } from './runner.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createFfmpegMediaProxyTranscoder } from './source-media-transcoder-process.js';
import { createFfmpegMediaIndexer } from './source-media-indexer-process.js';

let handle: DbHandle;
let storageRoot: string;
let storage: LocalObjectStorage;
const fixtures = resolve('packages/testing/fixtures/media-v04');
const deps = (): DomainDeps => ({ db: handle.db, storage });

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
  storageRoot = await mkdtemp(join(tmpdir(), 'ancs-media-probe-integration-'));
  storage = new LocalObjectStorage({
    rootDir: storageRoot,
    publicBaseUrl: 'http://127.0.0.1:3999',
    signingSecret: 'media-probe-test-secret-0123456789', // secrets:check-ignore：测试专用假密钥
  });
});

afterAll(async () => {
  await handle.close();
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(async () => {
  await handle.db.delete(workspaces);
});

async function uploadObject(bytes: Uint8Array, filename: string): Promise<{ workspaceId: string; assetId: string; versionId: string }> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: '媒体探测租户' });
  const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
  const intent = await createUploadIntent(deps(), {
    workspaceId,
    userId: null,
    input: { assetType: 'USER_UPLOAD', filename, contentType: 'video/mp4', sizeBytes: bytes.byteLength, checksumSha256 },
  });
  const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id)).limit(1))[0]!;
  await storage.putObject(version.storageKey, bytes);
  const confirmed = await confirmUpload(deps(), {
    workspaceId,
    assetId: intent.asset.id,
    input: { checksumSha256 },
  });
  expect(confirmed.status).toBe('PROCESSING');
  expect(confirmed.versions[0]?.probeStatus).toBe('PENDING');
  return { workspaceId, assetId: intent.asset.id, versionId: version.id };
}

async function executeProbe(workspaceId: string): Promise<void> {
  const claimed = await claimJob(deps(), { workerId: 'media-probe-worker', leaseSeconds: 120, types: [MEDIA_PROBE_JOB_TYPE] });
  expect(claimed).not.toBeNull();
  const outcome = await executeJob(
    deps(),
    createDefaultRegistry({ sourceMediaProbe: createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }) }),
    { workerId: 'media-probe-worker', leaseSeconds: 120, heartbeatIntervalMs: 30_000 },
    claimed!,
  );
  expect(outcome).toBe('succeeded');
  const persisted = (await handle.db.select().from(jobs).where(and(eq(jobs.id, claimed!.id), eq(jobs.workspaceId, workspaceId))).limit(1))[0];
  expect(persisted?.status).toBe('SUCCEEDED');
}

async function executeProxy(workspaceId: string): Promise<void> {
  const claimed = await claimJob(deps(), { workerId: 'media-proxy-worker', leaseSeconds: 120, types: [MEDIA_PROXY_JOB_TYPE] });
  expect(claimed).not.toBeNull();
  const outcome = await executeJob(
    deps(),
    createDefaultRegistry({ sourceMediaTranscoder: createFfmpegMediaProxyTranscoder({ timeoutMs: 60_000 }) }),
    { workerId: 'media-proxy-worker', leaseSeconds: 120, heartbeatIntervalMs: 30_000 },
    claimed!,
  );
  expect(outcome).toBe('succeeded');
  const persisted = (await handle.db.select().from(jobs).where(and(eq(jobs.id, claimed!.id), eq(jobs.workspaceId, workspaceId))).limit(1))[0];
  expect(persisted?.status).toBe('SUCCEEDED');
}

async function executeIndex(workspaceId: string, indexer: SourceMediaIndexer = createFfmpegMediaIndexer({ timeoutMs: 60_000 })): Promise<'succeeded' | 'failed' | 'cancelled' | 'cancel_failed'> {
  const claimed = await claimJob(deps(), { workerId: 'media-index-worker', leaseSeconds: 120, types: [MEDIA_INDEX_JOB_TYPE] });
  expect(claimed).not.toBeNull();
  const outcome = await executeJob(
    deps(),
    createDefaultRegistry({ sourceMediaIndexer: indexer }),
    { workerId: 'media-index-worker', leaseSeconds: 120, heartbeatIntervalMs: 30_000 },
    claimed!,
  );
  const persisted = (await handle.db.select().from(jobs).where(and(eq(jobs.id, claimed!.id), eq(jobs.workspaceId, workspaceId))).limit(1))[0];
  expect(persisted).toBeDefined();
  return outcome;
}

describe('N02-02 media probe worker', () => {
  it('upload confirmation and probe job are atomic; real VFR probe makes the asset READY', { timeout: 60_000 }, async () => {
    const bytes = await readFile(join(fixtures, 'clip-d-synthetic-vfr.mp4'));
    const created = await uploadObject(bytes, 'source-with-wrong-name.mov.mp4');
    expect(await handle.db.select().from(jobs).where(eq(jobs.type, MEDIA_PROBE_JOB_TYPE))).toHaveLength(1);

    await executeProbe(created.workspaceId);
    const detail = await getAsset(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    const version = detail.versions.find((candidate) => candidate.id === created.versionId)!;
    expect(detail.status).toBe('READY');
    expect(version.probeStatus).toBe('READY');
    expect(version.mediaProbe?.streams.find((stream) => stream.type === 'VIDEO')).toMatchObject({
      codecName: 'h264', cadence: 'VARIABLE', sampledPtsDeltaTicks: expect.arrayContaining(['512', '1024']),
    });
    expect(version.mediaProbe?.capabilities).toMatchObject({ decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE' });
  });

  it('V6-1: a byte-identical upload reuses the probe result, copies duration, and schedules its own analysis runs', { timeout: 60_000 }, async () => {
    const bytes = await readFile(join(fixtures, 'clip-d-synthetic-vfr.mp4'));
    const first = await uploadObject(bytes, 'first.mp4');
    await executeProbe(first.workspaceId);
    const firstVersion = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, first.versionId)))[0]!;
    expect(firstVersion.durationMs).toBeGreaterThan(0);

    // 同一工作区再传一次相同字节（不带校验值 → 不在意图阶段去重，在确认阶段复用对象）
    const intent = await createUploadIntent(deps(), { workspaceId: first.workspaceId, userId: null, input: { assetType: 'USER_UPLOAD', filename: 'again.mp4', contentType: 'video/mp4', sizeBytes: bytes.byteLength } });
    const secondVersion = (await handle.db.select().from(assetVersions).where(eq(assetVersions.assetId, intent.asset.id)).limit(1))[0]!;
    await storage.putObject(secondVersion.storageKey, bytes);
    const confirmed = await confirmUpload(deps(), { workspaceId: first.workspaceId, assetId: intent.asset.id, input: {} });
    expect(confirmed.status).toBe('READY');
    const reused = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, secondVersion.id)))[0]!;
    expect(reused).toMatchObject({ durationMs: firstVersion.durationMs, width: firstVersion.width, height: firstVersion.height, probeStatus: 'READY' });
    // 新版本有自己的代理与索引任务（AI 和界面按版本读取分析结果）
    const queued = await handle.db.select().from(jobs).where(eq(jobs.workspaceId, first.workspaceId));
    const forSecond = queued.filter((job) => JSON.stringify(job.input).includes(secondVersion.id)).map((job) => job.type).sort();
    expect(forSecond).toEqual(expect.arrayContaining([MEDIA_INDEX_JOB_TYPE, MEDIA_PROXY_JOB_TYPE]));
    expect(queued.filter((job) => job.type === MEDIA_PROBE_JOB_TYPE)).toHaveLength(1);
  });

  it('corrupt MP4 signature is not marked usable and the immutable original remains available for recovery', { timeout: 60_000 }, async () => {
    const bytes = Buffer.from([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0]);
    const created = await uploadObject(bytes, 'corrupt.mp4');
    await executeProbe(created.workspaceId);
    const detail = await getAsset(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    const version = detail.versions[0]!;
    expect(detail.status).toBe('FAILED');
    expect(version.status).toBe('READY');
    expect(version.probeStatus).toBe('FAILED');
    expect(version.mediaProbe?.decodeCheck.errorCode).toBe('INVALID_OR_UNSUPPORTED_MEDIA');
    expect(version.mediaProbe?.capabilities.preview).toBe('UNAVAILABLE');
    expect((await storage.probeObject(version.storageKey)).exists).toBe(true);
  });

  it('generates a VFR editing proxy, preserves the source and rebuilds a missing derivative', { timeout: 120_000 }, async () => {
    const bytes = await readFile(join(fixtures, 'clip-d-synthetic-vfr.mp4'));
    const created = await uploadObject(bytes, 'vfr-source.mp4');
    const sourceBefore = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, created.versionId)).limit(1))[0]!;
    await executeProbe(created.workspaceId);
    expect(await handle.db.select().from(jobs).where(eq(jobs.type, MEDIA_PROXY_JOB_TYPE))).toHaveLength(1);
    await executeProxy(created.workspaceId);

    const derivative = (await handle.db.select().from(mediaDerivatives).where(eq(mediaDerivatives.sourceAssetVersionId, created.versionId)).limit(1))[0]!;
    expect(derivative).toMatchObject({ kind: 'PROXY', profileKey: 'web-edit-video-720p-v1', status: 'READY', sourceChecksumSha256: sourceBefore.checksumSha256 });
    const playback = await createAssetPlaybackUrl(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    expect(playback).toMatchObject({ rendition: 'PROXY', proxyStatus: 'READY', mimeType: 'video/mp4' });
    expect((await listAssets(deps(), { workspaceId: created.workspaceId })).map((asset) => asset.id)).toEqual([created.assetId]);
    const videoMapping = playback.timeMappings.find((mapping) => mapping.streamType === 'VIDEO')!;
    expect(videoMapping.sourceTimeBase).toEqual({ numerator: 1, denominator: 15_360 });
    for (const anchor of videoMapping.anchors) {
      expect(mapSourcePtsToProxyPts(videoMapping, anchor.sourcePts)).toBe(anchor.proxyPts);
      expect(mapProxyPtsToSourcePts(videoMapping, anchor.proxyPts)).toBe(anchor.sourcePts);
    }
    const output = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, derivative.derivativeAssetVersionId!)).limit(1))[0]!;
    await storage.deleteObject(output.storageKey);
    const missing = await createAssetPlaybackUrl(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    expect(missing).toMatchObject({ rendition: 'ORIGINAL', proxyStatus: 'MISSING' });
    const queued = await rebuildMediaProxy(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    expect(queued).toMatchObject({ rendition: 'ORIGINAL', proxyStatus: 'PENDING' });
    await executeProxy(created.workspaceId);
    expect(await createAssetPlaybackUrl(deps(), { workspaceId: created.workspaceId, assetId: created.assetId })).toMatchObject({ rendition: 'PROXY', proxyStatus: 'READY' });
    const sourceAfter = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, created.versionId)).limit(1))[0]!;
    expect(sourceAfter).toMatchObject({ storageKey: sourceBefore.storageKey, checksumSha256: sourceBefore.checksumSha256, sizeBytes: sourceBefore.sizeBytes });
    expect((await storage.probeObject(sourceAfter.storageKey)).exists).toBe(true);
  });

  it('builds a paginated source-time index and keeps playable media intact when a rebuild fails', { timeout: 150_000 }, async () => {
    const bytes = await readFile(join(fixtures, 'clip-a-24000-1001.mp4'));
    const created = await uploadObject(bytes, 'indexed-source.mp4');
    await executeProbe(created.workspaceId);
    expect(await handle.db.select().from(jobs).where(eq(jobs.type, MEDIA_INDEX_JOB_TYPE))).toHaveLength(1);
    expect(await executeIndex(created.workspaceId)).toBe('succeeded');
    expect(await handle.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.sourceAssetVersionId, created.versionId), eq(mediaIndexRuns.processorVersion, MEDIA_INDEX_PROCESSOR_VERSION)))).toHaveLength(1);
    const persistedEntries = await handle.db.select().from(mediaIndexEntries);
    expect(persistedEntries.some((entry) => entry.kind === 'THUMBNAIL' && entry.storageKey !== null)).toBe(true);
    expect(persistedEntries.some((entry) => entry.kind === 'WAVEFORM')).toBe(true);
    expect(persistedEntries.some((entry) => entry.kind === 'SHOT')).toBe(true);
    expect(await searchMediaSegments(deps(), { workspaceId: created.workspaceId, query: '镜头 1' })).toMatchObject({ items: [{ assetId: created.assetId, modality: 'VISUAL', evidence: 'OBSERVATION', contentTreatment: 'REFERENCE_DATA_ONLY' }] });

    const first = await listMediaIndex(deps(), { workspaceId: created.workspaceId, assetId: created.assetId, kind: 'THUMBNAIL', limit: 1 });
    expect(first).toMatchObject({ status: 'READY', items: [{ kind: 'THUMBNAIL', previewUrl: expect.stringContaining('/api/v1/storage/download?token=') }] });
    expect(first.items[0]).not.toHaveProperty('storageKey');
    const otherWorkspaceId = `ws_${randomUUID()}`;
    await handle.db.insert(workspaces).values({ id: otherWorkspaceId, name: '其他租户' });
    await expect(listMediaIndex(deps(), { workspaceId: otherWorkspaceId, assetId: created.assetId })).rejects.toThrow('asset not found');
    if (first.nextCursor !== null) {
      const second = await listMediaIndex(deps(), { workspaceId: created.workspaceId, assetId: created.assetId, kind: 'THUMBNAIL', cursor: Number(first.nextCursor), limit: 1 });
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    }

    await rebuildMediaIndex(deps(), { workspaceId: created.workspaceId, assetId: created.assetId });
    const failing: SourceMediaIndexer = { kind: 'scripted-failure', async index() { throw new Error('decoder failed with secret path'); } };
    expect(await executeIndex(created.workspaceId, failing)).toBe('failed');
    const failed = await listMediaIndex(deps(), { workspaceId: created.workspaceId, assetId: created.assetId, limit: 1 });
    expect(failed.status).toBe('FAILED');
    expect(await createAssetPlaybackUrl(deps(), { workspaceId: created.workspaceId, assetId: created.assetId })).toMatchObject({ rendition: 'ORIGINAL' });
    expect((await storage.probeObject((await getAsset(deps(), { workspaceId: created.workspaceId, assetId: created.assetId })).versions[0]!.storageKey)).exists).toBe(true);
  });
});
