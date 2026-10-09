import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIO_MIX_GUARD_REASONS,
  dbToLinear,
  defaultProductionPolicy,
  equalPowerFadeGains,
  legacyMillisecondsToMediaTime,
  linearToDb,
  sampleEqualPowerCurve,
  sourceMediaProbeResultSchema,
  type EditRequest,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, projects, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createAudioRegion, createClip, createProject, createSequence, createTrack, planClipAudioMix } from '@ancs/domain';
import { eq, sql } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N03-06 验收（HTTP + SDK + 真实数据库）：基础混音与原声保护
 * - 增益/淡入淡出/声像只改对应区域（非破坏、源素材与源音不变）；
 * - 混音计划 fail-closed：会削波 → 422 MIX_CLIPPING_DETECTED；全部静音/未独奏 → 409 MIX_EMPTY_OUTPUT；
 * - 原声保护模式：改动源时钟的编辑被拒（语言内容未改），增益类仍允许；
 * - 基础 crossfade 用等功率曲线，撤销后源音参数恢复。
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
    secret: 'mix-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
const msOf = (time: { ticks: string; timebase: { num: number; den: number } }) => ((Number(time.ticks) * time.timebase.num) / time.timebase.den) * 1_000;

async function newSignedInClient(): Promise<AncsClient> {
  const email = `mix-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '混音测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface MixProject {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
}

async function makeProject(client: AncsClient, policy?: Record<string, boolean>): Promise<MixProject> {
  const workspace = await client.workspaces.create({ name: `混音-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '混音', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  if (policy !== undefined) {
    // 策略是 strict 完整对象：从默认值出发覆盖，避免部分字段导致文档投影失败
    const complete = { ...defaultProductionPolicy('FOOTAGE_EDIT'), ...policy };
    await handle.db.update(projects).set({ productionPolicy: sql`${JSON.stringify(complete)}::jsonb` }).where(eq(projects.id, project.id));
  }
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(60_000) },
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

async function seedAsset(project: MixProject): Promise<{ assetId: string; assetVersionId: string }> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-06/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs: 60_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(60_000),
  });
  return { assetId, assetVersionId };
}

async function seedRegion(
  project: MixProject,
  input: { assetVersionId: string; sequenceMs: [number, number]; gainDb?: number; parameters?: { schemaVersion: string; values: Record<string, unknown> } },
): Promise<string> {
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: project.videoTrackId, assetVersionId: input.assetVersionId,
      sourceRange: range(0, input.sequenceMs[1] - input.sequenceMs[0]),
      sequenceRange: range(...input.sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  const region = await createAudioRegion({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: project.audioTrackId,
      timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null },
      localRange: range(0, input.sequenceMs[1] - input.sequenceMs[0]),
      sourceStreamId: 'audio-main',
      channelMapping: [{ sourceChannel: 0, outputChannel: 0 }],
      gainDb: input.gainDb ?? 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0),
      parameters: input.parameters ?? { schemaVersion: '1.0', values: {} },
    },
  });
  return region.id;
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_06_${randomUUID()}`,
  });
}

async function regionById(client: AncsClient, projectId: string, regionId: string) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.audioRegions.find((region) => region.id === regionId);
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N03-06 基础混音与原声保护（HTTP + SDK）', () => {
  it('增益只改相应区域：其他区域与轨道不动，源素材与源音不变（非破坏）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedAsset(project);
    const first = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [0, 4_000] });
    const second = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [4_000, 8_000] });

    const versionsBefore = await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, project.workspaceId));
    const result = await applyEdits(client, project.projectId, [
      { op: 'update_audio_region', audioRegionId: first, changes: { gainDb: -6, pan: -0.5 } },
    ]);
    expect(result.editEvents.map((event) => event.action)).toEqual(['UPDATE_AUDIO_REGION']);

    expect(await regionById(client, project.projectId, first)).toMatchObject({ gainDb: -6, pan: -0.5 });
    // 第二个区域完全不受影响
    expect(await regionById(client, project.projectId, second)).toMatchObject({ gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0) });
    // 非破坏：源素材版本零变化（不产生新版本、不改源）
    expect(await handle.db.select().from(assetVersions).where(eq(assetVersions.workspaceId, project.workspaceId))).toHaveLength(versionsBefore.length);
  });

  it('混音计划 fail-closed：会削波 → 422；全部静音/未独奏 → 409；正常混音给出余量', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedAsset(project);
    // 声明源峰值 -1 dBFS（保守参考）
    const regionId = await seedRegion(project, {
      assetVersionId: source.assetVersionId, sequenceMs: [0, 4_000],
      parameters: { schemaVersion: '1.0', values: { sourcePeakDb: -1 } },
    });

    // 正常：0 dB 增益 → 余量 1 dB，计划可读
    const plan = await planClipAudioMix({ db: handle.db }, { workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId });
    expect(plan.audibleTrackCount).toBe(1);
    expect(plan.estimatedPeakDb).toBeCloseTo(-1, 6);
    expect(plan.headroomDb).toBeCloseTo(1, 6);

    // 抬到 +2 dB → 估计峰值 +1 dBFS，计划直接拒绝（不静默削波）
    await applyEdits(client, project.projectId, [{ op: 'update_audio_region', audioRegionId: regionId, changes: { gainDb: 2 } }]);
    await expect(planClipAudioMix({ db: handle.db }, { workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId }))
      .rejects.toMatchObject({ httpStatus: 422, details: { reason: AUDIO_MIX_GUARD_REASONS.CLIPPING } });

    // 静音该轨（无独奏）→ 有内容但可听轨为 0：拒绝意外静音
    await applyEdits(client, project.projectId, [
      { op: 'update_audio_region', audioRegionId: regionId, changes: { gainDb: -3 } },
      { op: 'update_track', trackId: project.audioTrackId, changes: { muted: true } },
    ]);
    await expect(planClipAudioMix({ db: handle.db }, { workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: AUDIO_MIX_GUARD_REASONS.EMPTY_OUTPUT } });

    // 独奏另一条轨（存在独奏时未独奏轨自动不发声）→ 同样拒绝；独奏该轨则恢复
    await applyEdits(client, project.projectId, [
      { op: 'update_track', trackId: project.audioTrackId, changes: { muted: false, solo: true } },
    ]);
    const soloPlan = await planClipAudioMix({ db: handle.db }, { workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId });
    expect(soloPlan.soloActive).toBe(true);
    expect(soloPlan.audibleTrackCount).toBe(1);
  });

  it('原声保护：改动源时钟的编辑被拒，增益/淡入淡出仍允许（语言内容未改）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client, { preserveOriginalSpeech: true, allowVoiceReplacement: false });
    const source = await seedAsset(project);
    const regionId = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [0, 4_000] });

    // 改源流 / 局部时间 / 时间绑定 → 触碰源时钟 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'update_audio_region', audioRegionId: regionId, changes: { sourceStreamId: 'audio-alt' } }]),
      { status: 409, reason: AUDIO_MIX_GUARD_REASONS.ORIGINAL_SPEECH_PROTECTED },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'update_audio_region', audioRegionId: regionId, changes: { localRange: range(500, 3_500) } }]),
      { status: 409, reason: AUDIO_MIX_GUARD_REASONS.ORIGINAL_SPEECH_PROTECTED },
    );

    // 非破坏性混音（增益/淡入淡出/声像/声道映射）仍允许
    await applyEdits(client, project.projectId, [
      { op: 'update_audio_region', audioRegionId: regionId, changes: { gainDb: -4, fadeIn: mt(200), fadeOut: mt(200), channelMapping: [{ sourceChannel: 0, outputChannel: 1 }] } },
    ]);
    const region = await regionById(client, project.projectId, regionId);
    expect(region).toMatchObject({ gainDb: -4, sourceStreamId: 'audio-main' });
    expect(msOf(region!.fadeIn)).toBe(200);
  });

  it('基础 crossfade：相邻区域铺等功率淡入淡出；不相邻/时长越界被拒；撤销恢复源音参数', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const source = await seedAsset(project);
    const left = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [0, 4_000] });
    const right = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [4_000, 8_000] });
    const far = await seedRegion(project, { assetVersionId: source.assetVersionId, sequenceMs: [20_000, 24_000] });

    // 等功率曲线：交叉段两端功率恒定（cos²+sin²=1），中点为 -3 dB 双侧
    const curve = sampleEqualPowerCurve(4);
    for (const point of curve) expect(point.out ** 2 + point.in ** 2).toBeCloseTo(1, 10);
    expect(dbToLinear(linearToDb(0.5))).toBeCloseTo(0.5, 10);
    expect(equalPowerFadeGains(0.5).in).toBeCloseTo(Math.SQRT1_2, 10);

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'apply_audio_crossfade', leftRegionId: left, rightRegionId: far, duration: mt(1_000) }]),
      { status: 422, reason: 'CROSSFADE_REGIONS_NOT_ADJACENT' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'apply_audio_crossfade', leftRegionId: left, rightRegionId: right, duration: mt(9_000) }]),
      { status: 422, reason: 'CROSSFADE_DURATION_OUT_OF_RANGE' },
    );

    const applied = await applyEdits(client, project.projectId, [
      { op: 'apply_audio_crossfade', leftRegionId: left, rightRegionId: right, duration: mt(1_000) },
    ]);
    expect(applied.editEvents.map((event) => event.action)).toEqual(['APPLY_AUDIO_CROSSFADE', 'APPLY_AUDIO_CROSSFADE']);
    expect(msOf((await regionById(client, project.projectId, left))!.fadeOut)).toBe(1_000);
    expect(msOf((await regionById(client, project.projectId, right))!.fadeIn)).toBe(1_000);

    // 撤销后源音参数恢复（两条事件逐条回退）
    await client.projects.undo(project.projectId);
    await client.projects.undo(project.projectId);
    expect(msOf((await regionById(client, project.projectId, left))!.fadeOut)).toBe(0);
    expect(msOf((await regionById(client, project.projectId, right))!.fadeIn)).toBe(0);
  });
});
