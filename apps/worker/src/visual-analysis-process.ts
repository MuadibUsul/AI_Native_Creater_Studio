import { spawn } from 'node:child_process';
import { generatedMediaVisualAnalysisSchema, type MediaVisualAnalysisAdapter } from '@ancs/contracts';

export function createProcessMediaVisualAnalysisAdapter(options: { executable: string; args?: string[]; timeoutMs?: number; maxOutputBytes?: number }): MediaVisualAnalysisAdapter {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  return {
    kind: 'process-visual-analysis',
    analyze({ sourcePath }) {
      return new Promise((resolve, reject) => {
        const child = spawn(options.executable, [...(options.args ?? []), sourcePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const stdout: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const fail = (message: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(new Error(message));
        };
        const timer = setTimeout(() => fail('VISUAL_ANALYSIS_TIMEOUT'), timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) fail('VISUAL_ANALYSIS_OUTPUT_LIMIT');
          else stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) fail('VISUAL_ANALYSIS_OUTPUT_LIMIT');
        });
        child.on('error', () => fail('VISUAL_ANALYSIS_PROCESS_START_FAILED'));
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) return reject(new Error('VISUAL_ANALYSIS_PROCESS_FAILED'));
          try { resolve(generatedMediaVisualAnalysisSchema.parse(JSON.parse(Buffer.concat(stdout).toString('utf8')))); }
          catch { reject(new Error('VISUAL_ANALYSIS_INVALID_RESPONSE')); }
        });
      });
    },
  };
}
