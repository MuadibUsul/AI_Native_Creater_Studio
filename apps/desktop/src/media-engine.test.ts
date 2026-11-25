import { execFileSync } from 'node:child_process';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { desktopVideoEncoderArgs, probeDesktopGpu } from './gpu.js';
import { startLocalMediaEngine, type LocalMediaEngine } from './media-engine.js';
import { LocalMediaRegistry } from './registry.js';

describe('Kinora Desktop Local GPU Media Engine', () => {
  const dirs: string[] = [];
  const engines: LocalMediaEngine[] = [];

  afterEach(async () => {
    for (const eng of engines.splice(0)) await eng.close();
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  it('enforces Bearer token and Origin allowlist, and streams Range bytes in O(1) memory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kinora-desktop-test-'));
    dirs.push(dir);
    const sample = join(dir, 'sample.bin');
    await writeFile(sample, Buffer.from('0123456789abcdefghij', 'utf8'));

    const engine = await startLocalMediaEngine({
      allowedOrigins: ['http://localhost:3000'],
      gpuInfo: { backend: 'nvenc', codec: 'h264_nvenc', hardwareAccelerated: true, probeMs: 50 },
      workRoot: join(dir, 'cache'),
      registry: new LocalMediaRegistry({
        probeFn: async () => ({ durationMs: 1000, videoDurationMs: 1000, width: 1920, height: 1080, fps: { num: 30, den: 1 }, hasVideo: true, hasAudio: false }),
      }),
    });
    engines.push(engine);

    // 1. 拒绝无令牌与非法 Origin
    expect((await fetch(`${engine.baseUrl}/health`)).status).toBe(401);
    expect((await fetch(`${engine.baseUrl}/health`, { headers: { authorization: `Bearer ${engine.token}`, origin: 'https://evil.example' } })).status).toBe(403);

    // 2. 合法令牌 + 白名单 Origin 返回 GPU 状态
    const healthRes = await fetch(`${engine.baseUrl}/health`, {
      headers: { authorization: `Bearer ${engine.token}`, origin: 'http://localhost:3000' },
    });
    expect(healthRes.status).toBe(200);
    expect(await healthRes.json()).toMatchObject({ status: 'ok', gpu: { backend: 'nvenc', codec: 'h264_nvenc' } });

    // 3. 零上传登记 + Range 206 流式播放 + 移动文件后 Relink
    const rec = await engine.registry.registerFile(sample);
    const rangeRes = await fetch(`${engine.baseUrl}/media/${rec.localId}?token=${engine.token}`, {
      headers: { range: 'bytes=4-9' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toBe('bytes 4-9/20');
    expect(await rangeRes.text()).toBe('456789');

    const moved = join(dir, 'moved-sample.bin');
    await rename(sample, moved);
    const relinked = await engine.registry.relink(rec.localId, moved);
    expect(relinked.fileName).toBe('moved-sample.bin');
    expect((await fetch(`${engine.baseUrl}/media/${rec.localId}?token=${engine.token}`)).status).toBe(200);
  });

  it('probes local GPU and executes real local frame sampling + GPU/CPU export on a real MP4', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kinora-desktop-gpu-'));
    dirs.push(dir);
    const clip = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', [
      '-hide_banner', '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
      clip,
    ]);

    const gpu = await probeDesktopGpu({ preference: 'auto' });
    expect(desktopVideoEncoderArgs(gpu.backend, { preset: 'veryfast', crf: 23 })).toContain(gpu.codec);

    const engine = await startLocalMediaEngine({
      allowedOrigins: ['http://localhost:3000'],
      gpuInfo: gpu,
      workRoot: join(dir, 'cache'),
    });
    engines.push(engine);

    const rec = await engine.registry.registerFile(clip);
    expect(rec.width).toBe(320);
    expect(rec.height).toBe(180);
    expect(rec.hasVideo).toBe(true);
    expect(rec.hasAudio).toBe(true);

    // 本地抽帧（无需上传原片）
    const frameRes = await fetch(`${engine.baseUrl}/media/${rec.localId}/frames`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ times: ['0.200', '1.000'], maxWidth: 256 }),
    });
    expect(frameRes.status).toBe(200);
    const frameBody = await frameRes.json() as { frames: { at: string; data: string }[] };
    expect(frameBody.frames).toHaveLength(2);
    expect(frameBody.frames[0]!.data.length).toBeGreaterThan(100);

    // 本地 GPU 导出（单片段）
    const outFile = join(dir, 'exported.mp4');
    const expRes = await fetch(`${engine.baseUrl}/export`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ localId: rec.localId, outputPath: outFile, preset: 'veryfast', crf: 20 }),
    });
    expect(expRes.status).toBe(200);
    const expBody = await expRes.json() as { sizeBytes: number; videoEncoder: string };
    expect(expBody.sizeBytes).toBeGreaterThan(1000);
    expect(expBody.videoEncoder).toBe(gpu.codec);

    // 本地 GPU 多片段时间线合成导出（/render-plan）
    const planOut = join(dir, 'timeline-plan.mp4');
    const planRes = await fetch(`${engine.baseUrl}/render-plan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${engine.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        outputPath: planOut,
        width: 320,
        height: 180,
        fps: 30,
        preset: 'veryfast',
        crf: 22,
        segments: [
          { localId: rec.localId, startSeconds: 0, endSeconds: 0.4 },
          { localId: rec.localId, startSeconds: 0.5, endSeconds: 0.9 },
        ],
      }),
    });
    expect(planRes.status).toBe(200);
    const planBody = await planRes.json() as { sizeBytes: number; segmentCount: number; videoEncoder: string };
    expect(planBody.segmentCount).toBe(2);
    expect(planBody.sizeBytes).toBeGreaterThan(1000);
    expect(planBody.videoEncoder).toBe(gpu.codec);
  }, 30_000);
});
