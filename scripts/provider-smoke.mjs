#!/usr/bin/env node
// 真实供应商冒烟（Fish Audio / HeyGen）：确认密钥、网络与协议都通，再做全链路评测。
//
// 默认只做两件很便宜的事：Fish Audio 合成一句话（按字节计费，约几十字节）；读 HeyGen 剩余额度（不计费）。
// 加 --heygen-generate <照片.png|jpg> <声音样本.wav|mp3> 才会真的生成一段数字人视频（消耗 HeyGen 额度，约 2 秒）。
//
// 密钥只从环境变量读（FISH_AUDIO_API_KEY / HEYGEN_API_KEY），不打印、不写文件。需要先构建：pnpm build。
// 在需要经代理出网的环境里加 NODE_USE_ENV_PROXY=1（Node 的 fetch 才会走 HTTPS_PROXY）。
//
// 用法：
//   FISH_AUDIO_API_KEY=… HEYGEN_API_KEY=… NODE_USE_ENV_PROXY=1 node scripts/provider-smoke.mjs [--fish-voice <Fish 声音 id>] [--out <目录>]
//   … node scripts/provider-smoke.mjs --heygen-generate me.png my-voice.wav
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createFishAudioClient } from '../apps/worker/dist/fish-audio.js';
import { createHeyGenAvatarProvider, createHeyGenClient } from '../apps/worker/dist/heygen.js';

const args = process.argv.slice(2);
const option = (name) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
const out = resolve(option('--out') ?? 'provider-smoke-output');
await mkdir(out, { recursive: true });
const report = [];
const seconds = (file) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());

if (process.env.FISH_AUDIO_API_KEY) {
  const fish = createFishAudioClient({ apiKey: process.env.FISH_AUDIO_API_KEY, ...(process.env.ANCS_FISH_AUDIO_MODEL ? { model: process.env.ANCS_FISH_AUDIO_MODEL } : {}) });
  const started = Date.now();
  try {
    const audio = await fish.tts({ text: '你好，这是一句测试。Hello, this is a test.', referenceId: option('--fish-voice') ?? null, format: 'wav' });
    const file = join(out, 'fish-tts.wav');
    await writeFile(file, audio);
    report.push(`Fish Audio TTS OK：${String(audio.byteLength)} 字节，${seconds(file).toFixed(2)} 秒音频，耗时 ${String(Date.now() - started)} ms → ${file}`);
  } catch (error) {
    report.push(`Fish Audio TTS 失败：${error.message}`);
    process.exitCode = 1;
  }
} else {
  report.push('Fish Audio：未设置 FISH_AUDIO_API_KEY，跳过');
}

if (process.env.HEYGEN_API_KEY) {
  try {
    const response = await fetch('https://api.heygen.com/v2/user/remaining_quota', { headers: { 'x-api-key': process.env.HEYGEN_API_KEY } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`HTTP ${String(response.status)}: ${JSON.stringify(body.error ?? body).slice(0, 200)}`);
    report.push(`HeyGen 额度读取 OK：${JSON.stringify(body.data ?? body).slice(0, 200)}`);
  } catch (error) {
    report.push(`HeyGen 额度读取失败：${error.message}`);
    process.exitCode = 1;
  }
  const generate = args.indexOf('--heygen-generate');
  if (generate !== -1 && process.env.FISH_AUDIO_API_KEY) {
    const [photo, voice] = [args[generate + 1], args[generate + 2]];
    const provider = createHeyGenAvatarProvider({ heygen: createHeyGenClient({ apiKey: process.env.HEYGEN_API_KEY }), fish: createFishAudioClient({ apiKey: process.env.FISH_AUDIO_API_KEY }) });
    const outputPath = join(out, 'heygen-avatar.mp4');
    const started = Date.now();
    try {
      const result = await provider.generate({
        kind: 'AVATAR_CLIP', providerId: 'heygen', prompt: null, script: 'Hello, this is my digital human.', language: 'en', seconds: 2.5, maxSeconds: 5,
        width: 1280, height: 720, fps: 30, outputPath, likenessPath: resolve(photo), voicePath: resolve(voice), sourcePath: null, region: null,
      });
      report.push(`HeyGen 数字人 OK：任务 ${result.providerJobId}，${seconds(outputPath).toFixed(2)} 秒，耗时 ${String(Math.round((Date.now() - started) / 1000))} s → ${outputPath}`);
    } catch (error) {
      report.push(`HeyGen 数字人失败（${error.outcome ?? 'ERROR'}）：${error.message}`);
      process.exitCode = 1;
    }
  }
} else {
  report.push('HeyGen：未设置 HEYGEN_API_KEY，跳过');
}

for (const line of report) console.log(line);
