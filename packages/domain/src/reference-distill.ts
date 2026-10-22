import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  AGENT_ERROR_REASONS,
  ApiFailure,
  DISTILL_ERROR_REASONS,
  ERROR_CODES,
  MAX_REFERENCE_ANALYSIS_SECONDS,
  REFERENCE_DISTILL_WORKFLOW,
  REFERENCE_DISTILL_WORKFLOW_VERSION,
  ReferenceFetchError,
  distillRunSchema,
  referenceMeasurementSchema,
  startDistillRequestSchema,
  strategyPackSchema,
  updateStrategyPackRequestSchema,
  type AgentFrameSampler,
  type AgentImage,
  type AgentModelAdapter,
  type DistillRun,
  type ReferenceAnalyzer,
  type ReferenceFetcher,
  type ReferenceMeasurement,
  type StartDistillRequest,
  type StrategyPack,
  type UpdateStrategyPackRequest,
} from '@ancs/contracts';
import { assets, assetVersions, strategyPacks, workflowRuns } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { workspaceAiSpend } from './ai-spend.js';
import { distillStats, editingDnaFromStats } from './distill-dna.js';
import { composeStrategyFromStats, composeStrategyWithModel, type ComposedPack, type DistillSource } from './distill-compose.js';
import { getStrategyPack, saveStrategyPack } from './strategies.js';
import { listUnifiedMediaIndex } from './unified-media-index.js';
import { getWorkflowRun, startWorkflow, type WorkflowDefinition, type WorkflowStepContext } from './workflow.js';

/**
 * 蒸馏工作流（V6-6，V6 §6.7）：抓取 → 分析 → 撰写 → 保存。外部调用（链接抓取、模型撰写）只在工作流里发生；
 * 每一步都可续跑（抓取按运行 + 序号复用已存的参考视频，保存用确定的包 id），付费的撰写步骤最多重试一次。
 * 参考视频存为工作区资产（不属于任何作品），记录来源链接；版权由项目所有者负责，系统不内置审查。
 */

export interface ReferenceDistillPorts {
  analyzer?: ReferenceAnalyzer;
  fetcher?: ReferenceFetcher;
  /** 给模型看的抽帧（Worker 装配） */
  frames?: AgentFrameSampler;
  /** 导演模型（配置了才用模型写说明；没配置用统计规则） */
  model?: AgentModelAdapter;
  workDirRoot?: string;
  /** 链接抓取的大小上限（字节） */
  maxReferenceBytes?: number;
}

const DEFAULT_MAX_REFERENCE_BYTES = 1024 * 1024 * 1024;
const MODEL_FRAMES = 6;

interface ResolvedReference {
  index: number;
  label: string;
  url: string | null;
  assetId: string;
  versionId: string;
  storageKey: string;
}

const fail = (reason: string, message: string, status: number, details: Record<string, unknown> = {}): ApiFailure =>
  new ApiFailure(status === 404 ? ERROR_CODES.NOT_FOUND : status === 409 ? ERROR_CODES.PRECONDITION_FAILED : status === 501 ? ERROR_CODES.CAPABILITY_UNAVAILABLE : status === 415 ? ERROR_CODES.UNSUPPORTED_MEDIA_TYPE : status >= 500 ? ERROR_CODES.INTERNAL : ERROR_CODES.VALIDATION_FAILED, message, status, { reason, ...details });

function fetchFailure(error: ReferenceFetchError): ApiFailure {
  switch (error.failure) {
    case 'NOT_CONFIGURED': return fail(DISTILL_ERROR_REASONS.FETCH_NOT_CONFIGURED, error.message, 501);
    case 'BLOCKED': return fail(DISTILL_ERROR_REASONS.FETCH_BLOCKED, error.message, 422);
    case 'TOO_LARGE': return fail(DISTILL_ERROR_REASONS.TOO_LARGE, error.message, 413);
    case 'NOT_VIDEO': return fail(DISTILL_ERROR_REASONS.NOT_VIDEO, error.message, 415);
    default: return fail(DISTILL_ERROR_REASONS.FETCH_FAILED, error.message, 502);
  }
}

async function loadReferenceAsset(deps: DomainDeps, workspaceId: string, assetId: string): Promise<{ label: string; versionId: string; storageKey: string; mimeType: string }> {
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId), isNull(assets.deletedAt))).limit(1);
  const row = rows[0];
  if (row === undefined) throw fail(DISTILL_ERROR_REASONS.ASSET_NOT_READY, 'reference video not found', 404);
  if (row.version === null || row.version.status !== 'READY') throw fail(DISTILL_ERROR_REASONS.ASSET_NOT_READY, 'the reference video has not finished uploading', 409);
  if (!row.version.mimeType.startsWith('video/')) throw fail(DISTILL_ERROR_REASONS.NOT_VIDEO, 'the reference is not a video', 415);
  const filename = (row.asset.metadata as { filename?: unknown } | null)?.filename;
  return { label: typeof filename === 'string' && filename !== '' ? filename.slice(0, 200) : assetId, versionId: row.version.id, storageKey: row.version.storageKey, mimeType: row.version.mimeType };
}

// ---------------------------------------------------------------------------
// 启动与读取
// ---------------------------------------------------------------------------

export async function startReferenceDistill(deps: DomainDeps, input: { workspaceId: string; request: StartDistillRequest; createdBy?: string | null; idempotencyKey?: string | null }): Promise<DistillRun> {
  const request = startDistillRequestSchema.parse(input.request);
  // 上传的参考视频在发起时就校验（不存在 / 还没传完 / 不是视频 → 立刻告诉用户）
  for (const reference of request.references) if ('assetId' in reference) await loadReferenceAsset(deps, input.workspaceId, reference.assetId);
  const run = await startWorkflow(deps, {
    workspaceId: input.workspaceId,
    projectId: null,
    type: REFERENCE_DISTILL_WORKFLOW,
    version: REFERENCE_DISTILL_WORKFLOW_VERSION,
    subjectRef: `distill:${String(request.references.length)}`,
    input: { references: request.references, name: request.name, locale: request.locale },
    idempotencyKey: input.idempotencyKey ?? null,
    createdBy: input.createdBy ?? null,
  });
  return getReferenceDistill(deps, { workspaceId: input.workspaceId, runId: run.id });
}

export async function getReferenceDistill(deps: DomainDeps, input: { workspaceId: string; runId: string }): Promise<DistillRun> {
  const run = await getWorkflowRun(deps, input);
  if (run.type !== REFERENCE_DISTILL_WORKFLOW) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'distill run not found', 404);
  const requested = (run.outputs['fetch'] as { references?: ResolvedReference[] } | undefined)?.references;
  const inputs = (await deps.db.select({ input: workflowRuns.input }).from(workflowRuns).where(eq(workflowRuns.id, run.id)).limit(1))[0]?.input as { references?: ({ assetId: string } | { url: string })[] } | undefined;
  const references = requested !== undefined
    ? requested.map((item) => ({ label: item.label, url: item.url, assetId: item.assetId }))
    : (inputs?.references ?? []).map((item) => ('url' in item ? { label: item.url, url: item.url, assetId: null } : { label: item.assetId, url: null, assetId: item.assetId }));
  const failedStep = run.steps.filter((step) => step.status === 'FAILED').at(-1);
  const order = ['fetch', 'analyze', 'compose', 'save'] as const;
  const done = new Set(run.steps.filter((step) => step.status === 'SUCCEEDED').map((step) => step.stepKey));
  const step = run.status === 'SUCCEEDED' ? 'save' : (failedStep?.stepKey as (typeof order)[number] | undefined) ?? order.find((key) => !done.has(key)) ?? null;
  const errorDetails = (run.error as { details?: { reason?: unknown }; message?: unknown } | null);
  const status = run.status === 'SUCCEEDED' ? 'SUCCEEDED' : run.status === 'FAILED' ? 'FAILED' : run.status === 'CANCELLED' ? 'CANCELLED' : 'RUNNING';
  return distillRunSchema.parse({
    runId: run.id,
    status,
    step,
    references,
    packId: (run.outputs['save'] as { packId?: string } | undefined)?.packId ?? null,
    composer: (run.outputs['compose'] as { composer?: 'MODEL' | 'RULES' } | undefined)?.composer ?? null,
    error: status !== 'FAILED' || errorDetails === null ? null : {
      reason: typeof errorDetails.details?.reason === 'string' ? errorDetails.details.reason : 'DISTILL_FAILED',
      message: typeof errorDetails.message === 'string' ? errorDetails.message.slice(0, 500) : 'distill failed',
    },
    createdAt: run.createdAt,
  });
}

// ---------------------------------------------------------------------------
// 工作流
// ---------------------------------------------------------------------------

const inputOf = (context: WorkflowStepContext) => startDistillRequestSchema.parse(context.run.input);

/** 转写层 → 说话占比、语速（中文按字计）、第一句结束时刻。没有完成的转写（未配置、失败、仍在进行）→ null（不当作"没有说话"）。 */
async function speechOf(deps: DomainDeps, workspaceId: string, assetId: string, analyzedSeconds: number): Promise<ReferenceMeasurement['speech']> {
  let page = await listUnifiedMediaIndex(deps, { workspaceId, assetId, query: { kind: 'TRANSCRIPT_SEGMENT', limit: 100 } }).catch(() => null);
  if (page === null) return null;
  const status = page.capabilities.find((item) => item.kind === 'TRANSCRIPT_SEGMENT')?.status;
  if (status !== 'READY' && status !== 'EMPTY') return null;
  const items = [...page.items];
  for (let pages = 1; page.nextCursor !== null && pages < 30; pages += 1) {
    page = await listUnifiedMediaIndex(deps, { workspaceId, assetId, query: { kind: 'TRANSCRIPT_SEGMENT', limit: 100, cursor: Number(page.nextCursor) } });
    items.push(...page.items);
  }
  const at = (pts: string, base: { numerator: number; denominator: number }) => (Number(pts) * base.numerator) / base.denominator;
  const segments = items.map((item) => ({ start: at(item.sourceRange.startPts, item.sourceRange.timeBase), end: at(item.sourceRange.endPts, item.sourceRange.timeBase), text: String((item.payload as { text?: unknown }).text ?? '') }))
    .filter((segment) => segment.start < analyzedSeconds).sort((left, right) => left.start - right.start);
  const spoken = segments.reduce((sum, segment) => sum + Math.max(0, Math.min(segment.end, analyzedSeconds) - segment.start), 0);
  const words = segments.reduce((sum, segment) => sum + (segment.text.match(/[㐀-鿿]/g)?.length ?? 0) + (segment.text.replace(/[㐀-鿿]/g, ' ').match(/[A-Za-z0-9'’-]+/g)?.length ?? 0), 0);
  return {
    ratio: Math.round(Math.min(1, spoken / analyzedSeconds) * 1000) / 1000,
    wordsPerMinute: spoken < 5 ? null : Math.round(words / (spoken / 60)),
    firstSentenceEnd: segments[0] === undefined ? null : Math.round(segments[0].end * 100) / 100,
  };
}

/** 给模型看的抽帧时刻：各参考视频的镜头中点，均匀取 MODEL_FRAMES 张。 */
function frameTimes(references: readonly ResolvedReference[], measurements: readonly ReferenceMeasurement[]): { reference: ResolvedReference; times: string[] }[] {
  const perReference = Math.max(1, Math.floor(MODEL_FRAMES / references.length));
  return references.map((reference, index) => {
    const m = measurements[index]!;
    const bounds = [0, ...m.cuts, m.analyzedSeconds];
    const mids = bounds.slice(1).map((end, i) => (bounds[i]! + end) / 2);
    const picks = Array.from({ length: Math.min(perReference, mids.length) }, (_, k) => mids[Math.floor(((k + 0.5) * mids.length) / perReference)]!);
    return { reference, times: picks.map((time) => time.toFixed(3)) };
  });
}

export function referenceDistillWorkflow(ports: ReferenceDistillPorts): WorkflowDefinition {
  const maxBytes = ports.maxReferenceBytes ?? DEFAULT_MAX_REFERENCE_BYTES;
  return {
    type: REFERENCE_DISTILL_WORKFLOW,
    version: REFERENCE_DISTILL_WORKFLOW_VERSION,
    steps: [
      {
        key: 'fetch',
        maxAttempts: 2,
        async run(context) {
          const { references } = inputOf(context);
          const storage = context.deps.storage;
          const resolved: ResolvedReference[] = [];
          for (const [index, reference] of references.entries()) {
            if ('assetId' in reference) {
              const asset = await loadReferenceAsset(context.deps, context.run.workspaceId, reference.assetId);
              resolved.push({ index, label: asset.label, url: null, assetId: reference.assetId, versionId: asset.versionId, storageKey: asset.storageKey });
              continue;
            }
            // 续跑：这次运行这一序号已经抓过 → 复用
            const existing = (await context.deps.db.select({ asset: assets, version: assetVersions }).from(assets)
              .innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
              .where(and(eq(assets.workspaceId, context.run.workspaceId), sql`(${assets.metadata} ->> 'distillRunId') = ${context.run.id}`, sql`(${assets.metadata} ->> 'referenceIndex') = ${String(index)}`)).limit(1))[0];
            if (existing !== undefined) {
              const filename = (existing.asset.metadata as { filename?: string }).filename ?? reference.url;
              resolved.push({ index, label: filename, url: reference.url, assetId: existing.asset.id, versionId: existing.version.id, storageKey: existing.version.storageKey });
              continue;
            }
            if (ports.fetcher === undefined) throw fail(DISTILL_ERROR_REASONS.FETCH_NOT_CONFIGURED, 'link fetching is not available in this deployment; upload the video file instead', 501);
            if (storage === undefined) throw fail(DISTILL_ERROR_REASONS.FETCH_FAILED, 'object storage is not configured', 501);
            const workDir = await mkdtemp(join(ports.workDirRoot ?? tmpdir(), 'ancs-reference-'));
            try {
              let fetched: Awaited<ReturnType<ReferenceFetcher['fetch']>>;
              try {
                fetched = await ports.fetcher.fetch({ url: reference.url, workDir, maxBytes });
              } catch (error) {
                // 未配置 / 被拦截 / 太大 / 不是视频 → 4xx/501 不重试；网络失败 → 502 重试一次
                throw error instanceof ReferenceFetchError ? fetchFailure(error) : error;
              }
              const bytes = await readFile(fetched.filePath);
              const assetId = `ast_${randomUUID()}`;
              const versionId = `av_${randomUUID()}`;
              const host = new URL(fetched.finalUrl).hostname;
              const label = (fetched.title ?? `${host}${new URL(reference.url).pathname}`).slice(0, 200);
              const storageKey = `workspaces/${context.run.workspaceId}/references/${versionId}/reference${fetched.contentType === 'video/webm' ? '.webm' : fetched.contentType === 'video/quicktime' ? '.mov' : '.mp4'}`;
              await storage.putObject(storageKey, bytes);
              await context.deps.db.transaction(async (tx) => {
                await tx.insert(assets).values({
                  id: assetId, workspaceId: context.run.workspaceId, projectId: null, assetType: 'USER_UPLOAD', origin: 'PUBLIC_SOURCE', status: 'READY', retentionClass: 'DRAFT_RENDER_30D',
                  license: { type: 'UNKNOWN', holder: null, attribution: null, sourceUrl: reference.url, termsUrl: null, notes: '参考视频：只用于风格分析；版权由项目所有者负责', confirmedBy: null, confirmedAt: null },
                  metadata: { filename: label, mimeType: fetched.contentType, purpose: 'REFERENCE', sourceUrl: reference.url, finalUrl: fetched.finalUrl, distillRunId: context.run.id, referenceIndex: String(index) },
                  currentVersionId: versionId,
                  createdBy: null,
                });
                await tx.insert(assetVersions).values({
                  id: versionId, assetId, workspaceId: context.run.workspaceId, versionNumber: 1, storageKey, mimeType: fetched.contentType, sizeBytes: bytes.byteLength,
                  checksumSha256: createHash('sha256').update(bytes).digest('hex'), status: 'READY', metadata: { sourceUrl: reference.url },
                });
              });
              resolved.push({ index, label, url: reference.url, assetId, versionId, storageKey });
            } finally {
              await rm(workDir, { recursive: true, force: true });
            }
          }
          return { kind: 'DONE', output: { references: resolved } };
        },
      },
      {
        key: 'analyze',
        maxAttempts: 2,
        async run(context) {
          if (ports.analyzer === undefined) throw fail(DISTILL_ERROR_REASONS.ANALYZER_UNAVAILABLE, 'reference analysis is not available in this deployment', 501);
          const storage = context.deps.storage;
          if (storage === undefined) throw fail(DISTILL_ERROR_REASONS.ANALYSIS_FAILED, 'object storage is not configured', 501);
          const { references } = context.run.outputs['fetch'] as { references: ResolvedReference[] };
          const measurements: ReferenceMeasurement[] = [];
          for (const reference of references) {
            const workDir = await mkdtemp(join(ports.workDirRoot ?? tmpdir(), 'ancs-analyze-'));
            try {
              const bytes = await storage.getObject(reference.storageKey);
              if (bytes === null) throw fail(DISTILL_ERROR_REASONS.ANALYSIS_FAILED, 'reference video bytes are missing', 409);
              const filePath = join(workDir, 'reference');
              await writeFile(filePath, bytes);
              let measured: ReferenceMeasurement;
              try {
                measured = await ports.analyzer.analyze({ filePath, label: reference.label, maxSeconds: MAX_REFERENCE_ANALYSIS_SECONDS });
              } catch (error) {
                if (error instanceof ApiFailure) throw error;
                throw fail(DISTILL_ERROR_REASONS.ANALYSIS_FAILED, `could not analyze ${reference.label}: ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`, 422);
              }
              const speech = await speechOf(context.deps, context.run.workspaceId, reference.assetId, measured.analyzedSeconds);
              measurements.push(referenceMeasurementSchema.parse({ ...measured, speech }));
            } finally {
              await rm(workDir, { recursive: true, force: true });
            }
          }
          return { kind: 'DONE', output: { measurements } };
        },
      },
      {
        key: 'compose',
        maxAttempts: 2,
        async run(context) {
          const { name } = inputOf(context);
          const { references } = context.run.outputs['fetch'] as { references: ResolvedReference[] };
          const measurements = (context.run.outputs['analyze'] as { measurements: unknown[] }).measurements.map((item) => referenceMeasurementSchema.parse(item));
          const sources: DistillSource[] = references.map((reference) => ({ label: reference.label, url: reference.url, assetId: reference.assetId }));
          const stats = distillStats(measurements);
          const dna = editingDnaFromStats(stats);
          const base = composeStrategyFromStats({ stats, dna, sources, name });
          if (ports.model === undefined) return { kind: 'DONE', output: { composer: 'RULES', pack: base, stats } };
          // 工作区本月 AI 费用已达上限：改用规则撰写（不调用模型，结果照常可用）
          if ((await workspaceAiSpend(context.deps, { workspaceId: context.run.workspaceId })).reached) {
            return { kind: 'DONE', output: { composer: 'RULES', pack: base, stats, reason: AGENT_ERROR_REASONS.MONTHLY_CAP_REACHED } };
          }
          const images: AgentImage[] = [];
          if (ports.frames !== undefined) {
            for (const { reference, times } of frameTimes(references, measurements)) {
              images.push(...await ports.frames.sample({ storageKey: reference.storageKey, times, maxWidth: 512 }).catch(() => []));
            }
          }
          const composed = await composeStrategyWithModel(ports.model, { stats, base, sources, frames: images, name });
          return { kind: 'DONE', output: { composer: 'MODEL', pack: composed.pack, stats, model: composed.model, costMicros: composed.costMicros, frames: images.length } };
        },
      },
      {
        key: 'save',
        maxAttempts: 2,
        async run(context) {
          const composed = (context.run.outputs['compose'] as { pack: ComposedPack }).pack;
          // 确定的包 id：续跑不会存出第二份
          const pack = await saveStrategyPack(context.deps, { workspaceId: context.run.workspaceId, pack: { ...composed, id: `stp_${context.run.id.replace(/^wfr_/, '')}` } });
          return { kind: 'DONE', output: { packId: pack.id } };
        },
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// 编辑策略包
// ---------------------------------------------------------------------------

/** 编辑蒸馏 / 用户的策略包（只改可读文字；剪辑 DNA 的测量值不可手改）；版本号 +1。 */
export async function updateStrategyPack(deps: DomainDeps, input: { workspaceId: string; packId: string; changes: UpdateStrategyPackRequest }): Promise<StrategyPack> {
  const changes = updateStrategyPackRequestSchema.parse(input.changes);
  const current = await getStrategyPack(deps, { workspaceId: input.workspaceId, packId: input.packId });
  if (current.kind === 'BUILT_IN') throw fail(DISTILL_ERROR_REASONS.PACK_NOT_EDITABLE, 'built-in styles cannot be edited', 409);
  const next = strategyPackSchema.parse({ ...current, ...changes, version: current.version + 1 });
  const rows = await deps.db.update(strategyPacks).set({ version: next.version, pack: next, updatedAt: new Date() })
    .where(and(eq(strategyPacks.id, input.packId), eq(strategyPacks.workspaceId, input.workspaceId), isNull(strategyPacks.deletedAt))).returning({ id: strategyPacks.id });
  if (rows.length === 0) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'strategy pack not found', 404);
  return next;
}
