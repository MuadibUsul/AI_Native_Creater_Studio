import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  legacyMillisecondsToMediaTime,
  sourceMediaProbeResultSchema,
} from '@ancs/contracts';
import { assetVersions, assets, createDb, mediaIndexEntries, mediaIndexRuns, mediaTranscriptRuns, mediaTranscriptVersions, projects, resolveTestDatabaseUrl, runMigrations, workspaces, type DbHandle } from '@ancs/db';
import { createChannel, createProject, createSequence, type DomainDeps } from './index.js';
import { agentTimelineViewOf, defaultAgentToolCatalog, simulateAgentDraft, type AgentToolContext } from './agent-tools.js';

/**
 * AP-01 编辑候选层的两个导演工具（真实 PostgreSQL + 编辑内核）：
 * - find_edit_points：从真实存储的转写快照与镜头/质量索引派生剪点（安全窗口不切字）、可收紧段落、整句不切断；可按范围过滤；
 * - caption_speech：按原声给时间线上说话的片段加字幕——词按片段的源区间映射到时间线，句末换行、语气词去掉；
 *   再跑一次不重复加（跳过已有字幕），replaceExisting 换掉旧字幕；没有转写的片段如实列出。
 */

let handle: DbHandle;
const deps = (): DomainDeps => ({ db: handle.db });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await runMigrations(handle);
});
afterAll(async () => { await handle.close(); });

function probe(durationMs: number) {
  const video = {
    index: 0, type: 'VIDEO' as const, codecName: 'h264', codecLongName: 'H.264', profile: 'High',
    timeBase: { numerator: 1, denominator: 15_360 }, startPts: '0', durationTicks: '122880', durationMs,
    width: 1920, height: 1080, rotationDegrees: 0, pixelFormat: 'yuv420p', colorRange: 'tv', colorSpace: 'bt709',
    colorTransfer: 'bt709', colorPrimaries: 'bt709', nominalFrameRate: { numerator: 30, denominator: 1 },
    averageFrameRate: { numerator: 30, denominator: 1 }, frameCount: '240', sampleRate: null, channels: null,
    channelLayout: null, cadence: 'CONSTANT' as const, sampledPacketCount: 30, sampledPtsDeltaTicks: ['512'],
  };
  const audio = {
    ...video, index: 1, type: 'AUDIO' as const, codecName: 'aac', codecLongName: 'AAC', profile: 'LC', width: null, height: null, rotationDegrees: null,
    pixelFormat: null, colorRange: null, colorSpace: null, colorTransfer: null, colorPrimaries: null, nominalFrameRate: null, averageFrameRate: null,
    frameCount: null, sampleRate: 48_000, channels: 2, channelLayout: 'stereo',
  };
  return sourceMediaProbeResultSchema.parse({
    schemaVersion: '1.0', status: 'READY', formatNames: ['mp4'], formatLongName: 'QuickTime / MOV', startTimeMs: 0, durationMs, bitRate: 92_000,
    streams: [video, audio], decodeCheck: { status: 'PASSED', errorCode: null, message: null },
    capabilities: { upload: 'AVAILABLE', decode: 'AVAILABLE', preview: 'AVAILABLE', export: 'AVAILABLE', reasons: [] },
  });
}

const ms = { numerator: 1, denominator: 1000 };
const WORDS: [number, number, string][] = [
  [200, 500, '今天'], [520, 800, '我们'], [820, 1000, '去'], [1020, 1400, '冰川。'],
  [3600, 3800, '呃'], [3820, 4300, '那里'], [4650, 5200, '很冷。'],
];

async function fixture(options: { transcript: boolean }) {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.insert(workspaces).values({ id: workspaceId, name: 'AP-01 编辑候选' });
  const channel = await createChannel(deps(), { workspaceId, input: { name: '口播' } });
  const project = await createProject(deps(), { workspaceId, input: { title: '冰川口播', channelId: channel.id, mode: 'FOOTAGE_EDIT' } });
  const sequence = await createSequence(deps(), { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: legacyMillisecondsToMediaTime(1_000) } });
  const assetId = `ast_${randomUUID()}`;
  const versionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({ id: assetId, workspaceId, projectId: project.id, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: versionId, metadata: { filename: 'talk.mp4' } });
  await handle.db.insert(assetVersions).values({ id: versionId, assetId, workspaceId, versionNumber: 1, storageKey: `ap01/${versionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 2048, checksumSha256: 'c'.repeat(64), durationMs: 8_000, width: 1920, height: 1080, status: 'READY', mediaProbe: probe(8_000) });
  if (options.transcript) {
    const runId = `mtr_${randomUUID()}`;
    await handle.db.insert(mediaTranscriptRuns).values({ id: runId, workspaceId, sourceAssetVersionId: versionId, sourceChecksumSha256: 'c'.repeat(64), processorVersion: MEDIA_TRANSCRIPT_PROCESSOR_VERSION, status: 'READY', currentVersion: 1 });
    await handle.db.insert(mediaTranscriptVersions).values({
      id: `mtv_${randomUUID()}`, workspaceId, runId, version: 1, source: 'ASR', provider: 'test-asr', model: 'test',
      snapshot: {
        language: 'zh-CN', speakers: [], terminology: [],
        words: WORDS.map(([start, end, text], ordinal) => ({ ordinal, text, speakerId: null, confidencePermille: 900, sourceStartPts: String(start), sourceEndPts: String(end), timeBase: ms })),
        segments: [
          { id: 'seg_1', ordinal: 0, text: '今天我们去冰川。', speakerId: null, wordStartOrdinal: 0, wordEndOrdinal: 3, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '200', sourceEndPts: '1400', timeBase: ms },
          { id: 'seg_2', ordinal: 1, text: '呃那里很冷。', speakerId: null, wordStartOrdinal: 4, wordEndOrdinal: 6, evidence: 'ASR_INFERENCE', reviewState: 'UNREVIEWED', sourceStartPts: '3600', sourceEndPts: '5200', timeBase: ms },
        ],
      },
    });
  }
  const indexRunId = `mir_${randomUUID()}`;
  await handle.db.insert(mediaIndexRuns).values({ id: indexRunId, workspaceId, sourceAssetVersionId: versionId, sourceChecksumSha256: 'c'.repeat(64), processorVersion: MEDIA_INDEX_PROCESSOR_VERSION, status: 'READY', coveragePermille: 1000 });
  const entry = (kind: string, ordinal: number, start: number, end: number, payload: Record<string, unknown>) => ({ id: `mie_${randomUUID()}`, workspaceId, runId: indexRunId, kind, ordinal, sourceStartPts: String(start), sourceEndPts: String(end), timeBaseNumerator: 1, timeBaseDenominator: 1000, payload });
  await handle.db.insert(mediaIndexEntries).values([
    entry('SHOT', 0, 0, 2000, { transitionType: 'START' }),
    entry('SHOT', 1, 2000, 8000, { transitionType: 'CUT' }),
    entry('QUALITY', 0, 6000, 7600, { marker: 'SILENCE' }),
  ]);
  const revision = (await handle.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, project.id)))[0]!.revision;
  const context: AgentToolContext = { deps: deps(), workspaceId, projectId: project.id, sequenceId: sequence.id, actorId: 'agent', locale: 'zh-CN', draft: { baseRevision: revision, operations: [] } };
  return { context, footageId: versionId };
}

const catalog = defaultAgentToolCatalog();
const tool = (name: string) => {
  const found = catalog.get(name);
  if (found === undefined) throw new Error(`tool ${name} not registered`);
  return found;
};

describe('AP-01 编辑候选层（工具）', () => {
  it('find_edit_points：剪点带安全窗口、语气词与长停顿可收紧、整句不切断、镜头边界与静音来自索引', async () => {
    const { context, footageId } = await fixture({ transcript: true });
    const outcome = await tool('find_edit_points').run(context, { footageId });
    expect(outcome.isError).toBe(false);
    const result = JSON.parse(outcome.content) as { analysis: unknown; cutPoints: { at: string; kind: string; window: [string, string]; pause?: string; after?: string; insideSpeech?: boolean }[]; removable: { from: string; to: string; kind: string; text?: string }[]; keepIntact: [string, string][] };
    expect(result.analysis).toEqual({ transcript: 'READY', shotsAndQuality: 'READY' });
    expect(result.cutPoints.find((point) => point.after === '冰川。')).toMatchObject({ kind: 'SENTENCE_END', window: ['1.440', '3.560'], pause: '2.200' });
    expect(result.cutPoints.find((point) => point.kind === 'SHOT_BOUNDARY')).toMatchObject({ at: '2.000', window: ['2.000', '2.000'] });
    expect(result.removable).toEqual(expect.arrayContaining([
      { from: '1.440', to: '3.560', kind: 'LONG_PAUSE' },
      { from: '3.600', to: '3.800', kind: 'FILLER', text: '呃' },
      { from: '6.000', to: '7.600', kind: 'SILENCE' },
      { from: '5.240', to: '8.000', kind: 'TAIL' },
    ]));
    expect(result.keepIntact).toEqual([['0.200', '1.400'], ['3.600', '5.200']]);

    const ranged = JSON.parse((await tool('find_edit_points').run(context, { footageId, from: '3', to: '6' })).content) as typeof result;
    expect(ranged.cutPoints.every((point) => Number(point.at) >= 3 && Number(point.at) <= 6)).toBe(true);
    expect(ranged.keepIntact).toEqual([['3.600', '5.200']]);
    expect((await tool('find_edit_points').run(context, { footageId: 'av_missing' })).isError).toBe(true);
    expect((await tool('find_edit_points').run(context, { footageId, from: '5', to: '4' })).isError).toBe(true);
  }, 60_000);

  it('caption_speech：按片段映射到时间线、句末换行、去掉语气词；不重复加；可替换；没有转写如实说明', async () => {
    const { context, footageId } = await fixture({ transcript: true });
    // 两段：第一句（0–1.5 s）放在 0；第二句（3.5–5.5 s）接在后面 → 时间线 1.5–3.5
    const placed = await tool('edit_timeline').run(context, { operations: [
      { op: 'place_clip', footageId, sourceStart: '0', sourceEnd: '1.5' },
      { op: 'place_clip', footageId, sourceStart: '3.5', sourceEnd: '5.5' },
      { op: 'fit_length' },
    ] });
    expect(placed.isError).toBe(false);
    const withClips: AgentToolContext = { ...context, draft: { baseRevision: placed.baseRevision ?? context.draft.baseRevision, operations: placed.draftOperations! } };

    const captioned = await tool('caption_speech').run(withClips, {});
    expect(captioned.isError, captioned.content).toBe(false);
    expect(JSON.parse(captioned.content)).toMatchObject({ captionsAdded: 2, captionsRemoved: 0 });
    const afterFirst: AgentToolContext = { ...withClips, draft: { baseRevision: withClips.draft.baseRevision, operations: captioned.draftOperations! } };
    const view = (await agentTimelineViewOf(afterFirst, (await simulateAgentDraft(afterFirst, afterFirst.draft)).timeline, afterFirst.sequenceId)).view;
    expect(view.captions.map((caption) => [caption.text, caption.at])).toEqual([
      // 行尾留 0.2 秒余量（可以越过片段边界，但不压到下一行）
      ['今天我们去冰川。', ['0.200', '1.600']],
      // 第二句在时间线上从 1.5 + (3.82 − 3.5) 开始（本序列为毫秒网格）；"呃"被去掉
      ['那里很冷。', ['1.820', '3.400']],
    ]);

    // 再跑一次：已有字幕处不重复加
    const again = await tool('caption_speech').run(afterFirst, {});
    expect(JSON.parse(again.content)).toMatchObject({ applied: 0, skippedOverlapping: 2 });
    // 替换：先删旧的再加新的（按指定的每行字数重新分行）
    const replaced = await tool('caption_speech').run(afterFirst, { replaceExisting: true, maxCharsPerLine: 6 });
    expect(JSON.parse(replaced.content)).toMatchObject({ captionsRemoved: 2 });
    const afterReplace: AgentToolContext = { ...afterFirst, draft: { baseRevision: afterFirst.draft.baseRevision, operations: replaced.draftOperations! } };
    const replacedView = (await agentTimelineViewOf(afterReplace, (await simulateAgentDraft(afterReplace, afterReplace.draft)).timeline, afterReplace.sequenceId)).view;
    expect(replacedView.captions.map((caption) => caption.text)).toEqual(['今天我们去', '冰川。', '那里很冷。']);
    expect(replacedView.captions.every((caption) => caption.text.length <= 6)).toBe(true);
  }, 90_000);

  it('caption_speech：片段没有转写时不编造字幕', async () => {
    const { context, footageId } = await fixture({ transcript: false });
    const placed = await tool('edit_timeline').run(context, { operations: [{ op: 'place_clip', footageId, sourceStart: '0', sourceEnd: '2' }, { op: 'fit_length' }] });
    const withClip: AgentToolContext = { ...context, draft: { baseRevision: placed.baseRevision ?? context.draft.baseRevision, operations: placed.draftOperations! } };
    const outcome = await tool('caption_speech').run(withClip, {});
    expect(outcome.isError).toBe(false);
    expect(outcome.draftOperations).toBeUndefined();
    expect(JSON.parse(outcome.content)).toMatchObject({ applied: 0, note: 'no transcript for the speaking clips yet' });
    const points = JSON.parse((await tool('find_edit_points').run(context, { footageId })).content) as { analysis: unknown; keepIntact: unknown[] };
    expect(points.analysis).toEqual({ transcript: 'NOT_ANALYZED', shotsAndQuality: 'READY' });
    expect(points.keepIntact).toEqual([]);
  }, 60_000);
});
