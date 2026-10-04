import { motionValidationReportSchema } from '@ancs/contracts';
import { validateMotion } from './validator.ts';

/**
 * Motion 验证 CLI（P07-02）：`node apps/motion-worker/src/run-validate.ts`
 *
 * 协议（与 RenderExecutor 的进程隔离同一范式）：
 * - stdin：JSON `{ code, name, fixture, sampleFrames }`；
 * - stdout：一行 JSON（MotionValidationReport；解析失败/内部异常 → 退出码 1 + stderr 摘要）。
 *
 * 生产装配（apps/worker 的进程验证器）以子进程方式调用——验证崩溃不拖垮 Worker。
 */

const readStdin = async (): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

try {
  const raw = await readStdin();
  const parsed = JSON.parse(raw) as { code?: unknown; name?: unknown; fixture?: unknown; sampleFrames?: unknown };
  if (typeof parsed.code !== 'string' || typeof parsed.name !== 'string' || parsed.fixture === undefined) {
    console.error(JSON.stringify({ ok: false, error: 'INVALID_INPUT', message: '需要 { code, name, fixture, sampleFrames }' }));
    process.exit(1);
  }
  const report = await validateMotion({
    code: parsed.code,
    name: parsed.name,
    fixture: parsed.fixture as never,
    sampleFrames: Array.isArray(parsed.sampleFrames) ? (parsed.sampleFrames as number[]) : [0],
  });
  console.log(JSON.stringify(motionValidationReportSchema.parse(report)));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
}
