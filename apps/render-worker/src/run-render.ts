import { readFile } from 'node:fs/promises';
import path from 'node:path';
// Node 直跑（类型剥离）要求显式 .ts 扩展名（与 apps/motion-worker 的 sandbox-child 同一约定）
import { executeRenderSpec } from './executor.ts';

/**
 * Final 合成 CLI（P07-04）：`node apps/render-worker/src/run-render.ts --workdir <dir>`
 *
 * 约定（与 RenderExecutor 契约一致）：
 * - 输入：`<workdir>/spec.json`（编排层写入）+ `<workdir>/assets/`（冻结素材）；
 * - 输出：`<workdir>/out/{final.mp4,subtitles.srt,subtitles.vtt,manifest.json,result.json}`；
 * - 退出码：0 = 成功（stdout 打印回执摘要 JSON）；1 = 失败（stderr 打印结构化错误）。
 *
 * 生产装配（apps/worker 的进程执行器）以子进程方式调用本文件——渲染与 Worker 进程隔离。
 */

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

const workDir = argumentValue('--workdir');
if (workDir === null) {
  console.error(JSON.stringify({ ok: false, error: 'MISSING_WORKDIR', usage: 'run-render.ts --workdir <dir>' }));
  process.exit(1);
}

try {
  const specRaw = await readFile(path.join(workDir, 'spec.json'), 'utf8');
  const result = await executeRenderSpec({ spec: JSON.parse(specRaw), workDir });
  console.log(
    JSON.stringify({
      ok: true,
      renderId: result.renderId,
      manifestHash: result.manifestHash,
      durationMs: result.durationMs,
      durationInFrames: result.durationInFrames,
      format: result.format,
      files: result.files.map((file) => ({ kind: file.kind, fileName: file.fileName, sizeBytes: file.sizeBytes })),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 6).join('\n') : null,
    }),
  );
  process.exit(1);
}
