import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
  type MediaRange,
} from '@ancs/contracts';
import { createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * N06-08 验收（HTTP + SDK + 真实数据库）：A/B 比较与差异标记
 * - 对照右侧是候选**试改后的真实执行结果**，左侧是当前确认版或另一候选；
 * - **时段/片段数不同用内容锚点对齐**，相同锚点对照不错位；
 * - 对照回带**实际素材版本**（证明对照的是真资产，不是重新生成）；对照本身不改工程。
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
    secret: 'proposal-compare-secret-0123456789a', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `compare-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: 'A/B 对照测试' });
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
  const workspace = await client.workspaces.create({ name: `compare-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'compare', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

async function seedClip(fixture: Fixture, sequenceMs: [number, number], sourceMs?: [number, number]): Promise<string> {
  const source = sourceMs ?? [0, sequenceMs[1] - sequenceMs[0]];
  const clip = await createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.videoTrackId, assetVersionId: fixture.assetVersionId,
      sourceRange: range(...source), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

async function revisionOf(client: AncsClient, projectId: string): Promise<number> {
  return (await client.projects.state(projectId)).document.projectRevision;
}

describe('N06-08 A/B 比较与差异标记（HTTP + SDK）', () => {
  it('与当前确认版对照：标出内容变化与未变片段，并回带实际素材版本', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const changed = await seedClip(fixture, [0, 3_000]);
    const untouched = await seedClip(fixture, [4_000, 7_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId: changed, opacity: 0.5 }],
    });
    const report = await client.projects.compareProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    expect(report.comparedAgainst.kind).toBe('CURRENT');
    expect(report.alignment).toBe('CLIP_ID');
    const changedDiff = report.diffs.find((diff) => diff.objectId === changed)!;
    expect(changedDiff.change).toBe('CHANGED');
    expect(changedDiff.axes).toContain('CONTENT');
    // 对照引用**实际素材版本**（不是重新生成）
    expect(changedDiff.beforeAssetVersionId).toBe(fixture.assetVersionId);
    expect(changedDiff.afterAssetVersionId).toBe(fixture.assetVersionId);
    expect(report.assetVersionIds).toContain(fixture.assetVersionId);
    // 未触碰的片段计为未变，且不产生差异
    expect(report.unchangedCount).toBe(1);
    expect(report.diffs.some((diff) => diff.objectId === untouched)).toBe(false);
    // 对照不改工程
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
  });

  it('片段数/时长不同：按内容锚点对齐（相同锚点不错位）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    // 同一素材同一源区间，放在不同序列位置 → 只能靠内容锚点对齐
    const leftOnly = await seedClip(fixture, [0, 3_000], [0, 3_000]);
    const shared = await seedClip(fixture, [4_000, 7_000], [3_000, 6_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);

    // 候选：涟漪删除 leftOnly → shared 左移（clipId 不变，位置变）
    const proposal = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'ripple_clip', clipId: leftOnly, action: 'DELETE', amount: null, closeAcrossTracks: true }],
    });
    const report = await client.projects.compareProposal(fixture.workspaceId, fixture.projectId, proposal.proposalId);
    // shared 的 clipId 保留 → 按 CLIP_ID 对齐；leftOnly 被删除 → REMOVED
    const removedDiff = report.diffs.find((diff) => diff.objectId === leftOnly)!;
    expect(removedDiff.change).toBe('REMOVED');
    expect(removedDiff.afterAssetVersionId).toBeNull();
    const sharedDiff = report.diffs.find((diff) => diff.objectId === shared)!;
    expect(sharedDiff.change).toBe('CHANGED');
    expect(sharedDiff.axes).toContain('POSITION');
    expect(report.removedCount).toBe(1);
    expect(report.unmatchedAnchors).toEqual([]);
  });

  it('候选之间 A/B 对照：同样回带两侧实际素材版本，且不改工程', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const revisionBefore = await revisionOf(client, fixture.projectId);
    const proposalA = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'set_clip_opacity', clipId, opacity: 0.2 }],
    });
    const proposalB = await client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
      baseProjectRevision: revisionBefore, selectionAnchorId: null, intentRevisionId: null,
      operations: [{ op: 'trim_clip', clipId, sourceRange: range(500, 3_500), sequenceRange: range(0, 3_000) }],
    });
    const report = await client.projects.compareProposal(fixture.workspaceId, fixture.projectId, proposalB.proposalId, {
      againstProposalId: proposalA.proposalId,
    });
    expect(report.comparedAgainst.kind).toBe('PROPOSAL');
    expect(report.comparedAgainst.ref).toBe(proposalA.proposalId);
    const diff = report.diffs.find((item) => item.objectId === clipId)!;
    expect(diff.change).toBe('CHANGED');
    expect(diff.axes).toContain('CONTENT');
    expect(diff.beforeAssetVersionId).toBe(fixture.assetVersionId);
    expect(diff.afterAssetVersionId).toBe(fixture.assetVersionId);
    expect(await revisionOf(client, fixture.projectId)).toBe(revisionBefore);
  });
});
