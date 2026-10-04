import { existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { parseMedia } from '@remotion/media-parser';
import { nodeReader } from '@remotion/media-parser/node';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * P00-03 渲染兼容性验证（真实渲染，非 mock）：
 * - 预览：渲染两个时间点的静帧 PNG；
 * - 成片：渲染 3 秒 1920×1080 30fps MP4，并解析元数据校验。
 * 产物写入 .artifacts/p00-03/（gitignored），路径记录在 docs/verification/P00-03.md。
 * 本机已有 Chrome 时直接复用（REMOTION_BROWSER_EXECUTABLE 可覆盖）；否则由 Remotion 自动下载 Headless Shell。
 */

const here = import.meta.dirname;
const entryPoint = path.resolve(here, 'index.ts');
const outDir = path.resolve(here, '../../../.artifacts/p00-03');
const COMPOSITION_ID = 'BigNumberScene';

function resolveBrowserExecutable(): string | undefined {
  const fromEnv = process.env['REMOTION_BROWSER_EXECUTABLE'];
  if (fromEnv) return fromEnv;
  if (process.platform === 'win32') {
    const candidates = [
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

describe('Remotion 服务端渲染（标准 Scene：BigNumberScene）', () => {
  const browserExecutable = resolveBrowserExecutable();
  let serveUrl: string;

  beforeAll(async () => {
    await mkdir(outDir, { recursive: true });
    serveUrl = await bundle({ entryPoint });
  }, 300_000);

  it('生成预览静帧 PNG（frame 0 与 frame 45）', async () => {
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, browserExecutable });
    for (const frame of [0, 45]) {
      const output = path.join(outDir, `preview-frame-${String(frame)}.png`);
      await renderStill({ composition, serveUrl, output, frame, imageFormat: 'png', browserExecutable });
      const info = await stat(output);
      expect(info.size, `静帧 ${output} 应大于 10KB`).toBeGreaterThan(10_000);
      console.log(`[render] 预览静帧：${output}（${String(info.size)} bytes）`);
    }
  }, 600_000);

  it('渲染 MP4 并通过元数据校验（1920×1080 / 3s / 30fps）', async () => {
    const composition = await selectComposition({ serveUrl, id: COMPOSITION_ID, browserExecutable });
    const output = path.join(outDir, 'big-number-scene.mp4');
    await renderMedia({ composition, serveUrl, codec: 'h264', outputLocation: output, browserExecutable });

    const info = await stat(output);
    expect(info.size, 'MP4 应大于 50KB').toBeGreaterThan(50_000);
    console.log(`[render] 成片：${output}（${String(info.size)} bytes）`);

    const media = await parseMedia({
      src: output,
      reader: nodeReader,
      // 内部开发用途；商业上线前的 Remotion 授权核验见计划 P09-06（REQ-47-01）
      acknowledgeRemotionLicense: true,
      fields: { dimensions: true, durationInSeconds: true, fps: true },
    });
    expect(media.dimensions).toEqual({ width: 1920, height: 1080 });
    expect(media.durationInSeconds).toBeGreaterThan(2.8);
    expect(media.durationInSeconds).toBeLessThan(3.2);
    expect(media.fps).toBe(30);
  }, 600_000);
});
