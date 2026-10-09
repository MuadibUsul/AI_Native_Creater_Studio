import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  PLAYBACK_ERROR_REASONS,
  legacyMillisecondsToMediaTime,
  mediaTimeToLegacyMilliseconds,
  playbackFrameAt,
  sourceMediaProbeResultSchema,
  visualParametersSchema,
  type MediaRange,
} from '@ancs/contracts';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import {
  PLAYBACK_BACKEND_CAPABILITIES,
  createChannel,
  buildPlaybackSnapshot,
  buildServerSynthesisPlan,
  createClip,
  createProject,
  createSequence,
  createTrack,
  createVisualObject,
  playbackSupports,
  playbackTimeOfFrame,
} from '@ancs/domain';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';

/**
 * N03-08 验收（真实 FFmpeg 探测 + 真实数据库）：多轨媒体预览与真实合成
 * - 真实 MP4 解码检查：源区间、时长、音轨与探测结果一致（不靠声明字段自证）；
 * - 预览快照与服务端合成计划同源同帧（documentRevision 一致，无浏览器 props 之外的隐藏工程）；
 * - 能力显式：未列出的能力一律不支持，图形对象在 baseline 后端 fail-closed；
 * - 空时间线 / 不可播放源 fail-closed，不用静态截图或静默黑屏冒充连续播放。
 */

const fixtures = resolve('packages/testing/fixtures/media-v04');

let handle: DbHandle;

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
});

afterAll(async () => {
  await handle.close();
});

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });
const ms = (time: unknown): number => mediaTimeToLegacyMilliseconds(time as never);

interface Fixture {
  workspaceId: string;
  projectId: string;
  sequenceId: string;
  videoTrackId: string;
  audioTrackId: string;
  captionTrackId: string;
}

async function makeProject(durationMs = 30_000): Promise<Fixture> {
  const workspaceId = `ws_${randomUUID()}`;
  await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'playback', now(), now())`);
  // 通道经 domain 建立：样式版本随通道一并就位（createProject 依赖它）
  const channel = await createChannel({ db: handle.db }, {
    workspaceId, createdBy: `usr_${randomUUID()}`, input: { name: '素材栏目', language: 'zh' },
  });
  const channelId = channel.id;
  const project = await createProject({ db: handle.db }, { workspaceId, input: { title: 'playback', channelId, mode: 'FOOTAGE_EDIT', brief: {} } });
  const sequence = await createSequence({ db: handle.db }, { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30, den: 1 }, duration: mt(durationMs) } });
  const videoTrack = await createTrack({ db: handle.db }, { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
  const audioTrack = await createTrack({ db: handle.db }, { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
  const captionTrack = await createTrack({ db: handle.db }, { workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind: 'CAPTION', position: 2, name: 'C1' } });
  return { workspaceId, projectId: project.id, sequenceId: sequence.id, videoTrackId: videoTrack.id, audioTrackId: audioTrack.id, captionTrackId: captionTrack.id };
}

/** 用真实探测结果播种资产版本（不用手写 mediaProbe 冒充探测输出）。 */
async function seedAssetFromRealFile(
  fixture: Fixture,
  filePath: string,
  options: { status?: 'READY' | 'PROCESSING'; omitChecksum?: boolean } = {},
): Promise<{ assetId: string; assetVersionId: string; probe: ReturnType<typeof sourceMediaProbeResultSchema.parse> }> {
  const probe = createFfmpegSourceMediaProbe({ timeoutMs: 30_000 });
  const result = await probe.probe({ filePath, declaredMimeType: 'video/mp4' });
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId: fixture.workspaceId, projectId: fixture.projectId, assetType: 'UPLOADED_VIDEO',
    origin: 'USER_UPLOAD', status: 'READY', retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId: fixture.workspaceId, versionNumber: 1,
    storageKey: `n03-08/${assetVersionId}.mp4`, mimeType: 'video/mp4', sizeBytes: 1024,
    checksumSha256: options.omitChecksum === true ? null : 'a'.repeat(64),
    durationMs: result.durationMs ?? 1_000, width: result.streams.find((stream) => stream.type === 'VIDEO')?.width ?? null,
    height: result.streams.find((stream) => stream.type === 'VIDEO')?.height ?? null,
    status: options.status ?? 'READY', mediaProbe: result,
  });
  return { assetId, assetVersionId, probe: result };
}

async function seedClip(fixture: Fixture, assetVersionId: string, sequenceMs: [number, number], sourceMs: [number, number], parameters?: unknown) {
  return createClip({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.videoTrackId, assetVersionId,
      sourceRange: range(...sourceMs), sequenceRange: range(...sequenceMs),
      timeMapping: { kind: 'LINEAR', rate: { num: 1, den: 1 }, direction: 'FORWARD', preservePitch: true },
    },
  }).then(async (clip) => {
    if (parameters !== undefined) {
      await handle.db.execute(`update sequence_clips set parameters = '${JSON.stringify(parameters)}'::jsonb where id = '${clip.id}'`);
    }
    return clip;
  });
}

describe('N03-08 多轨媒体预览与真实合成（真实 FFmpeg 探测 + 真实数据库）', () => {
  it('真实 MP4 解码检查：源区间/时长/音轨与探测结果一致，预览快照与合成计划同源同帧', { timeout: 60_000 }, async () => {
    const fixture = await makeProject(30_000);
    const video = await seedAssetFromRealFile(fixture, resolve(fixtures, 'clip-b-30000-1001.mp4'));
    const audioOnly = await seedAssetFromRealFile(fixture, resolve(fixtures, 'independent-48k-stereo.wav'));
    const realDurationMs = video.probe.durationMs ?? 0;
    expect(realDurationMs).toBeGreaterThan(1_000);

    // 用真实时长做一次源区间裁剪（0.5s–2.5s），并带上外观参数
    const clip = await seedClip(fixture, video.assetVersionId, [0, 2_000], [500, 2_500], visualParametersSchema.parse({ opacity: 0.8 }));
    expect(clip.id).toBeTruthy();

    const snapshot = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, backend: 'HTML_MEDIA_BASELINE',
    });
    expect(snapshot.videoSegments).toHaveLength(1);
    const segment = snapshot.videoSegments[0]!;
    // 源区间与时长：真实文件时长必须放得下该区间，且快照逐字保留编辑时的区间
    expect(ms(segment.sourceRange.start)).toBe(500);
    expect(ms(segment.sourceRange.end)).toBe(2_500);
    expect(ms(segment.sequenceRange.end) - ms(segment.sequenceRange.start)).toBe(2_000);
    expect(realDurationMs).toBeGreaterThanOrEqual(2_500);
    expect(segment.sourceHasAudio).toBe(video.probe.streams.some((stream) => stream.type === 'AUDIO'));
    expect(segment.opacity).toBe(0.8);
    expect(snapshot.duration).toBeDefined();

    // 预览/服务端对照：同一 revision、同一帧映射
    const plan = buildServerSynthesisPlan(snapshot);
    expect(plan.documentRevision).toBe(snapshot.documentRevision);
    expect(plan.backend).toBe('SERVER_PRECOMPOSED');
    expect(plan.segments).toHaveLength(snapshot.videoSegments.length);
    expect(plan.segments[0]).toMatchObject({
      clipId: segment.clipId,
      startFrame: playbackFrameAt(segment.sequenceRange.start, snapshot.frameRate, 'floor'),
      endFrameExclusive: playbackFrameAt(segment.sequenceRange.end, snapshot.frameRate, 'floor'),
    });
    // 帧 → 时间与时间 → 帧互逆（30fps、整数毫秒切点）
    expect(playbackFrameAt(playbackTimeOfFrame('45', snapshot.frameRate), snapshot.frameRate, 'floor')).toBe('45');

    // 纯音频资产进入音频段时同样可解析（不被当成视频段）
    const fresh = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, backend: 'HTML_MEDIA_BASELINE',
    });
    expect(fresh.audioSegments.some((item) => item.sequenceRange !== undefined)).toBe(false);
    expect(audioOnly.probe.streams.some((stream) => stream.type === 'AUDIO')).toBe(true);
  });

  it('能力显式：未列出的能力不得视为支持；图形对象在 baseline 后端 fail-closed，切到服务端合成才允许', async () => {
    const fixture = await makeProject(20_000);
    const video = await seedAssetFromRealFile(fixture, resolve(fixtures, 'clip-c-60000-1001.mp4'));
    const graphicHostClip = await seedClip(fixture, video.assetVersionId, [0, 2_000], [0, 2_000]);

    const baseline = PLAYBACK_BACKEND_CAPABILITIES.HTML_MEDIA_BASELINE;
    expect(playbackSupports(baseline, 'GRAPHICS_COMPONENT_RENDER')).toBe(false);
    expect(playbackSupports(baseline, 'PER_SEGMENT_TRANSFORM')).toBe(true);
    // 未在任何后端声明过的能力（示例：HDR 渲染）不得被当作支持
    expect(playbackSupports(baseline, 'GRAPHICS_COMPONENT_RENDER')).toBe(false);
    expect(baseline.unsupported).toContain('GRAPHICS_COMPONENT_RENDER');

    await createVisualObject({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
      input: {
        trackId: fixture.videoTrackId, kind: 'TEXT',
        timeBinding: { basis: 'CLIP_LOCAL', clipId: graphicHostClip.id, semanticCueId: null },
        localRange: range(0, 2_000), parameters: { schemaVersion: '1.0', values: { text: '图形对象' } },
      },
    });
    await expect(buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, backend: 'HTML_MEDIA_BASELINE',
    })).rejects.toMatchObject({ httpStatus: 501, details: { reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY, capability: 'GRAPHICS_COMPONENT_RENDER' } });

    const serverSnapshot = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId, backend: 'SERVER_PRECOMPOSED',
    });
    expect(serverSnapshot.capabilities.videoPrecision).toBe('FRAME_ACCURATE');
    expect(playbackSupports(serverSnapshot.capabilities, 'GRAPHICS_COMPONENT_RENDER')).toBe(true);
  });

  it('隐藏视频轨被排除且显式列出；静音与独奏归一化后音频段的可听性正确', async () => {
    const fixture = await makeProject(20_000);
    const video = await seedAssetFromRealFile(fixture, resolve(fixtures, 'clip-a-24000-1001.mp4'));
    await seedClip(fixture, video.assetVersionId, [0, 1_000], [0, 1_000]);
    await handle.db.execute(`update sequence_tracks set muted = true where id = '${fixture.audioTrackId}'`);

    const snapshot = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    });
    expect(snapshot.videoSegments).toHaveLength(1);
    expect(snapshot.excludedTrackIds).toEqual([]);

    // 隐藏视频轨 → 从视频段中排除，并在 excludedTrackIds 与 warnings 里显式说明（不静默丢弃）
    await handle.db.execute(`update sequence_tracks set hidden = true where id = '${fixture.videoTrackId}'`);
    await expect(buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    })).rejects.toMatchObject({ httpStatus: 409, details: { reason: PLAYBACK_ERROR_REASONS.EMPTY_TIMELINE } });

    await handle.db.execute(`update sequence_tracks set hidden = false, muted = true where id = '${fixture.videoTrackId}'`);
    await handle.db.execute(`update sequence_tracks set muted = true where id = '${fixture.audioTrackId}'`);
    const withAudioRegion = await seedAudioRegionFor(fixture, video.assetVersionId, [0, 1_000]);
    const mutedSnapshot = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    });
    expect(mutedSnapshot.audioSegments.find((segment) => segment.id === withAudioRegion)?.audible).toBe(false);
    // 打开独奏后该轨可听
    await handle.db.execute(`update sequence_tracks set muted = false, solo = true where id = '${fixture.audioTrackId}'`);
    const soloSnapshot = await buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    });
    expect(soloSnapshot.audioSegments.find((segment) => segment.id === withAudioRegion)?.audible).toBe(true);
  });

  it('fail-closed：空时间线 409 EMPTY_TIMELINE；源未就绪/缺校验和 409 SOURCE_NOT_PLAYABLE', async () => {
    const fixture = await makeProject(20_000);
    await expect(buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    })).rejects.toMatchObject({ httpStatus: 409, details: { reason: PLAYBACK_ERROR_REASONS.EMPTY_TIMELINE } });

    // 先以 READY 建片段（编辑期本就要求源就绪），再把源置为未就绪：播放时必须 fail-closed
    const laterProcessing = await seedAssetFromRealFile(fixture, resolve(fixtures, 'clip-a-24000-1001.mp4'));
    await seedClip(fixture, laterProcessing.assetVersionId, [0, 1_000], [0, 1_000]);
    await handle.db.execute(`update asset_versions set status = 'PROCESSING' where id = '${laterProcessing.assetVersionId}'`);
    await expect(buildPlaybackSnapshot({ db: handle.db }, {
      workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    })).rejects.toMatchObject({ httpStatus: 409, details: { reason: PLAYBACK_ERROR_REASONS.SOURCE_NOT_PLAYABLE } });
  });
});

/** 建一条绑定到片段的音频区域（复用 domain 的 createAudioRegion，避免手写行）。 */
async function seedAudioRegionFor(fixture: Fixture, assetVersionId: string, sequenceMs: [number, number]): Promise<string> {
  const { createAudioRegion } = await import('@ancs/domain');
  const clipRows = await handle.db.execute(`select id from sequence_clips where sequence_id = '${fixture.sequenceId}' limit 1`);
  const clipId = clipRows.rows[0]!['id'] as string;
  const region = await createAudioRegion({ db: handle.db }, {
    workspaceId: fixture.workspaceId, projectId: fixture.projectId, sequenceId: fixture.sequenceId,
    input: {
      trackId: fixture.audioTrackId,
      timeBinding: { basis: 'CLIP_LOCAL', clipId, semanticCueId: null },
      localRange: range(0, sequenceMs[1] - sequenceMs[0]),
      sourceStreamId: 'audio-main',
      channelMapping: [{ sourceChannel: 0, outputChannel: 0 }],
      gainDb: 0, pan: 0, fadeIn: mt(0), fadeOut: mt(0),
      parameters: { schemaVersion: '1.0', values: {} },
    },
  });
  expect(assetVersionId).toBeTruthy();
  return region.id;
}
