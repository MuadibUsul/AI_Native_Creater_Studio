import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSubtitles,
  captionStyleSchema,
  containsDigits,
  containsNegation,
  legacyMillisecondsToMediaTime,
  preservationTokens,
  mediaTimeToLegacyMilliseconds,
  sourceMediaProbeResultSchema,
  type CaptionCue,
  type EditRequest,
  type MediaRange,
} from '@ancs/contracts';
import { AncsApiError, createClient, type AncsClient } from '@ancs/sdk';
import { createAuth, createInternalUser, DEFAULT_NATIVE_TOKEN_CONFIG, type AuthInstance } from '@ancs/auth';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import { createCaptionSpan, createClip, createProject, createSequence, createTrack } from '@ancs/domain';
import { buildServer } from './server.js';

/**
 * N03-07 验收（HTTP + SDK + 真实数据库）：字幕与转写驱动剪辑
 * - 改字幕**绝不**自动改原音（除非显式选 CUT_CONTENT）；
 * - 删转写必须明确模式（CAPTION_ONLY vs CUT_CONTENT）；
 * - 否定词与数字逐字保留（文本由词条重建，保留词不被改写）；
 * - 字幕跟随 ripple 左移且不越界；SRT/VTT 输出反映编辑结果。
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
    secret: 'caption-secret-0123456789abcdef', // secrets:check-ignore：测试专用假密钥（非真实凭据）
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
  const email = `caption-${randomUUID()}@test.local`;
  await createInternalUser(auth, { email, password: PASSWORD, name: '字幕测试' });
  const client = createClient({ baseUrl, clientType: 'web', clientVersion: '0.1.0' });
  await client.auth.signIn({ email, password: PASSWORD });
  return client;
}

interface CaptionProject {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  captionTrackId: string;
}

const captionStyleValues = {
  fontSizePx: 48, maxCharsPerLine: 18, maxLines: 2, position: 'BOTTOM', background: 'BLOCK',
  safeArea: { topPx: 60, bottomPx: 90, leftPx: 120, rightPx: 120 },
};
const captionStyle = captionStyleSchema.parse(captionStyleValues);
/** 字幕片段自身的样式是版本化参数包（values 里放字幕样式字段）。 */
const captionStyleParameters = { schemaVersion: 'caption-style/1.0', values: captionStyleValues };

async function makeProject(client: AncsClient): Promise<CaptionProject> {
  const workspace = await client.workspaces.create({ name: `字幕-${randomUUID().slice(0, 8)}` });
  const channel = await client.channels.create(workspace.id, { name: '素材栏目' });
  const project = await createProject({ db: handle.db }, {
    workspaceId: workspace.id, input: { title: '字幕', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} },
  });
  const sequence = await createSequence({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(30_000) },
  });
  const videoTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' },
  });
  const captionTrack = await createTrack({ db: handle.db }, {
    workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, input: { kind: 'CAPTION', position: 1, name: 'C1' },
  });
  return { workspaceId: workspace.id, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id, captionTrackId: captionTrack.id };
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
      averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '900', sampleRate: null, channels: null,
      channelLayout: null, cadence: 'CONSTANT', sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
    }],
    decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

async function seedClip(project: CaptionProject, sequenceMs: [number, number]): Promise<string> {
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: project.workspaceId, projectId: project.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: project.workspaceId, versionNumber: 1,
    storageKey: `n03-07/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'a'.repeat(64),
    durationMs: 30_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probeFixture(30_000),
  });
  const clip = await createClip({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: project.videoTrackId, assetVersionId,
      sourceRange: range(0, sequenceMs[1] - sequenceMs[0]), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  });
  return clip.id;
}

/** 生成一条字幕及其词条（词条时间与字幕本地时间同域，等速）。 */
async function seedCaption(
  project: CaptionProject,
  input: { sequenceMs: [number, number]; words: string[]; text?: string },
): Promise<{ captionId: string; wordIds: string[] }> {
  const duration = input.sequenceMs[1] - input.sequenceMs[0];
  const slice = duration / input.words.length;
  const words = input.words.map((word, index) => ({
    text: word,
    range: range(Math.round(index * slice), Math.round((index + 1) * slice)),
  }));
  const caption = await createCaptionSpan({ db: handle.db }, {
    workspaceId: project.workspaceId, projectId: project.projectId, sequenceId: project.sequenceId,
    input: {
      trackId: project.captionTrackId,
      timeBinding: { basis: 'CLIP_LOCAL', clipId: await seedClip(project, input.sequenceMs), semanticCueId: null },
      localRange: range(0, duration),
      text: input.text ?? input.words.join(''),
      languageTag: 'zh-CN',
      style: captionStyleParameters,
      words,
    },
  });
  return { captionId: caption.id, wordIds: [] };
}

async function applyEdits(client: AncsClient, projectId: string, operations: EditRequest['operations']) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return client.projects.edit(projectId, {
    schemaVersion: '1.0', baseProjectRevision: state.document.projectRevision, expectedSceneRevisions: {},
    operations, idempotencyKey: `idem_n03_07_${randomUUID()}`,
  });
}

async function captions(client: AncsClient, projectId: string) {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.captions
    .map((caption) => ({
      id: caption.id, text: caption.text, words: caption.words.map((word) => word.text),
      from: ms(caption.sequenceRange.start), to: ms(caption.sequenceRange.end),
    }))
    .sort((left, right) => left.from - right.from);
}

async function clipRanges(client: AncsClient, projectId: string, trackId: string): Promise<[number, number][]> {
  const state = await client.projects.state(projectId, { schemaVersion: '1.0' });
  return state.document.composition.clips
    .filter((clip) => clip.trackId === trackId)
    .map((clip) => [ms(clip.sequenceRange.start), ms(clip.sequenceRange.end)] as [number, number])
    .sort((left, right) => left[0] - right[0]);
}

async function expectApiFailure(promise: Promise<unknown>, expected: { status: number; reason?: string }): Promise<AncsApiError> {
  const caught = await promise.then(() => null, (error: unknown) => error);
  expect(caught).toBeInstanceOf(AncsApiError);
  const failure = caught as AncsApiError;
  expect(failure.status).toBe(expected.status);
  if (expected.reason !== undefined) expect(failure.details['reason']).toBe(expected.reason);
  return failure;
}

describe('N03-07 字幕与转写驱动剪辑（HTTP + SDK）', () => {
  it('update_caption 只改字幕：片段与音轨零变化；空文案与越界被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const caption = await seedCaption(project, { sequenceMs: [0, 4_000], words: ['没有', '3', '个', '人'] });
    const clipsBefore = await clipRanges(client, project.projectId, project.videoTrackId);

    await applyEdits(client, project.projectId, [
      { op: 'update_caption', captionId: caption.captionId, changes: { text: '没有 3 个人（改写）' } },
    ]);
    expect((await captions(client, project.projectId))[0]!.text).toBe('没有 3 个人（改写）');
    // "不让改字幕自动改原音"：片段与（不存在的）音轨零变化
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual(clipsBefore);

    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'update_caption', captionId: caption.captionId, changes: { text: '   ' } }]),
      { status: 422, reason: 'CAPTION_TEXT_EMPTY' },
    );
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'update_caption', captionId: caption.captionId, changes: { sequenceRange: range(28_000, 40_000) } }]),
      { status: 422, reason: 'CAPTION_OUTSIDE_SEQUENCE' },
    );
  });

  it('split_caption 断句：词条切分、文本按词重建，否定词与数字逐字保留', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const originalText = '没有3个人';
    const caption = await seedCaption(project, { sequenceMs: [0, 4_000], words: ['没有', '3', '个', '人'], text: originalText });
    const before = preservationTokens(originalText);
    expect(before.negations).toContain('没有');
    expect(before.digits).toContain('3');

    const result = await applyEdits(client, project.projectId, [
      { op: 'split_caption', captionId: caption.captionId, atWordIndex: 2 },
    ]);
    expect(result.editEvents.map((event) => event.action)).toEqual(['SPLIT_CAPTION']);

    const list = await captions(client, project.projectId);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ text: '没有3', words: ['没有', '3'] });
    expect(list[1]).toMatchObject({ text: '个人', words: ['个', '人'] });
    // 断句前后：否定词与数字都在，且拼接结果与原文本一致（逐字保留）
    const joined = list[0]!.text + list[1]!.text;
    expect(joined).toBe(originalText);
    expect(containsNegation(joined)).toBe(true);
    expect(containsDigits(joined)).toBe(true);
    expect(preservationTokens(joined).digits).toEqual(before.digits);
  });

  it('cut_caption_range：CAPTION_ONLY 只删词改文案（时间线零变化），与 CUT_CONTENT 明确区分', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const caption = await seedCaption(project, { sequenceMs: [0, 4_000], words: ['我们', '不', '需要', '这个'] });
    const clipsBefore = await clipRanges(client, project.projectId, project.videoTrackId);
    const captionsBefore = await captions(client, project.projectId);

    await applyEdits(client, project.projectId, [
      { op: 'cut_caption_range', captionId: caption.captionId, wordFrom: 1, wordTo: 2, mode: 'CAPTION_ONLY', closeAcrossTracks: true },
    ]);
    const after = await captions(client, project.projectId);
    expect(after).toHaveLength(1);
    expect(after[0]!.words).toEqual(['我们', '需要', '这个']);
    expect(after[0]!.text).toBe('我们需要这个');
    // CAPTION_ONLY：字幕时间与所有片段都分毫不动
    expect(after[0]!.from).toBe(captionsBefore[0]!.from);
    expect(after[0]!.to).toBe(captionsBefore[0]!.to);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual(clipsBefore);
  });

  it('cut_caption_range CUT_CONTENT：片段收缝、字幕跟随左移、跨切口字幕裁剪删词、越界与包含他条被拒', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const target = await seedCaption(project, { sequenceMs: [0, 4_000], words: ['第一句', '要剪', '的', '内容'] });
    // 另一条字幕整体落在切口之后（应随收缝左移）
    const trailing = await seedCaption(project, { sequenceMs: [6_000, 8_000], words: ['后面'] });

    const result = await applyEdits(client, project.projectId, [
      { op: 'cut_caption_range', captionId: target.captionId, wordFrom: 1, wordTo: 2, mode: 'CUT_CONTENT', closeAcrossTracks: true },
    ]);
    expect(result.editEvents.some((event) => event.action === 'CUT_CAPTION_RANGE')).toBe(true);

    // 目标字幕：删掉"要剪"，时间缩短 1s（词条各 1s）
    const list = await captions(client, project.projectId);
    const trimmed = list.find((caption) => caption.id === target.captionId)!;
    expect(trimmed.words).toEqual(['第一句', '的', '内容']);
    expect(trimmed.to - trimmed.from).toBe(3_000);
    // 后续字幕跟随 ripple 左移 1s，且仍在序列内（不越界）
    const moved = list.find((caption) => caption.id === trailing.captionId)!;
    expect([moved.from, moved.to]).toEqual([5_000, 7_000]);
    // 片段收缝：切口之后的片段左移
    const ranges = await clipRanges(client, project.projectId, project.videoTrackId);
    expect(ranges.every(([from, to]) => from >= 0 && to <= 30_000)).toBe(true);

    // 越界：词条区间超出该字幕词数 → 拒绝
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'cut_caption_range', captionId: target.captionId, wordFrom: 0, wordTo: 9, mode: 'CAPTION_ONLY', closeAcrossTracks: true }]),
      { status: 422, reason: 'CUT_RANGE_OUTSIDE_WORDS' },
    );
    // 完全包含另一条字幕 → 拒绝（不静默删字幕）
    const big = await seedCaption(project, { sequenceMs: [10_000, 20_000], words: ['很长', '很长的', '一条', '字幕', '内容', '很多', '很多', '很多', '很多', '够长'] });
    await seedCaption(project, { sequenceMs: [12_000, 13_000], words: ['中间'] });
    await expectApiFailure(
      applyEdits(client, project.projectId, [{ op: 'cut_caption_range', captionId: big.captionId, wordFrom: 0, wordTo: 10, mode: 'CUT_CONTENT', closeAcrossTracks: true }]),
      { status: 409, reason: 'CUT_CONTAINS_OTHER_CAPTION' },
    );
  });

  it('undo/redo：断句与剪内容都可逐条撤销回源状态；SRT/VTT 输出反映编辑结果', async () => {
    const client = await newSignedInClient();
    const project = await makeProject(client);
    const caption = await seedCaption(project, { sequenceMs: [0, 4_000], words: ['不要', '删掉', '这', '句'] });
    const before = await captions(client, project.projectId);
    const clipsBefore = await clipRanges(client, project.projectId, project.videoTrackId);

    const split = await applyEdits(client, project.projectId, [{ op: 'split_caption', captionId: caption.captionId, atWordIndex: 1 }]);
    expect((await captions(client, project.projectId)).length).toBe(2);
    await client.projects.undo(project.projectId); // SPLIT_CAPTION 的逆操作含 delete_caption（同一条事件两个逆操作）
    expect(await captions(client, project.projectId)).toEqual(before);
    await client.projects.redo(project.projectId);
    expect((await captions(client, project.projectId)).length).toBe(2);
    for (let index = 0; index < split.editEvents.length; index += 1) {
      await client.projects.undo(project.projectId);
    }
    expect(await captions(client, project.projectId)).toEqual(before);

    const cut = await applyEdits(client, project.projectId, [
      { op: 'cut_caption_range', captionId: caption.captionId, wordFrom: 0, wordTo: 1, mode: 'CUT_CONTENT', closeAcrossTracks: true },
    ]);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).not.toEqual(clipsBefore);
    // 逆操作逐条回退（字幕 + 被平移的片段）
    for (let index = 0; index < cut.editEvents.length; index += 1) {
      await client.projects.undo(project.projectId);
    }
    expect(await captions(client, project.projectId)).toEqual(before);
    expect(await clipRanges(client, project.projectId, project.videoTrackId)).toEqual(clipsBefore);

    // SRT/VTT：从当前投影生成字幕，否定词/数字保留
    const cues: CaptionCue[] = (await captions(client, project.projectId)).map((item) => ({
      startMs: item.from, durationMs: item.to - item.from, text: item.text,
    }));
    const srt = buildSubtitles({ format: 'SRT', cues, style: captionStyle });
    expect(srt.content).toContain('不要删掉这句');
    expect(containsNegation(srt.content)).toBe(true);
    const vtt = buildSubtitles({ format: 'VTT', cues, style: captionStyle });
    expect(vtt.content.startsWith('WEBVTT')).toBe(true);
  });
});
