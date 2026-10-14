#!/usr/bin/env node
// 真实供应商冒烟（Fish Audio / HeyGen / Google Gemini）：确认密钥、网络与协议都通，再做全链路评测。
//
// 默认只做很便宜的事：Fish Audio 合成一句话（按字节计费，约几十字节）；读 HeyGen 剩余额度（不计费）；
// Gemini 列出可用模型（不计费）+ 导演模型用一个工具回一句话 + TTS 合成一句话（各一次小请求）。
// 加 --heygen-generate <照片.png|jpg> <声音样本.wav|mp3> 才会真的生成一段数字人视频（消耗 HeyGen 额度，约 2 秒）。
// 加 --veo-generate 才会真的用 Veo 生成一段 4 秒镜头（按秒计费；模型取 ANCS_VEO_OFFER_JSON 的 model，缺省 veo-3.1-fast-generate-preview）。
// 加 --seedance-generate [模型 id] 才会真的用火山方舟 Seedance 生成一段镜头（计费；时长取 ANCS_SEEDANCE_OFFER_JSON 最短一档，缺省 5 秒；
//   模型取参数，其次 ANCS_SEEDANCE_OFFER_JSON 的 model）。方舟没有免费的探测接口，不加参数时不访问方舟。
//
// 密钥只从环境变量读（FISH_AUDIO_API_KEY / HEYGEN_API_KEY / GEMINI_API_KEY / ARK_API_KEY），不打印、不写文件。需要先构建：pnpm build。
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
import { createVeoGenerationProvider } from '../apps/worker/dist/gemini-media.js';
import { createSeedanceGenerationProvider } from '../apps/worker/dist/ark-media.js';
import { createSeedance } from '../packages/providers/ark/dist/index.js';
import { GeminiAgentModel, createGeminiHttp, createGeminiSpeech, createGeminiVeo } from '../packages/providers/gemini/dist/index.js';

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

if (process.env.GEMINI_API_KEY) {
  const apiKey = process.env.GEMINI_API_KEY;
  const step = async (name, run) => {
    const started = Date.now();
    try {
      report.push(`Gemini ${name} OK：${await run()}，耗时 ${String(Date.now() - started)} ms`);
    } catch (error) {
      report.push(`Gemini ${name} 失败：${error.message}`);
      process.exitCode = 1;
    }
  };
  await step('模型列表', async () => {
    const listed = await createGeminiHttp({ apiKey }).getJson('/models?pageSize=200');
    const names = (listed.models ?? []).map((model) => String(model.name).replace(/^models\//, ''));
    return `${String(names.length)} 个模型（含 ${names.filter((name) => /tts|veo/.test(name)).slice(0, 8).join('、')}）`;
  });
  const agentModel = process.env.ANCS_AGENT_MODEL ?? 'gemini-flash-latest';
  await step(`导演模型 ${agentModel}`, async () => {
    const model = new GeminiAgentModel({ apiKey, model: agentModel, maxRetries: 1 });
    const tools = [{ name: 'trim_clip', description: 'Trim a clip to a length in seconds', inputSchema: { type: 'object', properties: { clipId: { type: 'string' }, seconds: { type: 'number' } }, required: ['clipId', 'seconds'], additionalProperties: false } }];
    const response = await model.respond({ system: 'You edit videos with tools.', tools, messages: [{ role: 'user', content: [{ type: 'text', text: 'Trim clip clp_1 to 3 seconds.' }] }], maxOutputTokens: 1024, effort: 'low' });
    const call = response.content.find((block) => block.type === 'tool_use');
    return `${response.model}，${response.stopReason}，工具调用 ${call === undefined ? '无' : `${call.name}(${JSON.stringify(call.input)})`}，用量 ${String(response.usage.inputTokens)}/${String(response.usage.outputTokens)} tokens`;
  });
  const ttsModel = process.env.ANCS_GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-lite-tts';
  await step(`语音合成 ${ttsModel}`, async () => {
    const audio = await createGeminiSpeech({ apiKey, model: ttsModel, maxRetries: 1 }).synthesize({ text: '你好，这是一句测试。Hello, this is a test.', voiceName: 'Kore' });
    const file = join(out, 'gemini-tts.wav');
    await writeFile(file, audio);
    return `${String(audio.byteLength)} 字节，${seconds(file).toFixed(2)} 秒音频 → ${file}`;
  });
  if (args.includes('--veo-generate')) {
    const configured = process.env.ANCS_VEO_OFFER_JSON ? JSON.parse(process.env.ANCS_VEO_OFFER_JSON) : null;
    const offer = configured ?? { kind: 'VIDEO_SHOT', providerId: 'veo', implementation: 'REAL', model: 'veo-3.1-fast-generate-preview', perSecondMicros: { min: 0, max: 1 }, maxSeconds: 8, languages: [], durationOptions: [4, 6, 8] };
    await step(`Veo 生成镜头 ${offer.model}`, async () => {
      const provider = createVeoGenerationProvider({ veo: createGeminiVeo({ apiKey, model: offer.model }), offer });
      const outputPath = join(out, 'veo-shot.mp4');
      const result = await provider.generate({
        kind: 'VIDEO_SHOT', providerId: offer.providerId, prompt: 'A calm mountain lake at dawn, slow aerial push-in, soft mist over the water', script: null, language: null,
        seconds: 4, maxSeconds: 4, width: 1280, height: 720, fps: 30, outputPath, likenessPath: null, voicePath: null, sourcePath: null, region: null,
      });
      return `任务 ${String(result.providerJobId)}，${seconds(outputPath).toFixed(2)} 秒 → ${outputPath}`;
    });
  }
} else {
  report.push('Gemini：未设置 GEMINI_API_KEY，跳过');
}

const seedanceFlag = args.indexOf('--seedance-generate');
if (seedanceFlag !== -1) {
  if (!process.env.ARK_API_KEY) {
    report.push('Seedance：未设置 ARK_API_KEY，跳过');
  } else {
    const configured = process.env.ANCS_SEEDANCE_OFFER_JSON ? JSON.parse(process.env.ANCS_SEEDANCE_OFFER_JSON) : null;
    const argModel = args[seedanceFlag + 1] !== undefined && !args[seedanceFlag + 1].startsWith('--') ? args[seedanceFlag + 1] : undefined;
    const model = argModel ?? configured?.model;
    if (model === undefined) {
      report.push('Seedance：需要模型 id（--seedance-generate <模型 id> 或 ANCS_SEEDANCE_OFFER_JSON），跳过');
      process.exitCode = 1;
    } else {
      const offer = { ...(configured ?? { kind: 'VIDEO_SHOT', providerId: 'seedance', implementation: 'REAL', perSecondMicros: { min: 0, max: 1 }, maxSeconds: 10, languages: [], durationOptions: [5, 10] }), model };
      const clipSeconds = Math.min(...offer.durationOptions);
      const seedance = createSeedance({ apiKey: process.env.ARK_API_KEY, model, ...(process.env.ANCS_ARK_BASE_URL ? { baseUrl: process.env.ANCS_ARK_BASE_URL } : {}) });
      const marks = [];
      const started = Date.now();
      const traced = {
        model,
        start: async (request) => { const id = await seedance.start(request); marks.push(`提交 ${String(Date.now() - started)} ms（任务 ${id}）`); return id; },
        poll: async (id) => { const state = await seedance.poll(id); if (state.done) marks.push(`完成 ${String(Math.round((Date.now() - started) / 1000))} s${state.tokens === null ? '' : `，用量 ${String(state.tokens)} tokens`}`); return state; },
        download: async (uri) => { const bytes = await seedance.download(uri); marks.push(`下载 ${String(bytes.byteLength)} 字节`); return bytes; },
      };
      const outputPath = join(out, 'seedance-shot.mp4');
      try {
        const result = await createSeedanceGenerationProvider({ seedance: traced, offer, ...(process.env.ANCS_SEEDANCE_RESOLUTION ? { resolution: process.env.ANCS_SEEDANCE_RESOLUTION } : {}) }).generate({
          kind: 'VIDEO_SHOT', providerId: offer.providerId, prompt: '清晨的山间湖面，薄雾在水面上缓缓流动，镜头缓慢向前推进，柔和的晨光', script: null, language: null,
          seconds: clipSeconds, maxSeconds: clipSeconds, width: 1280, height: 720, fps: 30, outputPath, likenessPath: null, voicePath: null, sourcePath: null, region: null,
        });
        report.push(`Seedance 生成镜头 ${model} OK：任务 ${String(result.providerJobId)}，${seconds(outputPath).toFixed(2)} 秒 → ${outputPath}；${marks.join('；')}`);
      } catch (error) {
        report.push(`Seedance 生成镜头 ${model} 失败（${error.outcome ?? 'ERROR'}）：${error.message}${marks.length > 0 ? `；${marks.join('；')}` : ''}`);
        process.exitCode = 1;
      }
    }
  }
}

for (const line of report) console.log(line);
