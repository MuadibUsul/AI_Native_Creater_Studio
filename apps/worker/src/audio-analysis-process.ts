import { spawn } from 'node:child_process';
import { generatedMediaAudioAnalysisSchema, type MediaAudioAnalysisAdapter } from '@ancs/contracts';

export function createProcessMediaAudioAnalysisAdapter(options: { executable: string; args?: string[]; timeoutMs?: number; maxOutputBytes?: number }): MediaAudioAnalysisAdapter {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes ?? 32 * 1024 * 1024;
  return {
    kind: 'process-audio-analysis',
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
        const timer = setTimeout(() => fail('AUDIO_ANALYSIS_TIMEOUT'), timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) fail('AUDIO_ANALYSIS_OUTPUT_LIMIT');
          else stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) fail('AUDIO_ANALYSIS_OUTPUT_LIMIT');
        });
        child.on('error', () => fail('AUDIO_ANALYSIS_PROCESS_START_FAILED'));
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) return reject(new Error('AUDIO_ANALYSIS_PROCESS_FAILED'));
          try { resolve(generatedMediaAudioAnalysisSchema.parse(JSON.parse(Buffer.concat(stdout).toString('utf8')))); }
          catch { reject(new Error('AUDIO_ANALYSIS_INVALID_RESPONSE')); }
        });
      });
    },
  };
}
