import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { editRequestSchema, projectVersionSnapshotSchema } from '@ancs/contracts';
import {
  createDb,
  projectCompositionMigrations,
  projectOpLog,
  projectVersionCompositionProjections,
  projectVersions,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  scenes,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { and, asc, eq } from 'drizzle-orm';
import {
  addScene,
  assembleProjectDocument,
  assembleSceneGraph,
  compositionDigestSha256,
  createChannel,
  createProject,
  listProjectComposition,
  listProjectVersionCompositionProjections,
  migrateLegacyProjectComposition,
  processEdits,
  setProjectCompositionMigrationEnabled,
  verifyCompositionProjection,
  type DomainDeps,
} from './index.js';

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });

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
  await handle.db.insert(workspaces).values({ id: workspaceId, name: `N01-05 ${tag}` });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '迁移栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: `迁移项目 ${tag}`, channelId: channel.id } });
  const first = await addScene(deps(), {
    workspaceId,
    projectId: project.id,
    input: { sceneType: 'HOST_FULL', semanticType: 'HOOK', durationMs: 5_000, narration: '旧版开场' },
  });
  await addScene(deps(), {
    workspaceId,
    projectId: project.id,
    input: { sceneType: 'SUMMARY', semanticType: 'SUMMARY', durationMs: 7_000, narration: '旧版总结' },
  });
  const graph = await assembleSceneGraph(deps(), { workspaceId, projectId: project.id });
  const snapshot = projectVersionSnapshotSchema.parse({
    schemaVersion: '0.1',
    graph: {
      ...graph,
      captions: [{
        id: `cap_${randomUUID()}`,
        sceneId: first.scene.id,
        startMs: 250,
        durationMs: 1_500,
        text: '旧版字幕',
        words: [{ startMs: 250, endMs: 800, text: '旧版' }, { startMs: 800, endMs: 1_750, text: '字幕' }],
      }],
      audioTracks: [{ id: `audio_${randomUUID()}`, kind: 'MUSIC', assetId: null, volume: 0.5, fadeInMs: 300, fadeOutMs: 500, ducking: true }],
    },
    meta: { golden: true },
  });
  const versionId = `pv_${randomUUID()}`;
  await handle.db.insert(projectVersions).values({
    id: versionId,
    workspaceId,
    projectId: project.id,
    versionNumber: 1,
    snapshot,
    reason: 'MANUAL',
    note: 'N01-05 golden',
  });
  return { workspaceId, projectId: project.id, sceneId: first.scene.id, versionId, snapshot };
}

describe('N01-05 legacy composition migration', () => {
  it('retries an interrupted backfill, preserves legacy goldens and cuts old writes over once complete', async () => {
    const f = await fixture('resume');
    const beforeGraph = await assembleSceneGraph(deps(), f);
    const beforeScenes = await handle.db.select().from(scenes).where(eq(scenes.projectId, f.projectId));
    const beforeVersions = await handle.db.select().from(projectVersions).where(eq(projectVersions.projectId, f.projectId));
    const beforeDigest = compositionDigestSha256({ graph: beforeGraph, versions: beforeVersions.map((item) => item.snapshot) });

    await expect(migrateLegacyProjectComposition(deps(), f)).rejects.toMatchObject({
      details: { reason: 'COMPOSITION_MIGRATION_FEATURE_DISABLED' },
    });
    await setProjectCompositionMigrationEnabled(deps(), { ...f, enabled: true });

    await expect(migrateLegacyProjectComposition(deps(), f, {
      afterStep: (step) => { if (step === 'BASE') throw new Error('injected interruption after base'); },
    })).rejects.toThrow('injected interruption');
    const failed = (await handle.db.select().from(projectCompositionMigrations).where(eq(projectCompositionMigrations.projectId, f.projectId)))[0]!;
    expect(failed).toMatchObject({ status: 'FAILED', completedStep: 'BASE', authorityMode: 'LEGACY', attemptCount: 1 });

    const completed = await migrateLegacyProjectComposition(deps(), f);
    expect(completed).toMatchObject({ status: 'COMPLETE', completedStep: 'COMPLETE', authorityMode: 'COMPOSITION', attemptCount: 2 });
    expect(completed.sourceDigestSha256).toHaveLength(64);
    expect(completed.targetDigestSha256).toHaveLength(64);

    // V5-M2：迁移写入经投影器进入操作日志（每个已提交步骤一行 MIGRATION，不改 revision），折叠结果与投影一致
    const migrationLog = await handle.db.select().from(projectOpLog).where(eq(projectOpLog.projectId, f.projectId)).orderBy(asc(projectOpLog.position));
    expect(migrationLog[0]?.source).toBe('BASELINE');
    expect(migrationLog.filter((entry) => entry.source === 'MIGRATION').map((entry) => (entry.operations as { step: string }[])[0]?.step)).toEqual(['BASE', 'SCENES']);
    expect(await verifyCompositionProjection(handle.db, f)).toMatchObject({ logged: true, differences: [] });

    const afterGraph = await assembleSceneGraph(deps(), f);
    const afterScenes = await handle.db.select().from(scenes).where(eq(scenes.projectId, f.projectId));
    const afterVersions = await handle.db.select().from(projectVersions).where(eq(projectVersions.projectId, f.projectId));
    expect(afterGraph).toEqual(beforeGraph);
    expect(afterScenes).toEqual(beforeScenes);
    expect(afterVersions.map((item) => item.snapshot)).toEqual(beforeVersions.map((item) => item.snapshot));
    expect(compositionDigestSha256({ graph: afterGraph, versions: afterVersions.map((item) => item.snapshot) })).toBe(beforeDigest);

    const document = await assembleProjectDocument(deps(), f);
    expect(document.composition.sequences).toHaveLength(1);
    expect(document.composition.visualObjects).toHaveLength(2);
    expect(document.compatibility.sceneGraph).toEqual(beforeGraph);

    const projections = await listProjectVersionCompositionProjections(deps(), f);
    expect(projections).toHaveLength(1);
    expect(projections[0]?.projectVersionId).toBe(f.versionId);
    expect(projections[0]?.projection.compatibility.sceneGraph).toEqual(f.snapshot.graph);
    expect(projections[0]?.projection.captions).toHaveLength(1);
    expect(projections[0]?.projection.audioRegions).toHaveLength(1);
    expect(projections[0]?.sourceSnapshotSha256).toBe(compositionDigestSha256(f.snapshot));

    await expect(processEdits(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      actor: { type: 'USER', id: 'legacy-client' },
      request: editRequestSchema.parse({
        idempotencyKey: `idem_${randomUUID()}`,
        baseProjectRevision: beforeGraph.projectRevision,
        expectedSceneRevisions: { [f.sceneId]: 1 },
        operations: [{ op: 'update_scene', sceneId: f.sceneId, changes: { narration: '不应写入' } }],
      }),
    })).rejects.toMatchObject({ details: { reason: 'LEGACY_WRITE_BLOCKED_AFTER_COMPOSITION_CUTOVER' } });
    expect((await handle.db.select().from(scenes).where(eq(scenes.id, f.sceneId)))[0]?.narration).toBe('旧版开场');

    // V5-M2：切换后只拒绝写 Scene 的操作；组合编辑照常可用（此前全部编辑被拒，已迁移项目无法编辑）
    const migratedTrack = (await listProjectComposition(deps(), f)).tracks.find((track) => track.kind === 'GRAPHIC')!;
    const renamed = await processEdits(deps(), {
      workspaceId: f.workspaceId,
      projectId: f.projectId,
      actor: { type: 'USER', id: 'composition-client' },
      request: editRequestSchema.parse({
        idempotencyKey: `idem_${randomUUID()}`,
        baseProjectRevision: beforeGraph.projectRevision,
        expectedSceneRevisions: {},
        operations: [{ op: 'update_track', trackId: migratedTrack.id, changes: { name: '已迁移图形' } }],
      }),
    });
    expect(renamed.response.editEvents.map((event) => event.action)).toEqual(['UPDATE_TRACK']);
    expect(await verifyCompositionProjection(handle.db, f)).toMatchObject({ logged: true, differences: [] });
  });

  it('never exposes another workspace migration or projection', async () => {
    const owner = await fixture('owner');
    const outsider = await fixture('outsider');
    await setProjectCompositionMigrationEnabled(deps(), { ...owner, enabled: true });
    await migrateLegacyProjectComposition(deps(), owner);

    await expect(listProjectVersionCompositionProjections(deps(), {
      workspaceId: outsider.workspaceId,
      projectId: owner.projectId,
    })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await handle.db.select().from(projectVersionCompositionProjections).where(and(
      eq(projectVersionCompositionProjections.workspaceId, owner.workspaceId),
      eq(projectVersionCompositionProjections.projectId, owner.projectId),
    ))).toHaveLength(1);
  });
});
