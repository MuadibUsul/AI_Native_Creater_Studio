import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { editRequestSchema, legacyMillisecondsToMediaTime } from '@ancs/contracts';
import {
  assets,
  assetVersions,
  createDb,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  clipInstanceToLegacyProjection,
  compileLegacyClipProjectionUpdate,
  createChannel,
  createClip,
  createProject,
  createSequence,
  createTrack,
  getProject,
  listProjectMediaViews,
  processEdits,
  upsertMediaDerivativeState,
  type DomainDeps,
} from './index.js';

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const linear = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try { await handle.pool.query('select 1'); }
  catch (error) {
    await handle.close();
    throw new Error(`Cannot connect to test database ${redactDatabaseUrl(url)}`, { cause: error });
  }
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });
beforeEach(async () => { await handle.db.delete(workspaces); });

async function addVersion(input: {
  workspaceId: string;
  projectId: string;
  tag: string;
  checksum: string;
  width?: number;
  height?: number;
}) {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD',
    status: 'READY',
    retentionClass: 'PROJECT',
    license: { kind: 'OWNED' },
    currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId,
    assetId,
    workspaceId: input.workspaceId,
    versionNumber: 1,
    storageKey: `n01-10/${input.tag}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    checksumSha256: input.checksum,
    durationMs: 12_000,
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    status: 'READY',
    metadata: { codec: 'h264' },
  });
  return { assetId, assetVersionId };
}

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'N01-10 媒体映射测试' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '媒体栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '媒体工程', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const source = await addVersion({ workspaceId, projectId: project.id, tag: 'source', checksum: 'a'.repeat(64) });
  const sequence = await createSequence(deps(), {
    workspaceId, projectId: project.id,
    input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(20_000) },
  });
  const firstTrack = await createTrack(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  const secondTrack = await createTrack(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { kind: 'VIDEO', position: 1, name: 'V2' },
  });
  const first = await createClip(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: firstTrack.id, assetVersionId: source.assetVersionId, sourceStreamId: 'video-main', sourceRange: range(0, 5_000), sequenceRange: range(0, 5_000), timeMapping: linear },
  });
  const second = await createClip(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: secondTrack.id, assetVersionId: source.assetVersionId, sourceStreamId: 'video-main', sourceRange: range(5_000, 10_000), sequenceRange: range(5_000, 10_000), timeMapping: linear },
  });
  return { workspaceId, projectId: project.id, source, sequence, first, second };
}

describe('N01-10 MediaSource and ClipInstance authority', () => {
  it('maps multiple clip instances to one immutable source and updates derivative state without changing source facts', async () => {
    const f = await fixture();
    const initial = await listProjectMediaViews(deps(), f);
    expect(initial.mediaSources).toMatchObject([{
      id: f.source.assetVersionId,
      sourceAssetVersionId: f.source.assetVersionId,
      checksumSha256: 'a'.repeat(64),
      mediaMetadata: { codec: 'h264' },
      derivatives: [],
    }]);
    expect(initial.clipInstances).toHaveLength(2);
    expect(initial.clipInstances.map((clip) => clip.sourceId)).toEqual([f.source.assetVersionId, f.source.assetVersionId]);

    const pending = await upsertMediaDerivativeState(deps(), {
      workspaceId: f.workspaceId,
      sourceAssetVersionId: f.source.assetVersionId,
      kind: 'ANALYSIS',
      profileKey: 'scene-cuts-v1',
      status: 'PROCESSING',
      metadata: { progress: 'started' },
    });
    const ready = await upsertMediaDerivativeState(deps(), {
      workspaceId: f.workspaceId,
      sourceAssetVersionId: f.source.assetVersionId,
      kind: 'ANALYSIS',
      profileKey: 'scene-cuts-v1',
      status: 'READY',
      metadata: { sceneCutsMs: [1000, 3000] },
    });
    expect(ready.id).toBe(pending.id);
    const proxy = await addVersion({
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      tag: 'proxy-720p',
      checksum: 'b'.repeat(64),
      width: 1280,
      height: 720,
    });
    await upsertMediaDerivativeState(deps(), {
      workspaceId: f.workspaceId,
      sourceAssetVersionId: f.source.assetVersionId,
      kind: 'PROXY',
      profileKey: '720p',
      status: 'READY',
      derivativeAssetVersionId: proxy.assetVersionId,
    });
    const sourceRow = (await handle.db.select().from(assetVersions).where(eq(assetVersions.id, f.source.assetVersionId)).limit(1))[0]!;
    expect(sourceRow).toMatchObject({ checksumSha256: 'a'.repeat(64), storageKey: 'n01-10/source.mp4' });
    const after = await listProjectMediaViews(deps(), f);
    expect(after.mediaSources[0]?.derivatives).toMatchObject([{
      id: pending.id,
      status: 'READY',
      sourceChecksumSha256: 'a'.repeat(64),
      metadata: { sceneCutsMs: [1000, 3000] },
    }, {
      kind: 'PROXY',
      status: 'READY',
      derivativeAssetVersionId: proxy.assetVersionId,
      sourceChecksumSha256: 'a'.repeat(64),
    }]);
  });

  it('compiles legacy millisecond updates into canonical edits without overwriting source identity or new clip fields', async () => {
    const f = await fixture();
    const current = (await listProjectMediaViews(deps(), f)).clipInstances.find((clip) => clip.clipId === f.first.id)!;
    const legacy = clipInstanceToLegacyProjection(current);
    expect(legacy).toMatchObject({ clipId: f.first.id, assetVersionId: f.source.assetVersionId, sourceInMs: 0, sourceOutMs: 5000 });
    const operation = compileLegacyClipProjectionUpdate(current, {
      sourceInMs: 1_000,
      sourceOutMs: 6_000,
      sequenceStartMs: 2_000,
      sequenceEndMs: 7_000,
    });
    const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    await processEdits(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      actor: { type: 'USER', id: 'u_n01_10' },
      request: editRequestSchema.parse({
        schemaVersion: '1.0',
        baseProjectRevision: project.revision,
        expectedSceneRevisions: {},
        operations: [operation],
        idempotencyKey: `idem_n01_10_${randomUUID()}`,
      }),
    });
    const updated = (await listProjectMediaViews(deps(), f)).clipInstances.find((clip) => clip.clipId === f.first.id)!;
    expect(updated).toMatchObject({
      sourceKind: 'MEDIA_SOURCE',
      sourceId: f.source.assetVersionId,
      sourceStreamId: 'video-main',
      sourceRange: range(1_000, 6_000),
      sequenceRange: range(2_000, 7_000),
    });
    expect((await handle.db.select().from(assetVersions).where(eq(assetVersions.id, f.source.assetVersionId)).limit(1))[0]).toMatchObject({
      checksumSha256: 'a'.repeat(64),
      storageKey: 'n01-10/source.mp4',
    });
  });

  it('fails closed for lossy legacy projection, invalid proxy output and cross-tenant derivatives', async () => {
    const f = await fixture();
    const current = (await listProjectMediaViews(deps(), f)).clipInstances[0]!;
    const lossyFailure = (() => {
      try {
        clipInstanceToLegacyProjection({
          ...current,
          sourceRange: { start: { ticks: '1', timebase: { num: 1, den: 24_000 } }, end: current.sourceRange.end },
        });
      } catch (error) { return error; }
      return null;
    })();
    expect(lossyFailure).toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { reason: 'LEGACY_TIME_PRECISION_LOSS' } });
    await expect(upsertMediaDerivativeState(deps(), {
      workspaceId: f.workspaceId,
      sourceAssetVersionId: f.source.assetVersionId,
      kind: 'PROXY',
      profileKey: '720p',
      status: 'READY',
    })).rejects.toMatchObject({ code: 'VALIDATION_FAILED', details: { reason: 'PROXY_OUTPUT_REQUIRED' } });

    const other = await fixture();
    await expect(upsertMediaDerivativeState(deps(), {
      workspaceId: f.workspaceId,
      sourceAssetVersionId: f.source.assetVersionId,
      kind: 'PROXY',
      profileKey: '720p',
      status: 'READY',
      derivativeAssetVersionId: other.source.assetVersionId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
