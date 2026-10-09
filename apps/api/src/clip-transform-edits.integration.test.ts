import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, mediaTimeToLegacyMilliseconds, sourceMediaProbeResultSchema, type EditRequest, type MediaRange } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, renderApprovals, renders, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createAudioRegion, createClip, createProject, createSequence, createTrack, getLatestRenderApproval } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N03-02 验收（HTTP + SDK + 真实数据库）：
 * - split／trim／move／duplicate／replace source 对源范围、序列范围与重叠关系正确；
 * - 拆分后两段拼回总时长与源范围不变；右段是原片段的子片段（血缘可追溯）；
 * - 越界 trim 失败；移动保持时长与轨类型；复制**不复制二进制原件**；
 * - 替换源需时长匹配，并使既有渲染批准在 revision 维度失效；
 * - 绑定到片段的音频区域随片段平移（局部时钟不变），无法保真的情形 fail-closed。
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
    secret: 'clip-transform-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `transform-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '时间线变换测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface TimelineProject {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
}

async function makeProject(client: AncsClient, durationMs = 60_000): Promise<TimelineProject> {
  const workspace = await client.workspaces.create({ name: `变换-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '时间线变换', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(durationMs) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  const audioTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id, audioTrackId: audioTrack.id };
}

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
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV',
    startTimeMs: 0, durationMs, bitRate: 92_000, streams: withAudio ? [videoStream, audioStream] : [videoStream],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedSource(
  project: TimelineProject,
  options: { durationMs: number; withAudio?: boolean; checksum?: string | null },
): Promise<{ assetId: string; assetVersionId: string }> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-02/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048,
    checksumSha256: options.checksum === undefined ? 'a'.repeat(64) : options.checksum,
    durationMs: options.durationMs, width: 1920, height: 1080, status: 'READY',
    mediaProbe: probeFixture(options.durationMs, options.withAudio === true),
  });
  return { assetId, assetVersionId };
}

const identityMapping = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

async function seedClip(
  project: TimelineProject,
  input: { trackId: string; assetVersionId: string; sourceMs: [number, number]; sequenceMs: [number, number]; avGroupId?: string },
): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: input.trackId, assetVersionId: input.assetVersionId, sourceRange: range(...input.sourceMs),
      sequenceRange: range(...input.sequenceMs), timeMapping: identityMapping,
      ...(input.avGroupId === undefined ? {} : { avGroupId: input.avGroupId }),
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
  parentClipId: string | null;
}

async function timeline(client: AncsClient, projectId: string, trackId: string): Promise<TimelineClip[]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => ({
      id: clip.id, from: ms(clip.sequenceRange.start), to: ms(clip.sequenceRange.end),
      srcFrom: ms(clip.sourceRange.start), srcTo: ms(clip.sourceRange.end),
      avGroupId: clip.avGroupId ?? null, assetVersionId: clip.assetVersionId, parentClipId: clip.parentClipId ?? null,
    }))
    .sort((left, right) => left.from - right.from);
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_02_${randomUUID()}`,
  });
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

/** 视频 + 音频关联对（同一 avGroupId），用于验证声画同步。 */
async function seedAvPair(project: TimelineProject, assetVersionId: string, sequenceMs: [number, number], sourceMs: [number, number]): Promise<{ videoClipId: string; audioClipId: string; avGroupId: string }> {
  const avGroupId = `avgp_${randomUUID()}`;
  const videoClipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId, sourceMs, sequenceMs, avGroupId });
  const audioClipId = await seedClip(project, { trackId: project.audioTrackId, assetVersionId, sourceMs, sequenceMs, avGroupId });
  return { videoClipId, audioClipId, avGroupId };
}

describe('N03-02 拆分／裁剪／移动／复制／替换源（HTTP + SDK）', () => {
  it('split_clip：两段范围守恒、右段为子片段、AV 关联片段同步切分', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source.assetVersionId, [4_000, 10_000], [1_000, 7_000]);

    const result = await applyEdits(client, project.projectId, [
      { op: 'split_clip', clipId: pair.videoClipId, at: mt(7_000) },
    ]);
    expect(result.editEvents.some((event) => event.action === 'SPLIT_CLIP')).toBe(true);

    const video = await timeline(client, project.projectId, project.videoTrackId);
    expect(video).toHaveLength(2);
    expect(video[0]).toMatchObject({ id: pair.videoClipId, from: 4_000, to: 7_000, srcFrom: 1_000, srcTo: 4_000, parentClipId: null });
    expect(video[1]).toMatchObject({ from: 7_000, to: 10_000, srcFrom: 4_000, srcTo: 7_000, parentClipId: pair.videoClipId, avGroupId: pair.avGroupId });
    // 守恒：两段时长之和与源范围拼接都等于原片段。
    expect((video[0]!.to - video[0]!.from) + (video[1]!.to - video[1]!.from)).toBe(6_000);
    expect(video[0]!.srcTo).toBe(video[1]!.srcFrom);
    expect(video[0]!.srcFrom).toBe(1_000);
    expect(video[1]!.srcTo).toBe(7_000);

    const audio = await timeline(client, project.projectId, project.audioTrackId);
    expect(audio).toHaveLength(2);
    expect(audio[0]).toMatchObject({ id: pair.audioClipId, from: 4_000, to: 7_000, srcFrom: 1_000, srcTo: 4_000 });
    expect(audio[1]).toMatchObject({ from: 7_000, to: 10_000, srcFrom: 4_000, srcTo: 7_000, avGroupId: pair.avGroupId });
  });

  it('split_clip 负面：切点必须在片段内部（含序列起点/终点）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const clipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 4_000], sequenceMs: [2_000, 6_000] });

    await expectApiFailure(applyEdits(client, project.projectId, [{ op: 'split_clip', clipId, at: mt(2_000) }]), { status: 422, reason: 'SPLIT_POINT_OUTSIDE_CLIP' });
    await expectApiFailure(applyEdits(client, project.projectId, [{ op: 'split_clip', clipId, at: mt(9_000) }]), { status: 422, reason: 'SPLIT_POINT_OUTSIDE_CLIP' });
    const clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toEqual([
      { id: clipId, from: 2_000, to: 6_000, srcFrom: 0, srcTo: 4_000, avGroupId: null, assetVersionId: source.assetVersionId, parentClipId: null },
    ]);
  });

  it('trim_clip：入出点裁剪保持 1:1 时长、AV 同步；越界与重叠被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 10_000, withAudio: true });
    const pair = await seedAvPair(project, source.assetVersionId, [20_000, 25_000], [1_000, 6_000]);
    await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 3_000], sequenceMs: [30_000, 33_000] });

    // 越界 trim：源范围超出素材时长
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'trim_clip', clipId: pair.videoClipId, sourceRange: range(5_000, 12_000), sequenceRange: range(20_000, 27_000) }]),
      { status: 422, reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' },
    );
    // 源/序列时长不一致 → 拒绝（不用隐式改速或改长）
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'trim_clip', clipId: pair.videoClipId, sourceRange: range(1_000, 5_000), sequenceRange: range(20_000, 26_000) }]),
      { status: 422, reason: 'TRIM_RANGE_DURATION_MISMATCH' },
    );
    // 与同轨既有片段重叠 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'trim_clip', clipId: pair.videoClipId, sourceRange: range(1_000, 4_000), sequenceRange: range(29_500, 32_500) }]),
      { status: 409, reason: 'CLIP_OVERLAP' },
    );

    await applyEdits(client, project.projectId, [
      { op: 'trim_clip', clipId: pair.videoClipId, sourceRange: range(2_000, 5_000), sequenceRange: range(20_500, 23_500) },
    ]);
    const video = await timeline(client, project.projectId, project.videoTrackId);
    expect(video.find((clip) => clip.id === pair.videoClipId)).toMatchObject({ from: 20_500, to: 23_500, srcFrom: 2_000, srcTo: 5_000 });
    const audio = await timeline(client, project.projectId, project.audioTrackId);
    // AV 同步：关联音频片段被裁到同一序列区间（源入点不变，出点按同一时长收敛）
    expect(audio.find((clip) => clip.id === pair.audioClipId)).toMatchObject({ from: 20_500, to: 23_500, srcFrom: 1_000, srcTo: 4_000 });
  });

  it('move_clip：重定位与跨轨移动保持时长；轨类型/锁定/重叠/长度改变被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const clipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 5_000], sequenceMs: [0, 5_000] });
    await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 4_000], sequenceMs: [10_000, 14_000] });

    // 改变长度必须走 trim_clip
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, sequenceRange: range(0, 3_000) }]),
      { status: 422, reason: 'MOVE_REQUIRES_EQUAL_DURATION' },
    );
    // 落在既有片段上 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, sequenceRange: range(11_000, 16_000) }]),
      { status: 409, reason: 'CLIP_OVERLAP' },
    );
    // 移到音频轨 → 类型不匹配
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, trackId: project.audioTrackId }]),
      { status: 422, reason: 'TRACK_KIND_MISMATCH' },
    );

    const moved = await applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, sequenceRange: range(20_000, 25_000) }]);
    expect(moved.editEvents.some((event) => event.action === 'MOVE_CLIP')).toBe(true);
    const video = await timeline(client, project.projectId, project.videoTrackId);
    expect(video.find((clip) => clip.id === clipId)).toMatchObject({ from: 20_000, to: 25_000, srcFrom: 0, srcTo: 5_000 });

    // 目标轨锁定 → 409（影响面门先拒）
    const secondTrack = await createTrack({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: { kind: 'VIDEO', position: 2, name: 'V2' },
    });
    await applyEdits(client, project.projectId, [
      { op: 'set_object_lock', objectKind: 'TRACK', objectId: secondTrack.id, dimensions: ['POSITION'], locked: true },
    ]);
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, trackId: secondTrack.id }]),
      { status: 409 },
    );
  });

  it('duplicate_clip：只复制时间线引用（同一 assetVersionId，不新增原件），AV 对一并复制', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source.assetVersionId, [0, 3_000], [2_000, 5_000]);

    const assetRowsBefore = await handle.db.select().from(assets).where(eq(assets.projectId, project.projectId));
    const versionRowsBefore = await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, project.workspaceId));

    const result = await applyEdits(client, project.projectId, [{ op: 'duplicate_clip', clipId: pair.videoClipId, afterClipId: null }]);
    expect(result.editEvents.some((event) => event.action === 'DUPLICATE_CLIP')).toBe(true);

    const video = await timeline(client, project.projectId, project.videoTrackId);
    expect(video).toHaveLength(2);
    const copy = video.find((clip) => clip.id !== pair.videoClipId)!;
    expect(copy).toMatchObject({ from: 3_000, to: 6_000, srcFrom: 2_000, srcTo: 5_000, assetVersionId: source.assetVersionId, parentClipId: pair.videoClipId });
    expect(copy.avGroupId).not.toBe(pair.avGroupId);

    const audio = await timeline(client, project.projectId, project.audioTrackId);
    expect(audio).toHaveLength(2);
    const audioCopy = audio.find((clip) => clip.id !== pair.audioClipId)!;
    expect(audioCopy).toMatchObject({ from: 3_000, to: 6_000, avGroupId: copy.avGroupId });

    // 二进制原件未被复制：资产/版本行数不变，且没有任何新资产指向该源。
    expect(await handle.db.select().from(assets).where(eq(assets.projectId, project.projectId))).toHaveLength(assetRowsBefore.length);
    expect(await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, project.workspaceId))).toHaveLength(versionRowsBefore.length);

    // 锚点之后已有片段 → 目标位置被占，拒绝（复制不会静默覆盖）
    await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 3_000], sequenceMs: [6_000, 9_000] });
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'duplicate_clip', clipId: pair.videoClipId, afterClipId: copy.id }]),
      { status: 409, reason: 'CLIP_OVERLAP' },
    );
  });

  it('replace_clip_source：新源需时长匹配且可用；切换后既有渲染批准在 revision 维度失效', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const original = await seedSource(project, { durationMs: 20_000 });
    const replacement = await seedSource(project, { durationMs: 15_000 });
    const noChecksum = await seedSource(project, { durationMs: 15_000, checksum: null });
    const clipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: original.assetVersionId, sourceMs: [1_000, 5_000], sequenceMs: [0, 4_000] });

    const stateBefore = await client.projects.state(project.projectId);
    const renderId = `rnd_${randomUUID()}`;
    await handle.db.insert(renders).values({
      id: renderId, workspaceId: project.workspaceId, projectId: project.projectId, profile: 'G0_BASELINE',
      status: 'SUCCEEDED', input: { schemaVersion: '1.0' }, manifestHash: 'b'.repeat(64),
    });
    await handle.db.insert(renderApprovals).values({
      id: `apr_${randomUUID()}`, workspaceId: project.workspaceId, projectId: project.projectId, renderId,
      decision: 'APPROVED', manifestHashAtApproval: 'b'.repeat(64), projectVersionIdAtApproval: `pv_${randomUUID()}`,
      projectRevisionAtApproval: stateBefore.document.projectRevision,
    });

    // 时长不匹配 → 拒绝（替换源不得隐式改变片段在序列上的长度）
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'replace_clip_source', clipId, nestedSequenceId: null, sourceStreamId: null, assetVersionId: replacement.assetVersionId, sourceRange: range(0, 2_000) }]),
      { status: 422, reason: 'SOURCE_DURATION_MISMATCH' },
    );
    // 缺校验和的源 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'replace_clip_source', clipId, nestedSequenceId: null, sourceStreamId: null, assetVersionId: noChecksum.assetVersionId, sourceRange: range(0, 4_000) }]),
      { status: 409, reason: 'SOURCE_CHECKSUM_MISSING' },
    );
    // 源范围越界 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'replace_clip_source', clipId, nestedSequenceId: null, sourceStreamId: null, assetVersionId: replacement.assetVersionId, sourceRange: range(12_000, 16_000) }]),
      { status: 422, reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' },
    );

    await applyEdits(client, project.projectId, [
      { op: 'replace_clip_source', clipId, nestedSequenceId: null, sourceStreamId: null, assetVersionId: replacement.assetVersionId, sourceRange: range(2_000, 6_000) },
    ]);
    const clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toEqual([
      { id: clipId, from: 0, to: 4_000, srcFrom: 2_000, srcTo: 6_000, avGroupId: null, assetVersionId: replacement.assetVersionId, parentClipId: null },
    ]);

    // 批准失效：批准记录的 revision 锚点落后于当前工程 revision（下游按该差值判 stale）。
    const approval = await getLatestRenderApproval({ db: handle.db }, { workspaceId: project.workspaceId, renderId });
    const stateAfter = await client.projects.state(project.projectId);
    expect(approval).not.toBeNull();
    expect(approval!.projectRevisionAtApproval).toBe(stateBefore.document.projectRevision);
    expect(stateAfter.document.projectRevision).toBeGreaterThan(approval!.projectRevisionAtApproval);
  });

  it('绑定音频区域：移动时随片段平移，裁剪超出局部时钟时 fail-closed', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const clipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source.assetVersionId, sourceMs: [0, 6_000], sequenceMs: [0, 6_000] });
    await createAudioRegion({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: {
        trackId: project.audioTrackId,
        timeBinding: { basis: 'CLIP_LOCAL', clipId, semanticCueId: null },
        localRange: range(1_000, 3_000),
        sourceStreamId: 'audio-main',
        channelMapping: [{ sourceChannel: 0, outputChannel: 0 }],
        gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0),
        parameters: { schemaVersion: '1.0', values: {} },
      },
    });

    await applyEdits(client, project.projectId, [{ op: 'move_clip', clipId, sequenceRange: range(10_000, 16_000) }]);
    const regions = (await client.projects.state(project.projectId)).document.composition.audioRegions;
    expect(regions).toHaveLength(1);
    // 局部时钟不变：序列区间随片段整体平移 10s
    expect(ms(regions[0]!.sequenceRange.start)).toBe(11_000);
    expect(ms(regions[0]!.sequenceRange.end)).toBe(13_000);

    // 裁到局部区域之内 → 保真（局部时钟仍在片段内）
    await applyEdits(client, project.projectId, [{ op: 'trim_clip', clipId, sourceRange: range(0, 4_000), sequenceRange: range(10_000, 14_000) }]);
    // 裁到局部区域之外 → fail-closed（区域级重算属 N03-06）
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'trim_clip', clipId, sourceRange: range(0, 1_500), sequenceRange: range(10_000, 11_500) }]),
      { status: 409, reason: 'CLIP_BOUND_AUDIO_REGION_UNSUPPORTED' },
    );
  });

  it('undo/redo：拆分后逐事件撤销可完整恢复，重做按同一切分参数还原', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source.assetVersionId, [4_000, 10_000], [1_000, 7_000]);
    const before = await timeline(client, project.projectId, project.videoTrackId);
    const seqBefore = (await client.projects.state(project.projectId)).eventSeq;

    const result = await applyEdits(client, project.projectId, [{ op: 'split_clip', clipId: pair.videoClipId, at: mt(7_000) }]);
    const produced = result.editEvents.length;
    expect(produced).toBeGreaterThan(1);
    for (let index = 0; index < produced; index += 1) {
      await client.projects.undo(project.projectId);
    }
    expect(await timeline(client, project.projectId, project.videoTrackId)).toEqual(before);
    expect(await timeline(client, project.projectId, project.audioTrackId)).toHaveLength(1);

    await client.projects.redo(project.projectId);
    const redone = await client.projects.editEvents(project.projectId, { afterSeq: seqBefore, limit: 50 });
    expect(redone.items.some((event) => event.action === 'INSERT_CLIP')).toBe(true);
    expect((await timeline(client, project.projectId, project.videoTrackId)).length).toBe(2);
  });
});
