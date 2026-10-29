#!/usr/bin/env node
// V6-10 分章 + 只重做一章 的**真实模型**检查（会产生费用：每次运行前须经所有者批准）。
//
// 用真实导演模型（缺省 Claude Haiku 5.5，仓库价格表里最便宜的）跑一次分章运行与一次重做：
//   三段合成素材（共 18 秒，分章门槛调到 10 秒）→ 定计划 → 三章并行剪 → 拼装 → 通看收尾 → 自动采用
//   → 第 2 章由测试替身**在调用模型之前**故意失败（不花钱），交付后只重做这一章 → 放回原位。
// 回答 V6-10 S6 的四个问题：规划是否只写计划且按顺序覆盖素材；各章是否只剪自己的场景；收尾是否只修接缝；重做是否只动这一章。
//
// 花费上限（三道）：授权预算与工作区月度 AI 上限都设为 ANCS_REAL_BUDGET_USD（缺省 1，最多 2）；
// 此外本脚本按价格表累计每次调用的实际费用，超过预算或调用次数超过 ANCS_REAL_MAX_CALLS（缺省 80）就不再调用模型。
//
// 密钥只从环境变量读（不打印、不写入任何文件）：ANTHROPIC_API_KEY（缺省），或 ANCS_REAL_DRIVER=deepseek 时 DEEPSEEK_API_KEY。
// 用法：node scripts/autonomous-chapters-real-check.mjs                  只打印计划与上限，不调用模型
//       node scripts/autonomous-chapters-real-check.mjs --confirm-spend  真的运行
//       node scripts/autonomous-chapters-real-check.mjs --offline        用脚本导演走一遍同样的流程（不联网、不花钱），先确认脚本本身能跑通
// 结果：.artifacts/real/v6-10-<时间>.json（不含密钥；含每次调用的阶段、模型、token 与费用）
import { execFileSync } from 'node:child_process';
import { Blob } from 'node:buffer';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AgentModelFailure, AGENT_MODEL_PRICES, agentModelCostMicros } from '../packages/contracts/dist/index.js';
import { configureDeploymentPolicy } from '../packages/domain/dist/index.js';
import { readTimelineSnapshot } from '../packages/domain/dist/edit-trial.js';
import { ScriptedDirector } from './lib/scripted-director.mjs';
import { startStudioEnv, waitFor } from './lib/studio-env.mjs';

const driver = process.env.ANCS_REAL_DRIVER ?? 'anthropic';
const model = process.env.ANCS_REAL_MODEL ?? (driver === 'deepseek' ? 'deepseek-flash' : 'claude-haiku-5-5');
const budgetUsd = Math.min(2, Math.max(0.2, Number(process.env.ANCS_REAL_BUDGET_USD ?? '1')));
const budgetMicros = Math.round(budgetUsd * 1_000_000);
const maxCalls = Math.min(150, Math.max(10, Number(process.env.ANCS_REAL_MAX_CALLS ?? '80')));
const keyName = driver === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'ANTHROPIC_API_KEY';
const confirmed = process.argv.includes('--confirm-spend');
const offline = process.argv.includes('--offline');

if (offline) console.log('offline: scripted director, no model calls, no spend');
else console.log(`plan: driver=${driver} model=${model} budget=$${budgetUsd.toFixed(2)} maxCalls=${String(maxCalls)} key=${keyName}:${process.env[keyName] ? 'set' : 'missing'}`);
if (!offline && AGENT_MODEL_PRICES[model] === undefined && !process.env.ANCS_MODEL_PRICES_JSON) {
  console.log(`no price for ${model}: spending could not be counted, so this check will not run it`);
  process.exit(1);
}
if (!offline && !process.env[keyName]) {
  console.log(`${keyName} is not set in this environment: add it in the environment settings (never paste it into chat), then start a new session`);
  process.exit(1);
}
if (!offline && !confirmed) {
  console.log('dry run: nothing was sent to the model. Re-run with --confirm-spend after the owner approves the spend.');
  process.exit(0);
}

/** 真实模型 + 花费护栏 + 第 2 章在调用模型之前故意失败（只在第一次运行里） */
class GuardedDirector {
  providerId;
  implementation = 'REAL';
  model;
  calls = [];
  spentMicros = 0;
  failChapter2 = true;
  constructor(inner) { this.inner = inner; this.providerId = inner.providerId; this.model = inner.model; }
  async respond(request) {
    const context = request.messages[0]?.content?.find((block) => block.type === 'text')?.text ?? '';
    const phase = /"phase":"([A-Z_]+)"/.exec(context)?.[1] ?? 'NONE';
    const number = phase === 'CUT_CHAPTER' ? Number(/"number":(\d+)/.exec(context)?.[1]) : null;
    if (this.failChapter2 && number === 2) throw new AgentModelFailure('BAD_REQUEST', 'injected test failure before calling the model (no spend)');
    if (this.calls.length >= maxCalls || this.spentMicros >= budgetMicros) throw new AgentModelFailure('BAD_REQUEST', 'spend guard: call or budget limit of this check reached');
    const started = Date.now();
    const response = await this.inner.respond(request);
    const cost = agentModelCostMicros(response.model, response.usage) ?? 0;
    this.spentMicros += cost;
    const tools = response.content.filter((block) => block.type === 'tool_use').map((block) => block.name);
    this.calls.push({ phase, chapter: number, model: response.model, ms: Date.now() - started, inputTokens: response.usage.inputTokens, outputTokens: response.usage.outputTokens, cacheRead: response.usage.cacheReadInputTokens, costMicros: cost, tools, stop: response.stopReason });
    console.log(`call ${String(this.calls.length)} ${phase}${number === null ? '' : ` #${String(number)}`} → ${tools.join(',') || response.stopReason} · $${(this.spentMicros / 1e6).toFixed(4)}`);
    return response;
  }
}

async function realModel() {
  if (offline) return new ScriptedDirector();
  const apiKey = process.env[keyName];
  if (driver === 'deepseek') {
    const { DeepSeekAgentModel } = await import('../packages/providers/deepseek/dist/index.js');
    return new DeepSeekAgentModel({ apiKey, model });
  }
  const { AnthropicAgentModel } = await import('../packages/providers/anthropic/dist/index.js');
  return new AnthropicAgentModel({ apiKey, model, maxRetries: 1, ...(process.env.ANCS_ANTHROPIC_BASE_URL ? { baseURL: process.env.ANCS_ANTHROPIC_BASE_URL } : {}) });
}

const director = new GuardedDirector(await realModel());
// 真实运行：工作区月度 AI 上限 = 预算（第二道护栏）。脱机的脚本导演没有价格表，设了上限它就不会被调用，所以不设
if (!offline) configureDeploymentPolicy({ aiMonthlyCapMicros: budgetMicros });
const env = await startStudioEnv({ director, workDirPrefix: 'ancs-v610-real-', chapters: { minFootageSeconds: 10, concurrency: 3, retries: 0, iterations: 20, planIterations: 10 } });
const result = { driver: offline ? 'offline-scripted' : driver, model: offline ? 'scripted-director' : model, budgetUsd, startedAt: new Date().toISOString() };
try {
  const { client } = await env.signedInClient(`v610-real-${String(Date.now())}@test.local`);
  const workspace = await client.workspaces.create({ name: 'V6-10 real model' });
  const ref = await client.studio.create(workspace.id, { title: 'Iceland in three parts', aspectRatio: '16:9', locale: 'en' }, { idempotencyKey: `real-${String(Date.now())}` });
  const footageDir = join(env.workDir, 'footage');
  await mkdir(footageDir, { recursive: true });
  const sources = [['1-glacier.mp4', 'testsrc2=size=1280x720:rate=30', 440], ['2-lake.mp4', 'smptehdbars=size=1280x720:rate=30', 660], ['3-road.mp4', 'rgbtestsrc=size=1280x720:rate=30', 880]];
  for (const [name, video, tone] of sources) {
    const file = join(footageDir, name);
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `${video}:duration=6`, '-f', 'lavfi', '-i', `sine=frequency=${String(tone)}:duration=6`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file]);
    await client.assets.uploadResumable(workspace.id, { assetType: 'USER_UPLOAD', filename: name, contentType: 'video/mp4', data: new Blob([await readFile(file)]), projectId: ref.projectId });
  }
  await waitFor(() => client.studio.state(workspace.id, ref.projectId), (state) => state.footage.length === 3 && state.footage.every((item) => item.status === 'READY'), { timeoutMs: 5 * 60_000, intervalMs: 1000, label: 'footage ready' });
  await client.autonomy.sign(workspace.id, ref.projectId, { approval: 'AUTO_SAFE', budgetMicros }, { idempotencyKey: `real-sign-${String(Date.now())}` });

  const goal = 'Cut the three clips into one short film in file order (1, 2, 3), about 3 seconds from each.';
  const terminal = (run) => !['WAITING_FOR_FOOTAGE', 'PLANNING', 'CUTTING_CHAPTERS', 'DIRECTING', 'CHECKING'].includes(run.status);
  const first = await client.autonomy.startRun(workspace.id, ref.projectId, { goal, targetDurationSeconds: 9, locale: 'en' }, { idempotencyKey: `real-run-${String(Date.now())}` });
  const delivered = await waitFor(() => client.autonomy.getRun(workspace.id, ref.projectId, first.id), terminal, { timeoutMs: 20 * 60_000, intervalMs: 2000, label: 'first run' });
  const plan = await client.autonomy.latestPlan(workspace.id, ref.projectId);
  result.first = summarize(delivered);
  result.plan = plan === null ? null : { scenes: plan.scenes.map((scene) => ({ id: scene.id, title: scene.title, window: scene.window, sources: scene.sources })) };
  const callsFirst = director.calls.length;

  const failed = delivered.chapters.find((chapter) => chapter.status === 'FAILED' && chapter.index === 1);
  if (delivered.mode === 'CHAPTERS' && failed !== undefined && delivered.report?.outcome === 'ADOPTED') {
    director.failChapter2 = false;
    const redo = await client.autonomy.redoChapter(workspace.id, ref.projectId, delivered.id, failed.id, { idempotencyKey: `real-redo-${String(Date.now())}` });
    const redone = await waitFor(() => client.autonomy.getRun(workspace.id, ref.projectId, redo.id), terminal, { timeoutMs: 15 * 60_000, intervalMs: 2000, label: 'redo run' });
    result.redo = summarize(redone);
  } else {
    result.redo = { skipped: `first run: mode ${delivered.mode}, status ${delivered.status}, outcome ${delivered.report?.outcome ?? 'none'}` };
  }

  const state = await client.studio.state(workspace.id, ref.projectId);
  const names = new Map(state.footage.map((item) => [item.footageId, item.name]));
  const { timeline } = await readTimelineSnapshot(env.deps, { workspaceId: workspace.id, projectId: ref.projectId });
  const seconds = (time) => Number(time.ticks) * time.timebase.num / time.timebase.den;
  result.film = timeline.clips
    .filter((clip) => clip.sequenceId === state.sequenceId && timeline.tracks.find((track) => track.id === clip.trackId)?.kind === 'VIDEO')
    .map((clip) => ({ footage: names.get(clip.assetVersionId) ?? clip.assetVersionId, at: [seconds(clip.sequenceRange.start), seconds(clip.sequenceRange.end)], source: [seconds(clip.sourceRange.start), seconds(clip.sourceRange.end)] }))
    .sort((a, b) => a.at[0] - b.at[0]);
  result.calls = director.calls;
  result.callsFirstRun = callsFirst;
  result.spentUsd = Number((director.spentMicros / 1e6).toFixed(4));
} catch (error) {
  result.error = error instanceof Error ? error.message.slice(0, 500) : String(error);
  result.calls = director.calls;
  result.spentUsd = Number((director.spentMicros / 1e6).toFixed(4));
  process.exitCode = 1;
} finally {
  await env.close().catch(() => undefined);
  await mkdir(resolve('.artifacts/real'), { recursive: true });
  const out = resolve('.artifacts/real', `v6-10-${result.startedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ spentUsd: result.spentUsd, calls: result.calls?.length ?? 0, first: result.first?.status, redo: result.redo?.status ?? result.redo?.skipped, film: result.film, error: result.error, out }, null, 2));
}

function summarize(run) {
  return {
    status: run.status, mode: run.mode, outcome: run.report?.outcome ?? null, note: run.report?.note ?? null,
    chapters: run.chapters.map((chapter) => ({ index: chapter.index, title: chapter.title, status: chapter.status, steps: chapter.progress.steps, costMicros: chapter.costMicros, error: chapter.error })),
    report: run.report === null ? null : { timeline: run.report.timeline, unmet: run.report.unmet, chapters: run.report.chapters, cost: run.report.cost, review: { warnings: run.report.review.warnings, notes: run.report.review.notes } },
    error: run.error,
  };
}
