import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  GENERATE_JOB_TYPE,
  QA_DURATION_TOLERANCE_MS,
  QA_ERROR_REASONS,
  QA_REPORT_VERSION,
  buildSubtitles,
  captionStyleSchema,
  projectVersionSnapshotSchema,
  qaReportSchema,
  renderManifestSchema,
  type MediaProbeResult,
  type QaCheck,
  type QaReport,
  type RenderMediaProbe,
  type RenderRecord,
} from '@ancs/contracts';
import { assetVersions, assets, jobs, projectSources, projectVersions, renderQaReports } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { assembleSceneGraph } from './projects.js';
import { getCurrentMasterNarration, getMasterNarrationById } from './alignment.js';
import { getRender, transitionRender } from './render.js';
import { createJob } from './jobs.js';
import { AI_VIDEO_FORBIDDEN_SCENE_TYPES, AI_VIDEO_FORBIDDEN_SEMANTIC } from './scene-generation.js';

/**
 * 发布前 QA（P07-05 / 规范 §86、§87）。
 *
 * - **同一个检查引擎**：渲染前预检（对当前项目状态）与 Final QA（对冻结快照 + 产物字节）共用 `runContentChecks`；
 * - 技术核验是**独立复核**：重新读产物字节 → 探测媒体（probe 注入，domain 不依赖渲染栈）→ 重算校验和/字幕时间；
 * - 判定：任一 BLOCKER 失败 → FAIL（Render=FAILED）；否则 PASS（Render=READY，等待人工批准 §87）；
 * - AI/Visual QA 与响度检查：显式 **SKIP** 并记录（不静默略过；§86 SHOULD 部分随后续任务/部署层）。
 */

/* ---------- 内容/前置检查（纯函数；预检与 Final QA 共用） ---------- */

export interface QaSubjectScene {
  id: string;
  sceneType: string;
  /** 语义类型（证据/数据类判定用；§14.4/§84） */
  semanticType: string;
  status: string;
  needsReview: boolean;
  dataBindings: { datasetId: string }[];
  sourceBindings: { sourceId: string }[];
  /** origin = 素材来源类别（GENERATED/PROVIDER_GENERATED 不得冒充证据——EVIDENCE_ASSET_ORIGIN 检查） */
  assetBindings: { assetId: string; origin?: string }[];
}

export interface QaSubject {
  scenes: readonly QaSubjectScene[];
  /** 项目来源记录 id 集合（project_sources；追溯性的权威来源——graph.sourceReferences 当前为占位空数组） */
  knownSourceIds: ReadonlySet<string>;
  /** 冻结资产版本资产 id 集合（预检为 null = 不校验冻结；Final QA 为渲染输入的清单） */
  frozenAssetIds: ReadonlySet<string> | null;
  masterPresent: boolean;
  /** 未完成 Provider 生成任务数（调用方统计；§86） */
  pendingProviderJobs: number;
}

/** 图表场景类型（§10.3：不得编造图形数据；与 director 的 CHART_SCENE_TYPES 对齐） */
const CHART_SCENE_TYPES: ReadonlySet<string> = new Set(['LINE_CHART', 'DUAL_LINE_CHART', 'BAR_CHART', 'SPREAD_AREA_CHART']);

const check = (
  id: QaCheck['id'],
  category: QaCheck['category'],
  severity: QaCheck['severity'],
  status: QaCheck['status'],
  message: string | null,
  details: Record<string, unknown> = {},
): QaCheck => ({ id, category, severity, status, message, details });

export function runContentChecks(subject: QaSubject, category: 'PRE_RENDER' | 'TECHNICAL' = 'PRE_RENDER'): QaCheck[] {
  const checks: QaCheck[] = [];

  checks.push(
    subject.scenes.length > 0
      ? check('SCENES_PRESENT', category, 'BLOCKER', 'PASS', null, { sceneCount: subject.scenes.length })
      : check('SCENES_PRESENT', category, 'BLOCKER', 'FAIL', '没有场景：无可交付内容'),
  );

  // 占位检查（§86：未解决的 placeholder 不允许进入 Final）：
  // - PLACEHOLDER = 显式未解决占位 → **阻止**；
  // - EMPTY = V1 默认场景状态（scene.status 尚未随资产就绪联动，TODO(P02-01)）→ **警告**（可见但不假阻止）；
  // - 媒体类场景未绑定素材 = 组件渲染"待绑定素材"占位 → **阻止**（见 MEDIA_SCENE_ASSETS_BOUND）。
  const explicitPlaceholders = subject.scenes.filter((scene) => scene.status === 'PLACEHOLDER');
  const emptyScenes = subject.scenes.filter((scene) => scene.status === 'EMPTY');
  if (explicitPlaceholders.length > 0) {
    checks.push(
      check('SCENE_STATUS_NO_PLACEHOLDER', category, 'BLOCKER', 'FAIL', `存在未解决的占位场景（${String(explicitPlaceholders.length)} 个）：占位不允许进入 Final（§86）`, {
        sceneIds: explicitPlaceholders.map((scene) => scene.id),
        statuses: explicitPlaceholders.map((scene) => ({ sceneId: scene.id, status: scene.status })),
      }),
    );
  } else if (emptyScenes.length > 0) {
    checks.push(
      check('SCENE_STATUS_NO_PLACEHOLDER', category, 'WARNING', 'FAIL', `存在 EMPTY 状态场景（${String(emptyScenes.length)} 个）：V1 场景状态未随资产就绪联动（默认值），请人工确认内容完整`, {
        sceneIds: emptyScenes.map((scene) => scene.id),
      }),
    );
  } else {
    checks.push(check('SCENE_STATUS_NO_PLACEHOLDER', category, 'BLOCKER', 'PASS', null));
  }

  // 媒体类场景必须已绑定素材（未绑定时组件渲染明确占位 → 不允许进入 Final）
  const MEDIA_SCENE_TYPES: ReadonlySet<string> = new Set(['IMAGE_FULL', 'REAL_BROLL', 'AI_VIDEO']);
  const unboundMedia = subject.scenes.filter((scene) => MEDIA_SCENE_TYPES.has(scene.sceneType) && scene.assetBindings.length === 0);
  checks.push(
    unboundMedia.length === 0
      ? check('MEDIA_SCENE_ASSETS_BOUND', category, 'BLOCKER', 'PASS', null)
      : check('MEDIA_SCENE_ASSETS_BOUND', category, 'BLOCKER', 'FAIL', `媒体类场景未绑定素材（${String(unboundMedia.length)} 个）：将以占位呈现，不允许进入 Final（§86）`, {
          sceneIds: unboundMedia.map((scene) => scene.id),
          sceneTypes: unboundMedia.map((scene) => scene.sceneType),
        }),
  );

  // **生成图不冒充证据**（§84/§14.4）：证据/数据类场景绑定了 AI 生成素材 → 阻止（生成素材与真实来源可区分）
  const evidenceScenes = subject.scenes.filter((scene) => AI_VIDEO_FORBIDDEN_SEMANTIC.has(scene.semanticType) || AI_VIDEO_FORBIDDEN_SCENE_TYPES.has(scene.sceneType));
  const evidenceViolations = evidenceScenes.flatMap((scene) =>
    scene.assetBindings
      .filter((binding) => binding.origin === 'GENERATED' || binding.origin === 'PROVIDER_GENERATED')
      .map((binding) => ({ sceneId: scene.id, assetId: binding.assetId, origin: binding.origin ?? 'UNKNOWN' })),
  );
  checks.push(
    evidenceViolations.length === 0
      ? check('EVIDENCE_ASSET_ORIGIN', category, 'BLOCKER', 'PASS', null, { evidenceScenes: evidenceScenes.length })
      : check('EVIDENCE_ASSET_ORIGIN', category, 'BLOCKER', 'FAIL', `证据/数据类场景绑定了 AI 生成素材（${String(evidenceViolations.length)} 处）：生成图不得冒充证据（§84）——请替换为真实素材/数据组件`, {
          violations: evidenceViolations,
        }),
  );

  const needsReview = subject.scenes.filter((scene) => scene.needsReview);
  checks.push(
    needsReview.length === 0
      ? check('SCENES_NOT_NEEDS_REVIEW', category, 'BLOCKER', 'PASS', null)
      : check('SCENES_NOT_NEEDS_REVIEW', category, 'BLOCKER', 'FAIL', `存在 needs_review 场景（${String(needsReview.length)} 个）：阻止自动发布（§86/§54）`, {
          sceneIds: needsReview.map((scene) => scene.id),
        }),
  );

  const charts = subject.scenes.filter((scene) => CHART_SCENE_TYPES.has(scene.sceneType));
  const chartsMissingData = charts.filter((scene) => scene.dataBindings.length === 0);
  checks.push(
    chartsMissingData.length === 0
      ? check('CHART_DATA_BINDINGS', category, 'BLOCKER', 'PASS', null, { chartScenes: charts.length })
      : check('CHART_DATA_BINDINGS', category, 'BLOCKER', 'FAIL', `图表场景缺少数据绑定（${String(chartsMissingData.length)} 个）：不得编造图形数据（§10.3）`, {
          sceneIds: chartsMissingData.map((scene) => scene.id),
        }),
  );

  const danglingSources = subject.scenes.flatMap((scene) =>
    scene.sourceBindings.filter((binding) => !subject.knownSourceIds.has(binding.sourceId)).map((binding) => ({ sceneId: scene.id, sourceId: binding.sourceId })),
  );
  checks.push(
    danglingSources.length === 0
      ? check('SOURCE_REFERENCES_PRESENT', category, 'BLOCKER', 'PASS', null)
      : check('SOURCE_REFERENCES_PRESENT', category, 'BLOCKER', 'FAIL', `存在悬空的来源引用（${String(danglingSources.length)} 处）：来源必须可追溯`, { dangling: danglingSources }),
  );

  if (subject.frozenAssetIds === null) {
    checks.push(check('ASSET_BINDINGS_FROZEN', category, 'BLOCKER', 'PASS', null));
  } else {
    const missing = subject.scenes.flatMap((scene) => scene.assetBindings.filter((binding) => !subject.frozenAssetIds?.has(binding.assetId)).map((binding) => ({ sceneId: scene.id, assetId: binding.assetId })));
    checks.push(
      missing.length === 0
        ? check('ASSET_BINDINGS_FROZEN', category, 'BLOCKER', 'PASS', null)
        : check('ASSET_BINDINGS_FROZEN', category, 'BLOCKER', 'FAIL', `存在未冻结的素材绑定（${String(missing.length)} 处）：缺素材不允许发布`, { missing }),
    );
  }

  checks.push(
    subject.masterPresent
      ? check('MASTER_NARRATION_PRESENT', category, 'BLOCKER', 'PASS', null)
      : check('MASTER_NARRATION_PRESENT', category, 'BLOCKER', 'FAIL', '缺少 Master Narration（Audio-First：无对齐不成片）'),
  );

  checks.push(
    subject.pendingProviderJobs === 0
      ? check('NO_PENDING_PROVIDER_JOBS', category, 'BLOCKER', 'PASS', null)
      : check('NO_PENDING_PROVIDER_JOBS', category, 'BLOCKER', 'FAIL', `存在未完成的 Provider 生成任务（${String(subject.pendingProviderJobs)} 个）：不允许发布（§86）`, {
          pendingCount: subject.pendingProviderJobs,
        }),
  );

  return checks;
}

/* ---------- 技术核验（独立复核产物字节） ---------- */

export interface QaArtifactBytes {
  kind: 'VIDEO' | 'SUBTITLE_SRT' | 'SUBTITLE_VTT' | 'MANIFEST';
  fileName: string;
  bytes: Uint8Array;
  /** 入库记录的校验和（null = 记录缺失；复核以重算为准） */
  recordedChecksumSha256: string | null;
}

const sha256HexOf = (bytes: Uint8Array): Promise<string> => Promise.resolve(createHash('sha256').update(bytes).digest('hex'));

/** SRT 时间解析（`HH:MM:SS,mmm`；用于字幕时间越界复核） */
export function parseSrtCues(content: string): { startMs: number; endMs: number }[] {
  const cues: { startMs: number; endMs: number }[] = [];
  const pattern = /(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/g;
  for (;;) {
    const match = pattern.exec(content);
    if (match === null) break;
    const toMs = (h: string, m: string, s: string, ms: string): number => Number(h) * 3_600_000 + Number(m) * 60_000 + Number(s) * 1000 + Number(ms);
    cues.push({
      startMs: toMs(match[1] ?? '0', match[2] ?? '0', match[3] ?? '0', match[4] ?? '0'),
      endMs: toMs(match[5] ?? '0', match[6] ?? '0', match[7] ?? '0', match[8] ?? '0'),
    });
  }
  return cues;
}

export interface RunTechnicalChecksInput {
  artifacts: readonly QaArtifactBytes[];
  /** 媒体探测（注入；缺省 → PROBE_UNAVAILABLE fail-closed） */
  probeResult: MediaProbeResult | null;
  expectedFormat: { width: number; height: number; fps: number };
  manifestDurationMs: number;
  masterDurationMs: number;
  /** 预期字幕 cue 数（Alignment 段数） */
  expectedCueCount: number;
  /** 字幕样式（重算断行，检查越界宽度） */
  captionStyle: unknown;
  captionCues: readonly { startMs: number; durationMs: number; text: string }[];
}

export async function runTechnicalChecks(input: RunTechnicalChecksInput): Promise<{ checks: QaCheck[]; recomputedSha: Record<string, string> }> {
  const checks: QaCheck[] = [];
  const recomputedSha: Record<string, string> = {};
  const byKind = new Map(input.artifacts.map((artifact) => [artifact.kind, artifact]));

  const expectedKinds: QaArtifactBytes['kind'][] = ['VIDEO', 'SUBTITLE_SRT', 'SUBTITLE_VTT', 'MANIFEST'];
  const missing = expectedKinds.filter((kind) => !byKind.has(kind));
  checks.push(
    missing.length === 0
      ? check('ARTIFACTS_PRESENT', 'TECHNICAL', 'BLOCKER', 'PASS', null, { artifacts: [...byKind.keys()] })
      : check('ARTIFACTS_PRESENT', 'TECHNICAL', 'BLOCKER', 'FAIL', `产物缺失：${missing.join(', ')}（四件套必须齐备）`, { missing }),
  );

  const checksumMismatch: { kind: string; recorded: string | null; actual: string }[] = [];
  for (const artifact of input.artifacts) {
    const digest = await sha256HexOf(artifact.bytes);
    recomputedSha[artifact.kind] = digest;
    if (artifact.recordedChecksumSha256 !== digest) {
      checksumMismatch.push({ kind: artifact.kind, recorded: artifact.recordedChecksumSha256, actual: digest });
    }
  }
  checks.push(
    checksumMismatch.length === 0
      ? check('ARTIFACT_CHECKSUM_MATCH', 'TECHNICAL', 'BLOCKER', 'PASS', null, { recomputed: recomputedSha })
      : check('ARTIFACT_CHECKSUM_MATCH', 'TECHNICAL', 'BLOCKER', 'FAIL', `产物校验和与入库记录不一致（${String(checksumMismatch.length)} 个）`, { mismatches: checksumMismatch }),
  );

  const video = byKind.get('VIDEO');
  if (video !== undefined && input.probeResult !== null) {
    const probe = input.probeResult;
    const formatOk = probe.width === input.expectedFormat.width && probe.height === input.expectedFormat.height && probe.fps === input.expectedFormat.fps;
    checks.push(
      formatOk
        ? check('VIDEO_RESOLUTION_FPS', 'TECHNICAL', 'BLOCKER', 'PASS', null, { width: probe.width, height: probe.height, fps: probe.fps })
        : check('VIDEO_RESOLUTION_FPS', 'TECHNICAL', 'BLOCKER', 'FAIL', `分辨率/fps 与渲染档位不一致（期望 ${String(input.expectedFormat.width)}×${String(input.expectedFormat.height)}@${String(input.expectedFormat.fps)}）`, {
            expected: input.expectedFormat,
            actual: { width: probe.width, height: probe.height, fps: probe.fps },
          }),
    );
    const durationOk = probe.durationMs !== null && Math.abs(probe.durationMs - input.manifestDurationMs) <= QA_DURATION_TOLERANCE_MS;
    checks.push(
      durationOk
        ? check('VIDEO_DURATION_MATCHES_MANIFEST', 'TECHNICAL', 'BLOCKER', 'PASS', null, { durationMs: probe.durationMs, manifestDurationMs: input.manifestDurationMs })
        : check('VIDEO_DURATION_MATCHES_MANIFEST', 'TECHNICAL', 'BLOCKER', 'FAIL', `时长与 Manifest 不一致（容差 ${String(QA_DURATION_TOLERANCE_MS)}ms）`, {
            actualMs: probe.durationMs,
            manifestMs: input.manifestDurationMs,
          }),
    );
    checks.push(
      probe.hasAudio
        ? check('AUDIO_TRACK_PRESENT', 'TECHNICAL', 'BLOCKER', 'PASS', null, { audioCodec: probe.audioCodec })
        : check('AUDIO_TRACK_PRESENT', 'TECHNICAL', 'BLOCKER', 'FAIL', '成片缺少音轨（§86）'),
    );
  } else if (video !== undefined && input.probeResult === null) {
    checks.push(check('VIDEO_RESOLUTION_FPS', 'TECHNICAL', 'BLOCKER', 'FAIL', '媒体探测不可用（PROBE_UNAVAILABLE）：fail-closed'));
    checks.push(check('VIDEO_DURATION_MATCHES_MANIFEST', 'TECHNICAL', 'BLOCKER', 'SKIP', '媒体探测不可用'));
    checks.push(check('AUDIO_TRACK_PRESENT', 'TECHNICAL', 'BLOCKER', 'FAIL', '媒体探测不可用（无法确认音轨）'));
  } else {
    // VIDEO 产物缺失：前置已 FAIL（ARTIFACTS_PRESENT）；相关项显式 SKIP（不静默）
    checks.push(check('VIDEO_RESOLUTION_FPS', 'TECHNICAL', 'BLOCKER', 'SKIP', 'VIDEO 产物缺失（见 ARTIFACTS_PRESENT）'));
    checks.push(check('VIDEO_DURATION_MATCHES_MANIFEST', 'TECHNICAL', 'BLOCKER', 'SKIP', 'VIDEO 产物缺失'));
    checks.push(check('AUDIO_TRACK_PRESENT', 'TECHNICAL', 'BLOCKER', 'SKIP', 'VIDEO 产物缺失'));
  }

  // 字幕时间边界（独立复核 SRT 文本；末 cue 结束 ≤ 成片时长 + 容差）
  const srt = byKind.get('SUBTITLE_SRT');
  if (srt !== undefined) {
    const cues = parseSrtCues(Buffer.from(srt.bytes).toString('utf8'));
    const lastEnd = cues.reduce((max, cue) => Math.max(max, cue.endMs), 0);
    const boundsOk = cues.length > 0 && lastEnd <= input.manifestDurationMs + QA_DURATION_TOLERANCE_MS;
    checks.push(
      boundsOk
        ? check('SUBTITLE_TIMING_BOUNDS', 'TECHNICAL', 'BLOCKER', 'PASS', null, { cueCount: cues.length, lastEndMs: lastEnd })
        : check('SUBTITLE_TIMING_BOUNDS', 'TECHNICAL', 'BLOCKER', 'FAIL', '字幕时间越界（末 cue 超出成片时长或没有 cue）', {
            cueCount: cues.length,
            lastEndMs: lastEnd,
            manifestDurationMs: input.manifestDurationMs,
          }),
    );
    const countOk = cues.length === input.expectedCueCount;
    if (!countOk) {
      checks.push(check('SUBTITLE_TIMING_BOUNDS', 'TECHNICAL', 'WARNING', 'FAIL', `字幕 cue 数与 Alignment 段数不一致（${String(cues.length)} vs ${String(input.expectedCueCount)}）`, {
        srtCues: cues.length,
        alignmentSegments: input.expectedCueCount,
      }));
    }
  }

  // 字幕行宽（重算断行；越界 → warning，不静默裁切）
  const style = captionStyleSchema.parse(input.captionStyle ?? {});
  const subtitles = buildSubtitles({ format: 'SRT', cues: input.captionCues, style });
  const widthIssues = subtitles.stats.overSafeWidthCues > 0 || subtitles.warnings.length > 0;
  checks.push(
    !widthIssues
      ? check('SUBTITLE_WIDTH_SAFE', 'TECHNICAL', 'WARNING', 'PASS', null, subtitles.stats)
      : check('SUBTITLE_WIDTH_SAFE', 'TECHNICAL', 'WARNING', 'FAIL', `字幕宽度安全区问题（截断 ${String(subtitles.stats.overSafeWidthCues)} 个 cue）：请缩短文本或调整样式`, {
          ...subtitles.stats,
          warnings: subtitles.warnings,
        }),
  );

  // 显式 SKIP（不静默略过）：
  checks.push(check('AUDIO_LOUDNESS_RANGE', 'TECHNICAL', 'WARNING', 'SKIP', '响度/峰值核验需要 FFmpeg ebur128——V1 未交付（记录为 SKIP，上线前补）'));
  checks.push(check('AI_VISUAL_QA', 'TECHNICAL', 'WARNING', 'SKIP', 'AI/Visual QA（§86 SHOULD：缩略帧抽样评估）未交付——随部署层网络阻断渲染（P08）接入'));

  return { checks, recomputedSha };
}

/** 汇总判定：任一 BLOCKER 失败 → FAIL。 */
export function summarizeQa(checks: readonly QaCheck[]): QaReport['summary'] & { verdict: 'PASS' | 'FAIL' } {
  const blockersFailed = checks.filter((item) => item.severity === 'BLOCKER' && item.status === 'FAIL').length;
  const warningsFailed = checks.filter((item) => item.severity === 'WARNING' && item.status === 'FAIL').length;
  const skipped = checks.filter((item) => item.status === 'SKIP').length;
  return { blockersFailed, warningsFailed, skipped, verdict: blockersFailed > 0 ? 'FAIL' : 'PASS' };
}

/* ---------- 数据装载（预检 / Final QA） ---------- */

/** 项目来源记录（project_sources）：来源追溯的权威集合（graph.sourceReferences 为 P02-01 占位）。 */
async function loadKnownSourceIds(deps: DomainDeps, workspaceId: string, projectId: string): Promise<ReadonlySet<string>> {
  const rows = await deps.db
    .select({ id: projectSources.id })
    .from(projectSources)
    .where(and(eq(projectSources.workspaceId, workspaceId), eq(projectSources.projectId, projectId)));
  return new Set(rows.map((row) => row.id));
}

async function countPendingProviderJobs(deps: DomainDeps, workspaceId: string, projectId: string): Promise<number> {
  const rows = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.projectId, projectId),
        eq(jobs.type, GENERATE_JOB_TYPE),
        notInArray(jobs.status, ['SUCCEEDED', 'FAILED_FINAL', 'CANCELLED']),
      ),
    );
  return rows.length;
}

/** 批量读取资产 origin（EVIDENCE_ASSET_ORIGIN 检查用；缺行 → 不含 origin 字段）。 */
async function loadAssetOrigins(deps: DomainDeps, assetIds: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(assetIds)];
  if (unique.length === 0) return new Map();
  const rows = await deps.db.select({ id: assets.id, origin: assets.origin }).from(assets).where(inArray(assets.id, unique));
  return new Map(rows.map((row) => [row.id, row.origin]));
}

const bindWithOrigin = (bindings: readonly { assetId: string }[], originById: Map<string, string>): { assetId: string; origin?: string }[] =>
  bindings.map((binding) => {
    const origin = originById.get(binding.assetId);
    return origin === undefined ? { assetId: binding.assetId } : { assetId: binding.assetId, origin };
  });

/** 渲染前预检（对当前项目状态；只读查询，不产生报告行）。 */
export async function precheckRenderReadiness(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<QaReport> {
  const graph = await assembleSceneGraph(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const master = await getCurrentMasterNarration(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const originById = await loadAssetOrigins(deps, graph.scenes.flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)));
  const subject: QaSubject = {
    scenes: graph.scenes.map((scene) => ({
      id: scene.id,
      sceneType: scene.sceneType,
      semanticType: scene.semanticType,
      status: scene.status,
      needsReview: scene.needsReview,
      dataBindings: scene.dataBindings.map((binding) => ({ datasetId: binding.datasetId })),
      sourceBindings: scene.sourceBindings.map((binding) => ({ sourceId: binding.sourceId })),
      assetBindings: bindWithOrigin(scene.assetBindings, originById),
    })),
    knownSourceIds: await loadKnownSourceIds(deps, input.workspaceId, input.projectId),
    frozenAssetIds: null,
    masterPresent: master !== null,
    pendingProviderJobs: await countPendingProviderJobs(deps, input.workspaceId, input.projectId),
  };
  const checks = runContentChecks(subject, 'PRE_RENDER');
  const summary = summarizeQa(checks);
  return qaReportSchema.parse({
    schemaVersion: QA_REPORT_VERSION,
    scope: 'PRE_RENDER',
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    renderId: null,
    verdict: summary.verdict,
    checks,
    summary: { blockersFailed: summary.blockersFailed, warningsFailed: summary.warningsFailed, skipped: summary.skipped },
    createdAt: new Date().toISOString(),
    createdBy: null,
  });
}

async function loadArtifactsForRender(
  deps: DomainDeps,
  render: RenderRecord,
): Promise<QaArtifactBytes[]> {
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：QA 必须复核产物字节', 501, { reason: QA_ERROR_REASONS.ARTIFACT_MISSING });
  }
  if (render.outputAssetIds.length === 0) return [];
  const versionRows = await deps.db
    .select()
    .from(assetVersions)
    .where(and(eq(assetVersions.workspaceId, render.workspaceId), inArray(assetVersions.assetId, render.outputAssetIds)));
  const assetRows = await deps.db.select().from(assets).where(inArray(assets.id, render.outputAssetIds));
  const kindByAssetId = new Map<string, QaArtifactBytes['kind']>();
  for (const row of assetRows) {
    const kind = (row.metadata as Record<string, unknown>)['kind'];
    if (kind === 'VIDEO' || kind === 'SUBTITLE_SRT' || kind === 'SUBTITLE_VTT' || kind === 'MANIFEST') kindByAssetId.set(row.id, kind);
  }
  const artifacts: QaArtifactBytes[] = [];
  for (const version of versionRows) {
    const kind = kindByAssetId.get(version.assetId);
    if (kind === undefined) continue;
    const bytes = await storage.getObject(version.storageKey);
    if (bytes === null) {
      throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `产物对象缺失：${version.storageKey}`, 409, { reason: QA_ERROR_REASONS.ARTIFACT_MISSING, storageKey: version.storageKey });
    }
    artifacts.push({
      kind,
      fileName: version.storageKey.split('/').at(-1) ?? kind,
      bytes,
      recordedChecksumSha256: version.checksumSha256,
    });
  }
  return artifacts;
}

export interface RunRenderQaResult {
  report: QaReport;
  render: RenderRecord;
}

/**
 * Final QA（对冻结快照 + 产物字节独立复核）→ 落库报告 → Render=READY/FAILED。
 * 幂等：仅当 Render 处于 QA 状态执行；已 READY/FAILED → 400/409 明确失败（重新 QA 需重新渲染）。
 */
export async function runRenderQa(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string; probe?: RenderMediaProbe | undefined; createdBy?: string | null },
): Promise<RunRenderQaResult> {
  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status !== 'QA') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Render 不在 QA 状态（当前 ${render.status}）：QA 只判定处于 QA 的渲染`, 409, {
      reason: QA_ERROR_REASONS.RENDER_NOT_IN_QA,
      status: render.status,
    });
  }

  // 1) 冻结快照（内容检查的权威输入）
  const versionRows = await deps.db.select().from(projectVersions).where(eq(projectVersions.id, render.input.projectVersionId)).limit(1);
  const versionRow = versionRows[0];
  if (versionRow === undefined) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'Render 输入快照丢失（版本不可变，不应发生）', 500);
  }
  const snapshot = projectVersionSnapshotSchema.parse(versionRow.snapshot);
  const graph = snapshot.graph;
  const master = render.input.masterNarrationId === null ? null : await getMasterNarrationById(deps, { workspaceId: render.workspaceId, narrationId: render.input.masterNarrationId });
  const frozenAssetIds = new Set<string>();
  {
    const rows = await deps.db
      .select({ assetId: assetVersions.assetId })
      .from(assetVersions)
      .where(and(eq(assetVersions.workspaceId, render.workspaceId), inArray(assetVersions.id, render.input.assetVersionIds.length === 0 ? ['__none__'] : render.input.assetVersionIds)));
    for (const row of rows) frozenAssetIds.add(row.assetId);
  }

  const originById = await loadAssetOrigins(deps, graph.scenes.flatMap((scene) => scene.assetBindings.map((binding) => binding.assetId)));
  const subject: QaSubject = {
    scenes: graph.scenes.map((scene) => ({
      id: scene.id,
      sceneType: scene.sceneType,
      semanticType: scene.semanticType,
      status: scene.status,
      needsReview: scene.needsReview,
      dataBindings: scene.dataBindings.map((binding) => ({ datasetId: binding.datasetId })),
      sourceBindings: scene.sourceBindings.map((binding) => ({ sourceId: binding.sourceId })),
      assetBindings: bindWithOrigin(scene.assetBindings, originById),
    })),
    knownSourceIds: await loadKnownSourceIds(deps, render.workspaceId, render.projectId),
    frozenAssetIds,
    masterPresent: master !== null,
    pendingProviderJobs: await countPendingProviderJobs(deps, render.workspaceId, render.projectId),
  };
  const checks = runContentChecks(subject, 'PRE_RENDER');

  // 2) 技术核验（产物字节；**始终执行**——产物缺失/探测不可用由检查项显式反映，绝不静默跳过）
  const artifacts = await loadArtifactsForRender(deps, render);
  const manifestArtifact = artifacts.find((artifact) => artifact.kind === 'MANIFEST');
  const manifest = manifestArtifact === undefined ? null : renderManifestSchema.parse(JSON.parse(Buffer.from(manifestArtifact.bytes).toString('utf8')));
  const videoArtifact = artifacts.find((artifact) => artifact.kind === 'VIDEO');
  let probeResult: MediaProbeResult | null = null;
  if (videoArtifact !== undefined && input.probe !== undefined) {
    probeResult = await input.probe.probe({ bytes: videoArtifact.bytes, mimeType: 'video/mp4' });
  }

  const technical = await runTechnicalChecks({
    artifacts,
    probeResult,
    expectedFormat: render.input.format,
    manifestDurationMs: manifest?.renderSettings.durationMs ?? 0,
    masterDurationMs: master?.totalDurationMs ?? 0,
    expectedCueCount: master?.segments.length ?? 0,
    captionStyle: {},
    captionCues: master?.segments.map((segment) => ({ startMs: segment.startMs, durationMs: segment.durationMs, text: segment.text })) ?? [],
  });
  checks.push(...technical.checks);

  const summary = summarizeQa(checks);
  const report = qaReportSchema.parse({
    schemaVersion: QA_REPORT_VERSION,
    scope: 'FINAL_RENDER',
    workspaceId: render.workspaceId,
    projectId: render.projectId,
    renderId: render.id,
    verdict: summary.verdict,
    checks,
    summary: { blockersFailed: summary.blockersFailed, warningsFailed: summary.warningsFailed, skipped: summary.skipped },
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? null,
  });

  // 3) 落库（append-only）+ 状态迁移
  await deps.db.insert(renderQaReports).values({
    id: `qar_${randomUUID()}`,
    workspaceId: render.workspaceId,
    projectId: render.projectId,
    renderId: render.id,
    verdict: report.verdict,
    blockersFailed: report.summary.blockersFailed,
    warningsFailed: report.summary.warningsFailed,
    skipped: report.summary.skipped,
    report,
    createdBy: input.createdBy ?? null,
  });

  const failedChecks = checks.filter((item) => item.status === 'FAIL').map((item) => `${item.id}:${item.severity}`);
  const next =
    report.verdict === 'PASS'
      ? await transitionRender(deps, {
          workspaceId: render.workspaceId,
          renderId: render.id,
          to: 'READY',
          note: `QA 通过（${String(checks.length)} 项检查；SKIP ${String(report.summary.skipped)}），等待人工批准（§87）`,
        })
      : await transitionRender(deps, {
          workspaceId: render.workspaceId,
          renderId: render.id,
          to: 'FAILED',
          note: `QA 未通过（BLOCKER 失败 ${String(report.summary.blockersFailed)}）：${failedChecks.slice(0, 6).join(', ')}`,
        });

  return { report, render: next };
}

/** 最新 QA 报告（UI/审批消费）。 */
export async function getLatestRenderQaReport(deps: DomainDeps, input: { workspaceId: string; renderId: string }): Promise<QaReport | null> {
  const rows = await deps.db
    .select()
    .from(renderQaReports)
    .where(and(eq(renderQaReports.workspaceId, input.workspaceId), eq(renderQaReports.renderId, input.renderId)))
    .orderBy(desc(renderQaReports.createdAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : qaReportSchema.parse(row.report);
}

/** 手动触发 QA（仅 QA 状态；用于自动入队窗口的恢复与重试——同一 Render 重跑 QA 产生新报告）。 */
export async function triggerRenderQa(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string; requestedBy?: string | null },
): Promise<{ jobId: string }> {
  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status !== 'QA') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Render 不在 QA 状态（当前 ${render.status}）：QA 只判定处于 QA 的渲染`, 409, {
      reason: QA_ERROR_REASONS.RENDER_NOT_IN_QA,
      status: render.status,
    });
  }
  const job = await createJob(deps, {
    workspaceId: render.workspaceId,
    projectId: render.projectId,
    type: 'RENDER_QA',
    input: { renderId: render.id, requestedBy: input.requestedBy ?? null },
    maxAttempts: 2,
    createdBy: input.requestedBy ?? null,
  });
  return { jobId: job.id };
}
