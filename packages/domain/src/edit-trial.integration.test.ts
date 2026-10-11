import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { ApiFailure, editRequestSchema, legacyMillisecondsToMediaTime, type EditOperation } from '@ancs/contracts';
import {
  assetVersions,
  assets,
  createDb,
  projectOpLog,
  projects,
  redactDatabaseUrl,
  resolveTestDatabaseUrl,
  runMigrations,
  workspaces,
  type DbHandle,
} from '@ancs/db';
import { clipDigestsOf } from './content-protection.js';
import { runEditTrial, type EditTrialOutcome } from './edit-trial.js';
import {
  createChannel,
  createClip,
  createProject,
  createSequence,
  createTrack,
  getProject,
  processEdits,
  type DomainDeps,
} from './index.js';

/**
 * V5-M2：内核内存试改与"事务内执行再回滚"必须等价——同一批操作得到相同的事件序列、revision、
 * 逐字节相同的片段行（含 jsonb 列）与相同的三轴指纹；拒绝时得到相同的领域错误。
 * 内存试改不写库、不取项目行锁。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });
const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (start: number, end: number) => ({ start: mt(start), end: mt(end) });
const LINEAR = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

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
    id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `v5-m2-trial/${versionId}.mp4`,
    mimeType: 'video/mp4', sizeBytes: 1000, checksumSha256: '7'.repeat(64), durationMs: 20_000,
    width: 1920, height: 1080, status: 'READY',
  });
  return versionId;
}

async function fixture() {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'V5-M2 试改等价' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '试改栏目' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '试改等价', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const scope = { workspaceId, projectId: project.id };
  const first = await assetVersion(workspaceId, project.id);
  const second = await assetVersion(workspaceId, project.id);
  const sequence = await createSequence(deps(), { ...scope, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) } });
  const video = await createTrack(deps(), { ...scope, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const a = await createClip(deps(), { ...scope, sequenceId: sequence.id, input: { trackId: video.id, assetVersionId: first, sourceStreamId: 'main', sourceRange: range(0, 10_000), sequenceRange: range(0, 10_000), timeMapping: LINEAR } });
  const b = await createClip(deps(), { ...scope, sequenceId: sequence.id, input: { trackId: video.id, assetVersionId: first, sourceStreamId: 'main', sourceRange: range(10_000, 18_000), sequenceRange: range(10_000, 18_000), timeMapping: LINEAR } });
  return { ...scope, first, second, sequence, video, a, b };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const GENERATED = /^(clp|avgp|trk|cap)_[0-9a-f-]{36}$/;
const JSONB_COLUMNS = ['sourceRange', 'sequenceRange', 'timeMapping', 'parameters'] as const;

/** 生成的 ID 按首次出现顺序替换为占位符（事件顺序在两条路径上相同），使两次试改可比较。 */
function normalize(outcome: EditTrialOutcome, known: ReadonlySet<string>) {
  const names = new Map<string, string>();
  const name = (value: string | null): string | null => {
    if (value === null || known.has(value) || !GENERATED.test(value)) return value;
    if (!names.has(value)) names.set(value, `new_${String(names.size + 1)}`);
    return names.get(value)!;
  };
  const events = outcome.events.map((event) => ({ ...event, objectId: name(event.objectId) }));
  const ordered = [...outcome.clips].sort((left, right) => JSON.stringify([left.sequenceRange, left.trackId]).localeCompare(JSON.stringify([right.sequenceRange, right.trackId])));
  const clips = ordered.map((clip) => {
    const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = clip;
    return {
      ...rest,
      id: name(clip.id),
      avGroupId: name(clip.avGroupId),
      parentClipId: name(clip.parentClipId),
      // jsonb 列逐字节比较（键顺序也必须一致：三轴指纹依赖 JSON.stringify）
      jsonb: JSONB_COLUMNS.map((column) => JSON.stringify(clip[column])),
      digests: clipDigestsOf(clip),
    };
  }).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return { revision: outcome.revision, events, clips };
}

async function bothEngines(f: Fixture, operations: EditOperation[], baseProjectRevision?: number) {
  const project = await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId });
  const input = { workspaceId: f.workspaceId, projectId: f.projectId, baseProjectRevision: baseProjectRevision ?? project.revision, operations, actorId: 'trial-equivalence' };
  const memory = await runEditTrial(deps(), { ...input, engine: 'KERNEL_MEMORY' });
  const transaction = await runEditTrial(deps(), { ...input, engine: 'TRANSACTION_ROLLBACK' });
  expect(memory.engine).toBe('KERNEL_MEMORY');
  expect(transaction.engine).toBe('TRANSACTION_ROLLBACK');
  const known = new Set([f.a.id, f.b.id, f.video.id]);
  return { memory: normalize(memory, known), transaction: normalize(transaction, known) };
}

async function errorOf(promise: Promise<unknown>): Promise<{ code: string; status: number; reason: unknown }> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ApiFailure);
    const failure = error as ApiFailure;
    return { code: failure.code, status: failure.httpStatus, reason: failure.details['reason'] ?? null };
  }
  throw new Error('expected the trial to be rejected');
}

describe('V5-M2 试改引擎：内核内存执行 ≡ 事务内执行再回滚', () => {
  const batches: [string, (f: Fixture) => EditOperation[]][] = [
    ['split_clip（含新片段）', (f) => [{ op: 'split_clip', clipId: f.a.id, at: mt(4_000) }]],
    ['move_clip', (f) => [{ op: 'move_clip', clipId: f.b.id, sequenceRange: range(20_000, 28_000) }]],
    ['trim_clip', (f) => [{ op: 'trim_clip', clipId: f.a.id, sourceRange: range(1_000, 6_000), sequenceRange: range(0, 5_000) }]],
    ['set_clip_transform（参数 jsonb）', (f) => [{ op: 'set_clip_transform', clipId: f.a.id, transform: { position: { x: 0.1, y: -0.05 }, scale: { x: 1.5, y: 1.5 }, rotationDeg: 30, anchor: { x: 0.5, y: 0.5 } } }]],
    ['insert_clip INSERT（挤开后续片段）', (f) => [{ op: 'insert_clip', sequenceId: f.sequence.id, trackId: f.video.id, assetVersionId: f.second, nestedSequenceId: null, sourceStreamId: 'main', sourceRange: range(0, 2_000), mode: 'INSERT', sequenceStart: mt(5_000), linkAudio: false, audioTrackId: null } as EditOperation]],
    ['ripple_clip DELETE', (f) => [{ op: 'ripple_clip', clipId: f.a.id, action: 'DELETE', amount: null, closeAcrossTracks: true }]],
    ['多操作批次：拆分 → 移动新片段 → 改变换', (f) => [
      { op: 'split_clip', clipId: f.a.id, at: mt(5_000), createdClipId: 'clp_created_in_batch' },
      { op: 'move_clip', clipId: 'clp_created_in_batch', sequenceRange: range(19_000, 24_000) },
      { op: 'set_clip_transform', clipId: 'clp_created_in_batch', transform: { position: { x: 0, y: 0 }, scale: { x: 2, y: 2 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } },
    ]],
  ];

  for (const [label, build] of batches) {
    it(`等价：${label}`, async () => {
      const f = await fixture();
      const { memory, transaction } = await bothEngines(f, build(f));
      expect(memory).toEqual(transaction);
      expect(memory.events.length).toBeGreaterThan(0);
    });
  }

  it('拒绝时两条路径给出相同的领域错误（越界 / 对象锁 / 过期 base revision）', async () => {
    const f = await fixture();
    const base = (await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).revision;
    const cases: { operations: EditOperation[]; base?: number }[] = [
      { operations: [{ op: 'move_clip', clipId: f.b.id, sequenceRange: range(25_000, 33_000) }] },
      { operations: [{ op: 'split_clip', clipId: f.a.id, at: mt(4_000) }], base: base - 1 },
    ];
    for (const item of cases) {
      const input = { workspaceId: f.workspaceId, projectId: f.projectId, baseProjectRevision: item.base ?? base, operations: item.operations, actorId: 'trial-equivalence' };
      const memory = await errorOf(runEditTrial(deps(), { ...input, engine: 'KERNEL_MEMORY' }));
      const transaction = await errorOf(runEditTrial(deps(), { ...input, engine: 'TRANSACTION_ROLLBACK' }));
      expect(memory).toEqual(transaction);
    }
    await processEdits(deps(), {
      workspaceId: f.workspaceId, projectId: f.projectId, actor: { type: 'USER', id: 'u_lock' },
      request: editRequestSchema.parse({ baseProjectRevision: base, expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`, operations: [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: f.b.id, dimensions: ['POSITION'], locked: true, reason: '已确认位置' }] }),
    });
    const locked = { workspaceId: f.workspaceId, projectId: f.projectId, baseProjectRevision: base + 1, operations: [{ op: 'move_clip', clipId: f.b.id, sequenceRange: range(20_000, 28_000) }] as EditOperation[], actorId: 'trial-equivalence' };
    const memory = await errorOf(runEditTrial(deps(), { ...locked, engine: 'KERNEL_MEMORY' }));
    expect(memory).toEqual(await errorOf(runEditTrial(deps(), { ...locked, engine: 'TRANSACTION_ROLLBACK' })));
    expect(memory.status).toBe(409);
  });

  it('内存试改不写库、不取项目行锁：他人持有行锁时仍立即完成', async () => {
    const f = await fixture();
    const before = (await getProject(deps(), { workspaceId: f.workspaceId, projectId: f.projectId })).revision;
    const logBefore = (await handle.db.select().from(projectOpLog).where(eq(projectOpLog.projectId, f.projectId))).length;
    const holder = await handle.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from projects where id = $1 for update', [f.projectId]);
      const trial = runEditTrial(deps(), { workspaceId: f.workspaceId, projectId: f.projectId, baseProjectRevision: before, operations: [{ op: 'split_clip', clipId: f.a.id, at: mt(3_000) }], actorId: 'trial-lock-free' });
      const timeout = new Promise<'blocked'>((resolve) => { setTimeout(() => resolve('blocked'), 3_000); });
      const outcome = await Promise.race([trial, timeout]);
      expect(outcome).not.toBe('blocked');
      expect((outcome as EditTrialOutcome).engine).toBe('KERNEL_MEMORY');
      expect((outcome as EditTrialOutcome).revision).toBe(before + 1);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
    expect((await handle.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, f.projectId)))[0]?.revision).toBe(before);
    expect(await handle.db.select().from(projectOpLog).where(eq(projectOpLog.projectId, f.projectId))).toHaveLength(logBefore);
  });
});
