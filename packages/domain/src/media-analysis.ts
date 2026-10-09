import { createHash } from 'node:crypto';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_AUDIO_ANALYSIS_JOB_TYPE,
  MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION,
  MEDIA_ANALYSIS_STAGES,
  MEDIA_INDEX_ANALYSIS_CONFIG_HASH,
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  MEDIA_VISUAL_ANALYSIS_JOB_TYPE,
  MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
  mediaAnalysisGraphSchema,
  mediaAnalysisStageNameSchema,
  rebuildMediaAnalysisStageRequestSchema,
  type MediaAnalysisGraph,
  type MediaAnalysisStageName,
  type MediaAnalysisStageStatus,
  type RebuildMediaAnalysisStageRequest,
} from '@ancs/contracts';
import { assets, assetVersions, jobs, mediaAnalysisStages, mediaDerivatives, mediaIndexRuns, mediaTranscriptRuns } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { cancelJob } from './jobs.js';
import { rebuildMediaIndex } from './media-index.js';
import { rebuildMediaProxy } from './media-proxies.js';
import { retryMediaTranscript } from './media-transcripts.js';
import { MEDIA_VISUAL_ANALYSIS_CONFIG_HASH, retryMediaVisualAnalysis } from './media-visual-analysis.js';
import { MEDIA_AUDIO_ANALYSIS_CONFIG_HASH, retryMediaAudioAnalysis } from './media-audio-analysis.js';

const dependencies: Record<MediaAnalysisStageName, MediaAnalysisStageName[]> = {
  PROBE: [], PROXY: ['PROBE'], WAVEFORM: ['PROBE'], ASR: ['PROBE'], SHOT: ['PROBE'],
  SAMPLING: ['PROBE'], VISION: ['SAMPLING'], OCR: ['SAMPLING'], AUDIO: ['WAVEFORM'],
  EMBEDDINGS: ['ASR', 'VISION', 'OCR', 'AUDIO'], SEARCH_INDEX: ['EMBEDDINGS'],
};
const defaultConfig: Record<MediaAnalysisStageName, string> = Object.fromEntries(MEDIA_ANALYSIS_STAGES.map((stage) => [stage, createHash('sha256').update(`ancs-media-analysis\0${stage}\0v1`).digest('hex')])) as Record<MediaAnalysisStageName, string>;
defaultConfig.WAVEFORM = MEDIA_INDEX_ANALYSIS_CONFIG_HASH;
defaultConfig.SHOT = MEDIA_INDEX_ANALYSIS_CONFIG_HASH;
defaultConfig.ASR = createHash('sha256').update(MEDIA_TRANSCRIPT_PROCESSOR_VERSION).digest('hex');
defaultConfig.SAMPLING = MEDIA_VISUAL_ANALYSIS_CONFIG_HASH;
defaultConfig.VISION = MEDIA_VISUAL_ANALYSIS_CONFIG_HASH;
defaultConfig.AUDIO = MEDIA_AUDIO_ANALYSIS_CONFIG_HASH;

const stableId = (versionId: string, stage: MediaAnalysisStageName): string => `mas_${createHash('sha256').update(`${versionId}\0${stage}`).digest('hex').slice(0, 24)}`;
const stageForJob = (stage: MediaAnalysisStageName): string | null => stage === 'PROBE' ? 'ASSET_MEDIA_PROBE' : stage === 'PROXY' ? 'MEDIA_PROXY' : stage === 'WAVEFORM' || stage === 'SHOT' ? 'MEDIA_INDEX' : stage === 'ASR' ? 'MEDIA_TRANSCRIPT' : stage === 'SAMPLING' || stage === 'VISION' ? MEDIA_VISUAL_ANALYSIS_JOB_TYPE : stage === 'AUDIO' ? MEDIA_AUDIO_ANALYSIS_JOB_TYPE : null;

function jobStatus(status: string): MediaAnalysisStageStatus {
  if (status === 'QUEUED' || status === 'WAITING_DEPENDENCY') return 'QUEUED';
  if (status === 'RUNNING' || status === 'PROVIDER_QUEUED') return 'RUNNING';
  if (status === 'CANCEL_REQUESTED') return 'CANCEL_REQUESTED';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (status === 'FAILED_RETRYABLE' || status === 'FAILED_FINAL') return 'FAILED';
  return 'NOT_REQUESTED';
}

export async function getMediaAnalysisGraph(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<MediaAnalysisGraph> {
  const sourceRows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), eq(assetVersions.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(1);
  const source = sourceRows[0];
  if (!source) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'asset not found', 404);
  const [derivativeRows, indexRows, visualRows, audioRows, transcriptRows, existingRows, jobRows] = await Promise.all([
    deps.db.select().from(mediaDerivatives).where(and(eq(mediaDerivatives.workspaceId, input.workspaceId), eq(mediaDerivatives.sourceAssetVersionId, source.version.id), eq(mediaDerivatives.kind, 'PROXY'))).orderBy(desc(mediaDerivatives.updatedAt)).limit(1),
    deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, source.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_INDEX_PROCESSOR_VERSION))).orderBy(desc(mediaIndexRuns.updatedAt)).limit(1),
    deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, source.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION))).orderBy(desc(mediaIndexRuns.updatedAt)).limit(1),
    deps.db.select().from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), eq(mediaIndexRuns.sourceAssetVersionId, source.version.id), eq(mediaIndexRuns.processorVersion, MEDIA_AUDIO_ANALYSIS_PROCESSOR_VERSION))).orderBy(desc(mediaIndexRuns.updatedAt)).limit(1),
    deps.db.select().from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(mediaTranscriptRuns.sourceAssetVersionId, source.version.id))).orderBy(desc(mediaTranscriptRuns.updatedAt)).limit(1),
    deps.db.select().from(mediaAnalysisStages).where(and(eq(mediaAnalysisStages.workspaceId, input.workspaceId), eq(mediaAnalysisStages.sourceAssetVersionId, source.version.id))),
    deps.db.select().from(jobs).where(eq(jobs.workspaceId, input.workspaceId)).orderBy(desc(jobs.createdAt)).limit(500),
  ]);
  const derivative = derivativeRows[0]; const indexRun = indexRows[0]; const visualRun = visualRows[0]; const audioRun = audioRows[0]; const transcriptRun = transcriptRows[0];
  const currentByStage = new Map(existingRows.map((row) => [row.stage, row]));
  const relevantJobs = jobRows.filter((job) => {
    const payload = job.input as Record<string, unknown>;
    return payload['sourceAssetVersionId'] === source.version.id || payload['assetVersionId'] === source.version.id;
  });
  const now = new Date();
  const values = MEDIA_ANALYSIS_STAGES.map((stage) => {
    const current = currentByStage.get(stage);
    const config = current?.detectorConfigHash ?? defaultConfig[stage];
    const type = stageForJob(stage);
    const job = type === null ? undefined : relevantJobs.find((candidate) => candidate.type === type);
    let status: MediaAnalysisStageStatus = 'DISABLED'; let coveragePermille = 0; let completedUnits = 0; const totalUnits: number | null = source.version.durationMs;
    let errorSummary: string | null = null;
    if (stage === 'PROBE') {
      status = source.version.probeStatus === 'READY' ? 'READY' : source.version.probeStatus === 'FAILED' ? 'FAILED' : source.version.probeStatus === 'PROCESSING' ? 'RUNNING' : source.version.probeStatus === 'PENDING' ? 'QUEUED' : 'DISABLED';
      coveragePermille = status === 'READY' ? 1000 : 0; completedUnits = status === 'READY' ? source.version.durationMs ?? 1 : 0;
    } else if (stage === 'PROXY') {
      status = derivative === undefined ? (source.version.probeStatus === 'READY' ? 'NOT_REQUESTED' : 'NOT_REQUESTED') : derivative.status === 'READY' ? 'READY' : derivative.status === 'FAILED' ? 'FAILED' : derivative.status === 'PROCESSING' ? 'RUNNING' : 'QUEUED';
      coveragePermille = status === 'READY' ? 1000 : 0; completedUnits = status === 'READY' ? source.version.durationMs ?? 1 : 0; errorSummary = derivative?.errorSummary ?? null;
    } else if (stage === 'WAVEFORM' || stage === 'SHOT') {
      status = indexRun === undefined ? 'NOT_REQUESTED' : indexRun.status === 'READY' ? 'READY' : indexRun.status === 'EMPTY' ? 'EMPTY' : indexRun.status === 'FAILED' ? 'FAILED' : indexRun.status === 'STALE' ? 'STALE' : indexRun.status === 'PARTIAL' ? 'PARTIAL' : indexRun.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
      coveragePermille = indexRun?.coveragePermille ?? 0; completedUnits = indexRun?.checkpointMs ?? 0; errorSummary = indexRun?.errorSummary ?? null;
    } else if (stage === 'ASR') {
      status = transcriptRun === undefined ? 'NOT_REQUESTED' : transcriptRun.status === 'READY' ? 'READY' : transcriptRun.status === 'FAILED' ? 'FAILED' : transcriptRun.status === 'STALE' ? 'STALE' : transcriptRun.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
      coveragePermille = status === 'READY' ? 1000 : 0; completedUnits = status === 'READY' ? source.version.durationMs ?? 1 : 0; errorSummary = transcriptRun?.errorSummary ?? null;
    } else if (stage === 'SAMPLING' || stage === 'VISION') {
      status = visualRun === undefined ? 'NOT_REQUESTED' : visualRun.status === 'READY' ? 'READY' : visualRun.status === 'EMPTY' ? 'EMPTY' : visualRun.status === 'FAILED' ? 'FAILED' : visualRun.status === 'STALE' ? 'STALE' : visualRun.status === 'PARTIAL' ? 'PARTIAL' : visualRun.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
      coveragePermille = visualRun?.coveragePermille ?? 0; completedUnits = visualRun?.checkpointMs ?? 0; errorSummary = visualRun?.errorSummary ?? null;
    } else if (stage === 'AUDIO') {
      status = audioRun === undefined ? 'NOT_REQUESTED' : audioRun.status === 'READY' ? 'READY' : audioRun.status === 'EMPTY' ? 'EMPTY' : audioRun.status === 'FAILED' ? 'FAILED' : audioRun.status === 'STALE' ? 'STALE' : audioRun.status === 'PARTIAL' ? 'PARTIAL' : audioRun.status === 'RUNNING' ? 'RUNNING' : 'QUEUED';
      coveragePermille = audioRun?.coveragePermille ?? 0; completedUnits = audioRun?.checkpointMs ?? 0; errorSummary = audioRun?.errorSummary ?? null;
    }
    if (job !== undefined && !['READY', 'EMPTY', 'FAILED', 'STALE', 'DISABLED', 'PARTIAL'].includes(status)) status = jobStatus(job.status);
    const fingerprint = createHash('sha256').update([source.version.checksumSha256 ?? source.version.id, stage, config, ...dependencies[stage].map((dependency) => currentByStage.get(dependency)?.detectorConfigHash ?? defaultConfig[dependency])].join('\0')).digest('hex');
    return { id: stableId(source.version.id, stage), workspaceId: input.workspaceId, sourceAssetVersionId: source.version.id, stage, status, dependencies: dependencies[stage], coveragePermille, checkpoint: { cursor: completedUnits > 0 ? String(completedUnits) : null, completedUnits, totalUnits }, detectorConfigHash: config, inputFingerprint: fingerprint, jobId: job?.id ?? null, budgetMicros: null, spentMicros: current?.spentMicros ?? 0, errorSummary, updatedAt: now };
  });
  await deps.db.transaction(async (tx) => {
    for (const value of values) await tx.insert(mediaAnalysisStages).values(value).onConflictDoUpdate({ target: [mediaAnalysisStages.sourceAssetVersionId, mediaAnalysisStages.stage], set: { status: value.status, dependencies: value.dependencies, coveragePermille: value.coveragePermille, checkpoint: value.checkpoint, inputFingerprint: value.inputFingerprint, jobId: value.jobId, errorSummary: value.errorSummary, updatedAt: now } });
  });
  return mediaAnalysisGraphSchema.parse({
    assetId: source.asset.id,
    sourceAssetVersionId: source.version.id,
    playable: source.version.status === 'READY' && (source.version.probeStatus === 'READY' || source.version.probeStatus === 'NOT_REQUIRED'),
    deterministicEditingReady: source.version.status === 'READY' && source.version.probeStatus === 'READY',
    stages: values.map((value) => ({ id: value.id, stage: value.stage, dependencies: value.dependencies, status: value.status, coveragePermille: value.coveragePermille, checkpoint: value.checkpoint, detectorConfigHash: value.detectorConfigHash, inputFingerprint: value.inputFingerprint, jobId: value.jobId, budgetMicros: value.budgetMicros, spentMicros: value.spentMicros, errorSummary: value.errorSummary, reusable: value.status === 'READY' || value.status === 'EMPTY', updatedAt: value.updatedAt.toISOString() })),
  });
}

function downstream(stage: MediaAnalysisStageName): MediaAnalysisStageName[] {
  const result = new Set<MediaAnalysisStageName>([stage]);
  let changed = true;
  while (changed) { changed = false; for (const candidate of MEDIA_ANALYSIS_STAGES) if (!result.has(candidate) && dependencies[candidate].some((dependency) => result.has(dependency))) { result.add(candidate); changed = true; } }
  return [...result];
}

export async function rebuildMediaAnalysisStage(deps: DomainDeps, input: { workspaceId: string; assetId: string; stage: MediaAnalysisStageName; request: RebuildMediaAnalysisStageRequest }): Promise<MediaAnalysisGraph> {
  const stage = mediaAnalysisStageNameSchema.parse(input.stage); const request = rebuildMediaAnalysisStageRequestSchema.parse(input.request);
  const graph = await getMediaAnalysisGraph(deps, input);
  const current = graph.stages.find((candidate) => candidate.stage === stage)!;
  if (current.status === 'DISABLED') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'analysis detector is disabled', 409, { stage });
  // Keep every update workspace-scoped and explicit so unrelated branches remain reusable.
  for (const candidate of downstream(stage)) await deps.db.update(mediaAnalysisStages).set({ status: 'STALE', ...(candidate === stage ? { detectorConfigHash: request.detectorConfigHash } : {}), invalidatedAt: new Date(), updatedAt: new Date() }).where(and(eq(mediaAnalysisStages.workspaceId, input.workspaceId), eq(mediaAnalysisStages.sourceAssetVersionId, graph.sourceAssetVersionId), eq(mediaAnalysisStages.stage, candidate)));
  if (stage === 'PROXY') {
    await deps.db.update(mediaDerivatives).set({ status: 'FAILED', errorSummary: '配置已变化，等待局部重建。', updatedAt: new Date() }).where(and(eq(mediaDerivatives.workspaceId, input.workspaceId), eq(mediaDerivatives.sourceAssetVersionId, graph.sourceAssetVersionId), eq(mediaDerivatives.kind, 'PROXY')));
    await rebuildMediaProxy(deps, input);
  }
  else if (stage === 'WAVEFORM' || stage === 'SHOT') await rebuildMediaIndex(deps, input);
  else if (stage === 'ASR') {
    await deps.db.update(mediaTranscriptRuns).set({ status: 'STALE', updatedAt: new Date() }).where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), eq(mediaTranscriptRuns.sourceAssetVersionId, graph.sourceAssetVersionId)));
    await retryMediaTranscript(deps, input);
  } else if (stage === 'SAMPLING' || stage === 'VISION') {
    await retryMediaVisualAnalysis(deps, { ...input, analysisConfigHash: request.detectorConfigHash });
  } else if (stage === 'AUDIO') {
    await retryMediaAudioAnalysis(deps, { ...input, analysisConfigHash: request.detectorConfigHash });
  } else throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'analysis stage cannot be rebuilt directly', 409, { stage });
  return getMediaAnalysisGraph(deps, input);
}

export async function cancelMediaAnalysisStage(deps: DomainDeps, input: { workspaceId: string; assetId: string; stage: MediaAnalysisStageName }): Promise<MediaAnalysisGraph> {
  const stage = mediaAnalysisStageNameSchema.parse(input.stage); const graph = await getMediaAnalysisGraph(deps, input); const current = graph.stages.find((candidate) => candidate.stage === stage)!;
  if (current.jobId === null || !['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'].includes(current.status)) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'analysis stage has no cancellable job', 409, { stage, status: current.status });
  const job = await cancelJob(deps, { workspaceId: input.workspaceId, jobId: current.jobId, reason: `MEDIA_ANALYSIS_${stage}_CANCELLED` });
  await deps.db.update(mediaAnalysisStages).set({ status: job.status === 'CANCELLED' ? 'CANCELLED' : 'CANCEL_REQUESTED', updatedAt: new Date() }).where(and(eq(mediaAnalysisStages.workspaceId, input.workspaceId), eq(mediaAnalysisStages.sourceAssetVersionId, graph.sourceAssetVersionId), eq(mediaAnalysisStages.stage, stage)));
  return getMediaAnalysisGraph(deps, input);
}
