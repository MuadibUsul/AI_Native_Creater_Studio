import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, sourceMediaProbeResultSchema, type EditRequest, type MediaRange } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * N03-04 验收（HTTP + SDK + 真实数据库）：多轨、AV 链接与轨道控制
 * - 视频/音频/图形轨道可重排、静音、独奏、隐藏、链接、解链与同步锁；
 * - 关闭一轨只影响该轨（其他轨与片段不动）；
 * - 解除链接后视频 trim 不误裁音轨；
 * - 同步锁决定涟漪联动范围（预览/导出共用同一轨道状态投影）；
 * - undo 恢复关联。
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
    secret: 'tracks-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `tracks-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '多轨测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface TrackProject {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
}

async function makeProject(client: AncsClient, durationMs = 60_000): Promise<TrackProject> {
  const workspace = await client.workspaces.create({ name: `多轨-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '多轨', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

function probeFixture(durationMs: number) {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV',
    startTimeMs: 0, durationMs, bitRate: 92_000,
    streams: [
      {
        index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High',
        timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs,
        width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
        colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
        averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '300', sampleRate: null, channels: null,
        channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
      },
      {
        index: 1, type: 'AUDIO', codecName: 'aac', codecLongName: 'AAC', profile: 'LC',
        timeBase: { numerator: 1, denominator: 48_000 }, startPts: '0', durationTicks: '192000', durationMs,
        width: null, height: null, rotationDegrees: null, pixelFormat: null, colorRange: null, colorSpace: null,
        colorTransfer: null, colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null, frameCount: null,
        sampleRate: 48_000, channels: 2, channelLayout: 'stereo', cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['1024'],
      },
    ],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedSource(project: TrackProject, durationMs: number): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-04/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(durationMs),
  });
  return assetVersionId;
}

const identityMapping = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

async function seedClip(
  project: TrackProject,
  input: { trackId: string; assetVersionId: string; sequenceMs: [number, number]; avGroupId?: string },
): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: input.trackId, assetVersionId: input.assetVersionId,
      sourceRange: range(input.sequenceMs[0] - input.sequenceMs[0], input.sequenceMs[1] - input.sequenceMs[0]),
      sequenceRange: range(...input.sequenceMs), timeMapping: identityMapping,
      ...(input.avGroupId === undefined ? {} : { avGroupId: input.avGroupId }),
    },
  });
  return clip.id;
}

interface TrackView {
  id: string;
  kind: string;
  position: number;
  name: string;
  muted: boolean;
  hidden: boolean;
  solo: boolean;
  locked: boolean;
  syncLocked: boolean;
}

async function tracks(client: AncsClient, projectId: string): Promise<TrackView[]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.tracks
    .map((track) => ({
      id: track.id, kind: track.kind, position: track.position, name: track.name,
      muted: track.muted, hidden: track.hidden, solo: track.solo, locked: track.locked, syncLocked: track.syncLocked,
    }))
    .sort((left, right) => left.position - right.position);
}

async function clipRanges(client: AncsClient, projectId: string, trackId: string): Promise<[number, number][]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => [Number(clip.sequenceRange.start.ticks), Number(clip.sequenceRange.end.ticks)] as [number, number])
    .sort((left, right) => left[0] - right[0]);
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_04_${randomUUID()}`,
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

describe('N03-04 多轨、AV 链接与轨道控制（HTTP + SDK）', () => {
  it('create_track／move_track：位置占用自动让位，重排后 position 连续可排序', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);

    const created = await applyEdits(client, project.projectId, [
      { op: 'create_track', sequenceId: project.sequenceId, track: { kind: 'VIDEO', position: 0, name: 'V0', syncLocked: true } },
    ]);
    expect(created.editEvents.some((event) => event.action === 'CREATE_TRACK')).toBe(true);
    let list = await tracks(client, project.projectId);
    expect(list.map((track) => [track.name, track.position])).toEqual([['V0', 0], ['V1', 1], ['A1', 2]]);
    expect(list[0]!.syncLocked).toBe(true);
    expect(list[1]!.syncLocked).toBe(false);

    await applyEdits(client, project.projectId, [
      { op: 'move_track', trackId: project.audioTrackId, position: 0 },
    ]);
    list = await tracks(client, project.projectId);
    expect(list.map((track) => [track.name, track.position])).toEqual([['A1', 0], ['V0', 1], ['V1', 2]]);
  });

  it('update_track：关闭一轨只影响该轨（静音/隐藏/独奏/锁定状态进入投影，其他轨与片段不变）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, 20_000);
    const videoClipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [0, 4_000] });
    const audioClipId = await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [0, 4_000] });

    await applyEdits(client, project.projectId, [
      { op: 'update_track', trackId: project.audioTrackId, changes: { muted: true, solo: true, hidden: true, syncLocked: true } },
    ]);
    const list = await tracks(client, project.projectId);
    const audio = list.find((track) => track.id === project.audioTrackId)!;
    const video = list.find((track) => track.id === project.videoTrackId)!;
    expect(audio).toMatchObject({ muted: true, solo: true, hidden: true, syncLocked: true });
    // 其他轨完全不动
    expect(video).toMatchObject({ muted: false, solo: false, hidden: false, syncLocked: false, locked: false });
    // 轨道状态变化不改动任何片段
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual([[0, 4_000]]);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([[0, 4_000]]);

    // 轨道状态进入版本快照与客户端投影（预览/导出共用同一状态面）。
    const snapshot = await client.projects.state(project.projectId);
    expect(snapshot.document.composition.tracks.find((track) => track.id === project.audioTrackId)).toMatchObject({ muted: true, solo: true, hidden: true });
    expect(snapshot.document.composition.clips.map((clip) => clip.id).sort()).toEqual([videoClipId, audioClipId].sort());
  });

  it('delete_track：非空轨默认拒绝；MOVE_CLIPS 迁走片段后删除并重排位置', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, 20_000);
    await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [0, 2_000] });
    const extraVideo = await createTrack({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: { kind: 'VIDEO', position: 2, name: 'V2' },
    });

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'delete_track', trackId: project.audioTrackId, nonEmptyPolicy: 'REJECT', destinationTrackId: null }]),
      { status: 409, reason: 'TRACK_NOT_EMPTY' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'delete_track', trackId: project.audioTrackId, nonEmptyPolicy: 'MOVE_CLIPS', destinationTrackId: extraVideo.id }]),
      { status: 422, reason: 'TRACK_KIND_MISMATCH' },
    );

    const otherAudio = await createTrack({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: { kind: 'AUDIO', position: 3, name: 'A2' },
    });
    await applyEdits(client, project.projectId, [
      { op: 'delete_track', trackId: project.audioTrackId, nonEmptyPolicy: 'MOVE_CLIPS', destinationTrackId: otherAudio.id },
    ]);
    const list = await tracks(client, project.projectId);
    expect(list.some((track) => track.id === project.audioTrackId)).toBe(false);
    expect(list.map((track) => track.position)).toEqual(list.map((_, index) => index));
    // 片段被迁到目标轨（不丢片段），原轨为空
    expect(await clipRanges(client, project.projectId, otherAudio.id)).toEqual([[0, 2_000]]);
  });

  it('set_av_link：链接需一视频一音频且时长相等；解链后视频 trim 不误裁音轨；undo 恢复关联', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, 20_000);
    const videoClipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [0, 4_000] });
    const audioClipId = await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [0, 4_000] });
    const otherVideo = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [10_000, 12_000] });

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'set_av_link', linked: true, clipIds: [videoClipId, otherVideo] }]),
      { status: 422, reason: 'AV_LINK_INVALID' },
    );

    await applyEdits(client, project.projectId, [{ op: 'set_av_link', linked: true, clipIds: [videoClipId, audioClipId] }]);
    let state = await client.projects.state(project.projectId);
    const linkedGroup = state.document.composition.clips.find((clip) => clip.id === videoClipId)!.avGroupId;
    expect(linkedGroup).not.toBeNull();
    expect(state.document.composition.clips.find((clip) => clip.id === audioClipId)!.avGroupId).toBe(linkedGroup);
    // 链接后 trim 视频：音轨同步裁剪（声画一致）
    await applyEdits(client, project.projectId, [
      { op: 'trim_clip', clipId: videoClipId, sourceRange: range(0, 3_000), sequenceRange: range(0, 3_000) },
    ]);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([[0, 3_000]]);

    // 解链后 trim 视频不再影响音轨
    const seqAfterLink = (await client.projects.state(project.projectId)).eventSeq;
    await applyEdits(client, project.projectId, [{ op: 'set_av_link', linked: false, clipIds: [videoClipId, audioClipId] }]);
    state = await client.projects.state(project.projectId);
    expect(state.document.composition.clips.find((clip) => clip.id === videoClipId)!.avGroupId).toBeNull();
    await applyEdits(client, project.projectId, [
      { op: 'trim_clip', clipId: videoClipId, sourceRange: range(0, 2_000), sequenceRange: range(0, 2_000) },
    ]);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([[0, 3_000]]);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual([[0, 2_000], [10_000, 12_000]]);

    // undo 恢复关联：撤销链接之后产生的**全部**事件（解链两条 + 链接态裁剪两条），按事件粒度逐条回退
    const produced = await client.projects.editEvents(project.projectId, { afterSeq: seqAfterLink, limit: 100 });
    expect(produced.items.length).toBeGreaterThanOrEqual(3);
    for (let index = 0; index < produced.items.length; index += 1) {
      await client.projects.undo(project.projectId);
    }
    state = await client.projects.state(project.projectId);
    expect(state.document.composition.clips.find((clip) => clip.id === videoClipId)!.avGroupId).toBe(linkedGroup);
    expect(state.document.composition.clips.find((clip) => clip.id === audioClipId)!.avGroupId).toBe(linkedGroup);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([[0, 3_000]]);
  });

  it('同步锁决定涟漪联动范围：只收本轨 + 同步锁轨道，破坏声画同步的收缝 fail-closed', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, 20_000);
    const extraAudio = await createTrack({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: { kind: 'AUDIO', position: 2, name: 'A2' },
    });
    const pairGroup = `avgp_${randomUUID()}`;
    await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [0, 2_000], avGroupId: pairGroup });
    await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [2_000, 4_000] });
    await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [0, 2_000], avGroupId: pairGroup });
    await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [2_000, 4_000] });
    await seedClip(project, { trackId: extraAudio.id, assetVersionId: source, sequenceMs: [2_000, 4_000] });

    const videoFirst = (await client.projects.state(project.projectId)).document.composition.clips
      .filter((clip) => clip.trackId === project.videoTrackId)
      .sort((left, right) => Number(left.sequenceRange.start.ticks) - Number(right.sequenceRange.start.ticks))[0]!.id;

    // A1/A2 未开同步锁 → 只收本轨会与它们错位：显式拒绝（不静默改时钟）
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: videoFirst, action: 'DELETE', amount: null, closeAcrossTracks: false }]),
      { status: 409, reason: 'AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE' },
    );

    // 打开 A1/A2 的同步锁后，单轨收缝可联动（本轨 + 同步锁轨道）
    await applyEdits(client, project.projectId, [
      { op: 'update_track', trackId: project.audioTrackId, changes: { syncLocked: true } },
      { op: 'update_track', trackId: extraAudio.id, changes: { syncLocked: true } },
    ]);
    // 打开 v1 的同步锁不必要（本轨默认参与）
    await applyEdits(client, project.projectId, [
      { op: 'ripple_clip', clipId: videoFirst, action: 'DELETE', amount: null, closeAcrossTracks: false },
    ]);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual([[0, 2_000]]);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([[0, 2_000]]);
    expect(await clipRanges(client, project.projectId, extraAudio.id)).toEqual([[0, 2_000]]);
  });

  it('解链后单轨涟漪不再要求跨轨（同步锁未开也不得隐式联动别人）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, 20_000);
    const pairGroup = `avgp_${randomUUID()}`;
    const first = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sequenceMs: [0, 2_000], avGroupId: pairGroup });
    await seedClip(project, { trackId: project.audioTrackId, assetVersionId: source, sequenceMs: [0, 2_000], avGroupId: pairGroup });

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: first, action: 'DELETE', amount: null, closeAcrossTracks: false }]),
      { status: 409, reason: 'AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE' },
    );
    const result = await applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: first, action: 'DELETE', amount: null, closeAcrossTracks: true }]);
    expect(result.editEvents.some((event) => event.action === 'RIPPLE_CLIP')).toBe(true);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual([]);
    expect(await clipRanges(client, project.projectId, project.audioTrackId)).toEqual([]);
  });
});
