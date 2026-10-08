import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { legacyMillisecondsToMediaTime } from '@ancs/contracts';
import {
  assets,
  assetVersions,
  createDb,
  editEvents,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  compileEditOperationsV2,
  createAnimationBinding,
  createAudioRegion,
  createChannel,
  createClip,
  createProject,
  createSequence,
  createTrack,
  getProject,
  listProjectComposition,
  listProjectCompositionObjects,
  processEditsV2,
  type DomainDeps,
} from './index.js';

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const linear = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };
const params = (values: Record<string, unknown> = {}) => ({ schemaVersion: '1.0', values });

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

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'N01-11 操作编译测试' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '操作栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '操作工程', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD',
    status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId, versionNumber: 1, storageKey: `n01-11/${assetVersionId}.mp4`,
    mimeType: 'video/mp4', sizeBytes: 1000, checksumSha256: 'b'.repeat(64), durationMs: 20_000,
    width: 1920, height: 1080, status: 'READY',
  });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) } });
  const videoTrack = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const audioTrack = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
  const clip = await createClip(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: videoTrack.id, assetVersionId, sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000), timeMapping: linear },
  });
  const audio = await createAudioRegion(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: audioTrack.id, timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, localRange: range(0, 5_000), sourceStreamId: 'main', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0), parameters: params() },
  });
  const animation = await createAnimationBinding(deps(), {
    workspaceId, projectId: project.id,
    input: { targetKind: 'AUDIO_REGION', targetId: audio.id, propertyPath: 'audio.gain', parameterSchemaVersion: '1.0', timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, keyframes: [
      { time: mt(0), value: 0, interpolation: 'LINEAR' },
      { time: mt(4_000), value: -3, interpolation: 'HOLD' },
    ] },
  });
  return { workspaceId, projectId: project.id, sequence, videoTrack, clip, audio, animation };
}

describe('N01-11 Edit Operation v2 compiler', () => {
  it('produces identical canonical edits for GUI, shortcut and Agent and executes them through one transaction path', async () => {
    const f = await fixture();
    const source = { op: 'move_clip', clipId: f.clip.id, sequenceRange: range(2_000, 12_000) };
    const compiled = await Promise.all((['GUI', 'SHORTCUT', 'AGENT'] as const).map((entrypoint) => compileEditOperationsV2(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, entrypoint, operations: [source],
    })));
    expect(compiled[1]).toEqual(compiled[0]);
    expect(compiled[2]).toEqual(compiled[0]);
    expect(compiled[0]).toEqual([{ op: 'update_clip', clipId: f.clip.id, changes: { sequenceRange: range(2_000, 12_000) } }]);

    const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    const request = {
      schemaVersion: '1.0', baseProjectRevision: project.revision, expectedSceneRevisions: {},
      operations: [
        { op: 'trim_clip', clipId: f.clip.id, sourceRange: range(1_000, 7_000), sequenceRange: range(0, 6_000) },
        { op: 'set_audio_gain', audioRegionId: f.audio.id, gainDb: -8 },
        { op: 'set_audio_fade', audioRegionId: f.audio.id, fadeIn: mt(500), fadeOut: mt(750) },
      ],
      idempotencyKey: `idem_n01_11_${randomUUID()}`,
    };
    const first = await processEditsV2(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      actor: { type: 'USER', id: 'u_n01_11' },
      entrypoint: 'GUI',
      request,
    });
    expect(first.response.project.revision).toBe(project.revision + 1);
    expect(await handle.db.select().from(editEvents).where(eq(editEvents.projectId, f.projectId))).toHaveLength(3);
    expect((await listProjectComposition(deps(), f)).clips[0]).toMatchObject({ sourceRange: range(1_000, 7_000), sequenceRange: range(0, 6_000) });
    expect((await listProjectCompositionObjects(deps(), f)).audioRegions[0]).toMatchObject({ gainDb: -8, fadeIn: mt(500), fadeOut: mt(750) });
  });

  it('compiles sequential keyframe aliases against one authoritative animation state', async () => {
    const f = await fixture();
    const operations = await compileEditOperationsV2(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      entrypoint: 'SHORTCUT',
      operations: [
        { op: 'add_keyframe', animationId: f.animation.id, targetKind: 'AUDIO_REGION', targetId: f.audio.id, keyframe: { id: 'key_mid', time: mt(2_000), value: -6, interpolation: 'LINEAR' } },
        { op: 'update_keyframe', animationId: f.animation.id, targetKind: 'AUDIO_REGION', targetId: f.audio.id, keyframe: { id: 'key_mid', time: mt(2_000), value: -9, interpolation: 'HOLD' } },
        { op: 'remove_keyframe', animationId: f.animation.id, targetKind: 'AUDIO_REGION', targetId: f.audio.id, keyframeId: f.animation.keyframes[0]!.id },
      ],
    });
    expect(operations).toHaveLength(3);
    expect(operations[2]).toMatchObject({ op: 'update_animation', keyframes: [
      { id: 'key_mid', value: -9, interpolation: 'HOLD' },
      { id: f.animation.keyframes[1]!.id, value: -3 },
    ] });
  });

  it('fails closed for unknown, invalid and planned operations without writing edit events', async () => {
    const f = await fixture();
    await expect(compileEditOperationsV2(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, entrypoint: 'AGENT', operations: [{ op: 'invent_magic', targetId: f.clip.id }],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { reason: 'UNKNOWN_EDIT_OPERATION_V2' } });
    await expect(compileEditOperationsV2(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, entrypoint: 'GUI', operations: [{ op: 'set_audio_gain', audioRegionId: f.audio.id, gainDb: 200 }],
    })).rejects.toMatchObject({ details: { reason: 'EDIT_OPERATION_V2_INVALID_INPUT' } });
    await expect(compileEditOperationsV2(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, entrypoint: 'GUI', operations: [{ op: 'create_preview_branch', baseProjectRevision: 1, operation: { op: 'trim_clip' } }],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE', details: { reason: 'EDIT_OPERATION_V2_NOT_IMPLEMENTED', category: 'PREVIEW_COMMAND', plannedTask: 'N06-10' } });
    expect(await handle.db.select().from(editEvents).where(eq(editEvents.projectId, f.projectId))).toHaveLength(0);
  });
});
