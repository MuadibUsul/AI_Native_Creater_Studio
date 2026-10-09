import { spawn } from 'node:child_process';
import { generatedMediaTranscriptSchema, type SpeechRecognitionAdapter } from '@ancs/contracts';

export function createProcessSpeechRecognitionAdapter(options: { executable: string; args?: string[]; timeoutMs?: number; maxOutputBytes?: number }): SpeechRecognitionAdapter {
  const timeoutMs = options.timeoutMs ?? 30 * 60 * 1000;
  const maxOutputBytes = options.maxOutputBytes ?? 16 * 1024 * 1024;
  return {
    kind: 'process-asr',
    transcribe({ sourcePath }) {
      return new Promise((resolve, reject) => {
        const child = spawn(options.executable, [...(options.args ?? []), sourcePath], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const stdout: Buffer[] = [];
        let outputBytes = 0;
        let settled = false;
        const finishError = (message: string): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          child.kill('SIGKILL');
          reject(new Error(message));
        };
        const timer = setTimeout(() => finishError('ASR_TIMEOUT'), timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) finishError('ASR_OUTPUT_LIMIT');
          else stdout.push(chunk);
        });
        child.stderr.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) finishError('ASR_OUTPUT_LIMIT');
        });
        child.on('error', () => finishError('ASR_PROCESS_START_FAILED'));
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (code !== 0) return reject(new Error('ASR_PROCESS_FAILED'));
          try { resolve(generatedMediaTranscriptSchema.parse(JSON.parse(Buffer.concat(stdout).toString('utf8')))); }
          catch { reject(new Error('ASR_INVALID_RESPONSE')); }
        });
      });
    },
  };
}
