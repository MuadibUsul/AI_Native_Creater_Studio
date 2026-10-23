import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import { EFFECT_TEMPLATES } from '@ancs/domain';
import { resolveBrowserExecutable } from '../executor.ts';
import { LANDSCAPE_IDS } from './landscape-ids.ts';

/**
 * 宣传片渲染 CLI（离线工具，不进产品流水线）：
 *   node apps/render-worker/src/promo/run-promo.ts --out <dir> [--clips] [--stills] [--trailer] [--frames 0,120,...]
 * - --clips：四段原创风光素材 → <out>/clips/<id>.mp4（给 capture-ui 当用户素材上传）；
 * - --stills：每段素材 + 预告片指定帧的静帧 → <out>/stills/（目检用）；
 * - --trailer：预告片（无声）→ <out>/trailer-silent.mp4；配乐另由 scripts/promo/soundtrack.mjs 生成后用 FFmpeg 合成。
 * 预告片里的特效直接运行产品特效模板库（EFFECT_TEMPLATES）的代码；界面画面来自 <out>/public 下的真实截图（capture.json 为清单）。
 */
const { values } = parseArgs({ options: {
  out: { type: 'string' }, clips: { type: 'boolean' }, stills: { type: 'boolean' }, trailer: { type: 'boolean' }, frames: { type: 'string' },
  concurrency: { type: 'string' },
} });
if (values.out === undefined) throw new Error('--out <dir> is required');
const out = path.resolve(values.out);
const publicDir = path.join(out, 'public');
await mkdir(publicDir, { recursive: true });
const browser = resolveBrowserExecutable();
const browserOption = browser === undefined ? {} : { browserExecutable: browser };
const serveUrl = await bundle({ entryPoint: path.join(import.meta.dirname, 'entry.ts'), publicDir, outDir: path.join(out, '.bundle') });
const templates = Object.fromEntries(EFFECT_TEMPLATES.map((template) => [template.id, template.code]));
// 真实界面截图的清单（scripts/promo/capture-ui.mjs 写入）：文件名、连拍序列与元素位置；没有时预告片用占位画面
const capture = await readFile(path.join(publicDir, 'capture.json'), 'utf8').then((text) => JSON.parse(text) as unknown, () => null);
const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);

if (values.clips === true || values.stills === true) {
  for (const scene of LANDSCAPE_IDS) {
    const inputProps = { scene };
    const composition = await selectComposition({ serveUrl, id: 'PromoClip', inputProps, ...browserOption });
    if (values.stills === true) {
      await mkdir(path.join(out, 'stills'), { recursive: true });
      await renderStill({ serveUrl, composition, inputProps, frame: 90, output: path.join(out, 'stills', `clip-${scene}.png`), overwrite: true, ...browserOption });
    }
    if (values.clips === true) {
      await mkdir(path.join(out, 'clips'), { recursive: true });
      await renderMedia({ serveUrl, composition, inputProps, codec: 'h264', crf: 18, outputLocation: path.join(out, 'clips', `${scene}.mp4`), overwrite: true, ...browserOption, ...(concurrency === undefined ? {} : { concurrency }) });
    }
    console.log(JSON.stringify({ clip: scene }));
  }
}

if (values.trailer === true || values.frames !== undefined) {
  const inputProps = { templates, capture };
  const composition = await selectComposition({ serveUrl, id: 'LaunchTrailer', inputProps, ...browserOption });
  for (const frame of (values.frames ?? '').split(',').filter(Boolean).map(Number)) {
    await mkdir(path.join(out, 'stills'), { recursive: true });
    await renderStill({ serveUrl, composition, inputProps, frame, output: path.join(out, 'stills', `trailer-${String(frame).padStart(4, '0')}.png`), overwrite: true, ...browserOption });
    console.log(JSON.stringify({ still: frame }));
  }
  if (values.trailer === true) {
    const started = Date.now();
    await renderMedia({
      serveUrl, composition, inputProps, codec: 'h264', crf: 16, x264Preset: 'slow', pixelFormat: 'yuv420p', muted: true,
      outputLocation: path.join(out, 'trailer-silent.mp4'), overwrite: true, ...browserOption, ...(concurrency === undefined ? {} : { concurrency }),
      onProgress: ({ progress }) => { if (Math.round(progress * 100) % 10 === 0) process.stdout.write(`\r${String(Math.round(progress * 100))}%`); },
    });
    console.log(JSON.stringify({ trailer: path.join(out, 'trailer-silent.mp4'), renderMs: Date.now() - started }));
  }
}
