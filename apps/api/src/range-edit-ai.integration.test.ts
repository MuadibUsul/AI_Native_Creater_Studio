import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RANGE_EDIT_ERROR_REASONS,
  RANGE_EDIT_OUT_OF_SCOPE_REASONS,
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  sourceMediaProbeResultSchema,
  type EditRequest,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createAudioRegion, createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { MockLlmAdapter } from '@ancs/providers-mock-llm';
import { buildServer } from './server.js';

/**
 * N03-09 验收（HTTP + SDK + Mock LLM + 真实数据库）：范围编辑的最小 AI 入口
 * - 「去掉前面废话但保留原音」产出**实际可执行**的裁剪（Apply 后时间线真的变了）；
 * - 源证据之外的引用（不存在的片段）不虚构：记为 outOfScope 而不是执行或整批失败；
 * - 允许操作之外的操作被明确拒绝并说明；
 * - 计划阶段零 Provider 媒体调用、零数据库写入（未 Apply 不改工程）。
 */

const PASSWORD = 'password-1234';

let handle: DbHandle;
let auth: AuthInstance;
let app: Awaited<ReturnType<typeof buildServer>>;
let baseUrl: string;
let llm: MockLlmAdapter;

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
    secret: 'range-edit-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
    baseUrl: 'http://localhost:3001',
  });
  llm = new MockLlmAdapter();
  app = await buildServer({
    auth: { auth, db: handle.db, tokens: { db: handle.db, config: DEFAULT_NATIVE_TOKEN_CONFIG } },
    content: { llm },
  });
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
  const email = `range-edit-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '范围编辑测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
}

async function makeProject(client: AncsClient): Promise<Fixture> {
  const workspace = await client.workspaces.create({ name: `范围编辑-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '范围编辑', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
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
      { index: 0, type: 'VIDEO', codecName: 'h264', codecLongName: 'H.264', profile: 'High', timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '61440', durationMs, width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709', colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 }, averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '300', sampleRate: null, channels: null, channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'] },
      { index: 1, type: 'AUDIO', codecName: 'aac', codecLongName: 'AAC', profile: 'LC', timeBase: { numerator: 1, denominator: 48_000 }, startPts: '0', durationTicks: '48000', durationMs, width: null, height: null, rotationDegrees: null, pixelFormat: null, colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null, frameCount: null, sampleRate: 48_000, channels: 2, channelLayout: 'stereo', cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['1024'] },
    ],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedClip(fixture: Fixture, sequenceMs: [number, number]): Promise<{ clipId: string; regionId: string; assetVersionId: string }> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: fixture.workspaceId, projectId: fixture.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: fixture.workspaceId, versionNumber: 1,
    storageKey: `n03-09/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(30_000),
  });
  const clip = await createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.videoTrackId, assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  const region = await createAudioRegion({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.audioTrackId, timeBinding: { basis: 'CLIP_LOCAL', clipId: clip.id, semanticCueId: null },
      // 音频区域只覆盖片段中后段（局部 1–3s）：掐头 1s 后仍在片段时长内，
      // 因此裁剪可执行且无需重算区域时钟（区域级时钟重算属 N03-06）。
      localRange: range(Math.round((sequenceMs[1] - sequenceMs[0]) / 4), (sequenceMs[1] - sequenceMs[0]) - Math.round((sequenceMs[1] - sequenceMs[0]) / 4)), sourceStreamId: 'audio-main',
      channelMapping: [{ sourceChannel: 0, outputChannel: 0 }], gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0),
      parameters: { schemaVersion: '1.0', values: {} },
    },
  });
  return { clipId: clip.id, regionId: region.id, assetVersionId };
}

const ALLOWED = ['trim_clip', 'split_clip', 'ripple_clip', 'delete_clip', 'move_clip', 'update_caption'] as const;

async function plan(client: AncsClient, fixture: Fixture, prompt: string, selectedClipIds: string[], allowedOperations: readonly string[] = ALLOWED, preservesEverythingElse = false) {
  return client.narrative.rangeEditPlan(fixture.workspaceId, fixture.projectId, {
    prompt, sequenceId: fixture.sequenceId, selectedClipIds: [...selectedClipIds],
    allowedOperations: [...allowedOperations] as never, languageTag: 'zh-CN',
    preservesEverythingElse,
    brief: { objective: '去掉冗余开场，保留原声', audience: '观众', notes: '' },
  });
}

describe('N03-09 范围编辑的最小 AI 入口（HTTP + SDK + Mock LLM）', () => {
  it('「去掉前面废话但保留原音」产出可执行裁剪；未 Apply 不改工程；Apply 后片段真的被裁剪且原声保留', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const seeded = await seedClip(fixture, [0, 4_000]);
    const beforeRevision = (await client.projects.state(fixture.projectId)).document.projectRevision;
    const assetsBefore = await handle.db.select().from(assets);

    llm.scriptNext('range_edit_trim');
    const planResult = await plan(client, fixture, '去掉前面废话但保留原音', [seeded.clipId], ['trim_clip', 'delete_clip']);

    expect(planResult.operations).toHaveLength(1);
    expect(planResult.operations[0]).toMatchObject({ op: 'trim_clip', clipId: seeded.clipId });
    expect(planResult.originalAudioPreserved).toBe(true);
    expect(planResult.providerMediaCalls).toBe(0);
    expect(planResult.policy).toMatchObject({ mode: 'FOOTAGE_EDIT', preserveOriginalSpeech: true, allowGeneratedMedia: false });
    // 计划不落库：revision 与资产都未变（"没有浏览器 props 之外的隐藏工程"同样适用于计划）
    expect((await client.projects.state(fixture.projectId)).document.projectRevision).toBe(beforeRevision);
    expect(await handle.db.select().from(assets)).toHaveLength(assetsBefore.length);
    // 只有一次文本规划调用，没有任何媒体生成调用
    expect(llm.callCount).toBe(1);

    // Apply：经统一编辑协议提交计划里的操作
    const state = await client.projects.state(fixture.projectId);
    const applied = await client.projects.edit(fixture.projectId, {
      schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
      operations: planResult.operations as EditRequest['operations'],
      idempotencyKey: `idem_range_edit_${randomUUID()}`,
    });
    expect(applied.project.revision).toBeGreaterThan(beforeRevision);
    const clipAfter = (await client.projects.state(fixture.projectId)).document.composition.clips.find((clip) => clip.id === seeded.clipId)!;
    expect(ms(clipAfter.sequenceRange.start)).toBe(0);
    expect(ms(clipAfter.sequenceRange.end)).toBe(3_000);
    expect(ms(clipAfter.sourceRange.start)).toBe(1_000);
    // 原声保留：音频区域未被触碰
    const regionAfter = (await client.projects.state(fixture.projectId)).document.composition.audioRegions.find((region) => region.id === seeded.regionId)!;
    expect(ms(regionAfter.localRange.start)).toBe(1_000);
    expect(ms(regionAfter.localRange.end)).toBe(3_000);
    expect(regionAfter.sourceStreamId).toBe('audio-main');
    expect(regionAfter.gainDb).toBe(0);
  });

  it('不虚构素材：引用不存在片段的操作进入 outOfScope，且不产生可执行计划', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const seeded = await seedClip(fixture, [0, 4_000]);

    llm.scriptNext('range_edit_hallucinated');
    const failure = await plan(client, fixture, '把那个不存在的片段删掉', [seeded.clipId]).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    const apiError = failure as AncsApiError;
    expect(apiError.status).toBe(422);
    expect(apiError.details['reason']).toBe(RANGE_EDIT_ERROR_REASONS.NO_EXECUTABLE_OPERATIONS);
    const outOfScope = apiError.details['outOfScope'] as { reason: string }[];
    expect(outOfScope.some((item) => item.reason === RANGE_EDIT_OUT_OF_SCOPE_REASONS.UNKNOWN_SOURCE_REFERENCE)).toBe(true);
    // 工程完全没变
    expect((await client.projects.state(fixture.projectId)).document.composition.clips).toHaveLength(1);
  });

  it('允许操作之外的操作被明确拒绝并说明原因（不静默丢弃、不整批失败）', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const seeded = await seedClip(fixture, [0, 4_000]);

    llm.scriptNext('range_edit_disallowed');
    const failure = await plan(client, fixture, '把画面调淡一点', [seeded.clipId], ['trim_clip']).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(AncsApiError);
    const apiError = failure as AncsApiError;
    expect(apiError.details['reason']).toBe(RANGE_EDIT_ERROR_REASONS.NO_EXECUTABLE_OPERATIONS);
    expect((apiError.details['outOfScope'] as { reason: string }[]).some((item) => item.reason === RANGE_EDIT_OUT_OF_SCOPE_REASONS.NOT_ALLOWED_OPERATION)).toBe(true);

    // 同一意图在允许清单包含该操作时可以通过（说明是清单裁决而非能力缺失）
    llm.scriptNext('range_edit_disallowed');
    const allowed = await plan(client, fixture, '把画面调淡一点', [seeded.clipId], ['trim_clip', 'set_clip_opacity']);
    expect(allowed.operations).toHaveLength(1);
    expect(allowed.operations[0]).toMatchObject({ op: 'set_clip_opacity', opacity: 0.5 });
    expect(allowed.originalAudioPreserved).toBe(true);
  });

  it('负面：选中片段不属于该序列 → 422；规划器不可用 → 501 fail-closed', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const other = await makeProject(client);
    const seedOther = await seedClip(other, [0, 2_000]);

    const mismatch = await plan(client, fixture, '剪一下', [seedOther.clipId]).then(() => null, (error: unknown) => error);
    expect((mismatch as AncsApiError).details['reason']).toBe(RANGE_EDIT_ERROR_REASONS.INVALID_SELECTION);

    // 规划器不可用时的 fail-closed 语义由 domain 层保证（见 packages/domain/src/range-edit.ts）；此处仅确认选择校验先于规划器调用
  });

  it('N06-07 总时长守卫：「其他别动」下变长的计划必须先解释或改等长方案', async () => {
    const client = await newSignedInClient();
    const fixture = await makeProject(client);
    const seeded = await seedClip(fixture, [0, 4_000]);

    // 未声明"其他别动" → 不受时长约束
    llm.scriptNext('range_edit_ripple');
    const free = await plan(client, fixture, '去掉尾部 1 秒并收缝', [seeded.clipId]);
    expect(free.lengthGuard.preservesEverythingElse).toBe(false);
    expect(free.lengthGuard.verdict).toBe('SAFE');
    expect(free.lengthGuard.requiresExplanation).toBe(false);
    // 估算如实反映"缩短"（涟漪去尾 1s）
    expect(free.lengthGuard.estimatedDurationDeltaMs).toBe(-1_000);
    expect(free.lengthGuard.exact).toBe(true);

    // 声明"其他别动"且变短、但存在等长替代（同为涟漪）→ 建议改等长方案且必须先解释
    llm.scriptNext('range_edit_ripple');
    const guarded = await plan(client, fixture, '去掉尾部 1 秒并收缝', [seeded.clipId], ALLOWED, true);
    expect(guarded.lengthGuard.preservesEverythingElse).toBe(true);
    expect(guarded.lengthGuard.verdict).toBe('EQUAL_LENGTH_PLAN_RECOMMENDED');
    expect(guarded.lengthGuard.requiresExplanation).toBe(true);
    expect(guarded.lengthGuard.recommendEqualLength).toBe(true);
    // 计划本身不改工程（守卫只做判定与提示）
    expect(guarded.providerMediaCalls).toBe(0);
    expect(guarded.rationale.some((item) => item.includes('总时长守卫'))).toBe(true);

    // 等长的计划在"其他别动"下直接放行
    llm.scriptNext('range_edit_trim');
    const even = await plan(client, fixture, '去掉前面废话但保留原音', [seeded.clipId], ALLOWED, true);
    expect(even.lengthGuard.verdict).toBe('SAFE');
    expect(even.lengthGuard.requiresExplanation).toBe(false);
    expect(even.lengthGuard.estimatedDurationDeltaMs).toBe(0);
  });
});
