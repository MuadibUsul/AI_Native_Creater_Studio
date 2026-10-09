import { randomUUID } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  sourceMediaProbeResultSchema,
  type EditRequest,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, narrativePlans, resolveTestDatabaseUrl, runMigrations, scenes, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { LocalObjectStorage } from '@ancs/providers-storage-local';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';
import { createStorageDeps } from './plugins/storage.js';

/**
 * N03-01 验收（HTTP + SDK + 真实数据库 + 本地对象存储）：
 * - 三种插入语义（INSERT / OVERWRITE / APPEND）对**源范围、总时长（序列时长）、重叠关系**正确；
 * - 覆盖（及插入涟漪）命中锁定区间失败（409 TRACK_LOCKED / CLIP_LOCKED）；
 * - 无 NarrativePlan 的纯素材项目：插入后的片段引用 READY 源版本 + 校验和，且播放地址可取到真实字节；
 * - 源含音频流时建立 AV 关联；un/redo 可精确反演（按事件粒度）。
 */

const PASSWORD = 'password-1234';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let storage: LocalObjectStorage;

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

  const rootDir = await mkdtemp(join(tmpdir(), 'ancs-clip-edits-'));
  storage = new LocalObjectStorage({
    rootDir,
    publicBaseUrl: 'http://127.0.0.1:0',
    signingSecret: 'clip-edits-integration-secret-0123456789', // secrets:check-ignore：测试专用假密钥（非真实凭据）
  });

  auth = createAuth({
    db: handle.db,
    secret: 'clip-edits-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    storage: createStorageDeps(storage),
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  storage.publicBaseUrl = baseUrl;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });
const ms = (time: unknown): number => mediaTimeToLegacyMilliseconds(time as never);

async function newSignedInClient(): Promise<AncsClient> {
  const email = `clips-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '剪辑测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface FootageProject {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
}

async function makeFootageProject(client: AncsClient, durationMs = 30_000): Promise<FootageProject> {
  const workspace = await client.workspaces.create({ name: `纯素材-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  // 纯素材工程由 domain 的 createProject 建立（SDK 的 create 入参面尚未暴露 mode，属 N04 工程入口范围）。
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id,
    input: { title: '纯素材剪辑', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id,
    projectId: project.id,
    input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(durationMs) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id,
    projectId: project.id,
    sequenceId: sequence.id,
    input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id };
}

async function seedSource(
  project: FootageProject,
  options: { durationMs: number; withAudio?: boolean; checksum?: string | null },
): Promise<{ assetId: string; assetVersionId: string }> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  const checksum = options.checksum === undefined ? 'a'.repeat(64) : options.checksum;
  await handle.db.insert(assets).values({
    id: assetId,
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD',
    status: 'READY',
    retentionClass: 'PROJECT',
    license: { kind: 'OWNED' },
    currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId,
    assetId,
    workspaceId: project.workspaceId,
    versionNumber: 1,
    storageKey: `n03-01/${assetVersionId}.mp4`,
    mimeType: 'video/mp4',
    sizeBytes: 2048,
    checksumSha256: checksum,
    durationMs: options.durationMs,
    width: 1920,
    height: 1080,
    status: 'READY',
    // 规范探测结果（sourceMediaProbeResultSchema）：插入时的原声判定与播放可用性都读这里。
    mediaProbe: probeFixture(options.durationMs, options.withAudio === true),
  });
  return { assetId, assetVersionId };
}

/** 规范探测结果夹具：按 sourceMediaProbeResultSchema 构造，保证与真实探测输出同构。 */
function probeFixture(durationMs: number, withAudio: boolean) {
  const videoStream = {
    index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High',
    timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs,
    width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
    averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: String(Math.round(durationMs / 33.33)),
    sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT' as const,
    sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
  };
  const audioStream = {
    ...videoStream, index: 1, type: 'AUDIO' as const, codecName: 'aac', codecLongName: 'AAC', profile: 'LC',
    width: null, height: null, pixelFormat: null, colorRange: null, colorSpace: null, colorTransfer: null,
    colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null, frameCount: null,
    sampleRate: 48_000, channels: 2, channelLayout: 'stereo',
  };
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0',
    status: 'READY',
    formatNames: ['mp4'],
    formatLongName: 'QuickTime / MOV',
    startTimeMs: 0,
    durationMs,
    bitRate: 92_000,
    streams: withAudio ? [videoStream, audioStream] : [videoStream],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedClip(project: FootageProject, assetVersionId: string, startMs: number, durationMs: number): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId,
    projectId: project.projectId,
    sequenceId: project.sequenceId,
    input: {
      trackId: project.videoTrackId,
      assetVersionId,
      sourceRange: range(0, durationMs),
      sequenceRange: range(startMs, startMs + durationMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

interface TimelineClip {
  id: string;
  from: number;
  to: number;
  srcFrom: number;
  srcTo: number;
  avGroupId: string | null;
  assetVersionId: string | null;
}

async function timeline(client: AncsClient, projectId: string, trackId: string): Promise<TimelineClip[]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => ({
      id: clip.id,
      from: ms(clip.sequenceRange.start),
      to: ms(clip.sequenceRange.end),
      srcFrom: ms(clip.sourceRange.start),
      srcTo: ms(clip.sourceRange.end),
      avGroupId: clip.avGroupId ?? null,
      assetVersionId: clip.assetVersionId,
    }))
    .sort((left, right) => left.from - right.from);
}

async function audioTrackIds(client: AncsClient, projectId: string, sequenceId: string): Promise<string[]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.tracks.filter((track) => track.kind === 'AUDIO' && track.sequenceId === sequenceId).map((track) => track.id);
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0',
    baseProjectRevision: state.document.projectRevision,
    expectedSceneRevisions: {},
    operations,
    idempotencyKey: `idem_n03_01_${randomUUID()}`,
  });
}

interface InsertInput {
  assetVersionId: string;
  sourceMs?: [number, number];
  mode?: 'INSERT' | 'OVERWRITE' | 'APPEND';
  atMs?: number;
  linkAudio?: boolean;
}

const insertOp = (project: FootageProject, input: InsertInput) => {
  const mode = input.mode ?? 'INSERT';
  const [srcFrom, srcTo] = input.sourceMs ?? [0, 2000];
  return {
    op: 'insert_clip' as const,
    sequenceId: project.sequenceId,
    trackId: project.videoTrackId,
    assetVersionId: input.assetVersionId,
    nestedSequenceId: null,
    sourceStreamId: null,
    sourceRange: range(srcFrom, srcTo),
    mode,
    sequenceStart: mode === 'APPEND' ? null : mt(input.atMs ?? 0),
    linkAudio: input.linkAudio ?? true,
    audioTrackId: null,
  };
};

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(
    () => null,
    (error: unknown) => error,
  );
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect((failure.details as { reason?: string } | undefined)?.reason).toBe(expected.reason);
  return failure;
}

describe('N03-01 插入／覆盖／追加（HTTP + SDK）', () => {
  it('INSERT：新片段落位并涟漪右移后续片段，源范围与既有内容不变，序列时长不变', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const insertSource = await seedSource(project, { durationMs: 10_000, withAudio: true });
    const clipA = await seedClip(project, base.assetVersionId, 0, 2_000);
    const clipB = await seedClip(project, base.assetVersionId, 3_000, 2_000);
    const clipC = await seedClip(project, base.assetVersionId, 5_000, 2_000);

    const durationBefore = ms((await client.projects.state(project.projectId)).document.composition.sequences.find((s) => s.id === project.sequenceId)!.duration);
    expect(durationBefore).toBe(30_000);

    const result = await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 2_000], mode: 'INSERT', atMs: 2_000 }),
    ]);
    expect(result.editEvents.filter((event) => event.action === 'INSERT_CLIP')).toHaveLength(2); // 视频片段 + 关联音频片段

    const clips = await timeline(client, project.projectId, project.videoTrackId);
    // 插入的片段由"源版本"唯一确定；既有片段只被平移（id 不变）。
    const insertedClip = clips.find((clip) => clip.assetVersionId === insertSource.assetVersionId);
    expect(insertedClip).toBeDefined();
    expect(clips).toEqual([
      { id: clipA, from: 0, to: 2_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, assetVersionId: base.assetVersionId },
      { id: insertedClip!.id, from: 2_000, to: 4_000, srcFrom: 0, srcTo: 2_000, avGroupId: expect.any(String) as unknown as string, assetVersionId: insertSource.assetVersionId },
      { id: clipB, from: 5_000, to: 7_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, assetVersionId: base.assetVersionId },
      { id: clipC, from: 7_000, to: 9_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, assetVersionId: base.assetVersionId },
    ]);

    // AV 关联：源含音频流时，同一 avGroupId 的音频片段落在同一序列区间。
    const audioTracks = await audioTrackIds(client, project.projectId, project.sequenceId);
    expect(audioTracks).toHaveLength(1);
    const audioClips = await timeline(client, project.projectId, audioTracks[0]!);
    expect(audioClips).toHaveLength(1);
    expect(audioClips[0]).toMatchObject({ from: 2_000, to: 4_000 });
    expect(audioClips[0]!.avGroupId).toBe(clips[1]!.avGroupId);

    // 序列时长不因插入而变化（长度扩展属 N03-04）。
    const state = await client.projects.state(project.projectId, { schemaVersion: '1.0' });
    expect(ms(state.document.composition.sequences.find((s) => s.id === project.sequenceId)!.duration)).toBe(30_000);
    // 与 N01-09 投影一致：插入的片段同样出现在媒体源/片段实例视图中。
    expect(state.clipInstances).toContainEqual(expect.objectContaining({
      clipId: insertedClip!.id,
      sourceKind: 'MEDIA_SOURCE',
      sourceId: insertSource.assetVersionId,
    }));
  });

  it('INSERT：插入点落在片段内部时切分该片段，左段留位、右段右移，不产生重叠', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const insertSource = await seedSource(project, { durationMs: 10_000 });
    const spanning = await seedClip(project, base.assetVersionId, 0, 4_000);

    const result = await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 1_000], mode: 'INSERT', atMs: 2_000 }),
    ]);
    // 切分额外产生一条 INSERT_CLIP 事件（右段重建），加上本次插入本身共 2 条。
    expect(result.editEvents.filter((event) => event.action === 'INSERT_CLIP')).toHaveLength(2);

    const clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toHaveLength(3);
    expect(clips[0]).toMatchObject({ id: spanning, from: 0, to: 2_000, srcFrom: 0, srcTo: 2_000 });
    expect(clips[1]).toMatchObject({ from: 2_000, to: 3_000, srcFrom: 0, srcTo: 1_000, assetVersionId: insertSource.assetVersionId });
    expect(clips[2]).toMatchObject({ from: 3_000, to: 5_000, srcFrom: 2_000, srcTo: 4_000, assetVersionId: base.assetVersionId });
    expect(clips[2]!.id).not.toBe(spanning);
    // 无重叠：相邻片段首尾相接。
    expect(clips[0]!.to).toBeLessThanOrEqual(clips[1]!.from);
    expect(clips[1]!.to).toBeLessThanOrEqual(clips[2]!.from);
  });

  it('OVERWRITE：覆盖区间内整体删除／尾部裁切／内部切分，源范围同步对齐', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const insertSource = await seedSource(project, { durationMs: 10_000 });
    const covered = await seedClip(project, base.assetVersionId, 0, 2_000);
    const tailTrimmed = await seedClip(project, base.assetVersionId, 4_000, 4_000);
    const splitInside = await seedClip(project, base.assetVersionId, 10_000, 4_000);

    // ① 完全覆盖 → 删除
    await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 2_000], mode: 'OVERWRITE', atMs: 0 }),
    ]);
    let clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.some((clip) => clip.id === covered)).toBe(false);
    expect(clips.find((clip) => clip.from === 0)).toMatchObject({ to: 2_000, srcFrom: 0, srcTo: 2_000, assetVersionId: insertSource.assetVersionId });

    // ② 覆盖片段头部 → 保留尾部并把源入点前推
    await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 2_000], mode: 'OVERWRITE', atMs: 4_000 }),
    ]);
    clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.find((clip) => clip.id === tailTrimmed)).toMatchObject({ from: 6_000, to: 8_000, srcFrom: 2_000, srcTo: 4_000 });
    expect(clips.find((clip) => clip.from === 4_000)).toMatchObject({ to: 6_000, assetVersionId: insertSource.assetVersionId });

    // ③ 覆盖片段内部 → 左段保留、右段重建（源范围两侧同步切分）
    const beforeSplit = await timeline(client, project.projectId, project.videoTrackId);
    await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 1_000], mode: 'OVERWRITE', atMs: 11_000 }),
    ]);
    clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.find((clip) => clip.id === splitInside)).toMatchObject({ from: 10_000, to: 11_000, srcFrom: 0, srcTo: 1_000 });
    expect(clips.find((clip) => clip.from === 12_000)).toMatchObject({ to: 14_000, srcFrom: 2_000, srcTo: 4_000 });
    expect(clips.find((clip) => clip.from === 11_000)).toMatchObject({ to: 12_000, srcFrom: 0, srcTo: 1_000 });
    // 参与覆盖的片段总数：原 3 段 → 删除 1 段 + 新增 3 段 + 切分新增 1 段 = 6
    expect(clips).toHaveLength(beforeSplit.length + 2);
    expect(clips.every((clip, index) => index === 0 || clips[index - 1]!.to <= clip.from)).toBe(true);
  });

  it('APPEND：追加到目标轨道末端，既有片段与间隙不变', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const appendSource = await seedSource(project, { durationMs: 10_000 });
    const first = await seedClip(project, base.assetVersionId, 0, 2_000);
    const second = await seedClip(project, base.assetVersionId, 6_000, 2_000);

    await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: appendSource.assetVersionId, sourceMs: [0, 3_000], mode: 'APPEND' }),
    ]);

    const clips = await timeline(client, project.projectId, project.videoTrackId);
    const appendedClip = clips.find((clip) => clip.assetVersionId === appendSource.assetVersionId);
    expect(appendedClip).toBeDefined();
    expect(clips).toEqual([
      { id: first, from: 0, to: 2_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, assetVersionId: base.assetVersionId },
      { id: second, from: 6_000, to: 8_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, assetVersionId: base.assetVersionId },
      { id: appendedClip!.id, from: 8_000, to: 11_000, srcFrom: 0, srcTo: 3_000, avGroupId: null, assetVersionId: appendSource.assetVersionId },
    ]);
  });

  it('负面路径：轨道锁定与片段锁定分别拒绝（409 EDIT_IMPACT_LOCKED / CLIP_LOCKED）', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const lockedClip = await seedClip(project, base.assetVersionId, 4_000, 4_000);

    await applyEdits(client, project.projectId, [
      { op: 'set_object_lock', objectKind: 'TRACK', objectId: project.videoTrackId, dimensions: ['POSITION'], locked: true },
    ]);
    // 轨道锁命中 insert_clip 声明的 TRACK/POSITION 影响面，由统一的影响面锁门拒绝（不是先写后失败）。
    await expectApiFailure(
      applyEdits(client, project.projectId, [
        insertOp(project, { assetVersionId: base.assetVersionId, sourceMs: [0, 1_000], mode: 'OVERWRITE', atMs: 0 }),
      ]),
      { status: 409, reason: 'EDIT_IMPACT_LOCKED' },
    );

    await applyEdits(client, project.projectId, [
      { op: 'set_object_lock', objectKind: 'TRACK', objectId: project.videoTrackId, dimensions: ['POSITION'], locked: false },
      { op: 'set_object_lock', objectKind: 'CLIP', objectId: lockedClip, dimensions: ['POSITION'], locked: true },
    ]);
    const failure = await expectApiFailure(
      applyEdits(client, project.projectId, [
        insertOp(project, { assetVersionId: base.assetVersionId, sourceMs: [0, 2_000], mode: 'OVERWRITE', atMs: 4_000 }),
      ]),
      { status: 409, reason: 'CLIP_LOCKED' },
    );
    expect((failure.details as { clipId?: string }).clipId).toBe(lockedClip);

    // 一次事务失败不留下任何部分写入。
    const clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toEqual([
      { id: lockedClip, from: 4_000, to: 8_000, srcFrom: 0, srcTo: 4_000, avGroupId: null, assetVersionId: base.assetVersionId },
    ]);
  });

  it('负面路径：源未就绪/缺校验和/源范围越界被拒绝，且不产生部分写入', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const noChecksum = await seedSource(project, { durationMs: 5_000, checksum: null });
    const ready = await seedSource(project, { durationMs: 5_000 });

    await expectApiFailure(
      applyEdits(client, project.projectId, [
        insertOp(project, { assetVersionId: noChecksum.assetVersionId, sourceMs: [0, 1_000], mode: 'APPEND' }),
      ]),
      { status: 409, reason: 'SOURCE_CHECKSUM_MISSING' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [
        insertOp(project, { assetVersionId: ready.assetVersionId, sourceMs: [0, 6_000], mode: 'APPEND' }),
      ]),
      { status: 422, reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [
        insertOp(project, { assetVersionId: ready.assetVersionId, sourceMs: [0, 1_000], mode: 'INSERT', atMs: 29_500 }),
      ]),
      { status: 422, reason: 'SEQUENCE_RANGE_OUT_OF_BOUNDS' },
    );
    expect(await timeline(client, project.projectId, project.videoTrackId)).toEqual([]);
  });

  it('纯素材项目（无 NarrativePlan）：插入片段引用 READY 源版本并可取到真实播放字节', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const source = await seedSource(project, { durationMs: 8_000 });
    const payload = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]);
    await storage.putObject(`n03-01/${source.assetVersionId}.mp4`, payload);

    await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: source.assetVersionId, sourceMs: [1_000, 3_000], mode: 'APPEND', linkAudio: false }),
    ]);

    const state = await client.projects.state(project.projectId, { schemaVersion: '1.0' });
    // 无文章/叙事计划也能承载时间线：既无 Scene、也无 NarrativePlan 版本。
    expect(await handle.db.select().from(scenes).where(eq(scenes.projectId, project.projectId))).toHaveLength(0);
    expect(await handle.db.select().from(narrativePlans).where(eq(narrativePlans.projectId, project.projectId))).toHaveLength(0);
    expect(state.document.composition.clips).toHaveLength(1);
    expect(state.mediaSources).toContainEqual(
      expect.objectContaining({ sourceAssetVersionId: source.assetVersionId, checksumSha256: 'a'.repeat(64) }),
    );

    const playback = await client.assets.playbackUrl(project.workspaceId, source.assetId);
    expect(playback.url).not.toBeNull();
    const response = await fetch(playback.url!);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  });

  it('插入写入事件日志，undo 逐个事件反演后可完整恢复到插入前状态', async () => {
    const client = await newSignedInClient();
    const project = await makeFootageProject(client);
    const base = await seedSource(project, { durationMs: 20_000 });
    const insertSource = await seedSource(project, { durationMs: 10_000, withAudio: true });
    const clipA = await seedClip(project, base.assetVersionId, 0, 4_000);
    const clipB = await seedClip(project, base.assetVersionId, 6_000, 2_000);
    const before = await timeline(client, project.projectId, project.videoTrackId);
    expect(before.map((clip) => [clip.id, clip.from, clip.to])).toEqual([
      [clipA, 0, 4_000],
      [clipB, 6_000, 8_000],
    ]);
    const seqBefore = (await client.projects.state(project.projectId)).eventSeq;

    const result = await applyEdits(client, project.projectId, [
      insertOp(project, { assetVersionId: insertSource.assetVersionId, sourceMs: [0, 1_000], mode: 'INSERT', atMs: 2_000 }),
    ]);
    const producedEvents = result.editEvents.length;
    expect(producedEvents).toBeGreaterThan(1);
    const events = await client.projects.editEvents(project.projectId, { afterSeq: seqBefore, limit: 50 });
    expect(events.items).toHaveLength(producedEvents);
    expect(events.items.every((event) => ['INSERT_CLIP', 'UPDATE_CLIP', 'DELETE_CLIP'].includes(event.action))).toBe(true);

    for (let index = 0; index < producedEvents; index += 1) {
      await client.projects.undo(project.projectId);
    }
    const restored = await timeline(client, project.projectId, project.videoTrackId);
    expect(restored).toEqual(before);
    const audioTracks = await audioTrackIds(client, project.projectId, project.sequenceId);
    for (const trackId of audioTracks) expect(await timeline(client, project.projectId, trackId)).toEqual([]);

    // 撤销分支之上重做：按事件粒度重放最后一步（AV 关联的音轨创建属 N03-04 轨道生命周期）。
    await client.projects.redo(project.projectId);
    expect((await timeline(client, project.projectId, project.videoTrackId)).length).toBeGreaterThan(0);
  });
});
