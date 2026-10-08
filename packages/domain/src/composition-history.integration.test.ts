import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { editRequestSchema, legacyMillisecondsToMediaTime, type EditOperation } from '@ancs/contracts';
import {
  assetVersions,
  assets,
  createDb,
  editEvents,
  projectObjectLocks,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import {
  createAnimationBinding,
  createAudioRegion,
  createChannel,
  createClip,
  createProject,
  createProjectVersion,
  createSequence,
  createTrack,
  getProject,
  listProjectComposition,
  listProjectCompositionObjects,
  processEdits,
  redoProject,
  undoProject,
  type DomainDeps,
} from './index.js';

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const params = (values: Record<string, unknown> = {}) => ({ schemaVersion: '1.0', values });
const actor = { type: 'USER' as const, id: 'u_n01_08' };

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
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'N01-08 历史测试' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '历史栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '合成历史', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD',
    status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId, versionNumber: 1, storageKey: `n01-08/${assetVersionId}.mp4`,
    mimeType: 'video/mp4', sizeBytes: 1000, checksumSha256: '8'.repeat(64), durationMs: 20_000,
    width: 1920, height: 1080, status: 'READY',
  });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) } });
  const video = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const audioTrack = await createTrack(deps(), { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
  const clip = await createClip(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: video.id, assetVersionId, sourceStreamId: 'main', sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000), timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true } },
  });
  const audio = await createAudioRegion(deps(), {
    workspaceId, projectId: project.id, sequenceId: sequence.id,
    input: { trackId: audioTrack.id, timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, localRange: range(0, 4_000), sourceStreamId: 'main', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0), parameters: params({}) },
  });
  const animation = await createAnimationBinding(deps(), {
    workspaceId, projectId: project.id,
    input: { targetKind: 'AUDIO_REGION', targetId: audio.id, propertyPath: 'audio.gain', parameterSchemaVersion: '1.0', timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, keyframes: [{ time: mt(0), value: 0, interpolation: 'LINEAR' }, { time: mt(4_000), value: -3, interpolation: 'HOLD' }] },
  });
  return { workspaceId, projectId: project.id, clip, audio, animation };
}

async function edit(f: Awaited<ReturnType<typeof fixture>>, operations: EditOperation[], base?: number) {
  const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
  return processEdits(deps(), {
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    actor,
    request: editRequestSchema.parse({ baseProjectRevision: base ?? project.revision, expectedSceneRevisions: {}, idempotencyKey: `idem_n01_08_${randomUUID()}`, operations }),
  });
}

describe('N01-08 normalized composition history', () => {
  it('undoes and redoes source trims, keyframes and audio parameters with stable ids', async () => {
    const f = await fixture();
    const trimmed = { sourceRange: range(1_000, 4_000), sequenceRange: range(0, 3_000), timeMapping: { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true } };
    await edit(f, [{ op: 'update_clip', clipId: f.clip.id, changes: trimmed }]);
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect((await listProjectComposition(deps(), f)).clips[0]).toMatchObject({ id: f.clip.id, sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000) });
    await redoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect((await listProjectComposition(deps(), f)).clips[0]).toMatchObject({ id: f.clip.id, ...trimmed });

    const changedKeys = f.animation.keyframes.map((keyframe, index) => ({ ...keyframe, value: index === 0 ? -2 : -8 }));
    await edit(f, [{ op: 'update_animation', animationId: f.animation.id, targetKind: 'AUDIO_REGION', targetId: f.audio.id, keyframes: changedKeys }]);
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect((await listProjectCompositionObjects(deps(), f)).animations[0]?.keyframes).toEqual(f.animation.keyframes);

    await edit(f, [{ op: 'update_audio_region', audioRegionId: f.audio.id, changes: { gainDb: -9, pan: 0.5, fadeIn: mt(500), fadeOut: mt(500), parameters: params({ normalized: true }) } }]);
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect((await listProjectCompositionObjects(deps(), f)).audioRegions[0]).toMatchObject({ id: f.audio.id, gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0), parameters: params({}) });

    const events = await handle.db.select().from(editEvents).where(eq(editEvents.projectId, f.projectId)).orderBy(asc(editEvents.seq));
    expect(events.some((event) => event.action === 'UPDATE_CLIP' && event.objectKind === 'CLIP' && event.objectId === f.clip.id)).toBe(true);
    expect(events.some((event) => event.action === 'UNDO_UPDATE_AUDIO_REGION' && event.objectKind === 'AUDIO_REGION')).toBe(true);
  });

  it('allows only one concurrent write from the same project revision', async () => {
    const f = await fixture();
    const base = (await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).revision;
    const results = await Promise.allSettled([
      edit(f, [{ op: 'update_clip', clipId: f.clip.id, changes: { sourceStreamId: 'first' } }], base),
      edit(f, [{ op: 'update_clip', clipId: f.clip.id, changes: { sourceStreamId: 'second' } }], base),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((results.find((result) => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('undoes and redoes an object lock without rewriting its original event', async () => {
    const f = await fixture();
    await edit(f, [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['CONTENT', 'ASSET'], locked: true, reason: '已确认素材' }]);
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect(await handle.db.select().from(projectObjectLocks).where(eq(projectObjectLocks.projectId, f.projectId))).toHaveLength(0);
    await redoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    expect(await handle.db.select().from(projectObjectLocks).where(eq(projectObjectLocks.projectId, f.projectId))).toMatchObject([{ objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['CONTENT', 'ASSET'], reason: '已确认素材' }]);
    const events = await handle.db.select().from(editEvents).where(eq(editEvents.projectId, f.projectId)).orderBy(asc(editEvents.seq));
    expect(events.map((event) => event.action)).toEqual(['SET_OBJECT_LOCK', 'UNDO_SET_OBJECT_LOCK', 'REDO_SET_OBJECT_LOCK']);
    expect(events[1]?.compensatesEventId).toBe(events[0]?.id);
    expect(events[2]?.compensatesEventId).toBe(events[1]?.id);
  });

  it('restores the full normalized snapshot and its object locks transactionally', async () => {
    const f = await fixture();
    await edit(f, [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['ASSET'], locked: true, reason: '保留来源' }]);
    const version = await createProjectVersion(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, reason: 'MANUAL' });
    const lockedRevision = (await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).revision;
    await edit(f, [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['ASSET'], locked: false }], lockedRevision);
    await edit(f, [
      { op: 'update_clip', clipId: f.clip.id, changes: { sourceRange: range(2_000, 6_000), sequenceRange: range(0, 4_000), timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true } } },
      { op: 'update_audio_region', audioRegionId: f.audio.id, changes: { gainDb: -12 } },
    ]);
    await edit(f, [{ op: 'restore_project_version', versionId: version.id }]);
    expect((await listProjectComposition(deps(), f)).clips[0]).toMatchObject({ id: f.clip.id, sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000) });
    expect((await listProjectCompositionObjects(deps(), f)).audioRegions[0]).toMatchObject({ id: f.audio.id, gainDb: 0 });
    expect(await handle.db.select().from(projectObjectLocks).where(and(eq(projectObjectLocks.projectId, f.projectId), eq(projectObjectLocks.objectId, f.clip.id)))).toMatchObject([{ dimensions: ['ASSET'], reason: '保留来源' }]);
  });
});
