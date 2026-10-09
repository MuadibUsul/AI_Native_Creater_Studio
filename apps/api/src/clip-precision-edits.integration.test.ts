import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { legacyMillisecondsToMediaTime, mediaTimeToLegacyMilliseconds, sourceMediaProbeResultSchema, type EditRequest, type MediaRange } from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * N03-03 验收（HTTP + SDK + 真实数据库）：ripple／roll／slip／slide 与 J/L cut
 * - 每种操作有前后源/序列范围断言；
 * - 只有 `ripple_clip` 会移动其他片段（"其他别动"时不得意外涟漪）；
 * - J/L cut 切换处原音连续（音频源范围拼接无跳变）。
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
    secret: 'precision-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
/** 负向位移用显式负 ticks（legacy 毫秒 Helper 只接受非负整数）。 */
const negativeMt = (milliseconds: number) => ({ ticks: `-${milliseconds}`, timebase: { num: 1, den: 1_000 } });

async function newSignedInClient(): Promise<AncsClient> {
  const email = `precision-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '精剪测试' });
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
  const workspace = await client.workspaces.create({ name: `精剪-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '精剪', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
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

async function seedSource(project: TimelineProject, options: { durationMs: number; withAudio?: boolean }): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-03/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs: options.durationMs, width: 1920, height: 1080, status: 'READY',
    mediaProbe: probeFixture(options.durationMs, options.withAudio === true),
  });
  return assetVersionId;
}

const identityMapping = { kind: 'LINEAR' as const, rate: { num: 1, den: 1 }, direction: 'FORWARD' as const, preservePitch: true };

async function seedClip(
  project: TimelineProject,
  input: { trackId: string; assetVersionId: string; sourceMs: [number, number]; sequenceMs: [number, number]; avGroupId?: string; parentClipId?: string },
): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: input.trackId, assetVersionId: input.assetVersionId, sourceRange: range(...input.sourceMs),
      sequenceRange: range(...input.sequenceMs), timeMapping: identityMapping,
      ...(input.avGroupId === undefined ? {} : { avGroupId: input.avGroupId }),
      ...(input.parentClipId === undefined ? {} : { parentClipId: input.parentClipId }),
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
  parentClipId: string | null;
}

async function timeline(client: AncsClient, projectId: string, trackId: string): Promise<TimelineClip[]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => ({
      id: clip.id, from: ms(clip.sequenceRange.start), to: ms(clip.sequenceRange.end),
      srcFrom: ms(clip.sourceRange.start), srcTo: ms(clip.sourceRange.end),
      avGroupId: clip.avGroupId ?? null, parentClipId: clip.parentClipId ?? null,
    }))
    .sort((left, right) => left.from - right.from);
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_03_${randomUUID()}`,
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

async function seedAvPair(project: TimelineProject, assetVersionId: string, sequenceMs: [number, number], sourceMs: [number, number]) {
  const avGroupId = `avgp_${randomUUID()}`;
  const videoClipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId, sourceMs, sequenceMs, avGroupId });
  const audioClipId = await seedClip(project, { trackId: project.audioTrackId, assetVersionId, sourceMs, sequenceMs, avGroupId });
  return { videoClipId, audioClipId, avGroupId };
}

describe('N03-03 精剪：ripple／roll／slip／slide 与 J/L cut（HTTP + SDK）', () => {
  it('slip：只平移源入出点，序列位置与时长不变；AV 关联片段同步滑移', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source, [10_000, 14_000], [2_000, 6_000]);

    await applyEdits(client, project.projectId, [{ op: 'slip_clip', clipId: pair.videoClipId, sourceRange: range(5_000, 9_000) }]);

    const video = await timeline(client, project.projectId, project.videoTrackId);
    expect(video).toEqual([
      { id: pair.videoClipId, from: 10_000, to: 14_000, srcFrom: 5_000, srcTo: 9_000, avGroupId: pair.avGroupId, parentClipId: null },
    ]);
    const audio = await timeline(client, project.projectId, project.audioTrackId);
    // AV 同步：关联音频按同一源滑移量（+3s）平移源入出点，序列位置不变。
    expect(audio).toEqual([
      { id: pair.audioClipId, from: 10_000, to: 14_000, srcFrom: 5_000, srcTo: 9_000, avGroupId: pair.avGroupId, parentClipId: null },
    ]);
  });

  it('slip 负面：滑移不得改变时长，且源必须可用', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 6_000 });
    const clipId = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 4_000], sequenceMs: [0, 4_000] });

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'slip_clip', clipId, sourceRange: range(0, 2_000) }]),
      { status: 422, reason: 'SLIP_DURATION_MISMATCH' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'slip_clip', clipId, sourceRange: range(3_000, 7_000) }]),
      { status: 422, reason: 'SOURCE_RANGE_OUT_OF_BOUNDS' },
    );
    expect(await timeline(client, project.projectId, project.videoTrackId)).toEqual([
      { id: clipId, from: 0, to: 4_000, srcFrom: 0, srcTo: 4_000, avGroupId: null, parentClipId: null },
    ]);
  });

  it('slide：位移由左右邻居吸收，合成总时长不变；无邻居/handle 不足被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const prev = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [0, 2_000] });
    const middle = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 3_000], sequenceMs: [2_000, 5_000] });
    const next = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [5_000, 7_000] });

    // 无邻居（单独轨道）→ 拒绝
    const lonelyTrack = await createTrack({ db: handle.db }, {
      workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
      input: { kind: 'VIDEO', position: 3, name: 'V3' },
    });
    const lonely = await seedClip(project, { trackId: lonelyTrack.id, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [20_000, 22_000] });
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'slide_clip', clipId: lonely, offset: mt(500) }]),
      { status: 422, reason: 'SLIDE_REQUIRES_ADJACENT_NEIGHBORS' },
    );
    // handle 不足（next 源入点为 0，向左滑需要更早的素材）→ 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'slide_clip', clipId: middle, offset: negativeMt(500) }]),
      { status: 422, reason: 'HANDLE_UNAVAILABLE' },
    );

    await applyEdits(client, project.projectId, [{ op: 'slide_clip', clipId: middle, offset: mt(500) }]);
    const clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toEqual([
      { id: prev, from: 0, to: 2_500, srcFrom: 0, srcTo: 2_500, avGroupId: null, parentClipId: null },
      { id: middle, from: 2_500, to: 5_500, srcFrom: 0, srcTo: 3_000, avGroupId: null, parentClipId: null },
      { id: next, from: 5_500, to: 7_000, srcFrom: 500, srcTo: 2_000, avGroupId: null, parentClipId: null },
    ]);
    // 合成总时长守恒：0–7000 不变，且三段首尾相接。
    expect(clips[0]!.from).toBe(0);
    expect(clips[2]!.to).toBe(7_000);
    expect(clips[0]!.to).toBe(clips[1]!.from);
    expect(clips[1]!.to).toBe(clips[2]!.from);
  });

  it('roll：移动相邻剪辑点，左右两段合成不变，源入出点同步移动', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const left = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 4_000], sequenceMs: [0, 4_000] });
    const right = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [4_000, 8_000], sequenceMs: [4_000, 8_000] });
    const other = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 1_000], sequenceMs: [20_000, 21_000] });

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'roll_clip', leftClipId: left, rightClipId: other, at: mt(20_500) }]),
      { status: 422, reason: 'ROLL_REQUIRES_ADJACENT_CLIPS' },
    );

    await applyEdits(client, project.projectId, [{ op: 'roll_clip', leftClipId: left, rightClipId: right, at: mt(5_000) }]);
    const clips = await timeline(client, project.projectId, project.videoTrackId);
    const rolledLeft = clips.find((clip) => clip.id === left)!;
    const rolledRight = clips.find((clip) => clip.id === right)!;
    expect(rolledLeft).toMatchObject({ from: 0, to: 5_000, srcFrom: 0, srcTo: 5_000 });
    expect(rolledRight).toMatchObject({ from: 5_000, to: 8_000, srcFrom: 5_000, srcTo: 8_000 });
    // 合成不变：两段总时长仍为 8s，剪辑点两侧首尾相接且源连续。
    expect((rolledLeft.to - rolledLeft.from) + (rolledRight.to - rolledRight.from)).toBe(8_000);
    expect(rolledLeft.to).toBe(rolledRight.from);
    expect(rolledLeft.srcTo).toBe(rolledRight.srcFrom);
  });

  it('ripple：掐头/去尾/删除都会收缝并逐段落事件报告位移，其他原语不隐式涟漪', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const first = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 4_000], sequenceMs: [0, 4_000] });
    const second = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 3_000], sequenceMs: [4_000, 7_000] });
    const third = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [7_000, 9_000] });

    // 掐头 1s：片段自身与后续片段一起左移，缺口闭合
    const trimHead = await applyEdits(client, project.projectId, [
      { op: 'ripple_clip', clipId: first, action: 'TRIM_HEAD', amount: mt(1_000), closeAcrossTracks: true },
    ]);
    expect(trimHead.editEvents.some((event) => event.action === 'RIPPLE_CLIP')).toBe(true);
    // 位移对用户可见：每个被平移的片段都有 UPDATE_CLIP 事件（含 before/after 位置）
    const shifted = trimHead.editEvents.filter((event) => event.action === 'UPDATE_CLIP' && event.patch['ripple'] === true);
    expect(shifted).toHaveLength(2);
    let clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips).toEqual([
      { id: first, from: 0, to: 3_000, srcFrom: 1_000, srcTo: 4_000, avGroupId: null, parentClipId: null },
      { id: second, from: 3_000, to: 6_000, srcFrom: 0, srcTo: 3_000, avGroupId: null, parentClipId: null },
      { id: third, from: 6_000, to: 8_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, parentClipId: null },
    ]);

    // 去尾 1s
    await applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: second, action: 'TRIM_TAIL', amount: mt(1_000), closeAcrossTracks: true }]);
    clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.find((clip) => clip.id === second)).toMatchObject({ from: 3_000, to: 5_000, srcFrom: 0, srcTo: 2_000 });
    expect(clips.find((clip) => clip.id === third)).toMatchObject({ from: 5_000, to: 7_000 });

    // 非涟漪原语（trim_clip）**不得**移动后面的片段
    await applyEdits(client, project.projectId, [
      { op: 'trim_clip', clipId: first, sourceRange: range(1_000, 2_500), sequenceRange: range(0, 1_500) },
    ]);
    clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.find((clip) => clip.id === second)).toMatchObject({ from: 3_000, to: 5_000 });
    expect(clips.find((clip) => clip.id === third)).toMatchObject({ from: 5_000, to: 7_000 });

    // 删除收缝（显式请求）
    await applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: second, action: 'DELETE', amount: null, closeAcrossTracks: false }]);
    clips = await timeline(client, project.projectId, project.videoTrackId);
    expect(clips.some((clip) => clip.id === second)).toBe(false);
    expect(clips.find((clip) => clip.id === third)).toMatchObject({ from: 3_000, to: 5_000 });
  });

  it('ripple 负面：单轨收缝会破坏 AV 同步时 fail-closed；金额越界被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source, [0, 4_000], [0, 4_000]);

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: pair.videoClipId, action: 'DELETE', amount: null, closeAcrossTracks: false }]),
      { status: 409, reason: 'AV_SYNC_REQUIRES_CROSS_TRACK_RIPPLE' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: pair.videoClipId, action: 'TRIM_HEAD', amount: mt(9_000), closeAcrossTracks: true }]),
      { status: 422, reason: 'RIPPLE_AMOUNT_OUT_OF_RANGE' },
    );

    // 跨轨收缝：视频与音频同步删除并一起收缝
    const tail = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [4_000, 6_000] });
    await applyEdits(client, project.projectId, [{ op: 'ripple_clip', clipId: pair.videoClipId, action: 'DELETE', amount: null, closeAcrossTracks: true }]);
    expect(await timeline(client, project.projectId, project.videoTrackId)).toEqual([
      { id: tail, from: 0, to: 2_000, srcFrom: 0, srcTo: 2_000, avGroupId: null, parentClipId: null },
    ]);
    expect(await timeline(client, project.projectId, project.audioTrackId)).toEqual([]);
  });

  it('split_av_cut（J/L）：音频切点相对视频错开，切换处原音连续', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000, withAudio: true });
    const pair = await seedAvPair(project, source, [0, 8_000], [2_000, 10_000]);
    const unlinked = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 4_000], sequenceMs: [20_000, 24_000] });

    await expectApiFailure(
      applyEdits(client, project.projectId, [
        { op: 'split_av_cut', videoClipId: pair.videoClipId, audioClipId: unlinked, at: mt(4_000), offset: mt(500), kind: 'J' },
      ]),
      { status: 422, reason: 'CLIPS_NOT_AV_LINKED' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [
        { op: 'split_av_cut', videoClipId: pair.videoClipId, audioClipId: pair.audioClipId, at: mt(200), offset: mt(500), kind: 'J' },
      ]),
      { status: 422, reason: 'CUT_POINT_OUTSIDE_CLIP' },
    );

    // J cut：音频切点早于视频 500ms（音频先入）
    await applyEdits(client, project.projectId, [
      { op: 'split_av_cut', videoClipId: pair.videoClipId, audioClipId: pair.audioClipId, at: mt(4_000), offset: mt(500), kind: 'J' },
    ]);
    const video = (await timeline(client, project.projectId, project.videoTrackId))
      .filter((clip) => clip.id === pair.videoClipId || clip.parentClipId === pair.videoClipId);
    const audio = await timeline(client, project.projectId, project.audioTrackId);
    expect(video.map((clip) => [clip.from, clip.to])).toEqual([[0, 4_000], [4_000, 8_000]]);
    expect(audio.map((clip) => [clip.from, clip.to])).toEqual([[0, 3_500], [3_500, 8_000]]);
    // 原音连续：音频两段源范围首尾相接，且拼接后等于原源范围
    expect(audio[0]!.srcTo).toBe(audio[1]!.srcFrom);
    expect(audio[0]!.srcFrom).toBe(2_000);
    expect(audio[1]!.srcTo).toBe(10_000);
    // 右段是子片段（血缘可追溯）
    expect(audio[1]!.parentClipId).toBe(pair.audioClipId);
    expect(video[1]!.parentClipId).toBe(pair.videoClipId);
  });

  it('undo/redo：四种精剪各自逐事件撤销可完整复原', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedSource(project, { durationMs: 20_000 });
    const a = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [0, 2_000] });
    const b = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [2_000, 5_000], sequenceMs: [2_000, 5_000] });
    const c = await seedClip(project, { trackId: project.videoTrackId, assetVersionId: source, sourceMs: [0, 2_000], sequenceMs: [5_000, 7_000] });
    const before = await timeline(client, project.projectId, project.videoTrackId);

    const cases: EditRequest['operations'][] = [
      [{ op: 'slip_clip', clipId: b, sourceRange: range(4_000, 7_000) }],
      [{ op: 'slide_clip', clipId: b, offset: mt(300) }],
      [{ op: 'roll_clip', leftClipId: a, rightClipId: b, at: mt(400) }],
      [{ op: 'ripple_clip', clipId: c, action: 'DELETE', amount: null, closeAcrossTracks: false }],
    ];
    for (const operations of cases) {
      const state = await client.projects.state(project.projectId);
      const seqBefore = state.eventSeq;
      const result = await client.projects.edit(project.projectId, {
        schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
        operations, idempotencyKey: `idem_n03_03_undo_${randomUUID()}`,
      });
      expect(result.editEvents.length).toBeGreaterThan(0);
      expect(await timeline(client, project.projectId, project.videoTrackId)).not.toEqual(before);
      for (let index = 0; index < result.editEvents.length; index += 1) {
        await client.projects.undo(project.projectId);
      }
      // 逐事件撤销后完全复原（含被涟漪平移的片段）
      expect(await timeline(client, project.projectId, project.videoTrackId)).toEqual(before);
      const undone = await client.projects.editEvents(project.projectId, { afterSeq: seqBefore, limit: 100 });
      expect(undone.items.some((event) => event.action.startsWith('UNDO_'))).toBe(true);
    }
  });
});
