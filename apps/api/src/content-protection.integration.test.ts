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
 * N06-07 验收（HTTP + SDK + 真实数据库）：已确认内容保护与回归指纹
 * - 用户确认过的内容在三轮修改后仍引用**相同资产与参数**（核对报告 UNCHANGED）；
 * - **意外移位阻止自动采用**：本批的附带变化（非显式目标）落在受保护对象上 → 409 且零写入；
 * - 显式目标的变化不算范围外（该改的能改）。
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
    secret: 'content-protection-secret-0123456789', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `protect-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '内容保护测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture { workspaceId: string; projectId: string; sequenceId: string; videoTrackId: string; assetVersionId: string }

function probeFixture() {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'm', startTimeMs: 0, durationMs: 30_000, bitRate: 1,
    streams: [{ index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs: 30_000, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '900', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'] }],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `protect-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'protect', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

describe('N06-07 已确认内容保护与回归指纹（HTTP + SDK）', () => {
  it('三轮修改后早先认可的内容仍引用相同资产与参数（UNCHANGED）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const opening = await seedClip(fixture, [0, 3_000]); // 被确认的"开场"
    const other = await seedClip(fixture, [4_000, 7_000]);

    const protection = await client.projects.captureConfirmedContent(fixture.workspaceId, fixture.projectId, {
      label: '已确认开场', objects: [{ objectKind: 'CLIP', objectId: opening, label: '开场' }],
    });
    expect(protection.objects).toHaveLength(1);
    expect(protection.objects[0]!.assetDigest).toHaveLength(64);

    // 连续三轮修改"别的片段"
    for (const opacity of [0.9, 0.8, 0.7]) {
      await client.projects.edit(fixture.projectId, {
        schemaVersion: '1.0', baseProjectRevision: await revisionOf(client, fixture.projectId), expectedSceneRevisions: {},
        operations: [{ op: 'set_clip_opacity', clipId: other, opacity }], idempotencyKey: `idem_round_${randomUUID()}`,
      });
    }

    const report = await client.projects.checkConfirmedContent(fixture.workspaceId, fixture.projectId, protection.protectionId);
    expect(report.status).toBe('UNCHANGED');
    expect(report.intact).toBe(true);
    expect(report.diffs).toEqual([]);
    expect(report.outOfScope).toEqual([]);
    expect(report.currentRevision).toBeGreaterThan(report.capturedRevision);
  });

  it('意外移位阻止自动采用：本批附带改动受保护对象 → 409 且零写入', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipA = await seedClip(fixture, [0, 3_000]);
    const clipB = await seedClip(fixture, [3_000, 6_000]);
    const protection = await client.projects.captureConfirmedContent(fixture.workspaceId, fixture.projectId, {
      label: '受保护的 B', objects: [{ objectKind: 'CLIP', objectId: clipB, label: 'B' }],
    });
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const eventsBefore = (await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length;

    // 候选只针对 A 做涟漪删除 → B 会被**附带**左移（非显式目标）
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'ripple_clip', clipId: clipA, action: 'DELETE', amount: null, closeAcrossTracks: true }],
    });
    const failure = await expectApiFailure(
      client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
        expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
        idempotencyKey: `idem_protect_${randomUUID()}`, protectionIds: [protection.protectionId],
      }),
      { status: 409, reason: 'CONFIRMED_CONTENT_REGRESSION' },
    );
    expect((failure.details['violations'] as { objectId: string }[]).some((item) => item.objectId === clipB)).toBe(true);

    // 阻止自动采用 = 零写入
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
    expect((await handle.db.select().from(editEvents).where(eq(editEvents.projectId, fixture.projectId))).length).toBe(eventsBefore);
    // 候选保持 OPEN（可被重新评估/丢弃）
    expect((await client.projects.proposal(fixture.workspaceId, fixture.projectId, proposal.proposalId)).status).toBe('OPEN');
  });

  it('显式目标的变化不算范围外：该改的能改', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const protection = await client.projects.captureConfirmedContent(fixture.workspaceId, fixture.projectId, {
      objects: [{ objectKind: 'CLIP', objectId: clipId }],
    });
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: await revisionOf(client, fixture.projectId), selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }],
    });
    const adopted = await client.projects.adoptProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId, {
      expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: null,
      idempotencyKey: `idem_explicit_${randomUUID()}`, protectionIds: [protection.protectionId],
    });
    expect(adopted.adopted).toBe(true);
    // 显式目标之后的核对：报告能如实给出该对象的变化，但标注 explicitTarget
    const report = await client.projects.checkConfirmedContent(fixture.workspaceId, fixture.projectId, protection.protectionId, {
      explicitTargets: [{ objectKind: 'CLIP', objectId: clipId }],
    });
    expect(report.intact).toBe(false);
    expect(report.diffs[0]!.explicitTarget).toBe(true);
    expect(report.outOfScope).toEqual([]);
  });

  it('不支持的保护对象类型 → 501 fail-closed', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    await expectApiFailure(
      client.projects.captureConfirmedContent(fixture.workspaceId, fixture.projectId, {
        objects: [{ objectKind: 'CAPTION', objectId: 'cap_x' }],
      }),
      { status: 501, reason: 'CONTENT_PROTECTION_UNSUPPORTED_KIND' },
    );
  });
});
