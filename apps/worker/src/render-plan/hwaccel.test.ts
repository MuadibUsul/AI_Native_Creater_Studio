import { describe, expect, it } from 'vitest';
import { candidateGpuBackends, probeVideoEncoder, videoEncoderArgs } from './hwaccel.js';

describe('GPU hardware video encoder adapter', () => {
  it('generates exact libx264 args for cpu and valid encoder args for NVIDIA/Apple/Intel/AMD', () => {
    expect(videoEncoderArgs('cpu', { preset: 'medium', crf: 18 })).toEqual([
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    ]);
    expect(videoEncoderArgs('nvenc', { preset: 'veryfast', crf: 23 })).toEqual([
      '-c:v', 'h264_nvenc', '-preset', 'p3', '-rc', 'vbr', '-cq', '23', '-b:v', '0', '-pix_fmt', 'yuv420p',
    ]);
    expect(videoEncoderArgs('videotoolbox', { preset: 'medium', crf: 18 })).toEqual([
      '-c:v', 'h264_videotoolbox', '-q:v', '72', '-pix_fmt', 'yuv420p',
    ]);
    expect(videoEncoderArgs('qsv', { preset: 'veryfast', crf: 20 })).toEqual([
      '-c:v', 'h264_qsv', '-preset', 'veryfast', '-global_quality', '20', '-pix_fmt', 'yuv420p',
    ]);
    expect(videoEncoderArgs('amf', { preset: 'medium', crf: 22 })).toEqual([
      '-c:v', 'h264_amf', '-quality', 'balanced', '-rc', 'cqp', '-qp_i', '22', '-qp_p', '22', '-pix_fmt', 'yuv420p',
    ]);
  });

  it('orders platform GPU candidates for darwin and win32/linux', () => {
    expect(candidateGpuBackends('darwin')).toEqual(['videotoolbox']);
    expect(candidateGpuBackends('win32')).toEqual(['nvenc', 'qsv', 'amf']);
    expect(candidateGpuBackends('linux')).toEqual(['nvenc', 'qsv', 'amf']);
  });

  it('auto-selects first passing GPU backend and falls back to cpu when none pass', async () => {
    const probed: string[] = [];
    const qsv = await probeVideoEncoder({
      preference: 'auto',
      platform: 'win32',
      testEncoder: async (backend) => {
        probed.push(backend);
        return backend === 'qsv';
      },
    });
    expect(probed).toEqual(['nvenc', 'qsv']);
    expect(qsv).toMatchObject({ backend: 'qsv', codec: 'h264_qsv', hardwareAccelerated: true });

    const fallback = await probeVideoEncoder({
      preference: 'auto',
      platform: 'win32',
      testEncoder: async () => false,
    });
    expect(fallback).toMatchObject({ backend: 'cpu', codec: 'libx264', hardwareAccelerated: false });
  });

  it('fails closed when an explicit GPU backend is unavailable and skips probing for cpu', async () => {
    let called = false;
    const cpu = await probeVideoEncoder({
      preference: 'cpu',
      testEncoder: async () => { called = true; return true; },
    });
    expect(called).toBe(false);
    expect(cpu).toMatchObject({ backend: 'cpu', codec: 'libx264', hardwareAccelerated: false });

    await expect(probeVideoEncoder({
      preference: 'nvenc',
      testEncoder: async () => false,
    })).rejects.toThrow(/h264_nvenc/);
  });
});
