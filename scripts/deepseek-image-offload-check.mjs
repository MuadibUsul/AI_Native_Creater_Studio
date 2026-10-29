#!/usr/bin/env node
// V7 B1 真实验证（docs/V07/milestones/B1.md）：DeepSeek 只发送最新的图，没有新图的一步回到配置的模型。
//
// 只做三次小请求（不自动重试）：
//   1. 配置的模型（缺省 deepseek-v4-pro）：要求它先调用 look_at_footage；
//   2. 带两张新抽帧 → 应改用 deepseek-flash；要求它再调用 get_timeline；
//   3. 没有新图 → 应回到配置的模型；旧图换成说明，Flash 的思考内容原样回放。
// 每次输出上限 1024 token、推理强度 low；估算总花费远低于 0.05 美元（按 ANCS_MODEL_PRICES_JSON，未设置时按 B1 记录的峰值价）。
//
// 密钥只从环境变量 DEEPSEEK_API_KEY 读，不打印、不写文件。需要先构建：pnpm --filter @ancs/providers-deepseek run build。
// 在需要经代理出网的环境里加 NODE_USE_ENV_PROXY=1。--offline 用假响应检查脚本本身，不联网、不花钱。
//
// 用法：
//   DEEPSEEK_API_KEY=… NODE_USE_ENV_PROXY=1 node scripts/deepseek-image-offload-check.mjs [--model deepseek-v4-pro]
//   node scripts/deepseek-image-offload-check.mjs --offline
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEEPSEEK_IMAGE_MODEL, DeepSeekAgentModel } from '../packages/providers/deepseek/dist/index.js';

const args = process.argv.slice(2);
const offline = args.includes('--offline');
const modelIndex = args.indexOf('--model');
const configured = modelIndex === -1 ? process.env.ANCS_AGENT_MODEL ?? 'deepseek-v4-pro' : args[modelIndex + 1];
if (!offline && !process.env.DEEPSEEK_API_KEY) {
  console.error('未设置 DEEPSEEK_API_KEY：不调用。只想检查脚本本身时加 --offline。');
  process.exit(2);
}

// 峰值价（美元 / 百万 token），见 docs/verification/vps-darely-20261023.md；部署方的价目表优先
const prices = { 'deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044 }, 'deepseek-flash': { input: 0.30, output: 1.20, cacheRead: 0.006 }, ...JSON.parse(process.env.ANCS_MODEL_PRICES_JSON ?? '{}') };
const costOf = (model, usage) => {
  const price = prices[model];
  if (price === undefined) return null;
  return (usage.inputTokens * price.input + usage.cacheReadInputTokens * (price.cacheRead ?? price.input) + usage.outputTokens * price.output) / 1e6;
};

const work = await mkdtemp(join(tmpdir(), 'ancs-ds-b1-'));
const frames = [];
for (const [index, source] of ['testsrc2=size=1280x720', 'smptehdbars=size=1280x720'].entries()) {
  const file = join(work, `frame-${String(index)}.jpg`);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', source, '-frames:v', '1', '-vf', 'scale=512:-2', file]);
  frames.push({ mediaType: 'image/jpeg', data: (await readFile(file)).toString('base64') });
}
await rm(work, { recursive: true, force: true });

// 只记录请求体的统计（模型、图片数、是否带说明），不记录请求头
const sent = [];
const offlineReplies = [
  { finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'Look first.', tool_calls: [{ id: 'call_look', function: { name: 'look_at_footage', arguments: '{"footageId":"A"}' } }] } },
  { finish_reason: 'tool_calls', message: { content: null, reasoning_content: 'Bars and a test pattern.', tool_calls: [{ id: 'call_timeline', function: { name: 'get_timeline', arguments: '{}' } }] } },
  { finish_reason: 'stop', message: { content: 'Test patterns; the timeline has 3 clips.', reasoning_content: 'Done.' } },
];
const recordingFetch = async (url, init) => {
  const body = String(init.body);
  const parsed = JSON.parse(body);
  sent.push({ model: parsed.model, images: body.split('"type":"image_url"').length - 1, omittedNote: body.includes('were shown in an earlier step and are omitted now') });
  if (!offline) return fetch(url, init);
  return globalThis.Response.json({ model: parsed.model, choices: [offlineReplies[sent.length - 1]], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 0 } });
};
const model = new DeepSeekAgentModel({ apiKey: offline ? 'offline-check' : process.env.DEEPSEEK_API_KEY, model: configured, fetch: recordingFetch });

const tools = [
  { name: 'look_at_footage', description: 'See frames from one piece of footage.', inputSchema: { type: 'object', properties: { footageId: { type: 'string' } }, required: ['footageId'], additionalProperties: false } },
  { name: 'get_timeline', description: 'Read the current timeline.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
];
const system = 'You are a video editor. Follow the user\'s steps exactly, one tool call per step. Keep the final reply to one sentence.';
const messages = [{ role: 'user', content: [{ type: 'text', text: 'Step 1: call look_at_footage for footage "A". Step 2: after you see the frames, call get_timeline. Step 3: reply in one sentence with what the frames show and how many clips the timeline has.' }] }];
const results = { look_at_footage: { content: '{"frames":2}', images: frames }, get_timeline: { content: '{"clips":3,"duration":"12s"}' } };

const calls = [];
for (let step = 0; step < 3; step += 1) {
  let response;
  try {
    response = await model.respond({ system, tools, messages, maxOutputTokens: 1024, effort: 'low' });
  } catch (error) {
    // 适配器的错误信息不含上游正文与凭据
    calls.push({ step: step + 1, error: `${error.kind ?? 'ERROR'}: ${error.message}` });
    break;
  }
  const uses = response.content.filter((block) => block.type === 'tool_use');
  calls.push({ step: step + 1, model: response.model, stopReason: response.stopReason, tools: uses.map((use) => use.name), usage: response.usage, costUsd: costOf(response.model, response.usage), text: response.content.filter((block) => block.type === 'text').map((block) => block.text).join(' ').slice(0, 200) });
  messages.push({ role: 'assistant', content: response.content });
  if (uses.length === 0) {
    if (step === 2) break;
    // 模型提前收尾：追加一句用户消息让它继续（同样只追加，不改历史）
    messages.push({ role: 'user', content: [{ type: 'text', text: 'Please continue with the next step and call the tool.' }] });
    continue;
  }
  messages.push({ role: 'user', content: uses.map((use) => ({ type: 'tool_result', toolUseId: use.id, isError: !(use.name in results), content: results[use.name]?.content ?? '{"error":"unknown tool"}', ...(results[use.name]?.images ? { images: results[use.name].images } : {}) })) });
}

const expected = [{ model: configured, images: 0 }, { model: DEEPSEEK_IMAGE_MODEL, images: 2 }, { model: configured, images: 0, omittedNote: true }];
const checks = expected.map((want, index) => {
  const got = sent[index];
  const ok = got !== undefined && got.model === want.model && got.images === want.images && (want.omittedNote === undefined || got.omittedNote === want.omittedNote) && calls[index]?.error === undefined;
  return { request: index + 1, want, got: got ?? null, ok };
});
const total = calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
console.log(JSON.stringify({ mode: offline ? 'offline' : 'real', configured, calls, checks, estimatedCostUsd: Number(total.toFixed(6)) }, null, 2));
if (!checks.every((check) => check.ok)) process.exitCode = 1;
