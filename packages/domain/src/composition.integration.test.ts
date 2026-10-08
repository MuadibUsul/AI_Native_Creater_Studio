import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { legacyMillisecondsToMediaTime } from '@ancs/contracts';
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
  assembleProjectDocument,
  createChannel,
  createClip,
  createProject,
  createSequence,
  createTrack,
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

async function fixture(tag: string) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: `N01-03 ${tag}` });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '剪辑栏目' } });
  const project = await createProject(deps(), {
    workspaceId,
    input: { title: `工程 ${tag}`, channelId: channel.id, mode: 'FOOTAGE_EDIT' },
  });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId,
    workspaceId,
    projectId: project.id,
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
    workspaceId,
    versionNumber: 1,
    storageKey: `n01-03/${assetVersionId}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 1000,
    checksumSha256: '0'.repeat(64),
    durationMs: 12_000,
    width: 1920,
    height: 1080,
    status: 'READY',
  });
  return { workspaceId, projectId: project.id, assetVersionId };
}

describe('N01-03 normalized Sequence / Track / Clip', () => {
  it('reuses one source in different ranges and allows overlap across tracks with AV grouping and parent references', async () => {
    const f = await fixture('reuse');
    const sequence = await createSequence(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      input: { name: '主序列', frameRate: { num: 30000, den: 1001 }, duration: mt(20_000) },
    });
    const v1 = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
    const v2 = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 1, name: 'V2' } });
    const avGroupId = `avg_${randomUUID()}`;
    const first = await createClip(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: sequence.id,
      input: { trackId: v1.id, assetVersionId: f.assetVersionId, sourceRange: range(0, 4_000), sequenceRange: range(0, 4_000), timeMapping: linear, avGroupId },
    });
    const second = await createClip(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      sequenceId: sequence.id,
      input: { trackId: v2.id, assetVersionId: f.assetVersionId, sourceRange: range(4_000, 8_000), sequenceRange: range(2_000, 6_000), timeMapping: linear, avGroupId, parentClipId: first.id },
    });

    expect(first.assetVersionId).toBe(second.assetVersionId);
    expect(first.sourceRange).not.toEqual(second.sourceRange);
    expect(second.parentClipId).toBe(first.id);
    expect(second.avGroupId).toBe(avGroupId);
    const document = await assembleProjectDocument(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(document.composition.sequences.map((item) => item.id)).toEqual([sequence.id]);
    expect(document.composition.tracks).toHaveLength(2);
    expect(document.composition.clips).toHaveLength(2);
    expect(document.composition.sequenceId).toBe(sequence.id);
  });

  it('rejects out-of-bounds source ranges, mismatched time maps and cross-tenant asset versions', async () => {
    const f = await fixture('bounds');
    const sequence = await createSequence(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(20_000) } });
    const track = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });

    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id,
      input: { trackId: track.id, assetVersionId: f.assetVersionId, sourceRange: range(10_000, 13_000), sequenceRange: range(0, 3_000), timeMapping: linear },
    })).rejects.toMatchObject({ details: { reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' } });

    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id,
      input: { trackId: track.id, assetVersionId: f.assetVersionId, sourceRange: range(0, 4_000), sequenceRange: range(0, 2_000), timeMapping: linear },
    })).rejects.toMatchObject({ details: { reason: 'TIME_MAPPING_MISMATCH' } });

    const other = await fixture('other-tenant');
    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id,
      input: { trackId: track.id, assetVersionId: other.assetVersionId, sourceRange: range(0, 4_000), sequenceRange: range(0, 4_000), timeMapping: linear },
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await handle.db.update(assetVersions).set({ checksumSha256: null }).where(eq(assetVersions.id, f.assetVersionId));
    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: sequence.id,
      input: { trackId: track.id, assetVersionId: f.assetVersionId, sourceRange: range(0, 4_000), sequenceRange: range(0, 4_000), timeMapping: linear },
    })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', details: { reason: 'SOURCE_CHECKSUM_MISSING' } });
  });

  it('rejects direct and indirect nested sequence cycles', async () => {
    const f = await fixture('cycles');
    const a = await createSequence(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, input: { name: 'A', frameRate: { num: 30, den: 1 }, duration: mt(10_000) } });
    const b = await createSequence(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, input: { name: 'B', frameRate: { num: 30, den: 1 }, duration: mt(10_000) } });
    const aTrack = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: a.id, input: { kind: 'VIDEO', position: 0, name: 'A V1' } });
    const bTrack = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: b.id, input: { kind: 'VIDEO', position: 0, name: 'B V1' } });

    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: a.id,
      input: { trackId: aTrack.id, nestedSequenceId: a.id, sourceRange: range(0, 5_000), sequenceRange: range(0, 5_000), timeMapping: linear },
    })).rejects.toMatchObject({ details: { reason: 'SEQUENCE_CYCLE' } });

    await createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: a.id,
      input: { trackId: aTrack.id, nestedSequenceId: b.id, sourceRange: range(0, 5_000), sequenceRange: range(0, 5_000), timeMapping: linear },
    });
    await expect(createClip(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: b.id,
      input: { trackId: bTrack.id, nestedSequenceId: a.id, sourceRange: range(0, 5_000), sequenceRange: range(0, 5_000), timeMapping: linear },
    })).rejects.toMatchObject({ details: { reason: 'SEQUENCE_CYCLE' } });
  });
});
