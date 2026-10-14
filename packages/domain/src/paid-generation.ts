import { createHash, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  ASSET_DEFAULT_RETENTION,
  AVATAR_VOICE_TRACK_PREFIX,
  ApiFailure,
  ERROR_CODES,
  GENERATION_ERROR_REASONS,
  GENERATION_TRACK_PREFIX,
  MICROS_PER_CREDIT,
  OUTSIDE_REGION_CHANGE_THRESHOLD,
  PAID_GENERATION_WORKFLOW,
  PAID_GENERATION_WORKFLOW_VERSION,
  PaidGenerationFailure,
  acceptGenerationRequestSchema,
  compareMediaTime,
  editOperationSchema,
  generationRequestSchema,
  mediaTimeSchema,
  mediaTimeToDisplaySeconds,
  type AcceptGenerationRequest,
  type EditOperation,
  type FrameRegion,
  type Generation,
  type GenerationRequest,
  type MediaTime,
  type PaidGenerationExecutor,
  type PaidGenerationJob,
  type PaidGenerationProduct,
  type Rational,
  type WorkflowErrorClass,
} from '@ancs/contracts';
import type { KernelClip, TimelineState } from '@ancs/kernel';
import { agentSessions, agentTurns, assets, assetVersions, generationRequests, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { effectRegionTransform } from './agent-effects.js';
import { completeGenerationTurn, failGenerationTurn, startGenerationTurn } from './agent-runtime.js';
import { simulateAgentDraft } from './agent-tools.js';
import { getBudget, releaseHold, reserveCredits, settleHold } from './billing.js';
import { identityForGeneration } from './identity-profiles.js';
import { formatMicros, generationCanvas, quoteGeneration, toGeneration, type GenerationRow } from './paid-generation-quote.js';
import { assertProjectGenerationAllowed } from './project-document.js';
import type { WorkflowDefinition } from './workflow.js';

/**
 * V6-7 / V6-8 付费生成：确认 → 预算预留 → 生成一次 → 拉回自有存储 → 放进试改 → 结算（流程见 contracts/paid-generation.ts）。
 *
 * 不变量：
 * - 只有用户确认（API，project:write）能开始；确认的金额必须等于报价上限；未设工作区预算 → 拒绝（fail-closed）；
 * - 生成步骤只执行一次（maxAttempts 1、不可重试）；调用供应商之前记下 provider_called_at，之后的任何中断都进入"待对账"，
 *   绝不再次调用；预留保持到对账（不会悄悄释放或重复扣费）；
 * - 授权与制作规则在报价、确认、调用前各查一次：撤回立即生效；
 * - 结果作为确认这一轮（purpose GENERATE）的提案放进试改，在当前试改上继续；采用/撤回/撤销与其他修改相同；
 * - 结算：供应商报告的费用；没报告 → 按报价上限并标明 QUOTE_MAX；失败且明确未扣费 → 释放预留。
 */

const CORNER_REGION: FrameRegion = { x: 0.67, y: 0.67, width: 0.3, height: 0.3 };

type Locale = 'zh-CN' | 'en';

async function loadGeneration(deps: DomainDeps, input: { workspaceId: string; generationId: string; projectId?: string }): Promise<GenerationRow> {
  const rows = await deps.db.select().from(generationRequests)
    .where(and(eq(generationRequests.id, input.generationId), eq(generationRequests.workspaceId, input.workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined || (input.projectId !== undefined && row.projectId !== input.projectId)) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'generation not found', 404, { reason: GENERATION_ERROR_REASONS.NOT_FOUND });
  }
  return row;
}

async function loadById(deps: DomainDeps, generationId: string): Promise<GenerationRow> {
  const rows = await deps.db.select().from(generationRequests).where(eq(generationRequests.id, generationId)).limit(1);
  if (rows[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'generation not found', 404, { reason: GENERATION_ERROR_REASONS.NOT_FOUND });
  return rows[0];
}

async function sessionLocale(deps: DomainDeps, sessionId: string | null): Promise<Locale> {
  if (sessionId === null) return 'zh-CN';
  const rows = await deps.db.select({ locale: agentSessions.locale }).from(agentSessions).where(eq(agentSessions.id, sessionId)).limit(1);
  return rows[0]?.locale === 'en' ? 'en' : 'zh-CN';
}

/** 规则与授权复查（确认时、调用供应商前各一次）：撤回或换了参考素材 → 需要重新报价。 */
async function assertStillAllowed(deps: DomainDeps, row: GenerationRow): Promise<void> {
  const request = generationRequestSchema.parse(row.request);
  await assertProjectGenerationAllowed(deps, { workspaceId: row.workspaceId, projectId: row.projectId, capability: 'video.generate' });
  if (request.kind !== 'AVATAR_CLIP') return;
  await assertProjectGenerationAllowed(deps, { workspaceId: row.workspaceId, projectId: row.projectId, capability: 'speech.generate' });
  const snapshot = (row.identitySnapshot ?? {}) as { likeness?: { footageId?: string }; voice?: { footageId?: string } };
  const identity = await identityForGeneration(deps, { workspaceId: row.workspaceId, identityId: request.identityId });
  const likeness = identity.parts.LIKENESS;
  const voice = identity.parts.VOICE;
  if (likeness === null || voice === null || likeness.footageId !== snapshot.likeness?.footageId || voice.footageId !== snapshot.voice?.footageId) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the likeness or voice consent was withdrawn or its reference changed; ask for a new quote', 409, {
      reason: GENERATION_ERROR_REASONS.CONSENT_REQUIRED,
    });
  }
}

function confirmMessage(row: GenerationRow, locale: Locale): string {
  const estimate = `${formatMicros(row.estimateMinMicros)}–${formatMicros(row.estimateMaxMicros)}`;
  return locale === 'en' ? `Confirmed: ${row.summary} (estimated ${estimate})` : `确认生成：${row.summary}（预计 ${estimate}）`;
}

/**
 * 用户确认报价：校验（待确认、未过期、金额一致、规则与授权、预算已设置）→ 原子预留预算 → 占用报价 → 发起生成轮次。
 * 重复确认（同一报价已在进行或已完成）返回当前状态，不重复预留、不重复生成。
 */
export async function acceptGeneration(deps: DomainDeps, input: { workspaceId: string; projectId: string; generationId: string; request: AcceptGenerationRequest; actorId: string | null }): Promise<Generation> {
  const request = acceptGenerationRequestSchema.parse(input.request);
  const row = await loadGeneration(deps, input);
  if (row.status !== 'QUOTED') {
    if (row.acceptedAt !== null) return toGeneration(row);
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this quote is no longer waiting for confirmation', 409, { reason: GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING, status: row.status });
  }
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this quote has expired; ask for a new one', 409, { reason: GENERATION_ERROR_REASONS.QUOTE_EXPIRED });
  }
  if (request.expectedMaxMicros !== row.estimateMaxMicros) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the confirmed amount does not match the quote', 409, { reason: GENERATION_ERROR_REASONS.ESTIMATE_CHANGED, estimateMaxMicros: row.estimateMaxMicros });
  }
  await assertStillAllowed(deps, row);
  const budget = await getBudget(deps, { workspaceId: input.workspaceId });
  if (budget === null || budget.limitCredits <= 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'set a generation budget for this workspace before confirming paid generation', 409, { reason: GENERATION_ERROR_REASONS.BUDGET_NOT_SET });
  }
  if (row.sessionId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this quote has no conversation to report back to; ask for a new quote', 409, { reason: GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING });
  }
  // 原子预留（并发确认同一报价：同一 jobId、同一金额 → 同一预留，不重复占额）
  await reserveCredits(deps, { workspaceId: input.workspaceId, jobId: row.id, estimatedCredits: row.reserveCredits, referenceType: 'generation_request' });
  const acceptedAt = new Date();
  const [claimed] = await deps.db.update(generationRequests).set({ status: 'RUNNING', acceptedBy: input.actorId, acceptedAt })
    .where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'QUOTED'))).returning();
  if (claimed === undefined) return toGeneration(await loadById(deps, row.id));
  try {
    const turn = await startGenerationTurn(deps, {
      workspaceId: input.workspaceId,
      sessionId: row.sessionId,
      message: confirmMessage(row, await sessionLocale(deps, row.sessionId)),
      workflow: { type: PAID_GENERATION_WORKFLOW, version: PAID_GENERATION_WORKFLOW_VERSION, input: { generationId: row.id } },
      createdBy: input.actorId,
      idempotencyKey: `generation:${row.id}:${String(acceptedAt.getTime())}`,
    });
    const [updated] = await deps.db.update(generationRequests).set({ turnId: turn.id, workflowRunId: turn.workflowRunId }).where(eq(generationRequests.id, row.id)).returning();
    return toGeneration(updated ?? claimed);
  } catch (error) {
    // 没能开始（例如 AI 正在处理另一轮）：报价回到待确认，释放预留，用户稍后再确认
    await deps.db.update(generationRequests).set({ status: 'QUOTED', acceptedBy: null, acceptedAt: null })
      .where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'RUNNING'), isNull(generationRequests.turnId)));
    await releaseHold(deps, { workspaceId: input.workspaceId, jobId: row.id, reason: 'GENERATION_NOT_STARTED' }).catch(() => undefined);
    throw error;
  }
}

/** 不要了：待确认（含已过期）的报价 → DECLINED；已在进行或已结束的报价不能撤销确认。 */
export async function declineGeneration(deps: DomainDeps, input: { workspaceId: string; projectId: string; generationId: string }): Promise<Generation> {
  const row = await loadGeneration(deps, input);
  if (row.status === 'DECLINED') return toGeneration(row);
  if (row.status !== 'QUOTED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'only a quote waiting for confirmation can be declined', 409, { reason: GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING, status: row.status });
  }
  const [updated] = await deps.db.update(generationRequests).set({ status: 'DECLINED', completedAt: new Date() })
    .where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'QUOTED'))).returning();
  return toGeneration(updated ?? await loadById(deps, row.id));
}

// ---------------------------------------------------------------------------
// 工作流
// ---------------------------------------------------------------------------

export interface PaidGenerationPorts {
  executor: PaidGenerationExecutor;
}

const creditsOf = (micros: number): number => Math.ceil(micros / MICROS_PER_CREDIT);

/** 失败收尾：按"明确未扣费 / 已扣费 / 结果不明"记录并处理预留。 */
async function recordFailure(deps: DomainDeps, row: GenerationRow, input: { outcome: 'NOT_CHARGED' | 'CHARGED' | 'UNKNOWN'; costMicros: number | null; providerJobId: string | null; reason: string; message: string }): Promise<void> {
  const now = new Date();
  if (input.outcome === 'UNKNOWN') {
    await deps.db.update(generationRequests).set({
      status: 'NEEDS_RECONCILIATION', providerJobId: input.providerJobId ?? row.providerJobId, chargedMicros: null, completedAt: now,
      error: { reason: GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN, message: input.message.slice(0, 500) },
    }).where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'RUNNING')));
    return; // 预留保持到对账
  }
  const charged = input.outcome === 'CHARGED' ? (input.costMicros ?? row.estimateMaxMicros) : 0;
  await deps.db.update(generationRequests).set({
    status: 'FAILED', providerJobId: input.providerJobId ?? row.providerJobId, chargedMicros: charged,
    costSource: input.outcome === 'CHARGED' ? (input.costMicros === null ? 'QUOTE_MAX' : 'PROVIDER') : null,
    completedAt: now, error: { reason: input.reason, message: input.message.slice(0, 500) },
  }).where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'RUNNING')));
  if (charged > 0) await settleHold(deps, { workspaceId: row.workspaceId, jobId: row.id, actualCredits: creditsOf(charged), referenceType: 'generation_request' });
  else await releaseHold(deps, { workspaceId: row.workspaceId, jobId: row.id, reason: input.reason });
}

/** 选区重绘的源：在生成轮次的草稿（= 报价时看到的试改）里找到片段，换算成源素材上的时间范围。 */
async function regionSource(deps: DomainDeps, row: GenerationRow, request: Extract<GenerationRequest, { kind: 'VIDEO_REGION' }>): Promise<PaidGenerationJob['source']> {
  const turn = row.turnId === null ? undefined : (await deps.db.select().from(agentTurns).where(eq(agentTurns.id, row.turnId)).limit(1))[0];
  const draft = { baseRevision: turn?.baseRevision ?? 0, operations: editOperationSchema.array().parse(turn?.draftOperations ?? []) };
  if (turn === undefined) {
    const project = await deps.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, row.projectId)).limit(1);
    draft.baseRevision = project[0]?.revision ?? 0;
  }
  const { timeline } = await simulateAgentDraft({ deps, workspaceId: row.workspaceId, projectId: row.projectId, actorId: row.acceptedBy ?? 'agent' }, draft);
  const clip = timeline.clips.find((item) => item.id === request.clipId);
  if (clip === undefined || clip.assetVersionId === null || compareMediaTime(request.start, clip.sequenceRange.start) < 0 || compareMediaTime(request.end, clip.sequenceRange.end) > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the clip to regenerate is no longer on the timeline at that time', 409, { reason: GENERATION_ERROR_REASONS.CLIP_NOT_FOUND });
  }
  const version = (await deps.db.select({ storageKey: assetVersions.storageKey, mimeType: assetVersions.mimeType }).from(assetVersions)
    .where(and(eq(assetVersions.id, clip.assetVersionId), eq(assetVersions.workspaceId, row.workspaceId))).limit(1))[0];
  if (version === undefined) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the source footage is missing', 409, { reason: GENERATION_ERROR_REASONS.CLIP_NOT_FOUND });
  const offset = mediaTimeToDisplaySeconds(request.start) - mediaTimeToDisplaySeconds(clip.sequenceRange.start);
  const length = mediaTimeToDisplaySeconds(request.end) - mediaTimeToDisplaySeconds(request.start);
  const sourceStart = mediaTimeToDisplaySeconds(clip.sourceRange.start) + offset;
  return { storageKey: version.storageKey, mimeType: version.mimeType, startSeconds: sourceStart.toFixed(6), endSeconds: (sourceStart + length).toFixed(6) };
}

async function buildJob(deps: DomainDeps, ports: PaidGenerationPorts, row: GenerationRow): Promise<PaidGenerationJob> {
  const request = generationRequestSchema.parse(row.request);
  const offer = ports.executor.offers().find((item) => item.providerId === row.providerId && item.kind === row.kind);
  if (offer === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'the provider for this quote is no longer configured', 501, { reason: GENERATION_ERROR_REASONS.UNAVAILABLE });
  }
  const project = (await deps.db.select({ aspectRatio: projects.aspectRatio }).from(projects).where(eq(projects.id, row.projectId)).limit(1))[0];
  const canvas = generationCanvas(project?.aspectRatio ?? '16:9');
  const timebase: Rational = (request.kind === 'VIDEO_REGION' ? request.start : request.at).timebase;
  const seconds = Number(row.estimatedSeconds);
  const base = {
    generationId: row.id, kind: request.kind, providerId: row.providerId, ...canvas,
    frameRate: { num: timebase.den, den: timebase.num },
    seconds, maxSeconds: quoteGeneration(offer, request.kind, seconds).maxSeconds,
  };
  if (request.kind === 'AVATAR_CLIP') {
    const identity = await identityForGeneration(deps, { workspaceId: row.workspaceId, identityId: request.identityId });
    const likeness = identity.parts.LIKENESS;
    const voice = identity.parts.VOICE;
    if (likeness === null || voice === null) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'consent missing', 409, { reason: GENERATION_ERROR_REASONS.CONSENT_REQUIRED });
    return {
      ...base, prompt: null, script: request.script, language: request.language,
      likeness: { storageKey: likeness.storageKey, mimeType: likeness.mimeType }, voice: { storageKey: voice.storageKey, mimeType: voice.mimeType },
      source: null, region: null,
    };
  }
  if (request.kind === 'VIDEO_SHOT') {
    return { ...base, prompt: request.prompt, script: null, language: null, likeness: null, voice: null, source: null, region: null };
  }
  return { ...base, prompt: request.prompt, script: null, language: null, likeness: null, voice: null, source: await regionSource(deps, row, request), region: request.region };
}

const extensionOf = (mimeType: string): string => (mimeType.includes('quicktime') ? 'mov' : mimeType.includes('webm') ? 'webm' : 'mp4');

async function storeProduct(deps: DomainDeps, row: GenerationRow, product: PaidGenerationProduct): Promise<{ assetId: string; footageId: string }> {
  const storage = deps.storage;
  if (storage === undefined) throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'object storage is not configured', 501, { reason: GENERATION_ERROR_REASONS.OUTPUT_INVALID });
  if (product.probe.status !== 'READY' || product.durationMs <= 0) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'the generated video is not decodable', 502, { reason: GENERATION_ERROR_REASONS.OUTPUT_INVALID });
  }
  const assetId = `ast_${randomUUID()}`;
  const footageId = `av_${randomUUID()}`;
  const key = `workspaces/${row.workspaceId}/projects/${row.projectId}/generated/${footageId}/output.${extensionOf(product.mimeType)}`;
  await storage.putObject(key, product.video);
  const assetType = row.kind === 'AVATAR_CLIP' ? 'AVATAR_CLIP' as const : 'GENERATED_VIDEO' as const;
  const video = product.probe.streams.find((stream) => stream.type === 'VIDEO');
  await deps.db.transaction(async (tx) => {
    await tx.insert(assets).values({
      id: assetId, workspaceId: row.workspaceId, projectId: row.projectId, assetType, origin: 'GENERATED',
      provider: row.providerId, providerAssetId: product.providerJobId, status: 'READY', retentionClass: ASSET_DEFAULT_RETENTION[assetType],
      license: {
        type: 'PROVIDER_TERMS', holder: null, attribution: null, sourceUrl: null, termsUrl: null,
        notes: `付费生成（${row.providerId} · ${product.model}${row.providerImplementation === 'SCRIPTED' ? ' · 测试替身' : ''}）`, confirmedBy: null, confirmedAt: null,
      },
      metadata: {
        filename: `${row.kind.toLowerCase()}-${row.id.slice(4, 12)}.${extensionOf(product.mimeType)}`, mimeType: product.mimeType,
        generation: { generationId: row.id, kind: row.kind, providerId: row.providerId, implementation: row.providerImplementation, model: product.model, providerJobId: product.providerJobId, request: row.request, identity: row.identitySnapshot },
      },
      currentVersionId: footageId,
      createdBy: row.acceptedBy,
    });
    await tx.insert(assetVersions).values({
      id: footageId, assetId, workspaceId: row.workspaceId, versionNumber: 1, storageKey: key, mimeType: product.mimeType,
      sizeBytes: product.video.byteLength, checksumSha256: createHash('sha256').update(product.video).digest('hex'),
      durationMs: product.durationMs, width: video?.width ?? null, height: video?.height ?? null, status: 'READY', probeStatus: 'READY', mediaProbe: product.probe,
      metadata: { generationId: row.id },
    });
  });
  return { assetId, footageId };
}

async function generateStep(deps: DomainDeps, ports: PaidGenerationPorts, generationId: string): Promise<Record<string, unknown>> {
  const row = await loadById(deps, generationId);
  if (row.status !== 'RUNNING') throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'generation is not running', 409, { reason: GENERATION_ERROR_REASONS.QUOTE_NOT_PENDING, status: row.status });
  if (row.footageId !== null) {
    const stored = (await deps.db.select({ durationMs: assetVersions.durationMs, probe: assetVersions.mediaProbe }).from(assetVersions).where(eq(assetVersions.id, row.footageId)).limit(1))[0];
    return { footageId: row.footageId, durationMs: stored?.durationMs ?? 0, hasAudio: JSON.stringify(stored?.probe ?? {}).includes('"AUDIO"'), reused: true };
  }
  if (row.providerCalledAt !== null) {
    // 上次调用后中断：结果不明，绝不再次调用
    await recordFailure(deps, row, { outcome: 'UNKNOWN', costMicros: null, providerJobId: null, reason: GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN, message: 'the worker stopped after calling the provider; the outcome is unknown' });
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'generation outcome unknown; needs reconciliation', 409, { reason: GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN });
  }
  let job: PaidGenerationJob;
  try {
    await assertStillAllowed(deps, row);
    job = await buildJob(deps, ports, row);
  } catch (error) {
    const reason = error instanceof ApiFailure ? String(error.details['reason'] ?? error.code) : GENERATION_ERROR_REASONS.PROVIDER_FAILED;
    await recordFailure(deps, row, { outcome: 'NOT_CHARGED', costMicros: null, providerJobId: null, reason, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
  let product: PaidGenerationProduct;
  try {
    product = await ports.executor.execute(job, {
      beforeProviderCall: async () => { await deps.db.update(generationRequests).set({ providerCalledAt: new Date() }).where(eq(generationRequests.id, row.id)); },
    });
  } catch (error) {
    const called = (await loadById(deps, row.id)).providerCalledAt !== null;
    const failure = error instanceof PaidGenerationFailure ? error : null;
    const outcome = failure?.outcome ?? (called ? 'UNKNOWN' : 'NOT_CHARGED');
    const message = error instanceof Error ? error.message : String(error);
    await recordFailure(deps, row, { outcome, costMicros: failure?.costMicros ?? null, providerJobId: failure?.providerJobId ?? null, reason: GENERATION_ERROR_REASONS.PROVIDER_FAILED, message });
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, `generation failed: ${message.slice(0, 300)}`, 502, {
      reason: outcome === 'UNKNOWN' ? GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN : GENERATION_ERROR_REASONS.PROVIDER_FAILED, outcome,
    });
  }
  // 先记下供应商结果与费用（之后存储失败也不会丢账），再拉回自有存储
  const charged = product.costMicros ?? row.estimateMaxMicros;
  await deps.db.update(generationRequests).set({
    providerJobId: product.providerJobId, chargedMicros: charged, costSource: product.costMicros === null ? 'QUOTE_MAX' : 'PROVIDER', outsideRegionChange: product.outsideRegionChange,
  }).where(eq(generationRequests.id, row.id));
  const stored = await storeProduct(deps, row, product);
  await deps.db.update(generationRequests).set({ assetId: stored.assetId, footageId: stored.footageId }).where(eq(generationRequests.id, row.id));
  return { footageId: stored.footageId, durationMs: product.durationMs, hasAudio: product.hasAudio, chargedMicros: charged };
}

// ---------------------------------------------------------------------------
// 放进时间线
// ---------------------------------------------------------------------------

function overlaps(clip: KernelClip, start: MediaTime, end: MediaTime): boolean {
  return compareMediaTime(clip.sequenceRange.start, end) < 0 && compareMediaTime(start, clip.sequenceRange.end) < 0;
}

/** 该时段空着的同名前缀轨（视频 GEN* / 音频 AV*）；都占用了就在最上面新建一条。 */
function placementTrack(state: TimelineState, sequenceId: string, kind: 'VIDEO' | 'AUDIO', prefix: string, start: MediaTime, end: MediaTime): { trackId: string; create: EditOperation | null } {
  const tracks = state.tracks.filter((track) => track.sequenceId === sequenceId).sort((left, right) => left.position - right.position);
  const own = tracks.filter((track) => track.kind === kind && track.name.startsWith(prefix) && !track.locked);
  for (const track of own) {
    if (!state.clips.some((clip) => clip.trackId === track.id && overlaps(clip, start, end))) return { trackId: track.id, create: null };
  }
  const trackId = `trk_${randomUUID()}`;
  const position = tracks.length === 0 ? 0 : Math.max(...tracks.map((track) => track.position)) + 1;
  return { trackId, create: { op: 'create_track', sequenceId, track: { kind, position, name: `${prefix}${String(own.length + 1)}` }, restoreTrackId: trackId } };
}

function msToTime(ms: number, timebase: Rational): MediaTime {
  return mediaTimeSchema.parse({ ticks: String(Math.floor((Math.max(0, ms) * timebase.den) / (1000 * timebase.num))), timebase });
}
const addTime = (left: MediaTime, right: MediaTime): MediaTime => mediaTimeSchema.parse({ ticks: (BigInt(left.ticks) + BigInt(right.ticks)).toString(), timebase: left.timebase });
const subTime = (left: MediaTime, right: MediaTime): MediaTime => mediaTimeSchema.parse({ ticks: (BigInt(left.ticks) - BigInt(right.ticks)).toString(), timebase: left.timebase });
const minTime = (left: MediaTime, right: MediaTime): MediaTime => (compareMediaTime(left, right) <= 0 ? left : right);

/** 生成结果的放置操作（纯计算）：数字人 = GEN 轨画面 + AV 轨人声（全屏或画中画）；生成镜头 = GEN 轨全屏；选区重绘 = GEN 轨 + 裁切到选区。 */
export function generationPlacementOperations(input: { state: TimelineState; sequenceId: string; request: GenerationRequest; footageId: string; durationMs: number; hasAudio: boolean }): EditOperation[] {
  const sequence = input.state.sequences.get(input.sequenceId);
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);
  const timebase = mediaTimeSchema.parse(sequence.duration).timebase;
  const request = input.request;
  const at = request.kind === 'VIDEO_REGION' ? request.start : request.at;
  const produced = msToTime(input.durationMs, timebase);
  const length = request.kind === 'AVATAR_CLIP' ? produced
    : request.kind === 'VIDEO_SHOT' ? minTime(request.duration, produced)
      : minTime(subTime(request.end, request.start), produced);
  if (BigInt(length.ticks) <= 0n) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the generated video is too short to place', 409, { reason: GENERATION_ERROR_REASONS.PLACEMENT_FAILED });
  const end = addTime(at, length);
  const video = placementTrack(input.state, input.sequenceId, 'VIDEO', GENERATION_TRACK_PREFIX, at, end);
  const withVoice = request.kind === 'AVATAR_CLIP' && input.hasAudio;
  const audio = withVoice ? placementTrack(input.state, input.sequenceId, 'AUDIO', AVATAR_VOICE_TRACK_PREFIX, at, end) : null;
  const clipId = `clp_${randomUUID()}`;
  const zero = mediaTimeSchema.parse({ ticks: '0', timebase });
  const operations: EditOperation[] = [
    ...(video.create === null ? [] : [video.create]),
    ...(audio === null || audio.create === null ? [] : [audio.create]),
    ...(compareMediaTime(end, sequence.duration) > 0 ? [{ op: 'set_sequence_duration' as const, sequenceId: input.sequenceId, duration: end }] : []),
    {
      op: 'insert_clip', sequenceId: input.sequenceId, trackId: video.trackId, assetVersionId: input.footageId, nestedSequenceId: null, sourceStreamId: null,
      sourceRange: { start: zero, end: length }, mode: 'OVERWRITE', sequenceStart: at,
      linkAudio: withVoice, audioTrackId: audio?.trackId ?? null, createdClipId: clipId, createdAudioClipId: `clp_${randomUUID()}`,
    },
  ];
  if (request.kind === 'AVATAR_CLIP' && request.framing === 'CORNER') operations.push({ op: 'set_clip_transform', clipId, transform: effectRegionTransform(CORNER_REGION) });
  if (request.kind === 'VIDEO_REGION') {
    const { x, y, width, height } = request.region;
    const full = x === 0 && y === 0 && width >= 1 && height >= 1;
    if (!full) {
      operations.push({ op: 'set_clip_crop', clipId, crop: { left: x, top: y, right: Math.max(0, 1 - x - width), bottom: Math.max(0, 1 - y - height) } });
    }
  }
  return operations;
}

const KIND_NAMES: Record<GenerationRequest['kind'], Record<Locale, string>> = {
  AVATAR_CLIP: { 'zh-CN': '数字人出镜', en: 'digital-human clip' },
  VIDEO_SHOT: { 'zh-CN': '生成镜头', en: 'generated shot' },
  VIDEO_REGION: { 'zh-CN': '选区重绘', en: 'region regeneration' },
};

function chargeText(row: GenerationRow, locale: Locale): string {
  const charged = row.chargedMicros ?? 0;
  if (locale === 'en') return `Charged ${formatMicros(charged)}${row.costSource === 'QUOTE_MAX' ? ' (the quote maximum: the provider did not report a cost)' : ''}.`;
  return `实际花费 ${formatMicros(charged)}${row.costSource === 'QUOTE_MAX' ? '（供应商没有报告费用，按报价上限计）' : ''}。`;
}

function successReply(row: GenerationRow, locale: Locale, placed: boolean): string {
  const name = KIND_NAMES[row.kind as GenerationRequest['kind']][locale];
  const outside = row.outsideRegionChange !== null && row.outsideRegionChange > OUTSIDE_REGION_CHANGE_THRESHOLD;
  if (locale === 'en') {
    return [
      `${name[0]!.toUpperCase()}${name.slice(1)} done: ${row.summary}.`,
      chargeText(row, locale),
      placed ? 'It is in the trial edit: preview it, then keep it or undo.' : 'It could not be placed on the timeline; the clip is in your footage.',
      outside ? `Note: the provider also changed the picture outside the region (mean difference ${row.outsideRegionChange!.toFixed(1)}); only the region is used.` : '',
    ].filter((part) => part.length > 0).join(' ');
  }
  return [
    `${name}好了：${row.summary}。`,
    chargeText(row, locale),
    placed ? '已放进试改，先预览再决定要不要。' : '没能放进时间线；生成的片段在素材里。',
    outside ? `注意：供应商把框外的画面也改了（平均差 ${row.outsideRegionChange!.toFixed(1)}），合成时只用了框内部分。` : '',
  ].filter((part) => part.length > 0).join('');
}

function failureReply(row: GenerationRow, locale: Locale): string {
  const message = String((row.error as { message?: unknown } | null)?.message ?? '');
  if (row.status === 'NEEDS_RECONCILIATION') {
    return locale === 'en'
      ? `The generation's outcome is unknown (${message}). It will not be retried automatically; the reserved budget stays held until the charge is reconciled with the provider.`
      : `这次生成结果不明（${message}）。不会自动重试；预留的预算暂不释放，等和供应商核对费用后处理。`;
  }
  const charged = row.chargedMicros ?? 0;
  if (locale === 'en') return `The generation did not succeed: ${message}. ${charged > 0 ? chargeText(row, locale) : 'Nothing was charged; the reserved budget was released.'}`;
  return `生成没有成功：${message}。${charged > 0 ? chargeText(row, locale) : '没有扣费，预留已释放。'}`;
}

async function placeStep(deps: DomainDeps, generationId: string, generated: { durationMs?: unknown; hasAudio?: unknown }): Promise<Record<string, unknown>> {
  const row = await loadById(deps, generationId);
  if (row.status !== 'RUNNING' || row.footageId === null || row.turnId === null) return { skipped: true, status: row.status };
  const turn = (await deps.db.select().from(agentTurns).where(eq(agentTurns.id, row.turnId)).limit(1))[0];
  if (turn === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'generation turn not found', 404);
  const session = (await deps.db.select({ sequenceId: agentSessions.sequenceId, locale: agentSessions.locale }).from(agentSessions).where(eq(agentSessions.id, turn.sessionId)).limit(1))[0];
  const locale: Locale = session?.locale === 'en' ? 'en' : 'zh-CN';
  let operations: EditOperation[];
  let placementError: ApiFailure | null = null;
  try {
    if (session === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'session not found', 404, { reason: GENERATION_ERROR_REASONS.PLACEMENT_FAILED });
    const { timeline } = await simulateAgentDraft(
      { deps, workspaceId: row.workspaceId, projectId: row.projectId, actorId: turn.createdBy ?? 'agent' },
      { baseRevision: turn.baseRevision, operations: editOperationSchema.array().parse(turn.draftOperations) },
    );
    operations = generationPlacementOperations({
      state: timeline, sequenceId: session.sequenceId, request: generationRequestSchema.parse(row.request), footageId: row.footageId,
      durationMs: Number(generated.durationMs ?? 0), hasAudio: generated.hasAudio === true,
    });
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.httpStatus >= 500) throw error;
    placementError = error;
    operations = [];
  }
  let proposalId: string | null;
  try {
    proposalId = (await completeGenerationTurn(deps, { turnId: turn.id, operations, reply: successReply(row, locale, placementError === null), error: placementError === null ? null : { reason: GENERATION_ERROR_REASONS.PLACEMENT_FAILED, message: placementError.message } })).proposalId;
  } catch (error) {
    if (!(error instanceof ApiFailure) || error.httpStatus >= 500 || operations.length === 0) throw error;
    // 草稿在最新版本上放不下（用户期间改了工程）：不放置，如实说明；生成结果留在素材里
    placementError = error;
    proposalId = (await completeGenerationTurn(deps, { turnId: turn.id, operations: [], reply: successReply(row, locale, false), error: { reason: GENERATION_ERROR_REASONS.PLACEMENT_FAILED, message: error.message } })).proposalId;
  }
  const charged = row.chargedMicros ?? row.estimateMaxMicros;
  await deps.db.update(generationRequests).set({
    status: 'SUCCEEDED', proposalId: placementError === null ? proposalId : null, completedAt: new Date(),
    error: placementError === null ? null : { reason: GENERATION_ERROR_REASONS.PLACEMENT_FAILED, message: placementError.message.slice(0, 500) },
  }).where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'RUNNING')));
  await settleHold(deps, { workspaceId: row.workspaceId, jobId: row.id, actualCredits: creditsOf(charged), referenceType: 'generation_request' });
  return { proposalId, placed: placementError === null, chargedMicros: charged };
}

/** 运行失败或取消（含工作进程中断）后的收尾：按是否已调用供应商决定"失败释放 / 已生成照常结算 / 待对账"，并结束轮次。 */
async function settleTerminated(deps: DomainDeps, input: { generationId: string; turnId: string | null; status: 'FAILED' | 'CANCELLED'; error: Record<string, unknown> | null }): Promise<void> {
  let row = await loadById(deps, input.generationId);
  if (row.status === 'RUNNING') {
    if (row.footageId !== null) {
      // 已生成并拉回，但没放进时间线：费用照常结算，片段留在素材里
      await deps.db.update(generationRequests).set({ status: 'SUCCEEDED', completedAt: new Date(), error: { reason: input.status === 'CANCELLED' ? GENERATION_ERROR_REASONS.CANCELLED : GENERATION_ERROR_REASONS.PLACEMENT_FAILED, message: 'generated but not placed on the timeline' } })
        .where(and(eq(generationRequests.id, row.id), eq(generationRequests.status, 'RUNNING')));
      await settleHold(deps, { workspaceId: row.workspaceId, jobId: row.id, actualCredits: creditsOf(row.chargedMicros ?? row.estimateMaxMicros), referenceType: 'generation_request' });
    } else if (row.chargedMicros !== null) {
      await recordFailure(deps, row, { outcome: 'CHARGED', costMicros: row.chargedMicros, providerJobId: row.providerJobId, reason: GENERATION_ERROR_REASONS.OUTPUT_INVALID, message: 'the provider returned a result that could not be stored' });
    } else if (row.providerCalledAt !== null) {
      await recordFailure(deps, row, { outcome: 'UNKNOWN', costMicros: null, providerJobId: row.providerJobId, reason: GENERATION_ERROR_REASONS.OUTCOME_UNKNOWN, message: 'the worker stopped after calling the provider' });
    } else {
      const reason = input.status === 'CANCELLED' ? GENERATION_ERROR_REASONS.CANCELLED : String(input.error?.['reason'] ?? (input.error?.['details'] as { reason?: unknown } | undefined)?.reason ?? GENERATION_ERROR_REASONS.PROVIDER_FAILED);
      await recordFailure(deps, row, { outcome: 'NOT_CHARGED', costMicros: null, providerJobId: null, reason, message: input.status === 'CANCELLED' ? 'cancelled before the provider was called' : String(input.error?.['message'] ?? 'generation stopped before the provider was called') });
    }
    row = await loadById(deps, input.generationId);
  }
  const turnId = input.turnId ?? row.turnId;
  if (turnId === null) return;
  const locale = await sessionLocale(deps, row.sessionId);
  const reply = row.status === 'SUCCEEDED' ? successReply(row, locale, false) : failureReply(row, locale);
  await failGenerationTurn(deps, { turnId, status: input.status, reply, error: (row.error as Record<string, unknown> | null) ?? { reason: input.status } });
}

export function paidGenerationWorkflow(ports: PaidGenerationPorts): WorkflowDefinition {
  const nonRetryable = (): WorkflowErrorClass => 'NON_RETRYABLE';
  return {
    type: PAID_GENERATION_WORKFLOW,
    version: PAID_GENERATION_WORKFLOW_VERSION,
    steps: [
      {
        key: 'generate',
        // 付费调用：只执行一次，不自动重试（结果不明 → 待对账）
        maxAttempts: 1,
        classify: nonRetryable,
        run: async (context) => ({ kind: 'DONE', output: await generateStep(context.deps, ports, String(context.run.input['generationId'])) }),
      },
      {
        key: 'place',
        maxAttempts: 1,
        classify: nonRetryable,
        run: async (context) => ({
          kind: 'DONE',
          output: await placeStep(context.deps, String(context.run.input['generationId']), (context.run.outputs['generate'] ?? {}) as { durationMs?: unknown; hasAudio?: unknown }),
        }),
      },
    ],
    onTerminated: async ({ deps, run, status, error }) => {
      await settleTerminated(deps, { generationId: String(run.input['generationId']), turnId: typeof run.input['turnId'] === 'string' ? run.input['turnId'] : null, status, error });
    },
  };
}

/** 运维读面用：待对账的生成（预留仍保持）。TODO（why：结果不明的付费调用需要人工与供应商核对；dependency：AdminAction 预检/授权/审计框架接入；interface：`reconcileGeneration(deps, { generationId, chargedMicros, actorId })` 结算或释放预留并写审计）。 */
export async function countGenerationsNeedingReconciliation(deps: DomainDeps, input: { workspaceId: string }): Promise<number> {
  const rows = await deps.db.select({ count: sql<number>`count(*)::int` }).from(generationRequests)
    .where(and(eq(generationRequests.workspaceId, input.workspaceId), eq(generationRequests.status, 'NEEDS_RECONCILIATION')));
  return Number(rows[0]?.count ?? 0);
}
