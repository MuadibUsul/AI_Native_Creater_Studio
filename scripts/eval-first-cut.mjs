#!/usr/bin/env node
// V6 §6.5 初剪评测（可重复）：按评测集清单逐个用例 新建共看片室工程 → 上传素材 → 等素材理解 → 让 AI 剪第一版
// → 用与 AI 自检同一套通用检查算自动指标 →（可选）采用并导出成片供人工评分 → 写报告与人工评分表。
//
// 模型：--model scripted（默认，脚本导演，只验证评测流程能跑通，不衡量质量）
//       --model anthropic（真实 Claude；需要环境变量 ANTHROPIC_API_KEY，可选 ANCS_AGENT_MODEL / ANCS_VISION_MODEL）
//       --model gemini（Google Gemini；需要环境变量 GEMINI_API_KEY，可选 ANCS_AGENT_MODEL / ANCS_VISION_MODEL / ANCS_GEMINI_TTS_MODEL）
// 真实模型时同一家的视觉模型同时做视觉理解；有 DEEPGRAM_API_KEY 时启用语音转写。
//
// 用例可以是素材（footage）或文章（article，V6-5：图文工程 + 讲述配音 + 图解卡）。讲述配音：--voice flite（FFmpeg 内置本地英文语音）
// 或 --voice gemini（Gemini TTS，中英等多语言；--model gemini 时缺省）。声音不会说用例要求的语言时如实跳过。
//
// 用法：node scripts/eval-first-cut.mjs [--set evals/first-cut/smoke.json] [--model scripted|anthropic|gemini] [--voice flite|gemini] [--export]
// 结果：.artifacts/eval/first-cut/<时间>/report.json、report.md、rating-sheet.md（以及 --export 的成片）
import { execFileSync } from 'node:child_process';
import { Blob } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { getStrategyPack, reviewDraftOperations, scoreFirstCut } from '../packages/domain/dist/index.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const { values } = parseArgs({ options: { set: { type: 'string', default: 'evals/first-cut/smoke.json' }, model: { type: 'string', default: 'scripted' }, voice: { type: 'string' }, export: { type: 'boolean', default: false } } });
const voiceEngine = values.voice ?? (values.model === 'gemini' ? 'gemini' : 'flite');
const manifest = JSON.parse(await readFile(resolve(values.set), 'utf8'));
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = resolve('.artifacts/eval/first-cut', runId);
await mkdir(outDir, { recursive: true });

async function createDirector() {
  if (values.model === 'scripted') return { director: new ScriptedDirector(), implementation: 'SCRIPTED', model: 'scripted-director' };
  if (values.model === 'gemini') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('--model gemini needs GEMINI_API_KEY in the environment (never pass keys on the command line)');
    const { GeminiAgentModel } = await import('../packages/providers/gemini/dist/index.js');
    const model = process.env.ANCS_AGENT_MODEL ?? 'gemini-flash-latest';
    return { director: new GeminiAgentModel({ apiKey, model }), implementation: 'REAL', model };
  }
  if (values.model !== 'anthropic') throw new Error(`unknown --model ${values.model}`);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('--model anthropic needs ANTHROPIC_API_KEY in the environment (never pass keys on the command line)');
  const { AnthropicAgentModel } = await import('../packages/providers/anthropic/dist/index.js');
  const model = process.env.ANCS_AGENT_MODEL ?? 'claude-opus-5-5';
  return { director: new AnthropicAgentModel({ apiKey, model }), implementation: 'REAL', model };
}

async function optionalAdapters() {
  const adapters = {};
  if (process.env.ANTHROPIC_API_KEY && values.model === 'anthropic') {
    const { AnthropicAgentModel } = await import('../packages/providers/anthropic/dist/index.js');
    const { createModelVisualAnalysisAdapter } = await import('../apps/worker/dist/model-visual-analysis.js');
    adapters.mediaVisualAnalysisAdapter = createModelVisualAnalysisAdapter({ model: new AnthropicAgentModel({ apiKey: process.env.ANTHROPIC_API_KEY, model: process.env.ANCS_VISION_MODEL ?? 'claude-haiku-5-5' }) });
  }
  if (process.env.GEMINI_API_KEY && values.model === 'gemini') {
    const { GeminiAgentModel } = await import('../packages/providers/gemini/dist/index.js');
    const { createModelVisualAnalysisAdapter } = await import('../apps/worker/dist/model-visual-analysis.js');
    adapters.mediaVisualAnalysisAdapter = createModelVisualAnalysisAdapter({ model: new GeminiAgentModel({ apiKey: process.env.GEMINI_API_KEY, model: process.env.ANCS_VISION_MODEL ?? 'gemini-flash-lite-latest' }) });
  }
  if (process.env.DEEPGRAM_API_KEY) {
    const { createDeepgramSpeechRecognitionAdapter } = await import('../apps/worker/dist/deepgram-speech-recognition.js');
    adapters.speechRecognitionAdapter = createDeepgramSpeechRecognitionAdapter({ apiKey: process.env.DEEPGRAM_API_KEY, ...(process.env.ANCS_DEEPGRAM_LANGUAGE ? { language: process.env.ANCS_DEEPGRAM_LANGUAGE } : {}) });
  }
  return adapters;
}

async function materializeFootage(item, workDir) {
  if (item.path) return resolve(item.path);
  const g = item.generate;
  const target = join(workDir, 'generated', `${randomUUID().slice(0, 8)}-${g.name}`);
  await mkdir(join(workDir, 'generated'), { recursive: true });
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${g.video}:duration=${String(g.seconds)}`, '-f', 'lavfi', '-i', `sine=frequency=${String(g.toneHz ?? 440)}:duration=${String(g.seconds)}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', target]);
  return target;
}

const contentType = (file) => (/\.(mov)$/i.test(file) ? 'video/quicktime' : /\.(m4a)$/i.test(file) ? 'audio/mp4' : /\.(mp3)$/i.test(file) ? 'audio/mpeg' : /\.(jpe?g)$/i.test(file) ? 'image/jpeg' : /\.(png)$/i.test(file) ? 'image/png' : 'video/mp4');
const understandingDone = (state) => state.footage.length > 0 && state.footage.every((item) => item.status === 'READY' && Object.values(item.understanding).every((value) => value !== 'WORKING'));

const { director, implementation, model } = await createDirector();
const usesArticles = manifest.cases.some((testCase) => testCase.article !== undefined);
// 文章用例需要图解卡（特效渲染）与讲述配音
async function narrationOption() {
  if (voiceEngine === 'flite') return { option: {}, languages: ['en'], label: 'the local English voice (flite)' };
  if (voiceEngine !== 'gemini') throw new Error(`unknown --voice ${voiceEngine}`);
  if (!process.env.GEMINI_API_KEY) throw new Error('--voice gemini needs GEMINI_API_KEY in the environment');
  const { createGeminiSpeech } = await import('../packages/providers/gemini/dist/index.js');
  const { GEMINI_DEFAULT_VOICES, createGeminiNarrationSynthesizer } = await import('../apps/worker/dist/gemini-media.js');
  const speech = createGeminiSpeech({ apiKey: process.env.GEMINI_API_KEY, model: process.env.ANCS_GEMINI_TTS_MODEL ?? 'gemini-3.8-flash-lite-tts' });
  return { option: { synthesizer: (probe) => createGeminiNarrationSynthesizer({ speech, probe }) }, languages: [...new Set(GEMINI_DEFAULT_VOICES.flatMap((voice) => voice.languages))], label: `Gemini TTS (${speech.model})` };
}
const narration = await narrationOption();
const env = await startStudioEnv({ director, ...(await optionalAdapters()), workDirPrefix: 'ancs-eval-', ...(usesArticles ? { effects: { codegen: 'disabled' }, narration: narration.option } : {}) });
const report = { runId, set: manifest.id, model: { implementation, model }, voice: narration.label, startedAt: new Date().toISOString(), cases: [] };
let failed = false;

try {
  const { client } = await env.signedInClient(`eval-${randomUUID().slice(0, 8)}@test.local`);
  const workspace = await client.workspaces.create({ name: `评测 ${manifest.id}` });
  // 本评测环境的配音引擎会说的语言
  const voiceLanguages = narration.languages;
  for (const testCase of manifest.cases) {
    const started = Date.now();
    const entry = { id: testCase.id, title: testCase.title, request: testCase.request, strategy: testCase.strategy ?? null };
    if (testCase.requiresVoiceLanguage !== undefined && !voiceLanguages.includes(testCase.requiresVoiceLanguage)) {
      entry.status = 'SKIPPED';
      entry.error = `needs a ${testCase.requiresVoiceLanguage} narration voice; this evaluation environment only has ${narration.label}`;
      report.cases.push(entry);
      console.log(`SKIP  ${testCase.id} — ${entry.error}`);
      continue;
    }
    try {
      const ref = await client.studio.create(workspace.id, {
        title: testCase.title, aspectRatio: testCase.aspectRatio ?? '16:9', locale: testCase.locale ?? 'zh-CN',
        ...(testCase.article === undefined ? {} : { article: testCase.article, narration: testCase.narration ?? true }),
      }, { idempotencyKey: `eval-${randomUUID()}` });
      const footage = testCase.footage ?? [];
      for (const item of footage) {
        const file = await materializeFootage(item, env.workDir);
        const bytes = await readFile(file);
        await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: item.generate?.name ?? basename(file), contentType: contentType(file), data: new Blob([bytes]), projectId: ref.projectId });
      }
      const state = footage.length === 0 ? await client.studio.state(workspace.id, ref.projectId)
        : await waitFor(() => client.studio.state(workspace.id, ref.projectId), understandingDone, { timeoutMs: 20 * 60_000, intervalMs: 1000, label: 'footage understanding' });
      if (testCase.article !== undefined) entry.article = state.project.article;
      entry.footage = state.footage.map((item) => ({ name: item.name, duration: item.duration, understanding: item.understanding }));
      const turnStarted = Date.now();
      const turn = await client.agent.startTurn(workspace.id, ref.sessionId, {
        message: testCase.request,
        ...(testCase.strategy ? { strategyPackId: testCase.strategy.packId, strategyKnobs: testCase.strategy.knobs ?? {} } : {}),
      }, { idempotencyKey: `eval-${randomUUID()}` });
      const done = await waitFor(() => client.agent.getTurn(workspace.id, turn.id), (current) => current.status !== 'RUNNING', { timeoutMs: 30 * 60_000, intervalMs: 1000, label: 'agent turn' });
      entry.turn = { status: done.status, reply: done.reply, toolCalls: done.toolCalls, usage: done.usage, costMicros: done.costMicros, seconds: Math.round((Date.now() - turnStarted) / 100) / 10, error: done.error };
      if (done.status !== 'COMPLETED' || done.proposalId === null) throw new Error(`no first cut (turn ${done.status}${done.error ? `: ${JSON.stringify(done.error).slice(0, 200)}` : ''})`);
      const proposal = await client.projects.proposal(workspace.id, ref.projectId, done.proposalId);
      const review = await reviewDraftOperations(env.deps, { workspaceId: workspace.id, projectId: ref.projectId, sequenceId: ref.sequenceId, baseRevision: proposal.baseProjectRevision, operations: proposal.operations });
      const usedFootage = new Set(proposal.operations.flatMap((operation) => (typeof operation.assetVersionId === 'string' ? [operation.assetVersionId] : [])));
      const strategy = testCase.strategy ? await getStrategyPack(env.deps, { workspaceId: workspace.id, packId: testCase.strategy.packId }) : null;
      entry.review = review;
      entry.scorecard = scoreFirstCut({ review, footageCount: state.footage.length, usedFootageCount: usedFootage.size, targetSeconds: testCase.targetSeconds ?? null, strategy });
      if (values.export) {
        await client.projects.adoptProposal(workspace.id, ref.projectId, proposal.proposalId, { expectedOperationsHash: proposal.operationsHash, expectedSelectionFingerprint: proposal.selectionFingerprint, idempotencyKey: `eval-${randomUUID()}` });
        const fresh = await client.studio.state(workspace.id, ref.projectId);
        const size = testCase.aspectRatio === '9:16' ? { width: 1080, height: 1920 } : testCase.aspectRatio === '1:1' ? { width: 1080, height: 1080 } : testCase.aspectRatio === '4:5' ? { width: 1080, height: 1350 } : { width: 1920, height: 1080 };
        const run = await client.finalRenders.start(workspace.id, ref.projectId, ref.sequenceId, { profile: size, expectedRevision: fresh.project.revision }, { idempotencyKey: `eval-${randomUUID()}` });
        const finished = await waitFor(() => client.workflowRuns.get(workspace.id, run.id), (current) => current.status !== 'RUNNING', { timeoutMs: 30 * 60_000, intervalMs: 1500, label: 'final render' });
        const videoAsset = finished.outputs?.render?.outputs?.find((output) => output.kind === 'VIDEO')?.assetId;
        if (finished.status === 'SUCCEEDED' && videoAsset) {
          const link = await client.assets.downloadUrl(workspace.id, videoAsset);
          const bytes = new Uint8Array(await (await fetch(link.url)).arrayBuffer());
          entry.exportFile = `${testCase.id}.mp4`;
          await writeFile(join(outDir, entry.exportFile), bytes);
        } else {
          entry.exportError = finished.error;
        }
      }
      entry.status = 'OK';
    } catch (error) {
      failed = true;
      entry.status = 'ERROR';
      entry.error = error instanceof Error ? error.message : String(error);
    }
    entry.seconds = Math.round((Date.now() - started) / 100) / 10;
    report.cases.push(entry);
    console.log(`${entry.status === 'OK' ? 'OK   ' : 'ERROR'} ${testCase.id}${entry.scorecard ? ` — automatic ${String(entry.scorecard.automaticScore)}` : ''}${entry.error ? ` — ${entry.error}` : ''}`);
  }
} finally {
  report.finishedAt = new Date().toISOString();
  await writeFile(join(outDir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(outDir, 'report.md'), renderReport(report));
  await writeFile(join(outDir, 'rating-sheet.md'), renderRatingSheet(report));
  await env.close();
}
console.log(`\nReport: ${join('.artifacts/eval/first-cut', runId)}${implementation === 'SCRIPTED' ? '\n(scripted director: this run checks the evaluation pipeline, not editing quality)' : ''}`);
if (failed) process.exitCode = 1;

function renderReport(data) {
  const lines = [
    `# 初剪评测报告 · ${data.set}`, '',
    `- 运行：${data.runId}`,
    `- 导演模型：${data.model.model}（${data.model.implementation === 'SCRIPTED' ? '脚本导演，只验证流程，不代表剪辑质量' : '真实模型'}）`, '',
  ];
  for (const entry of data.cases) {
    lines.push(`## ${entry.title}（${entry.id}）`, '', `- 请求：${entry.request}`, `- 策略：${entry.strategy ? `${entry.strategy.packId} ${JSON.stringify(entry.strategy.knobs ?? {})}` : '不选（通用能力）'}`, `- 结果：${entry.status}${entry.error ? ` — ${entry.error}` : ''}`);
    if (entry.turn) lines.push(`- AI：${entry.turn.status}，${String(entry.turn.seconds)} s，成本 ${entry.turn.costMicros === null ? '含未定价调用' : `$${(entry.turn.costMicros / 1e6).toFixed(4)}`}，工具 ${entry.turn.toolCalls.map((call) => call.name).join(' → ')}`, `- 回应：${entry.turn.reply ?? '—'}`);
    if (entry.scorecard) {
      lines.push('', `自动指标（${entry.scorecard.automaticScore ?? '无法评估'}）：`, '', '| 指标 | 原始值 | 分 | 说明 |', '|---|---|---|---|');
      for (const indicator of entry.scorecard.indicators) lines.push(`| ${indicator.key} | ${indicator.value ?? '—'} | ${indicator.score ?? '无法评估'} | ${indicator.note} |`);
      lines.push('', `检查：${entry.review.findings.length === 0 ? '没有发现' : entry.review.findings.map((finding) => `${finding.kind}@${finding.at[0]}`).join('，')}；无法检查：${entry.review.notChecked.join('，') || '无'}`);
    }
    if (entry.exportFile) lines.push(`- 成片：${entry.exportFile}`);
    lines.push('');
  }
  lines.push('> 自动指标只抓机械问题；叙事、节奏与品味以人工评分为准（rating-sheet.md）。');
  return `${lines.join('\n')}\n`;
}

function renderRatingSheet(data) {
  const criteria = ['叙事完整（开场、发展、高潮、收尾）', '节奏与剪点', '镜头选择（最好的画面用上了吗）', '声音连续与音量', '是否满足这句话的要求', '整体：愿意直接发吗'];
  const lines = [`# 人工评分表 · ${data.set} · ${data.runId}`, '', '每项 1–5 分（5 最好），写一句理由。评分标准见 docs/V06/eval/first-cut-rubric.md。', ''];
  for (const entry of data.cases.filter((item) => item.status !== 'SKIPPED')) {
    lines.push(`## ${entry.title}（${entry.id}）${entry.exportFile ? ` · 成片 ${entry.exportFile}` : ''}`, '', '| 项 | 分（1–5） | 理由 |', '|---|---|---|');
    for (const criterion of criteria) lines.push(`| ${criterion} |  |  |`);
    if (entry.strategy) lines.push('| 风格贴合度（只评所选策略） |  |  |');
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
