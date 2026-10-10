import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  sourceMediaProbeResultSchema,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, editEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N06-03 验收（HTTP + SDK + 真实数据库）：影响集、陈旧提案与受控 rebase
 * - 记录字段读写集与具体写目标（对象 + 维度）；
 * - 非冲突改动（不同片段／同对象不同维度）验证后**受控 rebase**；
 * - 同对象同维度竞争 → 409 明确冲突；间接影响（涟漪位移）同样可检测；
 * - 身份（锚点指纹）／源素材绑定变化 → 要求重新审核，**不得以最新 revision 强覆盖**。
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
    secret: 'proposal-rebase-secret-0123456789abcd', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `rebase-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: 'rebase 测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  assetVersionId: string;
}

function probeFixture() {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'm', startTimeMs: 0, durationMs: 30_000, bitRate: 1,
    streams: [{ index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs: 30_000, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '900', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'] }],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `rebase-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'rebase', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: workspace.id, projectId: project.id, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: workspace.id, versionNumber: 1, storageKey: `n06/${assetVersionId}.mp4`,
    mimeType: 'video/mp4', sizeBytes: 1024, checksumSha256: 'a'.repeat(64), durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(),
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id, assetVersionId };
}

async function seedClip(fixture: Fixture, sequenceMs: [number, number]): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.videoTrackId, assetVersionId: fixture.assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

async function revisionOf(client: AncsClient, projectId: string): Promise<number> {
  return (await client.projects.state(projectId)).document.projectRevision;
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N06-03 影响集、陈旧提案与受控 rebase（HTTP + SDK）', () => {
  it('创建候选即记录读写集与具体写目标（对象 + 维度）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    expect(proposal.writeSet).toEqual(['CLIP.PARAMETERS']);
    expect(proposal.readSet).toEqual(['CLIP']);
    expect(proposal.writeTargets).toEqual([{ objectKind: 'CLIP', objectId: clipId, dimensions: ['STYLE'], operationIndex: 0 }]);
    expect(proposal.rebaseCount).toBe(0);

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.baseProjectRevision).toBe(impact.currentProjectRevision);
    expect(impact.conflicts).toEqual([]);
    expect(impact.rebaseable).toBe(true);
    expect(impact.writeTargets).toEqual(proposal.writeTargets);
  });

  it('两端改不同片段：无竞争 → 受控 rebase 后仍可原子采用', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipA = await seedClip(fixture, [0, 3_000]);
    const clipB = await seedClip(fixture, [3_000, 6_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId: clipA, sourceRange: range(500, 2_500), sequenceRange: range(0, 2_000) }],
    });
    // 干预编辑：改**另一个**片段
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'set_clip_opacity', clipId: clipB, opacity: 0.4 }], idempotencyKey: `idem_other_${randomUUID()}`,
    });
    const current = await revisionOf(client, fixture.projectId);
    expect(current).toBe(revisionBefore + 1);

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.conflicts).toEqual([]);
    expect(impact.rebaseable).toBe(true);
    expect(impact.interveningChanges.map((change) => change.objectId)).toContain(clipB);

    const eventsBefore = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;
    const rebased = await client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash,
    });
    expect(rebased.rebased).toBe(true);
    expect(rebased.rebasedFromRevision).toBe(revisionBefore);
    expect(rebased.rebasedToRevision).toBe(current);
    expect(rebased.proposal.baseProjectRevision).toBe(current);
    expect(rebased.proposal.rebaseCount).toBe(1);
    // rebase 只改候选行，不动工程
    expect(await revisionOf(client, fixture.projectId)).toBe(current);
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsBefore);

    // 采用成功（结果与试改一致：片段 A 被裁剪到 2000ms）
    const adopted = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_adopt_${randomUUID()}`,
    });
    expect(adopted.adopted).toBe(true);
    const clipAfter = (await client.projects.state(fixture.projectId)).document.composition.clips.find((clip) => clip.id === clipA)!;
    expect(mediaTimeToLegacyMilliseconds(clipAfter.sequenceRange.end)).toBe(2_000);
  });

  it('改同对象同维度：报告冲突并拒绝 rebase，且绝不以最新 revision 强覆盖', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(500, 3_000), sequenceRange: range(0, 2_500) }],
    });
    // 干预编辑：改**同一片段**（同时位／时长维度）
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(1_000, 3_500), sequenceRange: range(0, 2_500) }],
      idempotencyKey: `idem_same_${randomUUID()}`,
    });
    const current = await revisionOf(client, fixture.projectId);
    expect(current).toBe(revisionBefore + 1);

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.conflicts.length).toBeGreaterThan(0);
    expect(impact.rebaseable).toBe(false);
    expect(impact.blockReasons).toContain('IMPACT_CONFLICT');
    const conflict = impact.conflicts[0]!;
    expect(conflict.objectKind).toBe('CLIP');
    expect(conflict.objectId).toBe(clipId);
    expect(conflict.dimensions).toContain('DURATION');
    expect(conflict.operationIndexes).toContain(0);

    const eventsBefore = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;
    await expectApiFailure(
      client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash }),
      { status: 409, reason: 'PROPOSAL_REBASE_CONFLICT' },
    );
    // 绝不强覆盖：候选 base 仍是旧 revision，采用依旧 409
    const reread = await client.projects.proposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(reread.baseProjectRevision).toBe(revisionBefore);
    expect(reread.rebaseCount).toBe(0);
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_stale_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_STALE_BASE' },
    );
    expect(await revisionOf(client, fixture.projectId)).toBe(current);
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsBefore);
  });

  it('同对象不同维度：不构成竞争，可受控合并', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    // 候选只改 STYLE（不透明度）
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.3 }],
    });
    // 干预编辑改同片段但属时序/内容维度
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(500, 3_000), sequenceRange: range(0, 2_500) }],
      idempotencyKey: `idem_dims_${randomUUID()}`,
    });

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.conflicts).toEqual([]);
    expect(impact.rebaseable).toBe(true);
    const rebased = await client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash,
    });
    expect(rebased.rebased).toBe(true);
    const adopted = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_adopt_dims_${randomUUID()}`,
    });
    expect(adopted.adopted).toBe(true);
  });

  it('间接影响可检测：涟漪位移到的片段同样计入冲突', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipA = await seedClip(fixture, [0, 3_000]);
    const clipB = await seedClip(fixture, [3_000, 6_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    // 候选基于 clipB 的位置
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'move_clip', clipId: clipB, sequenceRange: range(4_000, 7_000) }],
    });
    // 干预编辑：对 clipA 做涟漪删除 → clipB 被整体左移（clipB 只是**间接受影响**）
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'ripple_clip', clipId: clipA, action: 'DELETE', amount: null, closeAcrossTracks: true }],
      idempotencyKey: `idem_ripple_${randomUUID()}`,
    });
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore + 1);

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.interveningChanges.map((change) => change.objectId)).toContain(clipB);
    expect(impact.conflicts.length).toBeGreaterThan(0);
    expect(impact.conflicts.some((conflict) => conflict.objectId === clipB)).toBe(true);
    expect(impact.rebaseable).toBe(false);
    await expectApiFailure(
      client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash }),
      { status: 409, reason: 'PROPOSAL_REBASE_CONFLICT' },
    );
  });

  it('源素材绑定变化 → 必须重新审核，不得 rebase', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });

    // 直接换源（不经编辑协议 → 工程 revision 不变，但源素材绑定已变）
    const replacement = `av_${randomUUID()}`;
    await handle.db.insert(assetVersions).values({
      id: replacement, assetId: (await handle.db.select().from(assets).where(eq(assets.workspaceId, fixture.workspaceId)).limit(1))[0]!.id,
      workspaceId: fixture.workspaceId, versionNumber: 2, storageKey: `n06/${replacement}.mp4`, mimeType: 'video/mp4',
      sizeBytes: 1024, checksumSha256: 'b'.repeat(64), durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(),
    });
    await handle.db.execute(`update sequence_clips set asset_version_id = '${replacement}' where id = '${clipId}'`);

    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.assetChanged).toBe(true);
    expect(impact.rebaseable).toBe(false);
    expect(impact.blockReasons).toContain('ASSET_CHANGED');
    await expectApiFailure(
      client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash }),
      { status: 409, reason: 'PROPOSAL_REVIEW_REQUIRED' },
    );
  });

  it('绑定锚点指纹变化 → 必须重新审核', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const anchorId = `anch_${randomUUID()}`;
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: {
        anchorId, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, revision: 0,
        geometries: [], orderedTargetRefs: [{ targetRef: clipId, targetKind: 'CLIP', label: 'A', assetVersionId: fixture.assetVersionId }],
        temporalSelection: { kind: 'RANGES', ranges: [range(0, 2_000)] }, trackScope: { kind: 'ALL' }, propertyScope: ['opacity'],
        regionMode: 'SCREEN_FIXED', timeBindingPolicy: 'SEQUENCE_FIXED', trackingRef: null, resolutionStatus: 'RESOLVED',
        evidenceRefs: [], remapHistory: [], fingerprintInput: 'placeholder', utteranceSequenceTime: mt(0),
      },
    });
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: saved.anchor.anchorId, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    // 选区变化（同一锚点新修订 → 指纹变化）
    await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: { ...saved.anchor, revision: 0, temporalSelection: { kind: 'RANGES', ranges: [range(500, 2_500)] } },
    });
    const impact = await client.projects.proposalImpact(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(impact.identityChanged).toBe(true);
    expect(impact.rebaseable).toBe(false);
    expect(impact.blockReasons).toContain('IDENTITY_CHANGED');
    await expectApiFailure(
      client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash }),
      { status: 409, reason: 'PROPOSAL_REVIEW_REQUIRED' },
    );
  });

  it('已在最新 revision：rebase 为幂等空操作（不写库、不推进计数）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const eventsBefore = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;
    const result = await client.projects.rebaseProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash,
    });
    expect(result.rebased).toBe(false);
    expect(result.rebasedFromRevision).toBe(revisionBefore);
    expect(result.proposal.rebaseCount).toBe(0);
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsBefore);
  });
});
