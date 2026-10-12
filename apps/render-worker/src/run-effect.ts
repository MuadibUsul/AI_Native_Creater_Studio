import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBrowserExecutable } from './executor.ts';
import { renderEffectLayer } from './effects/render-effect.ts';

/**
 * 特效图层渲染 CLI（V6-3）：`node apps/render-worker/src/run-effect.ts --workdir <dir>`
 * 输入 `<workdir>/effect.json`（EffectRenderRequest）；输出 `<workdir>/out/{layer.mov,poster.png,result.json}`。
 * 退出码 0 成功；1 失败（stderr 结构化错误，不含代码以外的任何环境信息）。
 */
const index = process.argv.indexOf('--workdir');
const workDir = index < 0 ? null : process.argv[index + 1] ?? null;
if (workDir === null) {
  console.error(JSON.stringify({ ok: false, error: 'MISSING_WORKDIR' }));
  process.exit(1);
}
try {
  const request = JSON.parse(await readFile(path.join(workDir, 'effect.json'), 'utf8'));
  const result = await renderEffectLayer(request, { outDir: path.join(workDir, 'out'), browserExecutable: resolveBrowserExecutable(), ffmpegPath: process.env['ANCS_FFMPEG_PATH'] });
  await writeFile(path.join(workDir, 'out', 'result.json'), JSON.stringify({ ok: true, ...result }));
  console.log(JSON.stringify({ ok: true, renderMs: result.renderMs }));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: 'EFFECT_RENDER_FAILED', message: (error instanceof Error ? error.message : String(error)).slice(0, 500) }));
  process.exit(1);
}
