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
import { assets, assetVersions, createDb, proposalTrials, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack, previewProposal, proposalTrialCacheStats, runRetentionSweep } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N06-04 收口验收：局部试片缓存的 **TTL / 容量上限 / 保留清理 / 可观测性**。
 * 依赖键失效已是权威机制；本项补齐"陈旧与容量"的收敛，并把策略暴露出来。
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
    secret: 'proposal-trial-cache-secret-0123456', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `trial-cache-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '试片缓存测试' });
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
  const workspace = await client.workspaces.create({ name: `trial-cache-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: 'trial-cache', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

const rowsOf = (projectId: string) => handle.db.select().from(proposalTrials).where(eq(proposalTrials.projectId, projectId));

async function makeProposal(client: AncsClient, fixture: Fixture, clipId: string, opacity: number) {
  return client.projects.createProposal(fixture.workspaceId, fixture.projectId, {
    baseProjectRevision: (await client.projects.state(fixture.projectId)).document.projectRevision,
    selectionAnchorId: null, intentRevisionId: null,
    operations: [{ op: 'set_clip_opacity', clipId, opacity }],
  });
}

describe('N06-04 收口：TTL / 容量 / 保留清理 / 可观测（HTTP + SDK + 真实数据库）', () => {
  it('过期试片不再命中（TTL 兜底），并计入 stats.expired', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const proposal = await makeProposal(client, fixture, clipId, 0.5);
    // TTL=0 → 刚写入即视为过期
    const deps = { db: handle.db, retention: { proposalTrialTtlHours: 0 } };

    const first = await previewProposal(deps, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, proposalId: proposal.proposalId });
    expect(first.cached).toBe(false);
    const second = await previewProposal(deps, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, proposalId: proposal.proposalId });
    expect(second.cached).toBe(false); // 过期即不复用（仍会重算）
    expect(await rowsOf(fixture.projectId)).toHaveLength(1); // upsert 同一依赖键，不新增行

    const stats = await proposalTrialCacheStats(deps, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(stats).toMatchObject({ rows: 1, expired: 1, ttlHours: 0 });
  });

  it('容量上限：超出按最旧淘汰，只保留最新 N 行', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    // 三个不同操作集 → 三个不同依赖键
    const proposals = [
      await makeProposal(client, fixture, clipId, 0.2),
      await makeProposal(client, fixture, clipId, 0.4),
      await makeProposal(client, fixture, clipId, 0.6),
    ];
    const deps = { db: handle.db, retention: { proposalTrialMaxPerProject: 2 } };
    for (const proposal of proposals) {
      await previewProposal(deps, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, proposalId: proposal.proposalId });
    }
    const rows = await rowsOf(fixture.projectId);
    expect(rows.length).toBe(2);
    // 最新一行必在（第三次试改对应的操作哈希）；最旧一行被淘汰
    const hashes = rows.map((row) => row.operationsHash);
    expect(hashes).toContain(proposals[2]!.operationsHash);
    expect(hashes).not.toContain(proposals[0]!.operationsHash);

    const stats = await proposalTrialCacheStats(deps, { workspaceId: fixture.workspaceId, projectId: fixture.projectId });
    expect(stats).toMatchObject({ rows: 2, capacity: 2 });
  });

  it('保留清理：retention sweep 清掉过期试片并计入报告', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const clipId = await seedClip(fixture, [0, 4_000]);
    const proposal = await makeProposal(client, fixture, clipId, 0.5);
    await previewProposal({ db: handle.db }, { workspaceId: fixture.workspaceId, projectId: fixture.projectId, proposalId: proposal.proposalId });
    expect(await rowsOf(fixture.projectId)).toHaveLength(1);

    // TTL=0 + 未来时刻 → 该行已过期
    const report = await runRetentionSweep(
      { db: handle.db, retention: { proposalTrialTtlHours: 0, trashRetentionDays: 100_000, idempotencyKeyTtlHours: 1_000_000, proposalArtifactQuarantineTtlHours: 100_000 } },
      { now: new Date(Date.now() + 60_000) },
    );
    expect(report.proposalTrialCachePurged).toBeGreaterThanOrEqual(1);
    expect(await rowsOf(fixture.projectId)).toHaveLength(0);
  });

  it('可观测性经 HTTP/SDK 暴露：默认策略为 24h / 50 行', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const stats = await client.projects.proposalTrialCacheStats(fixture.workspaceId, fixture.projectId);
    expect(stats).toEqual({ rows: 0, expired: 0, capacity: 50, ttlHours: 24 });
  });
});
