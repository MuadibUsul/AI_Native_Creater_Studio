import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { createDb, redactDatabaseUrl } from '@ancs/db';
import { WorkflowRegistry, agentTurnWorkflow, claimJob, compositionFinalRenderWorkflow, configureDeploymentPolicy, runMaintenanceTick, unconfiguredAgentModel } from '@ancs/domain';
import { AnthropicAgentModel } from '@ancs/providers-anthropic';
import { checkProviderInventory, crossCheckWorkerEnv, formatEnvFailure, validateEnv, workerEnvSchema, type EnvIssue, type ProviderInventoryEntry } from '@ancs/contracts';
import { createDefaultRegistry, type JobHandlerRegistry } from './handlers.js';
import { createProcessRenderExecutor } from './render-executor-process.js';
import { createProcessMotionValidator } from './motion-validator-process.js';
import { createProcessMediaProbe } from './media-probe-process.js';
import { executeJob } from './runner.js';
import { createDomainDeps } from './domain.js';
import { createFfmpegSourceMediaProbe } from './source-media-probe-process.js';
import { createFfmpegRenderPlanExecutor } from './render-plan/ffmpeg-executor.js';
import { createFfmpegMediaProxyTranscoder } from './source-media-transcoder-process.js';
import { createFfmpegMediaIndexer } from './source-media-indexer-process.js';
import { createProcessSpeechRecognitionAdapter } from './speech-recognition-process.js';
import { createDeepgramSpeechRecognitionAdapter } from './deepgram-speech-recognition.js';
import { createProcessMediaVisualAnalysisAdapter } from './visual-analysis-process.js';
import { createStorageFrameSampler } from './frame-sampler-process.js';
import { createModelVisualAnalysisAdapter } from './model-visual-analysis.js';
import { createProcessMediaAudioAnalysisAdapter } from './audio-analysis-process.js';

/**
 * Worker 主循环（P03-01）。见 domain.ts 的说明。
 * 退出码：0 = 正常结束（once/信号停止）；1 = 配置错误或致命失败。
 *
 * P08-01：启动前一次性校验全部环境配置（fail-closed；未实现的驱动/缺失的渲染执行器
 * 明确失败并说明原因，绝不静默降级）。
 */

const envResult = validateEnv(workerEnvSchema, process.env);
const envIssues: EnvIssue[] = envResult.ok ? [] : envResult.issues;
if (envResult.ok && envResult.value !== null) {
  envIssues.push(...crossCheckWorkerEnv(envResult.value));
  // 渲染执行器/验证器/媒体探测：默认命令解析失败或脚本文件不存在 → 启动即失败（错误配置不等到任务时才暴露）
  const disableRender = envResult.value.ANCS_DISABLE_RENDER === '1';
  const customRenderCmd = envResult.value.ANCS_RENDER_EXECUTOR_CMD !== undefined;
  const customMotionCmd = envResult.value.ANCS_MOTION_VALIDATOR_CMD !== undefined;
  if (!disableRender && !customRenderCmd) {
    const repoRootCandidates = ['./apps/render-worker/src/run-render.ts'];
    if (!repoRootCandidates.some((candidate) => existsSync(candidate))) {
      envIssues.push({
        variable: 'ANCS_RENDER_EXECUTOR_CMD',
        message: `渲染执行器脚本不存在（${repoRootCandidates.join(' / ')}）：请在仓库根启动，或用 ANCS_RENDER_EXECUTOR_CMD 显式配置命令（部署形态见 docs/ops/deployment-runbook.md）`,
      });
    }
  }
  if (!customMotionCmd && !existsSync('./apps/motion-worker/src/run-validate.ts')) {
    envIssues.push({
      variable: 'ANCS_MOTION_VALIDATOR_CMD',
      message: 'Motion 验证器脚本不存在（./apps/motion-worker/src/run-validate.ts）：请在仓库根启动，或显式配置命令',
    });
  }
}
if (envIssues.length > 0 || envResult.value === null) {
  console.error(formatEnvFailure('worker', envIssues));
  process.exit(1);
}
const config = envResult.value;
const databaseUrl = config.DATABASE_URL;

const once = config.ANCS_WORKER_ONCE === '1' || process.argv.includes('--once');
/** 故障注入（P03-02）：在关键阶段退出进程，用于演练"杀 Worker 后可继续" */
const crashAt = config.ANCS_WORKER_CRASH_AT ?? '';
const workerId = config.ANCS_WORKER_ID ?? `${hostname()}-${String(process.pid)}`;
// 数值在 env schema 中带上下界校验：非法值启动即失败（不再出现 NaN 租约）
const tickIntervalMs = config.ANCS_WORKER_TICK_MS;
const leaseSeconds = config.ANCS_WORKER_LEASE_SECONDS;
const heartbeatIntervalMs = config.ANCS_WORKER_HEARTBEAT_MS ?? Math.max(1000, (leaseSeconds * 1000) / 3);

// 部署策略一次性注入领域层（领域层不读 process.env）
configureDeploymentPolicy({ defaultPlan: config.ANCS_DEFAULT_PLAN });
const handle = createDb(databaseUrl);
const deps = createDomainDeps(handle, config);
const ffmpegPaths = {
  ...(config.ANCS_FFMPEG_PATH === undefined ? {} : { ffmpegPath: config.ANCS_FFMPEG_PATH }),
  ...(config.ANCS_FFPROBE_PATH === undefined ? {} : { ffprobePath: config.ANCS_FFPROBE_PATH }),
};
const commandOf = (value: string | undefined): { command?: string[] } => (value === undefined ? {} : { command: value.trim().split(/\s+/) });
const sourceMediaProbe = createFfmpegSourceMediaProbe(ffmpegPaths);
const sourceMediaTranscoder = createFfmpegMediaProxyTranscoder(ffmpegPaths);
const sourceMediaIndexer = createFfmpegMediaIndexer(config.ANCS_FFMPEG_PATH === undefined ? {} : { ffmpegPath: config.ANCS_FFMPEG_PATH });
/**
 * ASR（V5-M3：Deepgram 进入正式路径）。驱动由 ANCS_ASR_DRIVER 显式选择；deepgram 缺密钥在 env 校验中启动失败。
 * 付费调用不自动重试：转写任务 maxAttempts = 1（失败后由用户显式重跑）。
 */
const asrDriver = config.ANCS_ASR_DRIVER ?? (config.ANCS_ASR_EXECUTABLE === undefined ? undefined : 'process');
const speechRecognitionAdapter = asrDriver === 'deepgram' && config.DEEPGRAM_API_KEY !== undefined
  ? createDeepgramSpeechRecognitionAdapter({
    apiKey: config.DEEPGRAM_API_KEY,
    ...(config.ANCS_DEEPGRAM_MODEL === undefined ? {} : { model: config.ANCS_DEEPGRAM_MODEL }),
    ...(config.ANCS_DEEPGRAM_LANGUAGE === undefined ? {} : { language: config.ANCS_DEEPGRAM_LANGUAGE }),
  })
  : asrDriver === 'process' && config.ANCS_ASR_EXECUTABLE !== undefined
    ? createProcessSpeechRecognitionAdapter({
      executable: config.ANCS_ASR_EXECUTABLE,
      args: config.ANCS_ASR_ARGS_JSON === undefined ? [] : JSON.parse(config.ANCS_ASR_ARGS_JSON) as string[],
    })
    : undefined;

/**
 * V6-1：通用导演 Agent 的模型。驱动由 ANCS_AGENT_DRIVER 显式选择（anthropic 缺密钥在 env 校验中启动失败）；
 * 未配置时装配"未配置"端口：AI 轮次明确失败（501），不回退 Mock。密钥只在本进程内存中。
 */
const agentModel = config.ANCS_AGENT_DRIVER === 'anthropic' && config.ANTHROPIC_API_KEY !== undefined
  ? new AnthropicAgentModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANCS_AGENT_MODEL ?? 'claude-opus-5-5' })
  : unconfiguredAgentModel();
/** V6-1b：AI 导演看素材的抽帧（源/代理文件流式物化 + FFmpeg 单帧解码，进程内 LRU 缓存）。 */
const frameSampler = createStorageFrameSampler({ storage: deps.storage, ...(config.ANCS_FFMPEG_PATH === undefined ? {} : { ffmpegPath: config.ANCS_FFMPEG_PATH }) });
/** V6-1b：视觉理解驱动（anthropic = 视觉模型写镜头说明；process = 运维子进程）。 */
const visualDriver = config.ANCS_VISUAL_ANALYSIS_DRIVER ?? (config.ANCS_VISUAL_ANALYSIS_EXECUTABLE === undefined ? undefined : 'process');

/** 装配清单与生产守卫（V5-M3，§11.3）：Worker 当前装配的外部能力驱动均为真实实现或运维配置的子进程。 */
const providerInventory: ProviderInventoryEntry[] = [
  ...(asrDriver === undefined ? [] : [{ capability: 'asr', driver: asrDriver, implementation: 'REAL' as const }]),
  ...(config.ANCS_AGENT_DRIVER === undefined ? [] : [{ capability: 'agent_model', driver: config.ANCS_AGENT_DRIVER, implementation: 'REAL' as const }]),
  ...(visualDriver === undefined ? [] : [{ capability: 'visual_analysis', driver: visualDriver, implementation: 'REAL' as const }]),
];
const inventoryIssues = checkProviderInventory(config, providerInventory);
if (inventoryIssues.length > 0) {
  console.error(formatEnvFailure('worker', inventoryIssues));
  process.exit(1);
}
console.log(`[worker] 外部能力驱动：${providerInventory.length === 0 ? '（无）' : providerInventory.map((entry) => `${entry.capability}=${entry.driver}:${entry.implementation}`).join('、')}`);
const mediaVisualAnalysisAdapter = visualDriver === 'anthropic' && config.ANTHROPIC_API_KEY !== undefined
  ? createModelVisualAnalysisAdapter({ model: new AnthropicAgentModel({ apiKey: config.ANTHROPIC_API_KEY, model: config.ANCS_VISION_MODEL ?? 'claude-haiku-5-5' }), ...ffmpegPaths })
  : visualDriver === 'process' && config.ANCS_VISUAL_ANALYSIS_EXECUTABLE !== undefined
    ? createProcessMediaVisualAnalysisAdapter({
      executable: config.ANCS_VISUAL_ANALYSIS_EXECUTABLE,
      args: config.ANCS_VISUAL_ANALYSIS_ARGS_JSON === undefined ? [] : JSON.parse(config.ANCS_VISUAL_ANALYSIS_ARGS_JSON) as string[],
    })
    : undefined;
const mediaAudioAnalysisAdapter = config.ANCS_AUDIO_ANALYSIS_EXECUTABLE === undefined ? undefined : createProcessMediaAudioAnalysisAdapter({
  executable: config.ANCS_AUDIO_ANALYSIS_EXECUTABLE,
  args: config.ANCS_AUDIO_ANALYSIS_ARGS_JSON === undefined ? [] : JSON.parse(config.ANCS_AUDIO_ANALYSIS_ARGS_JSON) as string[],
});
// V5-M4：工作流定义（素材工程终渲染：FFmpeg 媒体图后端 + 真实输出探测）。不依赖 Remotion/Chromium，
// 因此 ANCS_DISABLE_RENDER 不影响它；FFmpeg 缺失时推进会显式失败（工作流运行 FAILED，带错误）。
const workflowRegistry = new WorkflowRegistry()
  .register(compositionFinalRenderWorkflow({
    executor: createFfmpegRenderPlanExecutor(ffmpegPaths),
    outputProbe: sourceMediaProbe,
  }))
  // V6-1：通用导演 Agent 轮次（统一工具目录 + 可续跑循环；改动以提案交给用户采用）
  .register(agentTurnWorkflow({ model: agentModel, frames: frameSampler }));
// V6-1d：低清预览（与终渲染同一 FFmpeg 媒体图后端，按时间窗缓存复用）
const previewExecutor = { executor: createFfmpegRenderPlanExecutor(ffmpegPaths), ...(config.ANCS_FFMPEG_PATH === undefined ? {} : { ffmpegPath: config.ANCS_FFMPEG_PATH }) };
// P07-04：Final 合成任务注册（进程隔离渲染执行器；ANCS_DISABLE_RENDER=1 可显式关闭，
// 此时 RENDER_FINAL 落入"未知类型 → FAILED_FINAL"——明确失败，不静默吞）
const registry: JobHandlerRegistry =
  config.ANCS_DISABLE_RENDER === '1'
    ? createDefaultRegistry({ sourceMediaProbe, sourceMediaTranscoder, sourceMediaIndexer, speechRecognitionAdapter, mediaVisualAnalysisAdapter, mediaAudioAnalysisAdapter, workflowRegistry, previewExecutor })
    : createDefaultRegistry({
        renderExecutor: createProcessRenderExecutor(commandOf(config.ANCS_RENDER_EXECUTOR_CMD)),
        motionValidator: createProcessMotionValidator(commandOf(config.ANCS_MOTION_VALIDATOR_CMD)),
        mediaProbe: createProcessMediaProbe(commandOf(config.ANCS_MEDIA_PROBE_CMD)),
        sourceMediaProbe,
        sourceMediaTranscoder,
        sourceMediaIndexer,
        speechRecognitionAdapter,
        mediaVisualAnalysisAdapter,
        mediaAudioAnalysisAdapter,
        workflowRegistry,
        previewExecutor,
      });

let stopping = false;
const stop = (signal: string): void => {
  stopping = true;
  console.log(`[worker ${workerId}] 收到 ${signal}，当前任务完成后退出。`);
};
process.on('SIGINT', () => {
  stop('SIGINT');
});
process.on('SIGTERM', () => {
  stop('SIGTERM');
});

async function tick(): Promise<number> {
  // 1) 维护（可重入）：租约回收（崩溃恢复）→ 重试退避推进 → 孤儿依赖检查 → Outbox 派发
  const tickReport = await runMaintenanceTick(deps, { limit: 50 });
  if (tickReport.leases.requeued > 0) {
    console.log(`[worker ${workerId}] 租约回收：${String(tickReport.leases.requeued)}（需对账 ${String(tickReport.leases.needsReconciliation)}）`);
  }
  if (tickReport.retries.promoted > 0 || tickReport.dependents.resolved > 0) {
    console.log(
      `[worker ${workerId}] 恢复推进：重试升级 ${String(tickReport.retries.promoted)}、孤儿依赖解析 ${String(tickReport.dependents.resolved)}`,
    );
  }
  if (tickReport.dispatch.enqueued > 0 || tickReport.dispatch.failed > 0) {
    console.log(`[worker ${workerId}] 派发：enqueued=${String(tickReport.dispatch.enqueued)} failed=${String(tickReport.dispatch.failed)}`);
  }

  // 2) 认领并执行
  let executed = 0;
  for (;;) {
    if (stopping) break;
    const claimed = await claimJob(deps, { workerId, leaseSeconds, types: registry.types() });
    if (claimed === null) break;
    console.log(`[worker ${workerId}] 认领 ${claimed.id}（${claimed.type}，attempt ${String(claimed.attempts)}）`);
    const outcome = await executeJob(
      deps,
      registry,
      {
        workerId,
        leaseSeconds,
        heartbeatIntervalMs,
        onPhase: (phase) => {
          if (crashAt !== '' && crashAt === phase) {
            console.error(`[worker ${workerId}] 故障注入：在 ${phase} 阶段退出（模拟 Worker 崩溃）`);
            process.exit(86);
          }
        },
      },
      claimed,
    );
    console.log(`[worker ${workerId}] 完成 ${claimed.id} → ${outcome}`);
    executed += 1;
    if (once) break;
  }
  return executed;
}

try {
  let total = 0;
  if (once) {
    total += await tick();
  } else {
    while (!stopping) {
      total += await tick();
      if (stopping) break;
      await new Promise((resolve) => setTimeout(resolve, tickIntervalMs));
    }
  }
  console.log(JSON.stringify({ workerId, database: redactDatabaseUrl(databaseUrl), executed: total }));
  await deps.queue?.close?.();
  await handle.close();
  process.exit(0);
} catch (error) {
  console.error(`Worker 失败：${error instanceof Error ? error.message : String(error)}`);
  await handle.close().catch(() => undefined);
  process.exit(1);
}
