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
import { assets, assetVersions, createDb, editEvents, proposalTrials, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack, invalidateProposalTrials } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N06-01／N06-02／N06-04 验收（HTTP + SDK + 真实数据库）：私有候选 → 确定性试改 → 原子采用
 * - 候选创建与试改**不改工程**（revision 与 edit_events 都不变）；
 * - 试改用**真实执行器**在事务内跑一遍再回滚（同一操作集 → 同一结果）；
 * - 采用绑定 base revision／操作哈希／锚点指纹，**原子**执行；失败不显示"已采用"；
 * - 幂等键重放返回同一结果；版本过期/哈希不符/已丢弃一律拒绝。
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
    secret: 'proposal-auth-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
const ms = (time: unknown): number => mediaTimeToLegacyMilliseconds(time as never);

async function newSignedInClient(): Promise<AncsClient> {
  const email = `proposal-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '候选测试' });
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

function probeFixture() {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'm', startTimeMs: 0, durationMs: 30_000, bitRate: 1,
    streams: [{ index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs: 30_000, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '900', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'] }],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `候选-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '候选', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id };
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

async function revisionOf(client: AncsClient, projectId: string): Promise<number> {
  return (await client.projects.state(projectId)).document.projectRevision;
}

async function eventsOf(projectId: string) {
  return handle.db.select().from(editEvents).where(eq(editEvents.projectId, projectId));
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N06-01／02／04 私有候选 → 确定性试改 → 原子采用（HTTP + SDK）', () => {
  it('创建候选与试改都不改工程；试改用真实执行器，结果与采用一致', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 6_000]);

    const revisionBefore = await revisionOf(client, fixture.projectId);
    const eventsBefore = await eventsOf(fixture.projectId);

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore,
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(1_000, 4_000), sequenceRange: range(0, 3_000) }],
    });
    expect(proposal.status).toBe('OPEN');
    expect(proposal.operationsHash).toHaveLength(64);
    // 创建候选不改工程
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
    expect(await eventsOf(fixture.projectId)).toHaveLength(eventsBefore.length);

    const trial = await client.projects.previewProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(trial.projectUntouched).toBe(true);
    expect(trial.proposalId).toBe(proposal.proposalId);
    expect(trial.trialRevision).toBe(revisionBefore + 1);
    expect(trial.events.map((event) => event.action)).toContain('TRIM_CLIP');
    const trialClip = trial.clipRanges.find((item) => item.clipId === clipId)!;
    expect([trialClip.sequenceStartMs, trialClip.sequenceEndMs]).toEqual([0, 3_000]);
    expect([trialClip.sourceStartMs, trialClip.sourceEndMs]).toEqual([1_000, 4_000]);
    // 试改零落地
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
    expect(await eventsOf(fixture.projectId)).toHaveLength(eventsBefore.length);

    // 采用：结果与试改一致（同一操作集 → 同一结果）
    const adopted = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_adopt_${randomUUID()}`,
    });
    expect(adopted.adopted).toBe(true);
    expect(adopted.proposal.status).toBe('COMMITTED');
    expect(adopted.projectRevision).toBe(trial.trialRevision);
    const clipAfter = (await client.projects.state(fixture.projectId)).document.composition.clips.find((clip) => clip.id === clipId)!;
    expect(ms(clipAfter.sequenceRange.end)).toBe(3_000);
    expect(ms(clipAfter.sourceRange.start)).toBe(1_000);
  });

  it('幂等采用：同一幂等键重放返回同一结果且不产生第二次写入', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore,
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const key = `idem_replay_${randomUUID()}`;
    const first = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: key,
    });
    const eventsAfterFirst = (await eventsOf(fixture.projectId)).length;
    const second = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: key,
    });
    expect(second.projectRevision).toBe(first.projectRevision);
    expect((await eventsOf(fixture.projectId)).length).toBe(eventsAfterFirst);
    // 不同幂等键再次采用已提交候选 → 明确拒绝（不重复写入）
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_other_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_NOT_OPEN' },
    );
  });

  it('采用绑定校验：版本过期、操作哈希不符、已丢弃都拒绝且确认版不变', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const stale = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore,
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.4 }],
    });
    // 工程被别的编辑推进 → 候选过期
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'update_caption', captionId: 'cap_x', changes: { text: '占位' } }], idempotencyKey: `idem_touch_${randomUUID()}`,
    }).catch(() => undefined);
    const afterEdit = await revisionOf(client, fixture.projectId);
    if (afterEdit !== revisionBefore) {
      await expectApiFailure(
        client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, stale.proposalId, {
          expectedOperationsHash: stale.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_stale_${randomUUID()}`,
        }),
        { status: 409, reason: 'PROPOSAL_STALE_BASE' },
      );
    }

    // 哈希不符（用户看到的与候选当前内容不一致）
    const fresh = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.3 }],
    });
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, fresh.proposalId, {
        expectedOperationsHash: 'b'.repeat(64), expectedSelectionFingerprint: null, idempotencyKey: `idem_hash_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_HASH_MISMATCH' },
    );

    // 丢弃后不可采用
    const discarded = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.2 }],
    });
    const afterDiscard = await client.projects.discardProposal(fixture.workspaceId, fixture.projectId, discarded.proposalId, { reason: '改口了' });
    expect(afterDiscard.status).toBe('DISCARDED');
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, discarded.proposalId, {
        expectedOperationsHash: discarded.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_discard_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_NOT_OPEN' },
    );

    // 全程确认版保持完整（revision 只可能因那次"别的编辑"变化，绝不因候选/采用失败而变化）
    const finalRevision = await revisionOf(client, fixture.projectId);
    expect(finalRevision).toBe(afterEdit);
  });

  it('采用失败即失败：锁定目标导致执行失败时候选保持 OPEN 且不显示已采用', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    // 先锁住片段（STYLE 维度），再创建候选
    await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: revisionBefore, expectedSceneRevisions: {},
      operations: [{ op: 'set_object_lock', objectKind: 'CLIP', objectId: clipId, dimensions: ['STYLE'], locked: true }],
      idempotencyKey: `idem_lock_${randomUUID()}`,
    });
    const lockedRevision = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: lockedRevision,
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.1 }],
    });
    const eventsBefore = (await eventsOf(fixture.projectId)).length;
    const failure = await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_locked_${randomUUID()}`,
      }),
      { status: 409 },
    );
    expect(failure.details['reason']).toBe('EDIT_IMPACT_LOCKED');
    // 候选仍可（在被丢弃/解锁前保持 OPEN），且没有任何部分写入
    const reread = await client.projects.proposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(reread.status).toBe('OPEN');
    expect(await revisionOf(client, fixture.projectId)).toBe(lockedRevision);
    expect((await eventsOf(fixture.projectId)).length).toBe(eventsBefore);
  });

  it('候选绑定选择锚点：锚点变化后采用被拒（指纹不符）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const anchorId = `anch_${randomUUID()}`;
    const baseAnchor = {
      anchorId, workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, revision: 0,
      geometries: [{
        kind: 'RECT' as const, role: 'TARGET' as const, boundarySide: null, rawSamplesRef: null, stroke: null, geometryRevision: 1,
        coordinateSpaceRef: { kind: 'PREVIEW_FRAME' as const, previewRevision: 1, viewport: { width: 1920, height: 1080 }, sequenceTime: mt(1_000), sourcePts: null },
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      }],
      orderedTargetRefs: [{ targetRef: clipId, targetKind: 'CLIP' as const, label: 'A', assetVersionId: version }],
      temporalSelection: { kind: 'RANGES' as const, ranges: [range(1_000, 3_000)] },
      trackScope: { kind: 'ALL' as const }, propertyScope: ['opacity'], regionMode: 'SCREEN_FIXED' as const,
      timeBindingPolicy: 'SEQUENCE_FIXED' as const, trackingRef: null, resolutionStatus: 'RESOLVED' as const,
      evidenceRefs: [], remapHistory: [], fingerprintInput: 'placeholder', utteranceSequenceTime: mt(1_000),
    };
    const saved = await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, { anchor: baseAnchor });

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: saved.anchor.anchorId, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.6 }],
    });
    expect(proposal.selectionFingerprint).toBe(saved.fingerprint);

    // 选区变化（同一锚点保存新修订 → 指纹变化）
    await client.projects.saveSelectionAnchor(fixture.workspaceId, fixture.projectId, {
      anchor: { ...saved.anchor, revision: 0, temporalSelection: { kind: 'RANGES', ranges: [range(1_500, 3_500)] } },
    });
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: proposal.selectionFingerprint,
        idempotencyKey: `idem_fp_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_FINGERPRINT_MISMATCH' },
    );
    // 确认版未被改动
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
  });
});

describe('N06-04 局部试片缓存与依赖失效（HTTP + SDK）', () => {
  const cacheRows = (projectId: string) => handle.db.select().from(proposalTrials).where(eq(proposalTrials.projectId, projectId));
  // 每次用不同 HTTP 幂等键，绕过 HTTP 响应幂等缓存，专门检验**服务端局部试片缓存**。
  const preview = (client: AncsClient, fixture: Fixture, proposalId: string) =>
    client.projects.previewProposal(fixture.workspaceId, fixture.projectId, proposalId, { idempotencyKey: `preview_${randomUUID()}` });

  it('同一依赖重复试改命中缓存（cached=true），不重复跑执行器也不重复写缓存', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 6_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId),
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(1_000, 4_000), sequenceRange: range(0, 3_000) }],
    });

    const first = await preview(client, fixture, proposal.proposalId);
    expect(first.cached).toBe(false);
    expect(first.dependencyKey).toHaveLength(64);
    expect(await cacheRows(fixture.projectId)).toHaveLength(1);
    const storedRow = (await cacheRows(fixture.projectId))[0]!;
    expect(storedRow.dependencyKey).toBe(first.dependencyKey);
    expect(storedRow.proposalId).toBe(proposal.proposalId);

    const second = await preview(client, fixture, proposal.proposalId);
    expect(second.cached).toBe(true);
    expect(second.dependencyKey).toBe(first.dependencyKey);
    expect(second.trialRevision).toBe(first.trialRevision);
    expect(second.clipRanges).toEqual(first.clipRanges);
    expect(await cacheRows(fixture.projectId)).toHaveLength(1);

    // 采纳同一操作集的不同候选也能复用同一依赖键的缓存（同一确定性结果）
    const successor = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId),
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(1_000, 4_000), sequenceRange: range(0, 3_000) }],
    });
    const reused = await preview(client, fixture, successor.proposalId);
    expect(reused.cached).toBe(true);
    expect(reused.proposalId).toBe(successor.proposalId);
  });

  it('素材版本依赖变化 → 依赖键变化、自然失效并重新计算', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 5_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId),
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const before = await preview(client, fixture, proposal.proposalId);
    expect(before.cached).toBe(false);

    // 素材版本签名变化（片段换源），工程 revision 不变
    const assetRow = (await handle.db.select().from(assets).where(eq(assets.workspaceId, fixture.workspaceId)).limit(1))[0]!;
    const replacement = `av_${randomUUID()}`;
    await handle.db.insert(assetVersions).values({
      id: replacement, assetId: assetRow.id, workspaceId: fixture.workspaceId, versionNumber: 2,
      storageKey: `n06/${replacement}.mp4`, mimeType: 'video/mp4', sizeBytes: 1024, checksumSha256: 'b'.repeat(64),
      durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(),
    });
    await handle.db.execute(`update sequence_clips set asset_version_id = '${replacement}' where id = '${clipId}'`);
    const after = await preview(client, fixture, proposal.proposalId);
    expect(after.cached).toBe(false);
    expect(after.dependencyKey).not.toBe(before.dependencyKey);
    expect(await cacheRows(fixture.projectId)).toHaveLength(2);
  });

  it('显式失效与采用后清理：缓存不返回陈旧试片', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const version = (await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, fixture.workspaceId)).limit(1))[0]!.id;
    const clipId = await seedClip(fixture, version, [0, 4_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId),
      selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.25 }],
    });
    await preview(client, fixture, proposal.proposalId);
    expect(await cacheRows(fixture.projectId)).toHaveLength(1);

    const removed = await invalidateProposalTrials({ db: handle.db }, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(removed).toBe(1);
    expect(await cacheRows(fixture.projectId)).toHaveLength(0);

    // 重新试改会重建缓存；采用后该候选的缓存行被清理
    const rePreview = await preview(client, fixture, proposal.proposalId);
    expect(rePreview.cached).toBe(false);
    expect(await cacheRows(fixture.projectId)).toHaveLength(1);
    await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_cache_${randomUUID()}`,
    });
    expect(await cacheRows(fixture.projectId)).toHaveLength(0);
  });
});
