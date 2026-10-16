import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { editRequestSchema, legacyMillisecondsToMediaTime, type EditOperation } from '@ancs/contracts';
import {
  assetVersions,
  assets,
  compositionCaptionSpans,
  createDb,
  projectOpLog,
  projects,
  redactDatabaseUrl,
  referenceEdges,
  resolveTestDatabaseUrl,
  runMigrations,
  sequenceClips,
  sequenceTracks,
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
  createVisualObject,
  getProject,
  isAssetReferenced,
  listProjectComposition,
  processEdits,
  rebuildCompositionProjection,
  redoProject,
  undoProject,
  verifyCompositionProjection,
  type DomainDeps,
} from './index.js';

/**
 * V5-M2：操作日志是组合状态的权威——任何写入路径之后，日志折叠结果必须与投影表逐行一致；
 * 表被篡改可检出并按日志修复；并发写入在日志中线性化；引用边随日志开/关并保护历史引用。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const params = (values: Record<string, unknown> = {}) => ({ schemaVersion: '1.0', values });
const LINEAR = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };
const actor = { type: 'USER' as const, id: 'u_v5_m2' };

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

async function assetVersion(workspaceId: string, projectId: string) {
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId, projectId, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD',
    status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: versionId,
  });
  await handle.db.insert(assetVersions).values({
    id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `v5-m2/${versionId}.mp4`,
    mimeType: 'video/mp4', sizeBytes: 1000, checksumSha256: '9'.repeat(64), durationMs: 20_000,
    width: 1920, height: 1080, status: 'READY',
  });
  return { assetId, versionId };
}

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V5-M2 操作日志' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '日志栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '日志权威', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const first = await assetVersion(workspaceId, project.id);
  const second = await assetVersion(workspaceId, project.id);
  const scope = { workspaceId, projectId: project.id };
  const sequence = await createSequence(deps(), { ...scope, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) } });
  const video = await createTrack(deps(), { ...scope, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const audioTrack = await createTrack(deps(), { ...scope, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
  const captionTrack = await createTrack(deps(), { ...scope, sequenceId: sequence.id, input: { kind: 'CAPTION', position: 2, name: 'C1' } });
  const clip = await createClip(deps(), {
    ...scope, sequenceId: sequence.id,
    input: { trackId: video.id, assetVersionId: first.versionId, sourceStreamId: 'main', sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000), timeMapping: LINEAR },
  });
  const audio = await createAudioRegion(deps(), {
    ...scope, sequenceId: sequence.id,
    input: { trackId: audioTrack.id, timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, localRange: range(0, 4_000), sourceStreamId: 'main', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0), parameters: params({}) },
  });
  const animation = await createAnimationBinding(deps(), {
    ...scope,
    input: { targetKind: 'AUDIO_REGION', targetId: audio.id, propertyPath: 'audio.gain', parameterSchemaVersion: '1.0', timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null }, keyframes: [{ time: mt(0), value: 0, interpolation: 'LINEAR' }, { time: mt(4_000), value: -3, interpolation: 'HOLD' }] },
  });
  return { ...scope, first, second, sequence, video, audioTrack, captionTrack, clip, audio, animation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function edit(f: Fixture, operations: EditOperation[]) {
  const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
  return processEdits(deps(), {
    workspaceId: f.workspaceId,
    projectId: f.projectId,
    actor,
    request: editRequestSchema.parse({ baseProjectRevision: project.revision, expectedSceneRevisions: {}, idempotencyKey: `idem_v5_m2_${randomUUID()}`, operations }),
  });
}

const logOf = (projectId: string) => handle.db.select().from(projectOpLog).where(eq(projectOpLog.projectId, projectId)).orderBy(asc(projectOpLog.position));

async function expectConsistent(f: Fixture): Promise<void> {
  const report = await verifyCompositionProjection(handle.db, f);
  expect(report.logged).toBe(true);
  expect(report.differences).toEqual([]);
}

describe('V5-M2 操作日志权威与投影', () => {
  it('直接写入、内核操作、动画、锁、撤销/重做与版本恢复之后，日志折叠与投影表逐行一致', async () => {
    const f = await fixture();
    const created = await edit(f, [{ op: 'create_caption', sequenceId: f.sequence.id, trackId: f.captionTrack.id, timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null }, localRange: range(0, 2_000), sequenceRange: range(0, 2_000), text: '你好', languageTag: 'zh-CN', style: params({}), words: [], speechAnchorId: null }]);
    expect(created.response.editEvents).toHaveLength(1);
    const version = await createProjectVersion(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, reason: 'MANUAL' });
    await edit(f, [{ op: 'split_clip', clipId: f.clip.id, at: mt(5_000) }]);
    await edit(f, [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['ASSET'], locked: true, reason: '保留来源' }]);
    await edit(f, [{ op: 'update_animation', animationId: f.animation.id, targetKind: 'AUDIO_REGION', targetId: f.audio.id, keyframes: f.animation.keyframes.map((keyframe) => ({ ...keyframe, value: -6 })) }]);
    await edit(f, [{ op: 'update_audio_region', audioRegionId: f.audio.id, changes: { gainDb: -9 } }]);
    await edit(f, [{ op: 'create_track', sequenceId: f.sequence.id, track: { kind: 'VIDEO', position: 0, name: 'V0' } }]);
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    await redoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    await edit(f, [{ op: 'update_track', trackId: f.captionTrack.id, changes: { position: 0, muted: true } }]);
    await expectConsistent(f);

    await edit(f, [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.clip.id, dimensions: ['ASSET'], locked: false }]);
    await edit(f, [{ op: 'restore_project_version', versionId: version.id }]);
    await expectConsistent(f);

    // 日志线性化：位置连续、首行基线；编辑/补偿/直接写入的 revision 严格递增且末行 = 项目 revision
    const log = await logOf(f.projectId);
    expect(log.map((entry) => entry.position)).toEqual(log.map((_, index) => index + 1));
    expect(log[0]?.source).toBe('BASELINE');
    const revisions = log.filter((entry) => entry.source !== 'BASELINE').map((entry) => entry.revision);
    expect([...revisions].sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(revisions).size).toBe(revisions.length);
    const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
    expect(revisions.at(-1)).toBe(project.revision);
    expect(new Set(log.map((entry) => entry.source))).toEqual(new Set(['BASELINE', 'DIRECT', 'EDIT', 'COMPENSATION']));
    // 每个编辑批次的 baseRevision + 1 = revision
    for (const entry of log.filter((item) => item.source === 'EDIT' || item.source === 'COMPENSATION' || item.source === 'DIRECT')) {
      expect(entry.revision).toBe(entry.baseRevision + 1);
    }
  });

  it('日志启用前已存在的组合行被写入基线；投影表被篡改可检出并按日志修复', async () => {
    const f = await fixture();
    // 模拟 M2 之前写入、未经投影器的行
    await handle.db.delete(projectOpLog).where(eq(projectOpLog.projectId, f.projectId));
    await handle.db.update(sequenceTracks).set({ name: '旧名' }).where(eq(sequenceTracks.id, f.video.id));
    // 首批没有组合写入（基线在提交时补齐）：基线 revision 必须是本批的 base，而不是已推进的 revision
    await edit(f, [{ op: 'update_project', changes: { title: '日志权威（改名）' } }]);
    await edit(f, [{ op: 'move_clip', clipId: f.clip.id, sequenceRange: range(1_000, 11_000) }]);
    const log = await logOf(f.projectId);
    expect(log.map((entry) => entry.source)).toEqual(['BASELINE', 'EDIT', 'EDIT']);
    expect(log[0]?.revision).toBe(log[1]?.baseRevision);
    expect(log[1]?.revision).toBe(log[1]!.baseRevision + 1);
    await expectConsistent(f);

    // 篡改：删一个片段、改一条轨道、多插一条字幕
    const clipBefore = (await handle.db.select().from(sequenceClips).where(eq(sequenceClips.id, f.clip.id)))[0]!;
    await handle.db.delete(sequenceClips).where(eq(sequenceClips.id, f.clip.id));
    await handle.db.update(sequenceTracks).set({ muted: true }).where(eq(sequenceTracks.id, f.audioTrack.id));
    const strayId = `cap_${randomUUID()}`;
    await handle.db.insert(compositionCaptionSpans).values({
      id: strayId, workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: f.sequence.id, trackId: f.captionTrack.id,
      timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null }, localRange: range(0, 1_000), sequenceRange: range(0, 1_000),
      text: '越权写入', languageTag: 'zh-CN', style: {}, words: [],
    });
    const report = await verifyCompositionProjection(handle.db, f);
    expect(report.differences).toEqual(expect.arrayContaining([
      { entity: 'clip', id: f.clip.id, kind: 'MISSING' },
      { entity: 'track', id: f.audioTrack.id, kind: 'DIFFERENT' },
      { entity: 'caption', id: strayId, kind: 'UNEXPECTED' },
    ]));
    expect(report.differences).toHaveLength(3);

    const repaired = await rebuildCompositionProjection(handle.db, f);
    expect(repaired.repaired).toHaveLength(3);
    await expectConsistent(f);
    const clipAfter = (await handle.db.select().from(sequenceClips).where(eq(sequenceClips.id, f.clip.id)))[0]!;
    expect(clipAfter).toEqual(clipBefore);
    expect((await handle.db.select().from(sequenceTracks).where(eq(sequenceTracks.id, f.audioTrack.id)))[0]?.muted).toBe(false);
    expect(await handle.db.select().from(compositionCaptionSpans).where(eq(compositionCaptionSpans.id, strayId))).toHaveLength(0);
    // 修复不追加日志
    expect(await logOf(f.projectId)).toHaveLength(log.length);
  });

  it('并发写入在日志中线性化；数据库层拒绝重复 revision 的编辑日志行', async () => {
    const f = await fixture();
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, index) => processEdits(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      actor,
      request: editRequestSchema.parse({
        baseProjectRevision: 1, expectedSceneRevisions: {}, idempotencyKey: `idem_v5_m2_${randomUUID()}`,
        operations: [{ op: 'update_track', trackId: f.video.id, changes: { name: `V${String(index)}` } }],
      }),
    })));
    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const edits = (await logOf(f.projectId)).filter((entry) => entry.source === 'EDIT');
    expect(edits).toHaveLength(5);
    const revisions = edits.map((entry) => entry.revision);
    expect(revisions).toEqual(revisions.map((_, index) => revisions[0]! + index));
    await expectConsistent(f);

    const last = edits.at(-1)!;
    await expect(handle.db.insert(projectOpLog).values({
      ...last, id: `opl_${randomUUID()}`, position: last.position + 1,
    })).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('引用边：替换来源关闭旧边、删除关闭边、撤销重新打开；历史引用仍阻止资产清理', async () => {
    const f = await fixture();
    const edgesOf = (clipId: string) => handle.db.select().from(referenceEdges)
      .where(and(eq(referenceEdges.projectId, f.projectId), eq(referenceEdges.fromId, clipId))).orderBy(asc(referenceEdges.openedPosition));
    expect((await edgesOf(f.clip.id)).map((edge) => [edge.toId, edge.closedPosition === null])).toEqual([[f.first.versionId, true]]);

    await edit(f, [{ op: 'replace_clip_source', clipId: f.clip.id, assetVersionId: f.second.versionId, nestedSequenceId: null, sourceStreamId: 'main', sourceRange: range(0, 10_000) }]);
    expect((await edgesOf(f.clip.id)).map((edge) => [edge.toId, edge.closedPosition === null])).toEqual([[f.first.versionId, false], [f.second.versionId, true]]);

    await edit(f, [{ op: 'delete_clip', clipId: f.clip.id }]);
    const open = await handle.db.select().from(referenceEdges).where(and(eq(referenceEdges.fromId, f.clip.id), isNull(referenceEdges.closedPosition)));
    expect(open).toHaveLength(0);
    // 片段已删除，但撤销可以让引用重新生效：两条历史边都必须继续保护资产
    expect(await isAssetReferenced(deps(), f.workspaceId, f.first.assetId)).toBe(true);
    expect(await isAssetReferenced(deps(), f.workspaceId, f.second.assetId)).toBe(true);

    await undoProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, actor });
    const reopened = await handle.db.select().from(referenceEdges).where(and(eq(referenceEdges.fromId, f.clip.id), isNull(referenceEdges.closedPosition)));
    expect(reopened.map((edge) => edge.toId)).toEqual([f.second.versionId]);
    expect((await listProjectComposition(deps(), f)).clips.map((clip) => clip.id)).toContain(f.clip.id);
    await expectConsistent(f);
  });

  it('delete_track 不再级联静默删除字幕与视觉对象（409），轨道清空后可删除', async () => {
    const f = await fixture();
    await edit(f, [{ op: 'create_caption', sequenceId: f.sequence.id, trackId: f.captionTrack.id, timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null }, localRange: range(0, 2_000), sequenceRange: range(0, 2_000), text: '保留', languageTag: 'zh-CN', style: params({}), words: [], speechAnchorId: null }]);
    await expect(edit(f, [{ op: 'delete_track', trackId: f.captionTrack.id, nonEmptyPolicy: 'REJECT', destinationTrackId: null }]))
      .rejects.toMatchObject({ details: { reason: 'TRACK_NOT_EMPTY', objectCount: 1 } });
    expect(await handle.db.select().from(compositionCaptionSpans).where(eq(compositionCaptionSpans.trackId, f.captionTrack.id))).toHaveLength(1);

    const graphics = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: f.sequence.id, input: { kind: 'GRAPHIC', position: 3, name: 'G1' } });
    await createVisualObject(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: f.sequence.id,
      input: { trackId: graphics.id, kind: 'TEXT', timeBinding: { basis: 'SEQUENCE', clipId: null, semanticCueId: null }, localRange: range(0, 1_000), parameters: params({ text: '标题' }) },
    });
    await expect(edit(f, [{ op: 'delete_track', trackId: graphics.id, nonEmptyPolicy: 'REJECT', destinationTrackId: null }]))
      .rejects.toMatchObject({ details: { reason: 'TRACK_NOT_EMPTY', objectCount: 1 } });

    const emptyTrack = await createTrack(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, sequenceId: f.sequence.id, input: { kind: 'VIDEO', position: 5, name: 'V9' } });
    await edit(f, [{ op: 'delete_track', trackId: emptyTrack.id, nonEmptyPolicy: 'REJECT', destinationTrackId: null }]);
    await expectConsistent(f);
    expect((await handle.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, f.projectId)))[0]?.revision).toBeGreaterThan(1);
  });
});
