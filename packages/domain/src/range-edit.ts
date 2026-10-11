import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  EDIT_OPERATION_REGISTRY,
  ERROR_CODES,
  RANGE_EDIT_ERROR_REASONS,
  RANGE_EDIT_OUT_OF_SCOPE_REASONS,
  RANGE_EDIT_PLAN_VERSION,
  editOperationSchema,
  estimateRangeEditDurationDeltaMs,
  mediaTimeToDisplayMilliseconds,
  mediaTimesEqual,
  mediaRangeSchema,
  productionPolicySchema,
  rangeEditPlanSchema,
  resolveScopeGuard,
  sourceMediaProbeResultSchema,
  type CreateRangeEditPlanRequest,
  type EditOperation,
  type RangeEditOutOfScope,
  type RangeEditPlan,
  type RangeEditSourceEvidence,
} from '@ancs/contracts';
import { assetVersions, projectObjectLocks, projectSequences, projects, sequenceClips } from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * N03-09 范围编辑的最小 AI 入口（V03-01／V03-04／V03-28／V03-29）。
 *
 * 规划器输入：选中片段 + 相邻片段（源证据）、Brief、**允许操作清单**、项目策略。
 * 规划器输出：结构化操作 → 逐条契约校验 → 允许清单校验 → 源引用校验 → 策略/锁校验
 *   → 可执行操作 + 显式 `outOfScope`（含原因）。
 *
 * 纪律：计划阶段不写库、不产生任何 Provider 媒体调用（生成式意图只能由用户显式发起）。
 */

export const RANGE_EDIT_PROMPT_VERSION = 'range-edit-v1';

const MAX_ATTEMPTS = 2;

/** 提示词/证据用的显示毫秒（近似值，绝不回写权威时间；非整毫秒时基不抛异常）。 */
const msOf = (range: unknown): { start: number; end: number } => {
  const parsed = mediaRangeSchema.parse(range);
  return { start: mediaTimeToDisplayMilliseconds(parsed.start, 'floor'), end: mediaTimeToDisplayMilliseconds(parsed.end, 'ceil') };
};

/** 同轨首尾相接（精确比较，跨时基）。 */
const abuts = (left: unknown, right: unknown): boolean => {
  const a = mediaRangeSchema.parse(left);
  const b = mediaRangeSchema.parse(right);
  return mediaTimesEqual(a.end, b.start) || mediaTimesEqual(a.start, b.end);
};

/** 可审计的提示词（把证据与允许操作写进提示词）。 */
export function buildRangeEditPrompts(input: {
  prompt: string;
  evidence: readonly RangeEditSourceEvidence[];
  allowedOperations: readonly string[];
  brief: { objective: string; audience: string; notes: string };
  policy: { mode: string; preserveOriginalSpeech: boolean; allowGeneratedMedia: boolean };
}): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = [
    '你是视频剪辑助手。把用户的自然语言意图翻译为**结构化编辑计划**（JSON），不得输出其他文本。',
    `只允许使用这些操作类型：${input.allowedOperations.join('、')}。`,
    '每条操作只能引用下方"候选片段"里的 clip id；严禁虚构 id、资产或素材。',
    '输出结构：{ "rationale": string[], "operations": object[], "outOfScope": {request, reason, detail}[] }。',
    input.policy.preserveOriginalSpeech
      ? '原声保护已开启：不得改变语言内容（不要改动音频源流或音频局部时间）。'
      : '可以调整音频参数，但仍不得虚构素材。',
    '不要产生任何素材生成意图；需要新素材时写进 outOfScope 并说明。',
    `promptVersion: ${RANGE_EDIT_PROMPT_VERSION}`,
  ].join('\n');
  const evidenceLines = input.evidence
    .map((item) => `- clip id=${item.clipId} seqStartMs=${String(item.sequenceRangeMs.start)} seqEndMs=${String(item.sequenceRangeMs.end)} srcStartMs=${String(item.sourceRangeMs.start)} srcEndMs=${String(item.sourceRangeMs.end)} hasAudio=${String(item.sourceHasAudio)} selected=${String(item.selected)} locked=${String(item.locked)}`)
    .join('\n');
  const userPrompt = [
    `用户意图：${input.prompt}`,
    `Brief：objective=${input.brief.objective} audience=${input.brief.audience} notes=${input.brief.notes}`,
    '',
    '候选片段：',
    evidenceLines,
  ].join('\n');
  return { systemPrompt, userPrompt };
}

/** 操作引用的目标 id（用于源引用校验）。 */
function referencedIds(operation: EditOperation): string[] {
  const ids = new Set<string>();
  const record = operation as unknown as Record<string, unknown>;
  for (const key of ['clipId', 'leftClipId', 'rightClipId', 'videoClipId', 'audioClipId', 'cutCaptionId', 'captionId', 'audioRegionId', 'trackId']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) ids.add(value);
  }
  for (const key of ['clipIds']) {
    const value = record[key];
    if (Array.isArray(value)) for (const item of value) if (typeof item === 'string') ids.add(item);
  }
  return [...ids];
}

const touchesAudioClock = (operation: EditOperation): boolean =>
  operation.op === 'update_audio_region'
    ? operation.changes.sourceStreamId !== undefined || operation.changes.localRange !== undefined || operation.changes.timeBinding !== undefined
    : false;

export async function planRangeEdit(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  request: CreateRangeEditPlanRequest;
}): Promise<RangeEditPlan> {
  const llm = deps.llm;
  if (llm === undefined || llm.completePrompt === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '结构化的规划器适配器不可用', 501, { reason: RANGE_EDIT_ERROR_REASONS.PLANNER_UNAVAILABLE });
  }
  const sequenceRows = await deps.db.select().from(projectSequences).where(and(
    eq(projectSequences.id, input.request.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  const sequence = sequenceRows[0];
  if (!sequence) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404);

  const projectRows = await deps.db.select().from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  const project = projectRows[0];
  if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const policy = productionPolicySchema.parse(project.productionPolicy);
  const allowGeneratedMedia = policy.allowGeneratedVideo || policy.allowGeneratedImage || policy.allowGeneratedSpeech || policy.allowGeneratedMusic || policy.allowGeneratedSfx;

  const clips = await deps.db.select({
    clip: sequenceClips,
    mediaProbe: assetVersions.mediaProbe,
  }).from(sequenceClips)
    .innerJoin(assetVersions, eq(assetVersions.id, sequenceClips.assetVersionId))
    .where(and(
      eq(sequenceClips.sequenceId, input.request.sequenceId),
      eq(sequenceClips.workspaceId, input.workspaceId),
      eq(sequenceClips.projectId, input.projectId),
    ));
  const selectedClipIds = new Set(input.request.selectedClipIds);
  const selectedRows = clips.filter((row) => selectedClipIds.has(row.clip.id));
  if (selectedRows.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'selected clips do not belong to this sequence', 422, { reason: RANGE_EDIT_ERROR_REASONS.INVALID_SELECTION });
  }
  const locks = await deps.db.select({ objectKind: projectObjectLocks.objectKind, objectId: projectObjectLocks.objectId }).from(projectObjectLocks).where(and(
    eq(projectObjectLocks.projectId, input.projectId), eq(projectObjectLocks.workspaceId, input.workspaceId),
  ));
  const lockedIds = new Set(locks.map((lock) => lock.objectId));

  // 源证据 = 选中片段 + 同轨相邻片段（规划器只能引用这些）
  const evidenceRows = clips.filter((row) => selectedClipIds.has(row.clip.id)
    || selectedRows.some((selected) => selected.clip.trackId === row.clip.trackId
      && abuts(row.clip.sequenceRange, selected.clip.sequenceRange)));
  const evidence: RangeEditSourceEvidence[] = evidenceRows.map((row) => {
    const probe = sourceMediaProbeResultSchema.safeParse(row.mediaProbe);
    return {
      clipId: row.clip.id,
      trackId: row.clip.trackId,
      selected: selectedClipIds.has(row.clip.id),
      adjacent: !selectedClipIds.has(row.clip.id),
      sequenceRangeMs: msOf(row.clip.sequenceRange),
      sourceRangeMs: msOf(row.clip.sourceRange),
      assetVersionId: row.clip.assetVersionId ?? '',
      sourceHasAudio: probe.success && probe.data.status === 'READY' && probe.data.streams.some((stream) => stream.type === 'AUDIO'),
      locked: lockedIds.has(row.clip.id),
    };
  });

  const allowed = new Set<string>(input.request.allowedOperations);
  const prompts = buildRangeEditPrompts({
    prompt: input.request.prompt,
    evidence,
    allowedOperations: input.request.allowedOperations,
    brief: {
      objective: input.request.brief?.objective ?? '',
      audience: input.request.brief?.audience ?? '',
      notes: input.request.brief?.notes ?? '',
    },
    policy: { mode: policy.mode, preserveOriginalSpeech: policy.preserveOriginalSpeech, allowGeneratedMedia },
  });

  let raw: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const completion = await llm.completePrompt({ purpose: 'range_edit', systemPrompt: prompts.systemPrompt, userPrompt: prompts.userPrompt });
    try {
      raw = JSON.parse(completion.content) as unknown;
      break;
    } catch {
      raw = undefined;
    }
  }
  if (raw === undefined || typeof raw !== 'object' || raw === null) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '规划器输出不可解析', 422, { reason: RANGE_EDIT_ERROR_REASONS.INVALID_PLANNER_OUTPUT });
  }
  const candidate = raw as { rationale?: unknown; operations?: unknown; outOfScope?: unknown };
  const rationale = Array.isArray(candidate.rationale) ? candidate.rationale.filter((item): item is string => typeof item === 'string') : [];
  const proposed = Array.isArray(candidate.operations) ? candidate.operations : [];
  const declaredOutOfScope = Array.isArray(candidate.outOfScope) ? candidate.outOfScope : [];

  const operations: EditOperation[] = [];
  const outOfScope: RangeEditOutOfScope[] = [];
  for (const item of declaredOutOfScope) {
    const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
    outOfScope.push({
      request: typeof record['request'] === 'string' ? record['request'].slice(0, 500) : '',
      reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.UNKNOWN_SOURCE_REFERENCE,
      detail: typeof record['detail'] === 'string' ? record['detail'].slice(0, 500) : '',
    });
  }
  for (const item of proposed) {
    const parsed = editOperationSchema.safeParse(item);
    if (!parsed.success) {
      outOfScope.push({
        request: typeof (item as { op?: unknown })?.op === 'string' ? String((item as { op: string }).op) : 'unknown',
        reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.INVALID_OPERATION,
        detail: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ').slice(0, 500),
      });
      continue;
    }
    const operation = parsed.data;
    if (!allowed.has(operation.op)) {
      outOfScope.push({ request: operation.op, reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.NOT_ALLOWED_OPERATION, detail: '不在本次允许的操作清单内' });
      continue;
    }
    const evidenceIds = new Set(evidence.map((item) => item.clipId));
    const unknown = referencedIds(operation).filter((id) => !evidenceIds.has(id) && !id.startsWith('trk_') && !id.startsWith('cap_') && !id.startsWith('aud_'));
    if (unknown.length > 0) {
      outOfScope.push({ request: operation.op, reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.UNKNOWN_SOURCE_REFERENCE, detail: `引用了源证据之外的 id：${unknown.join(',')}` });
      continue;
    }
    if (lockedIds.has((operation as { clipId?: string }).clipId ?? '')) {
      outOfScope.push({ request: operation.op, reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.LOCKED_TARGET, detail: '目标片段被锁定，需先显式解锁' });
      continue;
    }
    if (policy.preserveOriginalSpeech && touchesAudioClock(operation)) {
      outOfScope.push({ request: operation.op, reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.POLICY_FORBIDDEN, detail: '原声保护开启：不得改动音频源时钟' });
      continue;
    }
    if (EDIT_OPERATION_REGISTRY[operation.op].availability !== 'ACTIVE') {
      outOfScope.push({ request: operation.op, reason: RANGE_EDIT_OUT_OF_SCOPE_REASONS.NOT_ALLOWED_OPERATION, detail: '该操作当前不可用（注册表非 ACTIVE）' });
      continue;
    }
    operations.push(operation);
  }

  if (operations.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '计划中没有可执行操作', 422, {
      reason: RANGE_EDIT_ERROR_REASONS.NO_EXECUTABLE_OPERATIONS,
      outOfScope,
    });
  }

  // N06-07：总时长守卫 —— "其他别动"下变长必须先解释或改等长方案（由操作负载确定性估算）。
  const durationEstimate = estimateRangeEditDurationDeltaMs(operations);
  // 等长替代：涟漪是**显式选择**的收缝动作 → 其"不涟漪（留空隙）"的变体即等长方案。
  const equalLengthAlternativeAvailable = operations.some((operation) => operation.op === 'ripple_clip' && operation.action !== 'DELETE');
  const guard = resolveScopeGuard({
    preservesEverythingElse: input.request.preservesEverythingElse ?? false,
    durationDeltaMs: durationEstimate.deltaMs,
    equalLengthAlternativeAvailable,
    exact: durationEstimate.exact,
  });
  const lengthGuard = {
    preservesEverythingElse: input.request.preservesEverythingElse ?? false,
    estimatedDurationDeltaMs: durationEstimate.deltaMs,
    exact: durationEstimate.exact,
    verdict: guard.verdict,
    requiresExplanation: guard.requiresExplanation,
    recommendEqualLength: guard.recommendEqualLength,
    reason: guard.reason,
  };
  const finalRationale = guard.requiresExplanation
    ? [...rationale, `总时长守卫：${guard.reason}（估算变化 ${String(durationEstimate.deltaMs)}ms；请先向用户解释，或改用等长方案）`]
    : rationale;

  return rangeEditPlanSchema.parse({
    planVersion: RANGE_EDIT_PLAN_VERSION,
    projectId: input.projectId,
    sequenceId: input.request.sequenceId,
    documentRevision: project.revision,
    rationale: finalRationale.slice(0, 100).map((item) => item.slice(0, 500)),
    operations,
    outOfScope,
    evidence,
    // 原声保留判据：计划里没有任何触碰音频源时钟的操作
    originalAudioPreserved: operations.every((operation) => !touchesAudioClock(operation)),
    lengthGuard,
    providerMediaCalls: 0,
    policy: { mode: policy.mode, preserveOriginalSpeech: policy.preserveOriginalSpeech, allowGeneratedMedia },
  });
}
