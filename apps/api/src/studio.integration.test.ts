import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  mediaTimeSchema,
  sourceMediaProbeResultSchema,
  type EditRequest,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assetVersions, assets, createDb, mediaIndexRuns, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { buildServer } from './server.js';

/**
 * V6-1c 验收（HTTP + SDK + 真实数据库）：
 * - 一步新建：素材工程 + 主序列（30 fps，V1/A1）+ AI 会话；画幅随请求；
 * - 工作台状态：只列用户素材（不含系统渲染产物），上传/理解进度按处理器聚合；AI 成本从 0 开始；
 * - 撤销这次修改：同一版本号的一批事件一组撤销；没有可撤销 → 409；之后仍可逐条重做；
 * - VIEWER 可读不可撤销（403）；跨工作区 404。
 */

const PASSWORD = 'password-1234';
let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
  auth = createAuth({ db: handle.db, secret: 'studio-http-secret-0123456789abcdef', baseUrl: 'http://localhost:3001' }); // secrets:check-ignore：测试专用假密钥（非真实凭据）
  app = await buildServer({ auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  baseUrl = `http://127.0.0.1:${String((app.server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await app.close();
  await handle.close();
});

async function signedIn(email = `studio-${randomUUID()}@test.local`): Promise<AncsClient> {
  await createInternalUser(auth, { email, password: PASSWORD, name: '共看片室测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

async function expectApiError(promise: Promise<unknown>, status: number): Promise<void> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  expect((caught as AncsApiError).status).toBe(status);
}

const ms = (value: number) => mediaTimeSchema.parse({ ticks: String(value), timebase: { num: 1, den: 1000 } });

async function seedFootage(workspaceId: string, projectId: string, input: { origin: 'USER_UPLOAD' | 'SYSTEM_RENDER'; filename: string; ready: boolean }): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId, projectId, assetType: 'UPLOADED_VIDEO', origin: input.origin, status: input.ready ? 'READY' : 'PROCESSING',
    retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: versionId, metadata: { filename: input.filename },
  });
  await handle.db.insert(assetVersions).values({
    id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `v6-1c/${versionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048,
    checksumSha256: 'd'.repeat(64), durationMs: 12_500, width: 1920, height: 1080, status: input.ready ? 'READY' : 'PROCESSING',
    mediaProbe: sourceMediaProbeResultSchema.parse({
      schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs: 12_500, bitRate: 92_000,
      streams: [{
        index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0',
        durationTicks: '192000', durationMs: 12_500, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
        colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 },
        frameCount: '375', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
      }],
      decodeCheck: { status: 'PASSED', errorCode: null, message: null },
      capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
    }),
  });
  return versionId;
}

describe('V6-1c 共看片室（HTTP + SDK）', () => {
  it('新建工程 → 工作台状态：序列/轨道/会话就绪，只列用户素材，理解进度按处理器聚合', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `看片-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: '冰岛环岛', aspectRatio: '9:16', locale: 'en' }, { idempotencyKey: `s-${randomUUID()}` });

    const state = await owner.studio.state(workspace.id, ref.projectId);
    expect(state.project).toMatchObject({ id: ref.projectId, title: '冰岛环岛', aspectRatio: '9:16' });
    expect(state.sequenceId).toBe(ref.sequenceId);
    expect(state.session).toMatchObject({ id: ref.sessionId, sequenceId: ref.sequenceId, locale: 'en' });
    expect(state.footage).toEqual([]);
    expect(state.cost).toMatchObject({ projectId: ref.projectId, turns: 0, costMicros: 0, unpricedCalls: 0 });

    const document = (await owner.projects.state(ref.projectId, { schemaVersion: '1.0' })).document;
    expect(document.composition.tracks.map((track) => [track.name, track.kind]).sort()).toEqual([['A1', 'AUDIO'], ['V1', 'VIDEO']]);
    expect(document.composition.sequences.find((sequence) => sequence.id === ref.sequenceId)?.frameRate).toEqual({ num: 30, den: 1 });

    // 素材：一条就绪（索引完成、转写进行中）、一条处理中、一条系统渲染产物（不列出）
    const ready = await seedFootage(workspace.id, ref.projectId, { origin: 'USER_UPLOAD', filename: 'glacier.mp4', ready: true });
    await seedFootage(workspace.id, ref.projectId, { origin: 'USER_UPLOAD', filename: 'road.mp4', ready: false });
    await seedFootage(workspace.id, ref.projectId, { origin: 'SYSTEM_RENDER', filename: 'final.mp4', ready: true });
    await handle.db.insert(mediaIndexRuns).values([
      { id: `mir_${randomUUID()}`, workspaceId: workspace.id, sourceAssetVersionId: ready, sourceChecksumSha256: 'd'.repeat(64), processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, status: 'READY', coveragePermille: 1000 },
      { id: `mir_${randomUUID()}`, workspaceId: workspace.id, sourceAssetVersionId: ready, sourceChecksumSha256: 'd'.repeat(64), processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION, status: 'RUNNING' },
    ]);
    const withFootage = await owner.studio.state(workspace.id, ref.projectId);
    expect(withFootage.footage.map((item) => [item.name, item.status, item.footageId === null])).toEqual([
      ['glacier.mp4', 'READY', false],
      ['road.mp4', 'PROCESSING', true],
    ]);
    expect(withFootage.footage[0]).toMatchObject({ kind: 'video', duration: '12.5', understanding: { index: 'READY', transcript: 'WORKING', visual: 'NONE' } });
  }, 60_000);

  it('撤销这次修改：一批事件一组撤销，之后可逐条重做；无可撤销 409；VIEWER 403；跨工作区 404', async () => {
    const owner = await signedIn();
    const workspace = await owner.workspaces.create({ name: `撤销-${randomUUID().slice(0, 8)}` });
    const ref = await owner.studio.create(workspace.id, { title: 'Undo' }, { idempotencyKey: `s-${randomUUID()}` });
    const source = await seedFootage(workspace.id, ref.projectId, { origin: 'USER_UPLOAD', filename: 'a.mp4', ready: true });
    await expectApiError(owner.studio.undoChange(workspace.id, ref.projectId, { idempotencyKey: `u-${randomUUID()}` }), 409);

    const snapshot = async () => {
      const document = (await owner.projects.state(ref.projectId, { schemaVersion: '1.0' })).document;
      const sequence = document.composition.sequences.find((item) => item.id === ref.sequenceId)!;
      return { revision: document.projectRevision, duration: `${sequence.duration.ticks}/${String(sequence.duration.timebase.den)}`, clips: document.composition.clips.length, document };
    };
    const before = await snapshot();
    const videoTrack = before.document.composition.tracks.find((track) => track.name === 'V1')!;
    const operations: EditRequest['operations'] = [
      { op: 'set_sequence_duration', sequenceId: ref.sequenceId, duration: ms(8_000) },
      {
        op: 'insert_clip', sequenceId: ref.sequenceId, trackId: videoTrack.id, assetVersionId: source, nestedSequenceId: null, sourceStreamId: null,
        sourceRange: { start: ms(0), end: ms(4_000) }, mode: 'OVERWRITE', sequenceStart: ms(0), linkAudio: false, audioTrackId: null,
      },
    ];
    await owner.projects.edit(ref.projectId, { schemaVersion: '1.0', baseProjectRevision: before.revision, expectedSceneRevisions: {}, operations, idempotencyKey: `e-${randomUUID()}` });
    const edited = await snapshot();
    expect(edited.clips).toBe(1);
    expect(edited.duration).toBe('240/30');

    const viewerEmail = `studio-viewer-${randomUUID()}@test.local`;
    const viewer = await signedIn(viewerEmail);
    await owner.workspaces.members.add(workspace.id, { email: viewerEmail, role: 'VIEWER' });
    expect((await viewer.studio.state(workspace.id, ref.projectId)).project.id).toBe(ref.projectId);
    await expectApiError(viewer.studio.undoChange(workspace.id, ref.projectId, { idempotencyKey: `u-${randomUUID()}` }), 403);
    const stranger = await signedIn();
    const strangerWorkspace = await stranger.workspaces.create({ name: `外部-${randomUUID().slice(0, 8)}` });
    await expectApiError(stranger.studio.state(workspace.id, ref.projectId), 404);
    await expectApiError(stranger.studio.state(strangerWorkspace.id, ref.projectId), 404);
    await expectApiError(stranger.studio.undoChange(strangerWorkspace.id, ref.projectId, { idempotencyKey: `u-${randomUUID()}` }), 404);

    const undone = await owner.studio.undoChange(workspace.id, ref.projectId, { idempotencyKey: `u-${randomUUID()}` });
    expect(undone.undoneEvents).toBe(2);
    const restored = await snapshot();
    expect(restored).toMatchObject({ clips: 0, duration: before.duration, revision: undone.projectRevision });
    await expectApiError(owner.studio.undoChange(workspace.id, ref.projectId, { idempotencyKey: `u-${randomUUID()}` }), 409);

    await owner.projects.redo(ref.projectId);
    await owner.projects.redo(ref.projectId);
    const redone = await snapshot();
    expect(redone).toMatchObject({ clips: 1, duration: '240/30' });
  }, 60_000);
});
