import { probeMediaFile } from './probe.ts';

/**
 * 媒体探测 CLI（P07-05）：`node apps/render-worker/src/run-probe.ts --file <path>`
 * stdin/stdout 协议：stdout 一行 JSON（MediaProbeResult）；失败退出码 1 + stderr 摘要。
 * 生产装配（apps/worker 的进程隔离媒体探测）以子进程方式调用。
 */

function argumentValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0) return null;
  return process.argv[index + 1] ?? null;
}

const file = argumentValue('--file');
if (file === null) {
  console.error(JSON.stringify({ ok: false, error: 'MISSING_FILE', usage: 'run-probe.ts --file <path>' }));
  process.exit(1);
}

try {
  const result = await probeMediaFile(file);
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
