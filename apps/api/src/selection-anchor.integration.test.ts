import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  selectionAnchorFromLegacySelection,
  type MediaRange,
  type SelectionAnchor,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, editEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N04-09 验收（HTTP + SDK + 真实数据库）：SelectionAnchor 归一与旧 Attention 兼容
 * - 选择动作**不改工程**（保存锚点不推进 revision、不写 edit_events）；
 * - 旧 inline 选择（场景/片段/字幕/素材范围/像素区域）经适配器解析一次，且**不丢有理时基**；
 * - 越权/跨项目引用被拒；跨租户读取 404；
 * - 帧号/帧哈希不能作为对象身份或授权；
 * - 重映射：目标消失 → FAILED/PARTIAL，重复素材引用 → AMBIGUOUS（附候选证据），源版本换代 → STALE。
 */

const PASSWORD = 'password-1234';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  const url = resolveTestDatabaseUrl();
  handle = createDb(url);
  try {
    await handle.pool.query('select 1');
  } catch (error) {
    await handle.close();
    throw new Error('无法连接测试数据库，请先运行：docker compose -f infra/docker-compose.dev.yml up -d', { cause: error });
  }
  await runMigrations(handle);
  auth = createAuth({
    db: handle.db,
    secret: 'selection-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });

async function newSignedInClient(): Promise<AncsClient> {
  const email = `selection-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '选择锚点测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `选择-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '选择', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id };
}

async function seedAsset(fixture: Fixture): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: fixture.workspaceId, projectId: fixture.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: fixture.workspaceId, versionNumber: 1,
    storageKey: `n04-09/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 1024, checksumSha256: 'a'.repeat(64),
    durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: { schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'm', startTimeMs: 0, durationMs: 30_000, bitRate: 1, streams: [], decodeCheck: { status: 'PASSED', errorCode: null, message: null }, capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] } },
  });
  return assetVersionId;
}

async function seedClip(fixture: Fixture, assetVersionId: string, sequenceMs: [number, number]): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.videoTrackId, assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

const spaceOf = (sequenceMs: number) => ({
  kind: 'PREVIEW_FRAME' as const, previewRevision: 7, viewport: { width: 1920, height: 1080 }, sequenceTime: mt(sequenceMs), sourcePts: null,
});

function anchor(fixture: Fixture, input: { anchorId?: string; clipIds: string[]; assetVersionIds: (string | null)[]; sequenceMs: number }): SelectionAnchor {
  return {
    anchorId: input.anchorId ?? `anch_${randomUUID()}`,
    workspaceId: fixture.workspaceId,
    projectId: fixture.projectId,
    sequenceId: fixture.sequenceId,
    revision: 0,
    geometries: [{
      kind: 'RECT', role: 'TARGET', coordinateSpaceRef: spaceOf(input.sequenceMs),
      rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, boundarySide: null, rawSamplesRef: null, stroke: null, geometryRevision: 1,
    }],
    orderedTargetRefs: input.clipIds.map((clipId, index) => ({
      targetRef: clipId, targetKind: 'CLIP' as const, label: String.fromCharCode(65 + index), assetVersionId: input.assetVersionIds[index] ?? null,
    })),
    temporalSelection: { kind: 'RANGES', ranges: [range(1_000, 3_000)] },
    utteranceSequenceTime: mt(input.sequenceMs),
    trackScope: { kind: 'ALL' },
    propertyScope: ['opacity'],
    regionMode: 'SCREEN_FIXED',
    timeBindingPolicy: 'SEQUENCE_FIXED',
    trackingRef: null,
    resolutionStatus: 'RESOLVED',
    evidenceRefs: [],
    remapHistory: [],
    fingerprintInput: 'placeholder',
  };
}

function anchorWithBindingBaseline(fixture: Fixture, input: {
  clipId: string;
  assetVersionId: string;
  policy: SelectionAnchor['timeBindingPolicy'];
  baselineSequence: [number, number];
  baselineSource: [number, number];
  temporal: [number, number];
  sequenceId?: string;
}): SelectionAnchor {
  const base = anchor(fixture, { clipIds: [input.clipId], assetVersionIds: [input.assetVersionId], sequenceMs: input.temporal[0] });
  return {
    ...base,
    ...(input.sequenceId === undefined ? {} : { sequenceId: input.sequenceId }),
    temporalSelection: { kind: 'RANGES', ranges: [range(...input.temporal)] },
    timeBindingPolicy: input.policy,
    orderedTargetRefs: base.orderedTargetRefs.map((target) => ({
      ...target,
      bindingBaseline: { sequenceRange: range(...input.baselineSequence), sourceRange: range(...input.baselineSource) },
    })),
  };
}

const jsonRange = (startMs: number, endMs: number): string =>
  JSON.stringify({ start: { ticks: String(startMs), timebase: { num: 1, den: 1000 } }, end: { ticks: String(endMs), timebase: { num: 1, den: 1000 } } });

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N04-09 SelectionAnchor 归一与旧 Attention 兼容（HTTP + SDK）', () => {
  it('保存/读回一致且不改工程；重复保存产生新锚点修订；指纹稳定', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const revisionBefore = (await client.projects.state(fixture.projectId)).document.projectRevision;
    const eventsBefore = await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId));

    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipId], assetVersionIds: [version], sequenceMs: 1_500 }),
    });
    expect(saved.fingerprint).toHaveLength(64);
    expect(saved.revision).toBe(1);
    expect(saved.anchor.geometries).toHaveLength(1);
    expect(saved.anchor.temporalSelection).toMatchObject({ kind: 'RANGES' });

    const read = await client.projects.selectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId);
    expect(read.fingerprint).toBe(saved.fingerprint);
    expect(read.anchor.orderedTargetRefs).toEqual(saved.anchor.orderedTargetRefs);
    expect(read.anchor.geometries).toEqual(saved.anchor.geometries);
    // 有理时基未被降精度（ticks + timebase 原样）
    expect(read.anchor.temporalSelection).toMatchObject({ kind: 'RANGES', ranges: [{ start: { ticks: '1000', timebase: { num: 1, den: 1000 } } }] });

    // 选择动作不改工程：revision 与事件数都不变
    expect((await client.projects.state(fixture.projectId)).document.projectRevision).toBe(revisionBefore);
    expect(await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).toHaveLength(eventsBefore.length);

    // 再次保存同一锚点：审计修订递增，指纹不变（内容未变）
    const again = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: { ...saved.anchor, revision: 0 },
    });
    expect(again.revision).toBe(2);
    expect(again.fingerprint).toBe(saved.fingerprint);
  });

  it('旧 inline 选择经适配器解析一次：场景/素材范围都能变成规范锚点且时间走有理时基', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);

    // 旧"素材范围"（毫秒）→ 规范锚点：区间必须是 1/1000 有理时基
    const legacyAnchor = selectionAnchorFromLegacySelection({
      anchorId: `anch_${randomUUID()}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
      legacy: { kind: 'MEDIA_RANGE', assetId: 'ast_legacy', sourceRangeMs: { start: 1_000, end: 2_500 } },
    });
    expect(legacyAnchor.temporalSelection).toMatchObject({ kind: 'RANGES', ranges: [{ start: { ticks: '1000', timebase: { num: 1, den: 1000 } }, end: { ticks: '2500', timebase: { num: 1, den: 1000 } } }] });
    expect(mediaTimeToLegacyMilliseconds((legacyAnchor.temporalSelection as { ranges: MediaRange[] }).ranges[0]!.end)).toBe(2_500);

    // 旧"场景"选择：目标进入 orderedTargetRefs（不产生第二套选择状态）
    const sceneAnchor = selectionAnchorFromLegacySelection({
      anchorId: `anch_${randomUUID()}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
      legacy: { kind: 'SCENE', sceneId: 'scn_legacy_1', sceneRevision: 4 },
    });
    expect(sceneAnchor.orderedTargetRefs[0]).toMatchObject({ targetRef: 'scn_legacy_1', label: 'A' });

    // 指代使用**对应发话时间**：语音/字幕场景把"说这句话时"的序列时间带进锚点（不是解析时刻）
    const spoken = selectionAnchorFromLegacySelection({
      anchorId: `anch_${randomUUID()}`, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
      legacy: { kind: 'CAPTION', captionId: 'cap_legacy_1', utteranceSequenceTime: mt(2_750) },
    });
    expect(spoken.utteranceSequenceTime).toMatchObject({ ticks: '2750', timebase: { num: 1, den: 1000 } });

    // 服务端接受 legacy 兼容入口（与规范锚点同时给出时以 anchor 为准）
    const clipId = await seedClip(fixture, version, [0, 2_000]);
    const savedLegacy = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipId], assetVersionIds: [version], sequenceMs: 500 }),
      legacy: { kind: 'CLIP', clipId },
    });
    expect(savedLegacy.anchor.orderedTargetRefs[0]!.targetRef).toBe(clipId);
    expect(savedLegacy.anchor.fingerprintInput.length).toBeGreaterThan(0);
  });

  it('负面：跨项目目标 422、跨租户读取 404、帧哈希不能当身份 422', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const other = await makeProject(client);
    const otherVersion = await seedAsset(other);
    const foreignClip = await seedClip(other, otherVersion, [0, 2_000]);
    const version = await seedAsset(fixture);
    const clipId = await seedClip(fixture, version, [0, 2_000]);

    await expectApiFailure(
      client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
        anchor: anchor(fixture, { clipIds: [foreignClip], assetVersionIds: [otherVersion], sequenceMs: 1_000 }),
      }),
      { status: 422, reason: 'SELECTION_INVALID_TARGET' },
    );

    await expectApiFailure(
      client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
        anchor: {
          ...anchor(fixture, { clipIds: [clipId], assetVersionIds: [version], sequenceMs: 1_000 }),
          orderedTargetRefs: [{ targetRef: 'framehash_9f2a1c', targetKind: 'CLIP', label: 'A', assetVersionId: null }],
        },
      }),
      { status: 422, reason: 'SELECTION_FRAME_HASH_NOT_IDENTITY' },
    );

    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipId], assetVersionIds: [version], sequenceMs: 1_000 }),
    });
    // 跨工作区读取 → 404（抗枚举）
    const stranger = await newSignedInClient();
    await expectApiFailure(
      stranger.projects.selectionAnchor(other.workspaceId, other.projectId, saved.anchor.anchorId),
      { status: 404 },
    );
  });

  it('重映射：目标消失 → FAILED，重复素材引用 → AMBIGUOUS（附候选证据），源版本换代 → STALE', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);
    const clipA = await seedClip(fixture, version, [0, 2_000]);
    const clipB = await seedClip(fixture, version, [4_000, 6_000]);

    // 重复素材引用：同一 assetVersionId 被两个片段引用 → AMBIGUOUS
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipA], assetVersionIds: [version], sequenceMs: 1_000 }),
    });
    const ambiguous = await client.projects.remapSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, { reason: '刷新后重解析' });
    expect(ambiguous.anchor.resolutionStatus).toBe('AMBIGUOUS');
    expect(ambiguous.anchor.evidenceRefs).toEqual(expect.arrayContaining([`clip:${clipA}`, `clip:${clipB}`]));
    expect(ambiguous.anchor.remapHistory.at(-1)).toMatchObject({ fromRevision: 1, toRevision: 2 });

    // 目标消失 → FAILED
    const staleTarget = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipB], assetVersionIds: [version], sequenceMs: 1_000 }),
    });
    await handle.db.execute(`delete from sequence_clips where id = '${clipB}'`);
    const failed = await client.projects.remapSelectionAnchor(fixture.workspaceId, fixture.projectId, staleTarget.anchor.anchorId, { reason: '片段被删除' });
    expect(failed.anchor.resolutionStatus).toBe('FAILED');
    expect(failed.anchor.remapHistory.at(-1)!.reason).toContain('缺失目标');

    // 源版本换代（同一片段换源）→ STALE
    const clipC = await seedClip(fixture, version, [8_000, 10_000]);
    const versioned = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipC], assetVersionIds: [version], sequenceMs: 1_000 }),
    });
    const replacementVersion = await seedAsset(fixture);
    await handle.db.execute(`update sequence_clips set asset_version_id = '${replacementVersion}' where id = '${clipC}'`);
    const stale = await client.projects.remapSelectionAnchor(fixture.workspaceId, fixture.projectId, versioned.anchor.anchorId, { reason: '工程刷新' });
    expect(stale.anchor.resolutionStatus).toBe('STALE');
    expect(stale.anchor.remapHistory.at(-1)!.reason).toContain('版本过期');
  });
});

describe('N04-10 刷新/嵌套/时序变更后的锚点自动恢复（HTTP + SDK）', () => {
  it('FOLLOW_OBJECT：片段移动后时间选择按位移跟随，且刷新幂等不重复追加修订', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);
    const clipId = await seedClip(fixture, version, [4_000, 8_000]);
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchorWithBindingBaseline(fixture, {
        clipId, assetVersionId: version, policy: 'FOLLOW_OBJECT',
        baselineSequence: [4_000, 8_000], baselineSource: [0, 4_000], temporal: [4_500, 5_500],
      }),
    });
    expect(saved.anchor.timeBindingPolicy).toBe('FOLLOW_OBJECT');

    // 片段在序列上右移 2000ms（源内容不变）
    await handle.db.execute(`update sequence_clips set sequence_range = '${jsonRange(6_000, 10_000)}'::jsonb where id = '${clipId}'`);
    const recovered = await client.projects.recoverSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, {
      trigger: 'TIMING_CHANGE', expectedRevision: saved.revision,
    });
    expect(recovered.changed).toBe(true);
    expect(recovered.previousRevision).toBe(1);
    expect(recovered.record.revision).toBe(2);
    const selection = recovered.record.anchor.temporalSelection as { kind: 'RANGES'; ranges: MediaRange[] };
    expect(mediaTimeToLegacyMilliseconds(selection.ranges[0]!.start)).toBe(6_500);
    expect(mediaTimeToLegacyMilliseconds(selection.ranges[0]!.end)).toBe(7_500);
    expect(recovered.record.anchor.remapHistory.at(-1)!.reason).toContain('时序重投影');

    // 刷新幂等：工程未再变化 → 不追加新修订，返回当前修订
    const again = await client.projects.recoverSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, { trigger: 'REFRESH' });
    expect(again.changed).toBe(false);
    expect(again.record.revision).toBe(2);
  });

  it('FOLLOW_SOURCE：片段修边后时间选择经源映射重投影到新序列区间', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);
    const clipId = await seedClip(fixture, version, [4_000, 8_000]);
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchorWithBindingBaseline(fixture, {
        clipId, assetVersionId: version, policy: 'FOLLOW_SOURCE',
        baselineSequence: [4_000, 8_000], baselineSource: [0, 4_000], temporal: [5_000, 7_000],
      }),
    });
    // 修掉源头部 1000ms：source [1000,4000] ↔ sequence [4000,7000]
    await handle.db.execute(`update sequence_clips set source_range = '${jsonRange(1_000, 4_000)}'::jsonb, sequence_range = '${jsonRange(4_000, 7_000)}'::jsonb where id = '${clipId}'`);
    const recovered = await client.projects.recoverSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, { trigger: 'TIMING_CHANGE' });
    expect(recovered.changed).toBe(true);
    const selection = recovered.record.anchor.temporalSelection as { kind: 'RANGES'; ranges: MediaRange[] };
    // 旧 [5000,7000] 对应源 [1000,3000]；新映射 = [4000,6000]
    expect(mediaTimeToLegacyMilliseconds(selection.ranges[0]!.start)).toBe(4_000);
    expect(mediaTimeToLegacyMilliseconds(selection.ranges[0]!.end)).toBe(6_000);
  });

  it('并发保护：期望修订与当前最新不符 → 409 SELECTION_CONCURRENT_UPDATE（不覆盖新状态）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = await seedAsset(fixture);
    const clipId = await seedClip(fixture, version, [0, 2_000]);
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: anchor(fixture, { clipIds: [clipId], assetVersionIds: [version], sequenceMs: 1_000 }),
    });
    await expectApiFailure(
      client.projects.recoverSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, {
        trigger: 'REFRESH', expectedRevision: saved.revision + 3,
      }),
      { status: 409, reason: 'SELECTION_CONCURRENT_UPDATE' },
    );
  });

  it('嵌套失效：父序列缺失时恢复为 PARTIAL 并写明原因（不静默当作有效）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const nested = await createSequence({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId,
      input: { name: '嵌套序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
    });
    await handle.db.execute(`update project_sequences set parent_sequence_id = 'seq_missing_parent' where id = '${nested.id}'`);
    const nestedTrack = await createTrack({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: nested.id,
      input: { kind: 'VIDEO', position: 0, name: 'V1' },
    });
    const version = await seedAsset(fixture);
    const clip = await createClip({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: nested.id,
      input: {
        trackId: nestedTrack.id, assetVersionId: version,
        sourceRange: range(0, 2_000), sequenceRange: range(0, 2_000),
        timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
      },
    });
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: { ...anchor(fixture, { clipIds: [clip.id], assetVersionIds: [version], sequenceMs: 1_000 }), sequenceId: nested.id },
    });
    const recovered = await client.projects.recoverSelectionAnchor(fixture.workspaceId, fixture.projectId, saved.anchor.anchorId, { trigger: 'NESTING_CHANGE' });
    expect(recovered.changed).toBe(true);
    expect(recovered.record.anchor.resolutionStatus).toBe('PARTIAL');
    expect(recovered.record.anchor.remapHistory.at(-1)!.reason).toContain('父序列缺失');
  });
});
