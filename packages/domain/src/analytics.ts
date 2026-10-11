import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ANALYTICS_ERROR_REASONS,
  ApiFailure,
  ERROR_CODES,
  analyticsSamplingSchema,
  projectVersionSnapshotSchema,
  scenePerformanceRecordSchema,
  videoPerformanceMetricsSchema,
  videoPerformanceRecordSchema,
  type CollectPublicationAnalyticsRequest,
  type VideoPerformanceMetrics,
  type VideoPerformanceRecord,
  type ScenePerformanceRecord,
  creatorLearningSchema,
  type CreatorLearning,
  type CreatorLearningAction,
} from '@ancs/contracts';
import { analyticsEvents, creatorLearnings, projects, projectVersions, providerConnections, publications, scenePerformance, videoPerformance } from '@ancs/db';
import type { DomainDeps } from './deps.js';

const toRecord = (row: typeof videoPerformance.$inferSelect): VideoPerformanceRecord =>
  videoPerformanceRecordSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

const canonicalValue = (value: unknown): unknown => Array.isArray(value)
  ? value.map(canonicalValue)
  : value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalValue(item)]))
    : value;

function nullableNumber(value: unknown, options: { ratio?: boolean; integer?: boolean } = {}): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (options.ratio === true && value > 1) || (options.integer === true && !Number.isInteger(value))) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Provider Analytics 指标非法', 422, { reason: ANALYTICS_ERROR_REASONS.INVALID_PROVIDER_METRICS });
  }
  return value;
}

function normalizeMetrics(raw: Record<string, unknown>): VideoPerformanceMetrics {
  const retentionRaw = raw['retention'];
  const retention = retentionRaw === undefined || retentionRaw === null
    ? []
    : Array.isArray(retentionRaw)
      ? retentionRaw.map((item) => {
          if (item === null || typeof item !== 'object') {
            throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Provider retention point 非法', 422, { reason: ANALYTICS_ERROR_REASONS.INVALID_PROVIDER_METRICS });
          }
          const point = item as Record<string, unknown>;
          const positionMs = nullableNumber(point['positionMs'], { integer: true });
          if (positionMs === null) throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'retention positionMs 缺失', 422, { reason: ANALYTICS_ERROR_REASONS.INVALID_PROVIDER_METRICS });
          return { positionMs, rate: nullableNumber(point['rate'], { ratio: true }) };
        })
      : (() => { throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'Provider retention 必须为数组', 422, { reason: ANALYTICS_ERROR_REASONS.INVALID_PROVIDER_METRICS }); })();
  return videoPerformanceMetricsSchema.parse({
    views: nullableNumber(raw['views']),
    impressions: nullableNumber(raw['impressions']),
    clickThroughRate: nullableNumber(raw['clickThroughRate'] ?? raw['ctr'], { ratio: true }),
    watchTimeMs: nullableNumber(raw['watchTimeMs']),
    averageWatchTimeMs: nullableNumber(raw['averageWatchTimeMs']),
    retention,
  });
}

export async function collectPublicationAnalytics(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; publicationId: string; request: CollectPublicationAnalyticsRequest },
): Promise<VideoPerformanceRecord> {
  const publication = (await deps.db.select().from(publications).where(and(
    eq(publications.id, input.publicationId), eq(publications.workspaceId, input.workspaceId), eq(publications.projectId, input.projectId),
  )).limit(1))[0];
  if (publication === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '发布记录不存在', 404, { reason: ANALYTICS_ERROR_REASONS.PUBLICATION_NOT_FOUND });
  if (publication.state !== 'PUBLISHED' || publication.remoteId === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '仅可采集已发布且有远端引用的记录', 409, { reason: ANALYTICS_ERROR_REASONS.PUBLICATION_NOT_READY });
  }
  const connection = (await deps.db.select({ status: providerConnections.status }).from(providerConnections).where(and(
    eq(providerConnections.id, publication.accountId), eq(providerConnections.workspaceId, input.workspaceId),
  )).limit(1))[0];
  if (connection !== undefined && connection.status !== 'ACTIVE') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '平台授权已撤销，Analytics 采集已停止', 409, { reason: ANALYTICS_ERROR_REASONS.AUTHORIZATION_REVOKED });
  }
  const provider = deps.distributionProviders?.find((candidate) => candidate.providerId === publication.platformId);
  if (provider === undefined || provider.fetchAnalytics === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '平台未提供 Analytics 采集能力', 501, { reason: ANALYTICS_ERROR_REASONS.PROVIDER_UNAVAILABLE });
  }
  const capabilities = await provider.capabilities({ workspaceId: input.workspaceId, providerConnectionId: connection === undefined ? null : publication.accountId });
  if (!capabilities.capabilities.includes('ANALYTICS')) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '平台能力不含 ANALYTICS', 422, { reason: ANALYTICS_ERROR_REASONS.CAPABILITY_MISSING });
  }
  const raw = await provider.fetchAnalytics({ remoteId: publication.remoteId, from: input.request.from, to: input.request.to });
  const metrics = normalizeMetrics(raw.metrics);
  const sampling = analyticsSamplingSchema.parse({ ...input.request, source: `${raw.platformId}:fetchAnalytics`, fetchedAt: raw.fetchedAt });
  const payloadHash = createHash('sha256').update(JSON.stringify(canonicalValue({ sampling, payload: raw.metrics }))).digest('hex');
  return deps.db.transaction(async (tx) => {
    const inserted = await tx.insert(analyticsEvents).values({
      id: `ane_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId, publicationId: publication.id,
      platformId: publication.platformId, remoteId: publication.remoteId as string, sampling, payload: raw.metrics, payloadHash,
    }).onConflictDoNothing().returning();
    const event = inserted[0] ?? (await tx.select().from(analyticsEvents).where(and(eq(analyticsEvents.publicationId, publication.id), eq(analyticsEvents.payloadHash, payloadHash))).limit(1))[0];
    if (event === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'Analytics 事件保存失败', 500);
    const existing = (await tx.select().from(videoPerformance).where(eq(videoPerformance.rawEventId, event.id)).limit(1))[0];
    if (existing !== undefined) return toRecord(existing);
    const rows = await tx.insert(videoPerformance).values({
      id: `vperf_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId, publicationId: publication.id,
      projectVersionId: publication.projectVersionId, platformId: publication.platformId, remoteId: publication.remoteId as string,
      sampling, metrics, rawEventId: event.id,
    }).returning();
    const row = rows[0];
    if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'Video performance 保存失败', 500);
    return toRecord(row);
  });
}

export async function listPublicationAnalytics(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; publicationId: string },
): Promise<VideoPerformanceRecord[]> {
  return (await deps.db.select().from(videoPerformance).where(and(
    eq(videoPerformance.workspaceId, input.workspaceId), eq(videoPerformance.projectId, input.projectId), eq(videoPerformance.publicationId, input.publicationId),
  )).orderBy(desc(videoPerformance.createdAt))).map(toRecord);
}

const toSceneRecord = (row: typeof scenePerformance.$inferSelect): ScenePerformanceRecord =>
  scenePerformanceRecordSchema.parse({ ...row, createdAt: row.createdAt.toISOString() });

/** P14-02：只按发布时冻结 Graph 的时间窗做相关性归因，不输出因果结论。 */
export async function attributeScenePerformance(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; videoPerformanceId: string },
): Promise<ScenePerformanceRecord[]> {
  const performance = (await deps.db.select().from(videoPerformance).where(and(
    eq(videoPerformance.id, input.videoPerformanceId), eq(videoPerformance.workspaceId, input.workspaceId), eq(videoPerformance.projectId, input.projectId),
  )).limit(1))[0];
  if (performance === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'Video performance 不存在', 404, { reason: ANALYTICS_ERROR_REASONS.PERFORMANCE_NOT_FOUND });
  const version = (await deps.db.select().from(projectVersions).where(and(
    eq(projectVersions.id, performance.projectVersionId), eq(projectVersions.workspaceId, input.workspaceId), eq(projectVersions.projectId, input.projectId),
  )).limit(1))[0];
  if (version === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '发布时项目版本不存在', 404);
  const snapshot = projectVersionSnapshotSchema.parse(version.snapshot);
  const metrics = videoPerformanceMetricsSchema.parse(performance.metrics);
  await deps.db.transaction(async (tx) => {
    for (const scene of snapshot.graph.scenes) {
      const points = metrics.retention.filter((point) => point.positionMs >= scene.startMs && point.positionMs < scene.startMs + scene.durationMs && point.rate !== null);
      const retentionRate = points.length === 0 ? null : points.reduce((sum, point) => sum + (point.rate as number), 0) / points.length;
      await tx.insert(scenePerformance).values({
        id: `sperf_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId,
        projectVersionId: version.id, videoPerformanceId: performance.id, sceneId: scene.id, sceneType: scene.sceneType,
        position: scene.position, startMs: scene.startMs, durationMs: scene.durationMs, retentionRate,
        interpretation: 'CORRELATION_ONLY', derivation: { method: 'TIME_WINDOW_AVERAGE', sampleCount: points.length },
      }).onConflictDoNothing();
    }
  });
  return listScenePerformance(deps, input);
}

export async function listScenePerformance(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; videoPerformanceId?: string },
): Promise<ScenePerformanceRecord[]> {
  const conditions = [eq(scenePerformance.workspaceId, input.workspaceId), eq(scenePerformance.projectId, input.projectId)];
  if (input.videoPerformanceId !== undefined) conditions.push(eq(scenePerformance.videoPerformanceId, input.videoPerformanceId));
  return (await deps.db.select().from(scenePerformance).where(and(...conditions)).orderBy(scenePerformance.position)).map(toSceneRecord);
}

const toLearning = (row: typeof creatorLearnings.$inferSelect): CreatorLearning => creatorLearningSchema.parse({
  ...row,
  createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
  acceptedAt: row.acceptedAt?.toISOString() ?? null, disabledAt: row.disabledAt?.toISOString() ?? null, revertedAt: row.revertedAt?.toISOString() ?? null,
});

export async function generateCreatorLearnings(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<CreatorLearning[]> {
  const project = (await deps.db.select().from(projects).where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId))).limit(1))[0];
  if (project === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '项目不存在', 404);
  const rows = await deps.db.select().from(scenePerformance).where(and(eq(scenePerformance.workspaceId, input.workspaceId), eq(scenePerformance.projectId, input.projectId)));
  const known = rows.filter((row) => row.retentionRate !== null);
  if (known.length === 0) return [];
  const byType = new Map<string, number[]>();
  for (const row of known) byType.set(row.sceneType, [...(byType.get(row.sceneType) ?? []), row.retentionRate as number]);
  const typeAverages = [...byType.entries()].map(([sceneType, values]) => ({ sceneType, average: values.reduce((a, b) => a + b, 0) / values.length, count: values.length })).sort((a, b) => b.average - a.average);
  const best = typeAverages[0]!;
  const hostRows = known.filter((row) => row.sceneType.startsWith('HOST') || row.sceneType.includes('AVATAR'));
  const nonHostRows = known.filter((row) => !hostRows.includes(row));
  const average = (items: typeof known): number | null => items.length === 0 ? null : items.reduce((sum, row) => sum + (row.retentionRate as number), 0) / items.length;
  const hostAverage = average(hostRows);
  const nonHostAverage = average(nonHostRows);
  const observedRatio = hostRows.length / known.length;
  const recommendedRatio = hostAverage === null || nonHostAverage === null ? observedRatio : Math.min(1, Math.max(0, observedRatio + (hostAverage >= nonHostAverage ? 0.1 : -0.1)));
  const sortedDurations = known.map((row) => row.durationMs).sort((a, b) => a - b);
  const medianDuration = sortedDurations[Math.floor(sortedDurations.length / 2)]!;
  const evidence = { sampleCount: known.length, interpretation: 'CORRELATION_ONLY' as const };
  const values = [
    {
      kind: 'RHYTHM', title: '按已观察片段中位时长校准节奏',
      explanation: '建议来自已发布视频的 Scene 时间窗与留存相关性，只作为可撤销建议，不代表因果关系。',
      evidence: { ...evidence, observations: [`已观察 ${known.length} 个有留存数据的 Scene`, `时长中位数 ${medianDuration}ms`] },
      recommendation: { maxContinuousSceneDurationMs: medianDuration },
    },
    {
      kind: 'SCENE_TYPE', title: `优先复核 ${best.sceneType} 的使用模式`,
      explanation: '该 Scene 类型在当前样本中的平均留存最高；主题、位置等混杂因素尚未排除。',
      evidence: { ...evidence, observations: [`${best.sceneType} 平均留存 ${best.average.toFixed(3)}`, `样本 ${best.count} 个`] },
      recommendation: { preferredSceneType: best.sceneType, observedAverageRetention: best.average },
    },
    {
      kind: 'AVATAR_RATIO', title: '调整主持人画面比例供人工评估',
      explanation: '建议基于主持人/非主持人 Scene 的观察相关性；接受只记录偏好，不会静默修改 Channel。',
      evidence: { ...evidence, observations: [`观察比例 ${observedRatio.toFixed(3)}`, `主持人均值 ${hostAverage?.toFixed(3) ?? 'unknown'}`, `非主持人均值 ${nonHostAverage?.toFixed(3) ?? 'unknown'}`] },
      recommendation: { observedRatio, suggestedRatio: recommendedRatio },
    },
  ] as const;
  const inserted = await deps.db.insert(creatorLearnings).values(values.map((value) => ({
    id: `clrn_${randomUUID()}`, workspaceId: input.workspaceId, projectId: input.projectId, channelId: project.channelId,
    kind: value.kind, title: value.title, explanation: value.explanation, evidence: value.evidence, recommendation: value.recommendation,
    channelMutationApplied: false,
  }))).returning();
  return inserted.map(toLearning);
}

export async function listCreatorLearnings(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<CreatorLearning[]> {
  return (await deps.db.select().from(creatorLearnings).where(and(eq(creatorLearnings.workspaceId, input.workspaceId), eq(creatorLearnings.projectId, input.projectId))).orderBy(desc(creatorLearnings.createdAt))).map(toLearning);
}

export async function actOnCreatorLearning(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; learningId: string; action: CreatorLearningAction['action'] },
): Promise<CreatorLearning> {
  const current = (await deps.db.select().from(creatorLearnings).where(and(eq(creatorLearnings.id, input.learningId), eq(creatorLearnings.workspaceId, input.workspaceId), eq(creatorLearnings.projectId, input.projectId))).limit(1))[0];
  if (current === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '学习建议不存在', 404);
  const now = new Date();
  const patch = input.action === 'DISABLE'
    ? { status: 'DISABLED', disabledAt: now, updatedAt: now }
    : input.action === 'ACCEPT'
      ? { status: 'ACCEPTED', acceptedAt: now, updatedAt: now }
      : current.status === 'ACCEPTED'
        ? { status: 'REVERTED', revertedAt: now, updatedAt: now }
        : { status: 'ACTIVE', disabledAt: null, updatedAt: now };
  const row = (await deps.db.update(creatorLearnings).set(patch).where(eq(creatorLearnings.id, current.id)).returning())[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, '学习建议更新失败', 500);
  return toLearning(row);
}
