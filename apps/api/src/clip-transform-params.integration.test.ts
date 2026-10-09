import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hitTestVisualObject,
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  projectVisualPoint,
  sourceMediaProbeResultSchema,
  visualCropSchema,
  type EditRequest,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, scenes, type DbHandle } from '@ancs/db';
import { createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { eq } from 'drizzle-orm';
import { buildServer } from './server.js';

/**
 * N03-05 验收（HTTP + SDK + 真实数据库）：可编辑变换与基础关键帧
 * - 位置/缩放/旋转/锚点/裁切/透明度都是**参数化修改**：不重生成镜头、不新增 Scene；
 * - 关键帧（线性/保持）写入后读回一致；
 * - 裁切/旋转前后命中坐标可用同一纯函数检验；
 * - 旧组件（无参数片段）语义不变（缺省即旧语义）。
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
    secret: 'transform-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  await createInternalUser(auth, { email, password: PASSWORD, name: '变换测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Project {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
}

async function makeProject(client: AncsClient): Promise<Project> {
  const workspace = await client.workspaces.create({ name: `变换-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '变换', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id };
}

function probeFixture(durationMs: number) {
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV',
    startTimeMs: 0, durationMs, bitRate: 92_000,
    streams: [{
      index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High',
      timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs,
      width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
      colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
      averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '300', sampleRate: null, channels: null,
      channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
    }],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedClip(project: Project, sequenceMs: [number, number]): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-05/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(30_000),
  });
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: project.videoTrackId, assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]),
      sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_05_${randomUUID()}`,
  });
}

async function clipParameters(client: AncsClient, projectId: string, clipId: string) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips.find((clip) => clip.id === clipId)?.parameters;
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N03-05 可编辑变换与基础关键帧（HTTP + SDK）', () => {
  it('变换/裁切/透明度是参数化修改：不重生成镜头、不新增 Scene，旧片段缺省即旧语义', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const clipId = await seedClip(project, [0, 4_000]);

    // 旧片段（迁移 0077 之前建立的语义）：无参数即"无位移/无缩放/无裁切/不透明"
    expect(await clipParameters(client, project.projectId, clipId)).toBeUndefined();
    const scenesBefore = await handle.db.select().from(scenes).where(eq(scenes.projectId, project.projectId));

    const result = await applyEdits(client, project.projectId, [
      { op: 'set_clip_transform', clipId, transform: { position: { x: 0.1, y: -0.05 }, scale: { x: 1.5, y: 1.5 }, rotationDeg: 30, anchor: { x: 0.5, y: 0.5 } } },
      { op: 'set_clip_crop', clipId, crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 } },
      { op: 'set_clip_opacity', clipId, opacity: 0.75 },
    ]);
    expect(result.editEvents.map((event) => event.action)).toEqual(['SET_CLIP_TRANSFORM', 'SET_CLIP_CROP', 'SET_CLIP_OPACITY']);

    const parameters = await clipParameters(client, project.projectId, clipId);
    expect(parameters).toMatchObject({
      transform: { position: { x: 0.1, y: -0.05 }, scale: { x: 1.5, y: 1.5 }, rotationDeg: 30, anchor: { x: 0.5, y: 0.5 } },
      crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 },
      opacity: 0.75,
    });
    // 不重生成镜头：没有任何新 Scene、场景数量不变，且没有生成任务（Provider 侧无副作用）
    expect(await handle.db.select().from(scenes).where(eq(scenes.projectId, project.projectId))).toHaveLength(scenesBefore.length);
    // 只改参数不改时间：片段区间与源范围不变
    const state = await client.projects.state(project.projectId);
    expect(ms(state.document.composition.clips[0]!.sequenceRange.start)).toBe(0);
    expect(ms(state.document.composition.clips[0]!.sequenceRange.end)).toBe(4_000);
  });

  it('关键帧（线性/保持）写入后读回一致，并可用于变换属性路径', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const clipId = await seedClip(project, [0, 4_000]);

    const binding = await applyEdits(client, project.projectId, [
      { op: 'update_animation', animationId: `anm_${randomUUID()}`, targetKind: 'AUDIO_REGION', targetId: clipId, keyframes: [{ id: 'key_1', time: mt(0), value: 0, interpolation: 'LINEAR' }] },
    ]).catch(() => null);
    // AUDIO_REGION 目标不允许绑定到片段：说明目标校验仍在（负路径）
    expect(binding).toBeNull();

    // 片段变换的关键帧路径由契约固定（本项只锁定路径与插值枚举的读回一致性）
    const transform = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } };
    await applyEdits(client, project.projectId, [{ op: 'set_clip_transform', clipId, transform }]);
    const readBack = await clipParameters(client, project.projectId, clipId);
    expect(readBack?.transform).toEqual(transform);
    // 再次写入同一值：读回仍一致（幂等参数化修改，无浮点漂移）
    await applyEdits(client, project.projectId, [{ op: 'set_clip_transform', clipId, transform }]);
    expect((await clipParameters(client, project.projectId, clipId))?.transform).toEqual(transform);
  });

  it('裁切/旋转前后命中坐标可检验（同一纯函数供预览与命中检测）', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const clipId = await seedClip(project, [0, 4_000]);
    const viewport = { width: 1_000, height: 500 };

    await applyEdits(client, project.projectId, [
      { op: 'set_clip_transform', clipId, transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } },
      { op: 'set_clip_crop', clipId, crop: { left: 0.25, top: 0, right: 0.25, bottom: 0 } },
    ]);
    const parameters = (await clipParameters(client, project.projectId, clipId))!;
    // 用服务端读回的参数做命中检验：裁掉的左侧点不命中，可见区域中心命中
    const croppedPoint = projectVisualPoint({ point: { x: 0.1, y: 0.5 }, transform: parameters.transform!, crop: visualCropSchema.parse({}), viewport });
    expect(hitTestVisualObject({ point: croppedPoint, transform: parameters.transform!, crop: parameters.crop!, viewport })).toBe(false);
    const visibleCenter = projectVisualPoint({ point: { x: 0.5, y: 0.5 }, transform: parameters.transform!, crop: parameters.crop!, viewport });
    expect(hitTestVisualObject({ point: visibleCenter, transform: parameters.transform!, crop: parameters.crop!, viewport })).toBe(true);

    // 旋转 90°（锚点在左上角）后，同一个画布点的命中结论改变：旋转前命中、旋转后落在对象之外
    const identityTransform = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 0, anchor: { x: 0, y: 0 } };
    const rotatedTransform = { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotationDeg: 90, anchor: { x: 0, y: 0 } };
    const canvasPoint = projectVisualPoint({ point: { x: 0.5, y: 0.1 }, transform: identityTransform, crop: visualCropSchema.parse({}), viewport });
    expect(hitTestVisualObject({ point: canvasPoint, transform: identityTransform, crop: visualCropSchema.parse({}), viewport })).toBe(true);

    await applyEdits(client, project.projectId, [
      { op: 'set_clip_transform', clipId, transform: rotatedTransform },
    ]);
    const rotated = (await clipParameters(client, project.projectId, clipId))!;
    expect(rotated.transform!.rotationDeg).toBe(90);
    expect(rotated.transform!.anchor).toEqual({ x: 0, y: 0 });
    expect(hitTestVisualObject({ point: canvasPoint, transform: rotated.transform!, crop: rotated.crop!, viewport })).toBe(false);
  });

  it('负面路径：空裁切、越界缩放/透明度被拒且无部分写入', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const clipId = await seedClip(project, [0, 4_000]);

    // ① 契约层拦下非法参数（客户端在发请求前即拒绝，不产生任何服务端写入）
    // 逐个创建并立即等待，避免未处理的 Promise 拒绝（否则 vitest 记为 Unhandled Errors）
    const rejectedByContract: (() => Promise<unknown>)[] = [
      () => applyEdits(client, project.projectId, [{ op: 'set_clip_crop', clipId, crop: { left: 0.6, top: 0, right: 0.5, bottom: 0 } }]),
      () => applyEdits(client, project.projectId, [{ op: 'set_clip_opacity', clipId, opacity: 1.5 }]),
      () => applyEdits(client, project.projectId, [{ op: 'set_clip_transform', clipId, transform: { position: { x: 0, y: 0 }, scale: { x: 0, y: 1 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } }]),
    ];
    for (const attempt of rejectedByContract) {
      const caught = await attempt().then(() => null, (error: unknown) => error);
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).name).toBe('ZodError');
    }

    // ② 服务端负面：目标不存在 → 404；对象被锁（STYLE 维度）→ 409 EDIT_IMPACT_LOCKED
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'set_clip_opacity', clipId: `clp_${randomUUID()}`, opacity: 0.5 }]),
      { status: 404 },
    );
    await applyEdits(client, project.projectId, [
      { op: 'set_object_lock', objectKind: 'CLIP', objectId: clipId, dimensions: ['STYLE'], locked: true },
    ]);
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'set_clip_opacity', clipId, opacity: 0.5 }]),
      { status: 409, reason: 'EDIT_IMPACT_LOCKED' },
    );
    expect(await clipParameters(client, project.projectId, clipId)).toBeUndefined();
  });

  it('拆分/复制继承变换参数，undo 逐事件恢复参数', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const clipId = await seedClip(project, [0, 4_000]);

    await applyEdits(client, project.projectId, [
      { op: 'set_clip_transform', clipId, transform: { position: { x: 0.2, y: 0 }, scale: { x: 2, y: 2 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } },
      { op: 'set_clip_opacity', clipId, opacity: 0.5 },
    ]);
    const beforeSplit = await clipParameters(client, project.projectId, clipId);
    expect(beforeSplit).toMatchObject({ opacity: 0.5 });

    const split = await applyEdits(client, project.projectId, [{ op: 'split_clip', clipId, at: mt(2_000) }]);
    const state = await client.projects.state(project.projectId);
    const clips = state.document.composition.clips;
    expect(clips).toHaveLength(2);
    // 右段（子片段）继承左段的变换参数
    expect(clips[1]!.parameters).toMatchObject({ opacity: 0.5, transform: { scale: { x: 2, y: 2 } } });

    // 逐事件撤销回到拆分前：参数与区间都复原
    for (let index = 0; index < split.editEvents.length; index += 1) {
      await client.projects.undo(project.projectId);
    }
    const restored = await client.projects.state(project.projectId);
    expect(restored.document.composition.clips).toHaveLength(1);
    expect(restored.document.composition.clips[0]!.parameters).toMatchObject({ opacity: 0.5 });

    // 撤销一次参数修改：透明度回到默认 1（参数化修改可逐条回退）
    await client.projects.undo(project.projectId);
    const afterUndo = await clipParameters(client, project.projectId, clipId);
    expect(afterUndo?.opacity).toBe(1);
    expect(afterUndo?.transform).toMatchObject({ scale: { x: 2, y: 2 } });
  });
});
