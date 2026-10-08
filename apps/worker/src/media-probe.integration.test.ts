import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { MEDIA_PROBE_JOB_TYPE } from '@ancs/contracts';
import { claimJob, confirmUpload, createUploadIntent, getAsset, type DomainDeps } from '@ancs/domain';
import {
  assetVersions,
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
});
