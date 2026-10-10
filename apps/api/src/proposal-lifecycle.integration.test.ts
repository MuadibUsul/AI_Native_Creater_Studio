import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, proposalArtifacts, proposalTrials, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack, runRetentionSweep } from '@ancs/domain';
import { and, eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N06-06 验收（HTTP + SDK + 真实数据库）：提案替代、取消与晚到结果隔离
 * - 新指令取代旧候选（同谱系自动 SUPERSEDED，记录取代者）；
 * - 先慢后快两任务**逆序完成**仍只展示最新意图（旧代际产物被隔离）；
 * - 取消标记**不丢已有结果**，取消后回调不改变 acceptedRevision；
 * - 外部晚到产物**隔离而非自动绑定**（代际/状态不符 → bound=false）。
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
    secret: 'proposal-lifecycle-secret-0123456789a', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `lifecycle-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: 'lifecycle 测试' });
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
  const workspace = await client.workspaces.create({ name: `lifecycle-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'lifecycle', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

async function saveAnchor(client: AncsClient, fixture: Fixture, clipId: string): Promise<string> {
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
  return saved.anchor.anchorId;
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N06-06 提案替代、取消与晚到结果隔离（HTTP + SDK）', () => {
  it('新指令取代同谱系旧候选；旧代际晚到产物被隔离，仍只展示最新意图', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revision = await revisionOf(client, fixture.projectId);
    const anchorId = await saveAnchor(client, fixture, clipId);

    // 先慢的任务：较早创建的一代
    const slow = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revision, selectionAnchorId: anchorId, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.3 }],
    });
    // 先快（后到）的任务：新指令产生更大代际，并取代旧候选
    const fast = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revision, selectionAnchorId: anchorId, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.8 }],
    });
    expect(fast.generation).toBe(slow.generation + 1);

    const slowAfter = await client.projects.proposal(fixture.workspaceId, fixture.projectId, slow.proposalId);
    expect(slowAfter.status).toBe('SUPERSEDED');
    expect(slowAfter.supersededByProposalId).toBe(fast.proposalId);
    expect(slowAfter.supersededAt).not.toBeNull();
    expect((await client.projects.proposal(fixture.workspaceId, fixture.projectId, fast.proposalId)).status).toBe('OPEN');

    // 旧代际的产物**晚到**：隔离，不自动绑定（先慢后快逆序完成仍显示最新意图）
    const lateArtifact = await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, slow.proposalId, {
      kind: 'preview_mp4', reference: `ext/${randomUUID()}.mp4`, generation: slow.generation,
    });
    expect(lateArtifact.bound).toBe(false);
    expect(lateArtifact.artifact.bindingReason).toBe('SUPERSEDED');

    // 最新代际的产物：绑定
    const currentArtifact = await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, fast.proposalId, {
      kind: 'preview_mp4', reference: `ext/${randomUUID()}.mp4`, generation: fast.generation,
    });
    expect(currentArtifact.bound).toBe(true);
    expect(currentArtifact.artifact.bindingReason).toBe('BOUND');

    // 台账可见隔离行与理由，且绑定产物未被旧产物覆盖
    const fastArtifacts = await client.projects.proposalArtifacts(fixture.workspaceId, fixture.projectId, fast.proposalId);
    expect(fastArtifacts).toHaveLength(1);
    expect(fastArtifacts[0]!.bound).toBe(true);
    const slowArtifacts = await client.projects.proposalArtifacts(fixture.workspaceId, fixture.projectId, slow.proposalId);
    expect(slowArtifacts).toHaveLength(1);
    expect(slowArtifacts[0]!.bound).toBe(false);

    // 旧候选永远不能采用（已被取代）
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, slow.proposalId, {
        expectedOperationsHash: slow.operationsHash, expectedSelectionFingerprint: slow.selectionFingerprint,
        idempotencyKey: `idem_slow_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_SUPERSEDED' },
    );
  });

  it('无谱系的候选互不取代（都保持 OPEN）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revision = await revisionOf(client, fixture.projectId);
    const first = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revision, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.2 }],
    });
    const second = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revision, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.6 }],
    });
    expect(second.generation).toBe(first.generation + 1);
    expect((await client.projects.proposal(fixture.workspaceId, fixture.projectId, first.proposalId)).status).toBe('OPEN');
    expect((await client.projects.proposal(fixture.workspaceId, fixture.projectId, second.proposalId)).status).toBe('OPEN');
  });

  it('取消：标记 CANCELLED 且保留已有结果；取消后回调不改变 acceptedRevision', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revision = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revision, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(500, 3_000), sequenceRange: range(0, 2_500) }],
    });
    // 已有结果：试片缓存 + 一个已绑定产物
    await client.projects.previewProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { idempotencyKey: `preview_${randomUUID()}` });
    const trialsBefore = await handle.db.select().from(proposalTrials).where(eq(proposalTrials.projectId, fixture.projectId));
    expect(trialsBefore.length).toBe(1);
    const bound = await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      kind: 'preview_mp4', reference: `ext/${randomUUID()}.mp4`, generation: proposal.generation,
    });
    expect(bound.bound).toBe(true);

    const cancelled = await client.projects.cancelProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { reason: '改主意了' });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancelledAt).not.toBeNull();

    // 晚到回调：隔离，不自动绑定；不改变任何 revision
    const late = await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      kind: 'preview_mp4', reference: `ext/${randomUUID()}.mp4`, generation: proposal.generation,
    });
    expect(late.bound).toBe(false);
    expect(late.artifact.bindingReason).toBe('CANCELLED');

    // 取消后采用被拒
    await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null, idempotencyKey: `idem_cancel_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_CANCELLED' },
    );
    // 取消后试改被拒（候选已非 OPEN）
    await expectApiFailure(
      client.projects.previewProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, { idempotencyKey: `preview_after_${randomUUID()}` }),
      { status: 409, reason: 'PROPOSAL_CANCELLED' },
    );
    // 取消**不丢已有结果**：试片缓存行与已绑定产物行仍在
    expect((await handle.db.select().from(proposalTrials).where(eq(proposalTrials.projectId, fixture.projectId))).length).toBe(1);
    const artifacts = await handle.db.select().from(proposalArtifacts).where(and(
      eq(proposalArtifacts.projectId, fixture.projectId), eq(proposalArtifacts.proposalId, proposal.proposalId),
    ));
    expect(artifacts).toHaveLength(2);
    expect(artifacts.filter((row) => row.bound)).toHaveLength(1);
    // acceptedRevision 未被取消/回调改变
    expect(await revisionOf(client, fixture.projectId)).toBe(revision);

    // 幂等：再次取消返回同一终态
    const again = await client.projects.cancelProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(again.status).toBe('CANCELLED');
  });

  it('孤儿产物隔离：代际陈旧 → bound=false（不自动绑定）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const reference = `ext/orphan-${randomUUID()}.mp4`;
    const result = await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      kind: 'preview_mp4', reference, generation: proposal.generation + 5,
    });
    expect(result.bound).toBe(false);
    expect(result.artifact.bindingReason).toBe('STALE_GENERATION');
    const rows = await handle.db.select().from(proposalArtifacts).where(and(
      eq(proposalArtifacts.projectId, fixture.projectId), eq(proposalArtifacts.reference, reference),
    ));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.bound).toBe(false);
  });

  it('隔离产物按保留策略清理；已绑定产物保留为候选结果证据', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    // 一个已绑定产物 + 一个隔离产物（代际陈旧）
    const boundReference = `ext/bound-${randomUUID()}.mp4`;
    const quarantineReference = `ext/quarantine-${randomUUID()}.mp4`;
    await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      kind: 'preview_mp4', reference: boundReference, generation: proposal.generation,
    });
    await client.projects.submitProposalArtifact(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      kind: 'preview_mp4', reference: quarantineReference, generation: proposal.generation + 3,
    });
    expect((await handle.db.select().from(proposalArtifacts).where(eq(proposalArtifacts.projectId, fixture.projectId))).length).toBe(2);

    // 隔离保留期设为 0 → 到期即清理孤儿行；Trash/幂等 TTL 放大以避免影响其它数据
    const report = await runRetentionSweep(
      { db: handle.db, retention: { trashRetentionDays: 100_000, idempotencyKeyTtlHours: 1_000_000, proposalArtifactQuarantineTtlHours: 0 } },
      { now: new Date(Date.now() + 1_000) },
    );
    expect(report.proposalArtifactsPurged).toBeGreaterThanOrEqual(1);
    expect(report.proposalArtifactsKeptBound).toBeGreaterThanOrEqual(1);
    // 本项目的隔离行被清理，已绑定行保留
    const remaining = await handle.db.select().from(proposalArtifacts).where(eq(proposalArtifacts.projectId, fixture.projectId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.bound).toBe(true);
    expect(remaining[0]!.reference).toBe(boundReference);
  });
});
