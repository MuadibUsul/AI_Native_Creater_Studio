import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApiFailure,
  PLAYBACK_ERROR_REASONS,
  legacyMillisecondsToMediaTime,
  timeToFraction,
  type MediaRange,
  type PlaybackSnapshot,
} from '@ancs/contracts';
import { assets, assetVersions, createDb, resolveTestDatabaseUrl, runMigrations, type DbHandle } from '@ancs/db';
import {
  buildPlaybackSnapshot,
  compileSequenceRenderPlan,
  createAudioRegion,
  createChannel,
  createProject,
  createSequence,
  createTrack,
  createVisualObject,
  processEdits,
} from '@ancs/domain';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';

/**
 * V5-M4（§13 一致性套件，精简集）：同一 RenderPlan 的 **baseline 播放投影** 与 **FFmpeg 终渲染** 逐帧/逐采样对照。
 *
 * 金样源由 FFmpeg lavfi 现场生成：每帧把"帧号 + 1"编码成 8 条黑白竖条（压缩后仍可无歧义解码；全暗 = 黑底画布），音频在已知源时刻放一个短促音。
 * 期望值**不手写**：从 baseline 播放快照（HTML_MEDIA_BASELINE）取段，按 `sequenceTimeToSourcePts` 映射源时刻，
 * 再按"保持"语义（PTS ≤ 源时刻的最后一帧）求源帧号；终渲染解码后逐帧比对——时间映射必须**逐帧相等**。
 * 音频：起点误差 ≤ 1 ms、增益误差 ≤ 0.5 dB、全左声像时右声道静音；Manifest 与计划同一 planHash，产物哈希可复核。
 */

let handle: DbHandle;
let workRoot: string;
const W = 256;
const H = 128;
const PROFILE = { width: W, height: H, videoCrf: 12, audioBitrateKbps: 192, captionDelivery: 'SIDECAR' as const };

const mt = (milliseconds: number) => legacyMillisecondsToMediaTime(milliseconds);
const range = (startMs: number, endMs: number): MediaRange => ({ start: mt(startMs), end: mt(endMs) });

beforeAll(async () => {
  handle = createDb(resolveTestDatabaseUrl());
  await handle.pool.query('select 1');
  await runMigrations(handle);
  workRoot = await mkdtemp(join(tmpdir(), 'ancs-conformance-'));
  // A：24000/1001 fps、128×64、帧号 + 1 编码（8 条 16px 竖条），立体声音轨在源 2.0 s 处有 10 ms 1 kHz 短音（振幅 0.5）
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=black:s=128x64:r=24000/1001:d=4,format=gray,geq=lum='255*mod(floor((N+1)/pow(2,floor(X/16))),2)'",
    '-f', 'lavfi', '-i', "aevalsrc='if(between(t,2.0,2.01),0.5*sin(2*PI*1000*t),0)':s=48000:d=4:c=stereo",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '12', '-c:a', 'aac', '-b:a', '192k', '-shortest', join(workRoot, 'coded-a.mp4')]);
  // B：30 fps、128×64、帧号 + 1 编码，无音轨
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y',
    '-f', 'lavfi', '-i', "color=c=black:s=128x64:r=30:d=4,format=gray,geq=lum='255*mod(floor((N+1)/pow(2,floor(X/16))),2)'",
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '15', join(workRoot, 'coded-b.mp4')]);
});

afterAll(async () => {
  await handle.close();
  await rm(workRoot, { recursive: true, force: true });
});

async function seedAsset(workspaceId: string, projectId: string, filePath: string) {
  const probe = await createFfmpegSourceMediaProbe({ timeoutMs: 30_000 }).probe({ filePath, declaredMimeType: 'video/mp4' });
  const bytes = await readFile(filePath);
  const assetId = `ast_${randomUUID()}`;
  const assetVersionId = `av_${randomUUID()}`;
  await handle.db.insert(assets).values({
    id: assetId, workspaceId, projectId, assetType: 'UPLOADED_VIDEO', origin: 'USER_UPLOAD', status: 'READY',
    retentionClass: 'PROJECT', license: { kind: 'OWNED' }, currentVersionId: assetVersionId,
  });
  await handle.db.insert(assetVersions).values({
    id: assetVersionId, assetId, workspaceId, versionNumber: 1, storageKey: `conformance/${assetVersionId}.mp4`, mimeType: 'video/mp4',
    sizeBytes: bytes.byteLength, checksumSha256: createHash('sha256').update(bytes).digest('hex'), durationMs: probe.durationMs ?? 4_000,
    width: 128, height: 64, status: 'READY', mediaProbe: probe,
  });
  return { assetId, assetVersionId, filePath };
}

/** 在画布像素处读 8 条竖条 → 帧号（编码值 − 1）；全部暗 = 黑底画布（返回 null）。 */
function decodeCodes(file: string, frames: number, sample: (bit: number) => { x: number; y: number }): (number | null)[] {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 28 });
  expect(raw.length).toBe(frames * W * H);
  const out: (number | null)[] = [];
  for (let frame = 0; frame < frames; frame += 1) {
    let code = 0;
    let lit = 0;
    for (let bit = 0; bit < 8; bit += 1) {
      const point = sample(bit);
      const value = raw[frame * W * H + point.y * W + point.x]!;
      if (value > 128) {
        code |= 1 << bit;
        lit += 1;
      }
    }
    out.push(lit === 0 ? null : code - 1);
  }
  return out;
}

/**
 * baseline 投影的期望：第 k 帧（T = k·den/num 秒，精确有理）被哪个段覆盖 → 源时刻 s = 源入点 + (T − 序列入点)
 * （计划已断言无 TIME_REMAP，映射为 1:1 正向）→ 保持语义的源帧号 floor(s·fps_src)。
 */
function expectedFrames(snapshot: PlaybackSnapshot, frames: number, layerOf: (clipId: string) => boolean, sourceFps: Map<string, { num: bigint; den: bigint }>): (number | null)[] {
  const out: (number | null)[] = [];
  for (let k = 0; k < frames; k += 1) {
    const T = { num: BigInt(k) * BigInt(snapshot.frameRate.den), den: BigInt(snapshot.frameRate.num) };
    const covering = snapshot.videoSegments.filter((segment) => layerOf(segment.clipId)).find((segment) => {
      const start = timeToFraction(segment.sequenceRange.start);
      const end = timeToFraction(segment.sequenceRange.end);
      return start.num * T.den <= T.num * start.den && T.num * end.den < end.num * T.den;
    });
    if (covering === undefined) {
      out.push(null);
      continue;
    }
    const seqStart = timeToFraction(covering.sequenceRange.start);
    const srcStart = timeToFraction(covering.sourceRange.start);
    // s = srcStart + T − seqStart（公分母）
    const den = srcStart.den * T.den * seqStart.den;
    const num = srcStart.num * T.den * seqStart.den + T.num * srcStart.den * seqStart.den - seqStart.num * srcStart.den * T.den;
    const fps = sourceFps.get(covering.sourceVersionId)!;
    out.push(Number((num * fps.num) / (den * fps.den)));
  }
  return out;
}

function decodeAudio(file: string): Float32Array {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
}

describe('V5-M4 一致性：baseline 播放投影 × FFmpeg 终渲染（真实 Postgres + 真实 FFmpeg 编解码）', () => {
  it('两层视频（全画幅 + 缩放 0.5 置于左上）与带增益/声像的音频区域：逐帧源帧号相等，音频起点/增益/声像符合计划', { timeout: 180_000 }, async () => {
    const workspaceId = `ws_${randomUUID()}`;
    await handle.db.execute(`insert into workspaces (id, name, created_at, updated_at) values ('${workspaceId}', 'conformance', now(), now())`);
    const channel = await createChannel({ db: handle.db }, { workspaceId, createdBy: `usr_${randomUUID()}`, input: { name: '一致性', language: 'zh' } });
    const project = await createProject({ db: handle.db }, { workspaceId, input: { title: 'conformance', channelId: channel.id, mode: 'FOOTAGE_EDIT', brief: {} } });
    const sequence = await createSequence({ db: handle.db }, { workspaceId, projectId: project.id, input: { name: '主序列', frameRate: { num: 30000, den: 1001 }, duration: mt(3_500) } });
    const scope = { workspaceId, projectId: project.id, sequenceId: sequence.id };
    const v1 = await createTrack({ db: handle.db }, { ...scope, input: { kind: 'VIDEO', position: 0, name: 'V1' } });
    const a1 = await createTrack({ db: handle.db }, { ...scope, input: { kind: 'AUDIO', position: 1, name: 'A1' } });
    const v2 = await createTrack({ db: handle.db }, { ...scope, input: { kind: 'VIDEO', position: 2, name: 'V2' } });
    const a = await seedAsset(workspaceId, project.id, join(workRoot, 'coded-a.mp4'));
    const b = await seedAsset(workspaceId, project.id, join(workRoot, 'coded-b.mp4'));
    const revision = async () => Number((await handle.db.execute(`select revision from projects where id = '${project.id}'`)).rows[0]!['revision']);
    const edit = async (operations: unknown[]) => processEdits({ db: handle.db }, {
      workspaceId, projectId: project.id, actor: { type: 'USER', id: null },
      request: { baseProjectRevision: await revision(), expectedSceneRevisions: {}, idempotencyKey: `idem_${randomUUID()}`, operations: operations as never },
    });
    const insert = (trackId: string, assetVersionId: string, source: MediaRange, atMs: number) => ({
      op: 'insert_clip', sequenceId: sequence.id, trackId, assetVersionId, nestedSequenceId: null, sourceStreamId: null,
      sourceRange: source, mode: 'OVERWRITE', sequenceStart: mt(atMs), linkAudio: false, audioTrackId: null,
    });
    await edit([insert(v1.id, a.assetVersionId, range(500, 3_500), 0), insert(v2.id, b.assetVersionId, range(0, 1_000), 1_000)]);
    const clipRows = (await handle.db.execute(`select id, track_id from sequence_clips where sequence_id = '${sequence.id}'`)).rows as { id: string; track_id: string }[];
    const clipA = clipRows.find((row) => row.track_id === v1.id)!.id;
    const clipB = clipRows.find((row) => row.track_id === v2.id)!.id;
    // B 缩放 0.5（无旋转时锚点不改变位置）：对象矩形 = 画布左上象限 [0,128)×[0,64)
    await edit([{ op: 'set_clip_transform', clipId: clipB, transform: { position: { x: 0, y: 0 }, scale: { x: 0.5, y: 0.5 }, rotationDeg: 0, anchor: { x: 0.5, y: 0.5 } } }]);
    // 音频区域：绑定 A 片段整段，-6 dB、全左声像、3 s 等功率淡入（短音在源 2.0 s → 序列 1.5 s = 淡入中点）
    await createAudioRegion({ db: handle.db }, {
      ...scope,
      input: {
        trackId: a1.id, timeBinding: { basis: 'CLIP_LOCAL', clipId: clipA, semanticCueId: null }, localRange: range(0, 3_000),
        sourceStreamId: 'audio-main', channelMapping: [{ sourceChannel: 0, outputChannel: 0 }, { sourceChannel: 1, outputChannel: 1 }],
        gainDb: -6, pan: -1, fadeIn: mt(3_000), fadeOut: mt(0), parameters: { schemaVersion: '1.0', values: {} },
      },
    });

    const plan = await compileSequenceRenderPlan({ db: handle.db }, scope);
    const baseline = await buildPlaybackSnapshot({ db: handle.db }, { ...scope, backend: 'HTML_MEDIA_BASELINE' });
    expect(baseline.planHash).toBe(plan.planHash);
    expect(plan.requirements).toEqual(['AUDIO_GAIN_FADE_PAN', 'MULTI_TRACK_COMPOSITE', 'PER_SEGMENT_TRANSFORM']);

    // 编排层职责（此处由测试扮演）：冻结源落盘到 workDir/assets
    const workDir = join(workRoot, `render-${randomUUID()}`);
    await mkdir(join(workDir, 'assets'), { recursive: true });
    await copyFile(a.filePath, join(workDir, 'assets', 'a.mp4'));
    await copyFile(b.filePath, join(workDir, 'assets', 'b.mp4'));
    const executor = createFfmpegRenderPlanExecutor({ timeoutMs: 120_000 });
    const result = await executor.execute({
      plan, profile: PROFILE, workDir,
      sources: [{ assetVersionId: a.assetVersionId, fileName: 'a.mp4' }, { assetVersionId: b.assetVersionId, fileName: 'b.mp4' }],
    });
    expect(result.planHash).toBe(plan.planHash);
    const output = join(workDir, 'out', 'final.mp4');

    // 产物完整性：回执哈希 = 文件字节哈希；Manifest 与计划同一 planHash
    for (const file of result.files) {
      expect(createHash('sha256').update(await readFile(join(workDir, 'out', file.fileName))).digest('hex')).toBe(file.sha256);
    }
    const manifest = JSON.parse(await readFile(join(workDir, 'out', 'manifest.json'), 'utf8')) as { planHash: string; graphHash: string; frameCount: string };
    expect(manifest).toMatchObject({ planHash: plan.planHash, graphHash: result.graphHash, frameCount: '105' });

    // 时长：3.5 s @ 30000/1001 → 105 帧
    const frames = Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', output]).toString().trim());
    expect(frames).toBe(105);

    // 视频逐帧：A 层从画面下半部读（128×64 拉伸到 256×128，竖条宽 32px）；B 层从左上象限读（128×64 → 对象 128×64，竖条宽 16px）
    const sourceFps = new Map([[a.assetVersionId, { num: 24000n, den: 1001n }], [b.assetVersionId, { num: 30n, den: 1n }]]);
    const decodedA = decodeCodes(output, frames, (bit) => ({ x: bit * 32 + 16, y: 100 }));
    const decodedB = decodeCodes(output, frames, (bit) => ({ x: bit * 16 + 8, y: 32 }));
    const expectedA = expectedFrames(baseline, frames, (clipId) => clipId === clipA, sourceFps);
    const expectedBOnly = expectedFrames(baseline, frames, (clipId) => clipId === clipB, sourceFps);
    expect(decodedA).toEqual(expectedA);
    // B 窗口外，左上象限显示的是 A（A 的竖条在该处的采样不构成 B 的编码）——只比较 B 覆盖的帧
    const bFrames = expectedBOnly.flatMap((value, index) => (value === null ? [] : [index]));
    expect(bFrames.length).toBe(30);
    expect(bFrames.map((index) => decodedB[index])).toEqual(bFrames.map((index) => expectedBOnly[index]));

    // 音频：短音起点（源 2.0 s → 序列 1.5 s）；-6 dB × 全左（立体声相加 ×2）× 等功率淡入中点 sin(π/4)
    // → 左声道峰值 ≈ 0.5 × 0.7071 ≈ 0.354（线性淡变会是 0.25，"dB 线性"曲线更低），右声道静音
    const pcm = decodeAudio(output);
    let onset = -1;
    let leftPeak = 0;
    let rightPeak = 0;
    for (let index = 0; index < pcm.length; index += 2) {
      leftPeak = Math.max(leftPeak, Math.abs(pcm[index]!));
      rightPeak = Math.max(rightPeak, Math.abs(pcm[index + 1]!));
      if (onset < 0 && Math.abs(pcm[index]!) > 0.05) onset = index / 2;
    }
    expect(Math.abs(onset / 48_000 - 1.5)).toBeLessThanOrEqual(0.001);
    expect(Math.abs(20 * Math.log10(leftPeak / (0.5 * Math.SQRT1_2)))).toBeLessThanOrEqual(0.5);
    expect(rightPeak).toBeLessThan(0.01);
    // 采样数：3.5 s × 48 kHz，允许 AAC 末帧补齐（≤ 1024 采样）
    expect(pcm.length / 2).toBeGreaterThanOrEqual(168_000);
    expect(pcm.length / 2).toBeLessThanOrEqual(168_000 + 1024);

    // 不支持的需求显式拒绝（不静默省略）：加一个图形对象 → 501 GRAPHICS_COMPONENT_RENDER，且不产生任何输出
    await createVisualObject({ db: handle.db }, {
      ...scope,
      input: { trackId: v2.id, kind: 'TEXT', timeBinding: { basis: 'CLIP_LOCAL', clipId: clipB, semanticCueId: null }, localRange: range(0, 1_000), parameters: { schemaVersion: '1.0', values: { text: '标题' } } },
    });
    const withGraphics = await compileSequenceRenderPlan({ db: handle.db }, scope);
    const refusedDir = join(workRoot, `refused-${randomUUID()}`);
    await mkdir(join(refusedDir, 'assets'), { recursive: true });
    const refusal = await executor.execute({ plan: withGraphics, profile: PROFILE, workDir: refusedDir, sources: [] }).then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(ApiFailure);
    expect((refusal as ApiFailure).httpStatus).toBe(501);
    expect((refusal as ApiFailure).details).toMatchObject({ reason: PLAYBACK_ERROR_REASONS.UNSUPPORTED_CAPABILITY, capability: 'GRAPHICS_COMPONENT_RENDER', backend: 'FFMPEG_MEDIA_GRAPH' });
  });
});
