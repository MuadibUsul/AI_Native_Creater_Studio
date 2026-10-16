import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findEffectTemplate } from '@ancs/domain';
import { resolveBrowserExecutable } from './executor.ts';
import { renderEffectLayer } from './effects/render-effect.ts';

/**
 * V6-3 特效图层真实渲染（Remotion 无头浏览器 + FFmpeg，非 mock）：
 * - 输出 PNG 编码的 QuickTime，像素格式 rgba：没画到的地方完全透明，画到的地方不透明；
 * - 特效代码运行的页面里，浏览器能力（fetch / document / window / localStorage …）被遮蔽为 undefined；
 * - 同一代码、参数、种子 → 逐帧相同（确定性随机数）。
 */

let workDir: string;
const browserExecutable = resolveBrowserExecutable();

beforeAll(async () => { workDir = await mkdtemp(path.join(os.tmpdir(), 'ancs-effect-render-')); });
afterAll(async () => { await rm(workDir, { recursive: true, force: true }); });

/** 读一帧的 RGBA 像素（FFmpeg 解码，保留 alpha） */
function frameRgba(file: string, frame: number, width: number, height: number): Buffer {
  const raw = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-i', file, '-vf', `select=eq(n\\,${String(frame)})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-']);
  expect(raw.byteLength).toBe(width * height * 4);
  return raw;
}
const pixel = (raw: Buffer, width: number, x: number, y: number) => [...raw.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

const PROBE_CODE = `
registerMotion({
  name: 'Probe',
  component: function Probe() {
    const sealed = typeof fetch === 'undefined' && typeof document === 'undefined' && typeof window === 'undefined' && typeof localStorage === 'undefined' && typeof XMLHttpRequest === 'undefined';
    return React.createElement(AbsoluteFill, null,
      React.createElement('div', { style: { position: 'absolute', left: '25%', top: '25%', width: '50%', height: '50%', background: sealed ? '#ff0000' : '#00ff00' } }));
  },
});
`;

describe('特效图层渲染（真实浏览器 + FFmpeg）', () => {
  it('透明背景 + 浏览器能力被遮蔽：中间是红块（遮蔽生效），四角完全透明', { timeout: 240_000 }, async () => {
    const result = await renderEffectLayer({ code: PROBE_CODE, params: {}, seed: '1', width: 160, height: 90, fps: 30, durationInFrames: 6 }, { outDir: path.join(workDir, 'probe'), browserExecutable });
    const streams = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,pix_fmt,width,height,nb_frames', '-of', 'csv=p=0', result.file]).toString().trim();
    expect(streams).toBe('png,160,90,rgba,6');
    const raw = frameRgba(result.file, 3, 160, 90);
    expect(pixel(raw, 160, 2, 2)[3]).toBe(0);
    expect(pixel(raw, 160, 157, 87)[3]).toBe(0);
    expect(pixel(raw, 160, 80, 45)).toEqual([255, 0, 0, 255]);
  });

  it('模板（闪光点）：同一代码/参数/种子逐帧确定；有透明区也有画到的像素', { timeout: 240_000 }, async () => {
    const template = findEffectTemplate('sparkles')!;
    const request = { code: template.code, params: { color: '#ffffff', count: 40, size: 1.5 }, seed: 'demo', width: 160, height: 90, fps: 30, durationInFrames: 12 };
    const first = await renderEffectLayer(request, { outDir: path.join(workDir, 'a'), browserExecutable });
    const second = await renderEffectLayer(request, { outDir: path.join(workDir, 'b'), browserExecutable });
    const a = frameRgba(first.file, 6, 160, 90);
    expect(a.equals(frameRgba(second.file, 6, 160, 90))).toBe(true);
    const alphas = [...Array(160 * 90).keys()].map((index) => a[index * 4 + 3]!);
    expect(alphas.filter((alpha) => alpha === 0).length).toBeGreaterThan(160 * 90 * 0.5);
    expect(alphas.some((alpha) => alpha > 200)).toBe(true);
  });
});
