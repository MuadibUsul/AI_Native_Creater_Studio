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
import { assets, assetVersions, createDb, editEvents, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N06-05 验收（HTTP + SDK + 真实数据库）：采用、继续微调、拒绝与**部分采用**
 * - 部分采用按**依赖闭包**扩张（被引用对象的创建操作 + 同一 AV 组的另一侧），作用范围如实回报；
 * - 只改画面那半边（同一 avGroupId）**必须**把音频侧一并采用，否则会被闭包扩张或 fail-closed；
 * - 部分采用是一次性交付（PARTIALLY_ADOPTED），未采用的操作不能重复落地（防重复写入）；
 * - 闭包覆盖全部操作时等价于完整采用（COMMITTED）。
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
    secret: 'proposal-partial-secret-0123456789abc', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `partial-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '部分采用测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
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
  const workspace = await client.workspaces.create({ name: `partial-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'partial', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  const audioTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' },
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
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id, audioTrackId: audioTrack.id, assetVersionId };
}

async function seedClip(fixture: Fixture, trackId: string, sequenceMs: [number, number], avGroupId: string | null = null): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId, assetVersionId: fixture.assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  if (avGroupId !== null) {
    await handle.db.execute(`update sequence_clips set av_group_id = '${avGroupId}' where id = '${clip.id}'`);
  }
  return clip.id;
}

async function revisionOf(client: AncsClient, projectId: string): Promise<number> {
  return (await client.projects.state(projectId)).document.projectRevision;
}

const opacityOf = async (client: AncsClient, projectId: string, clipId: string): Promise<number> => {
  const clip = (await client.projects.state(projectId)).document.composition.clips.find((item) => item.id === clipId)!;
  const parameters = clip.parameters as { opacity?: number } | null;
  return parameters?.opacity ?? 1;
};

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N06-05 采用、继续微调、拒绝与部分采用（HTTP + SDK）', () => {
  it('音画配对闭包：只选画面那半边 → 自动并入音频侧，作用范围如实回报', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const group = `avgp_${randomUUID()}`;
    const videoClip = await seedClip(fixture, fixture.videoTrackId, [0, 3_000], group);
    const audioClip = await seedClip(fixture, fixture.audioTrackId, [0, 3_000], group);
    const otherClip = await seedClip(fixture, fixture.videoTrackId, [5_000, 8_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [
        { op: 'set_clip_opacity', clipId: videoClip, opacity: 0.5 },
        { op: 'set_clip_opacity', clipId: audioClip, opacity: 0.5 },
        { op: 'set_clip_opacity', clipId: otherClip, opacity: 0.5 },
      ],
    });

    // 只勾选第 0 个（画面那半边）
    const result = await client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      selectedOperationIndexes: [0],
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
      idempotencyKey: `idem_partial_${randomUUID()}`,
    });
    // 闭包把音频侧（下标 1）并入，未勾选的无关片段（下标 2）保持未采用
    expect(result.adoptedOperationIndexes).toEqual([0, 1]);
    expect(result.remainingOperationIndexes).toEqual([2]);
    expect(result.closureExpanded).toBe(true);
    expect(result.proposal.status).toBe('PARTIALLY_ADOPTED');
    expect(result.proposal.adoptedOperationIndexes).toEqual([0, 1]);
    // 作用范围明确可见：写目标是视频/音频两个片段
    expect(result.effectiveWriteTargets.map((target) => target.objectId).sort()).toEqual([videoClip, audioClip].sort());

    // 声画两侧都已改动，无关片段未被动
    expect(await opacityOf(client, fixture.projectId, videoClip)).toBeCloseTo(0.5, 6);
    expect(await opacityOf(client, fixture.projectId, audioClip)).toBeCloseTo(0.5, 6);
    expect(await opacityOf(client, fixture.projectId, otherClip)).toBe(1);
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore + 1);
  });

  it('引用闭包：只选依赖创建结果的操作 → 自动并入创建操作', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const createdClipId = `clp_${randomUUID()}`;

    // 操作集：先插入一个新片段（显式 id），再对它设不透明度
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [
        {
          op: 'insert_clip', sequenceId: fixture.sequenceId, trackId: fixture.videoTrackId, assetVersionId: fixture.assetVersionId,
          nestedSequenceId: null, sourceStreamId: null, sourceRange: range(0, 2_000), mode: 'APPEND', sequenceStart: null,
          linkAudio: false, audioTrackId: null, createdClipId,
        },
        { op: 'set_clip_opacity', clipId: createdClipId, opacity: 0.25 },
      ],
    });

    // 只勾选第 1 个（引用新建片段）→ 闭包必须并入创建操作（下标 0）
    const result = await client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      selectedOperationIndexes: [1],
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
      idempotencyKey: `idem_ref_${randomUUID()}`,
    });
    expect(result.adoptedOperationIndexes).toEqual([0, 1]);
    expect(result.remainingOperationIndexes).toEqual([]);
    expect(result.closureExpanded).toBe(true);
    // 闭包覆盖全部操作 → 等价完整采用
    expect(result.proposal.status).toBe('COMMITTED');
    expect(await opacityOf(client, fixture.projectId, createdClipId)).toBeCloseTo(0.25, 6);
  });

  it('闭包覆盖全部操作 → COMMITTED；部分采用后不能再采用（防重复写入）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const group = `avgp_${randomUUID()}`;
    const videoClip = await seedClip(fixture, fixture.videoTrackId, [0, 3_000], group);
    const audioClip = await seedClip(fixture, fixture.audioTrackId, [0, 3_000], group);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [
        { op: 'set_clip_opacity', clipId: videoClip, opacity: 0.4 },
        { op: 'set_clip_opacity', clipId: audioClip, opacity: 0.4 },
      ],
    });

    // 选满：闭包 = 全部 → 完整采用
    const full = await client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      selectedOperationIndexes: [0, 1],
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
      idempotencyKey: `idem_full_${randomUUID()}`,
    });
    expect(full.proposal.status).toBe('COMMITTED');
    expect(full.closureExpanded).toBe(false);
    expect(full.remainingOperationIndexes).toEqual([]);
    const eventsAfter = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;

    // 再次部分采用 → 409（已终态，不产生第二次写入）
    await expectApiFailure(
      client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        selectedOperationIndexes: [0],
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
        idempotencyKey: `idem_again_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_NOT_OPEN' },
    );
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsAfter);
  });

  it('非法选择集（越界下标）→ 422 PROPOSAL_PARTIAL_SCOPE_INVALID，零写入', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, fixture.videoTrackId, [0, 3_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const eventsBefore = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;
    await expectApiFailure(
      client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        selectedOperationIndexes: [7],
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
        idempotencyKey: `idem_oob_${randomUUID()}`,
      }),
      { status: 422, reason: 'PROPOSAL_PARTIAL_SCOPE_INVALID' },
    );
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsBefore);
  });

  it('操作哈希不符 → 409（部分采用也要确认"看到的就是这一份"）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, fixture.videoTrackId, [0, 3_000]);
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    await expectApiFailure(
      client.projects.adoptProposalPartial(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        selectedOperationIndexes: [0],
        expectedOperationsHash: 'c'.repeat(64), expectedSelectionFingerprint: null,
        idempotencyKey: `idem_hash_${randomUUID()}`,
      }),
      { status: 409, reason: 'PROPOSAL_HASH_MISMATCH' },
    );
  });
});
