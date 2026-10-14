import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { NarrationSynthesizer, NarrationVoice, SourceMediaProbe } from '@ancs/contracts';
import { MEDIA_CHILD_ENV, childProcessEnv } from './child-env.js';

/**
 * V6-5 讲述配音的语音合成（Worker）。两种引擎，同一个输出形状：
 *
 * - flite：FFmpeg 内置的 libflite 本地语音（英文，无需密钥，音质基础）。用于没有供应商时把讲述流程跑通、
 *   以及本地验证；它是真实的语音合成（不是测试替身），但只会说英文。
 * - process：部署方接入的语音合成子进程（任意供应商）。协议：每句启动一次，stdin 写一行 JSON
 *   `{"text","voice","speed"}`，stdout 输出 FFmpeg 可解码的音频（WAV/MP3/……），退出码 0。
 *
 * 逐句合成后统一转成 24 kHz 单声道 16 位 PCM，句间留 0.25 s 停顿，在内存里拼成一个 WAV：
 * 每句在音频里的起止位置是精确的（字幕按句出现）。最后用真实探测确认产物可解码。
 */

const SAMPLE_RATE = 24_000;
const PAUSE_MS = 250;
const BYTES_PER_SAMPLE = 2;

export const FLITE_VOICES: readonly NarrationVoice[] = [
  { id: 'flite-slt', name: 'SLT', languages: ['en'], description: 'US English, female, clear. Basic local voice (flite), robotic but intelligible.' },
  { id: 'flite-rms', name: 'RMS', languages: ['en'], description: 'US English, male. Basic local voice (flite).' },
  { id: 'flite-awb', name: 'AWB', languages: ['en'], description: 'Scottish English, male. Basic local voice (flite).' },
  { id: 'flite-kal16', name: 'KAL', languages: ['en'], description: 'US English, male, 16 kHz. Basic local voice (flite).' },
];

interface RunResult { stdout: Buffer; stderr: string }

function run(command: string, args: readonly string[], options: { input?: Buffer | string; timeoutMs: number; maxOutputBytes: number; env: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: options.env });
    const stdout: Buffer[] = [];
    let stderr = '';
    let bytes = 0;
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error !== null) { child.kill('SIGKILL'); reject(error); return; }
      resolve({ stdout: Buffer.concat(stdout), stderr });
    };
    const timer = setTimeout(() => finish(new Error(`${path.basename(command)} timed out`)), options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > options.maxOutputBytes) finish(new Error(`${path.basename(command)} output is too large`));
      else stdout.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 4_000) stderr += chunk.toString('utf8'); });
    child.on('error', (error) => finish(new Error(`${path.basename(command)} could not start: ${error.message}`)));
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(`${path.basename(command)} exited with ${String(code)}: ${stderr.trim().split('\n').slice(-2).join(' ').slice(0, 300)}`));
      else finish(null);
    });
    child.stdin.on('error', () => undefined);
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

/** 44 字节 WAV 头 + PCM（单声道 16 位）。 */
export function wavFromPcm(pcm: Buffer, sampleRate = SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcm]);
}

/** atempo 只接受 0.5–2（本工具语速 0.7–1.4，单级即可）。 */
const tempoFilter = (speed: number): string => `atempo=${Math.min(2, Math.max(0.5, speed)).toFixed(3)}`;

interface SynthesizerCore {
  engine: string;
  voices: readonly NarrationVoice[];
  /** 合成一句，返回 24 kHz 单声道 s16le PCM */
  sentencePcm(input: { text: string; voice: string; speed: number; workDir: string; index: number }): Promise<Buffer>;
}

function assemble(core: SynthesizerCore, options: { probe: SourceMediaProbe }): NarrationSynthesizer {
  return {
    implementation: 'REAL',
    engine: core.engine,
    voices: () => core.voices,
    async synthesize(request) {
      if (!core.voices.some((voice) => voice.id === request.voice)) throw new Error(`unknown voice ${request.voice}`);
      const workDir = await mkdtemp(path.join(os.tmpdir(), 'ancs-narration-'));
      try {
        const pause = Buffer.alloc(Math.round((PAUSE_MS / 1000) * SAMPLE_RATE) * BYTES_PER_SAMPLE);
        const chunks: Buffer[] = [];
        const sentences: { startMs: number; endMs: number }[] = [];
        let samples = 0;
        for (const [index, text] of request.sentences.entries()) {
          const pcm = await core.sentencePcm({ text, voice: request.voice, speed: request.speed, workDir, index });
          const even = pcm.byteLength % 2 === 0 ? pcm : pcm.subarray(0, pcm.byteLength - 1);
          if (even.byteLength === 0) throw new Error(`the engine returned no audio for sentence ${String(index + 1)}`);
          if (index > 0) { chunks.push(pause); samples += pause.byteLength / BYTES_PER_SAMPLE; }
          const startMs = (samples * 1000) / SAMPLE_RATE;
          chunks.push(even);
          samples += even.byteLength / BYTES_PER_SAMPLE;
          sentences.push({ startMs, endMs: (samples * 1000) / SAMPLE_RATE });
        }
        const audio = wavFromPcm(Buffer.concat(chunks));
        const file = path.join(workDir, 'narration.wav');
        await writeFile(file, audio);
        const probe = await options.probe.probe({ filePath: file, declaredMimeType: 'audio/wav' });
        return { audio: new Uint8Array(audio), mimeType: 'audio/wav', probe, durationMs: (samples * 1000) / SAMPLE_RATE, sentences };
      } finally {
        await rm(workDir, { recursive: true, force: true });
      }
    },
  };
}

/** FFmpeg 把任意音频（文件或 stdin）转成 24 kHz 单声道 s16le PCM，可选变速。 */
function toPcmArgs(input: string, speed: number): string[] {
  const filters = [...(Math.abs(speed - 1) < 0.001 ? [] : [tempoFilter(speed)]), `aresample=${String(SAMPLE_RATE)}`];
  return ['-nostdin', '-v', 'error', ...(input === 'pipe:0' ? [] : ['-f', 'lavfi']), '-i', input, '-af', filters.join(','), '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-acodec', 'pcm_s16le', 'pipe:1'];
}

/** flite（FFmpeg libflite）：英文本地语音。文本经临时文件传入（不拼进滤镜参数，免转义问题）。 */
export function createFliteNarrationSynthesizer(options: { probe: SourceMediaProbe; ffmpegPath?: string; timeoutMs?: number }): NarrationSynthesizer {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? 60_000;
  return assemble({
    engine: 'flite',
    voices: FLITE_VOICES,
    async sentencePcm({ text, voice, speed, workDir, index }) {
      const textFile = path.join(workDir, `sentence-${String(index)}.txt`);
      await writeFile(textFile, text, 'utf8');
      // 滤镜参数里的路径：工作目录在系统临时目录下，只含安全字符；仍按滤镜语法转义冒号与反斜杠
      const escaped = textFile.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
      const result = await run(ffmpeg, toPcmArgs(`flite=textfile='${escaped}':voice=${voice.replace(/^flite-/, '')}`, speed), {
        timeoutMs, maxOutputBytes: 200 * 1024 * 1024, env: childProcessEnv(process.env, MEDIA_CHILD_ENV),
      });
      return result.stdout;
    },
  }, options);
}

/**
 * 供应商 HTTP 接口的语音合成（例如 Fish Audio）：`fetchAudio` 返回一句话的音频（任何 FFmpeg 能解码的格式），
 * 这里统一转成 24 kHz 单声道 PCM 并逐句拼接（句界精确）。语速交给供应商（`applySpeed` 为 false 时不再变速）。
 */
export function createHttpNarrationSynthesizer(options: {
  engine: string; voices: readonly NarrationVoice[]; probe: SourceMediaProbe; ffmpegPath?: string; timeoutMs?: number; applySpeed?: boolean;
  fetchAudio(input: { text: string; voice: string; speed: number }): Promise<Uint8Array>;
}): NarrationSynthesizer {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? 120_000;
  return assemble({
    engine: options.engine,
    voices: options.voices,
    async sentencePcm({ text, voice, speed }) {
      const audio = await options.fetchAudio({ text, voice, speed });
      if (audio.byteLength === 0) throw new Error('the speech service returned no audio');
      const pcm = await run(ffmpeg, toPcmArgs('pipe:0', options.applySpeed === true ? speed : 1), { input: Buffer.from(audio), timeoutMs, maxOutputBytes: 200 * 1024 * 1024, env: childProcessEnv(process.env, MEDIA_CHILD_ENV) });
      return pcm.stdout;
    },
  }, options);
}

/**
 * 部署方接入的语音合成子进程（任意供应商）。每句一次：stdin 一行 JSON `{"text","voice","speed"}`，stdout 是音频。
 * 子进程是部署方配置的可信程序（可能需要自己的供应商密钥），与 ASR 子进程同样继承 Worker 环境；不运行 AI 写的代码。
 */
export function createProcessNarrationSynthesizer(options: {
  executable: string; args?: string[]; voices: readonly NarrationVoice[]; probe: SourceMediaProbe; ffmpegPath?: string; timeoutMs?: number; maxOutputBytes?: number;
}): NarrationSynthesizer {
  const ffmpeg = options.ffmpegPath ?? 'ffmpeg';
  const timeoutMs = options.timeoutMs ?? 120_000;
  const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
  return assemble({
    engine: `process:${path.basename(options.executable)}`,
    voices: options.voices,
    async sentencePcm({ text, voice, speed }) {
      const audio = await run(options.executable, options.args ?? [], { input: `${JSON.stringify({ text, voice, speed })}\n`, timeoutMs, maxOutputBytes, env: process.env });
      if (audio.stdout.byteLength === 0) throw new Error('the speech process returned no audio');
      // 语速交给供应商处理（已在 JSON 里）；这里只做格式统一
      const pcm = await run(ffmpeg, toPcmArgs('pipe:0', 1), { input: audio.stdout, timeoutMs, maxOutputBytes: 200 * 1024 * 1024, env: childProcessEnv(process.env, MEDIA_CHILD_ENV) });
      return pcm.stdout;
    },
  }, options);
}
