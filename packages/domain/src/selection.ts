import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  SELECTION_RESOLUTION_STATUSES,
  addMediaTime,
  compareMediaTime,
  mediaRangeSchema,
  selectionAnchorFromLegacySelection,
  selectionAnchorRecordSchema,
  selectionAnchorSchema,
  selectionFingerprintInput,
  selectionRecoveryResultSchema,
  sequenceTimeToSourcePts,
  sourcePtsToSequenceTime,
  subtractMediaTime,
  temporalSelectionSchema,
  type LegacySelection,
  type MediaRange,
  type MediaTime,
  type OrderedTargetRef,
  type SelectionAnchor,
  type SelectionAnchorRecord,
  type SelectionRecoveryResult,
  type SelectionRecoveryTrigger,
  type TemporalSelection,
} from '@ancs/contracts';
import {
  compositionCaptionSpans,
  compositionVisualObjects,
  isUniqueViolation,
  projectSequences,
  sequenceClips,
  sequenceTracks,
  selectionAnchors,
} from '@ancs/db';
import type { DomainDeps } from './deps.js';

/**
 * N04-09：SelectionAnchor 归一与旧 Attention 兼容。
 *
 * - 规范锚点**唯一**（AttentionSnapshot 的选择子结构），旧 inline 选择经 `fromLegacy` 解析一次；
 * - 保存锚点**不改工程**（不推进 project revision、不写 edit_events）；
 * - 读取按 workspace/project 归属过滤（跨租户 404）；
 * - `remap` 把锚点目标重解析到**当前**工程状态：目标消失 → FAILED/PARTIAL 并记录 remapHistory，
 *   重复素材引用产生多个候选 → AMBIGUOUS（附候选证据，**不随机选一个**）。
 */

export const SELECTION_ERROR_REASONS = {
  ANCHOR_NOT_FOUND: 'SELECTION_ANCHOR_NOT_FOUND',
  INVALID_TARGET: 'SELECTION_INVALID_TARGET',
  STALE_TARGET: 'SELECTION_STALE_TARGET',
  AMBIGUOUS_TARGET: 'SELECTION_AMBIGUOUS_TARGET',
  FRAME_HASH_NOT_IDENTITY: 'SELECTION_FRAME_HASH_NOT_IDENTITY',
  /** N04-10：刷新/双请求并发恢复，期望修订与当前最新修订不一致 */
  CONCURRENT_UPDATE: 'SELECTION_CONCURRENT_UPDATE',
} as const;

export type SelectionErrorReason = (typeof SELECTION_ERROR_REASONS)[keyof typeof SELECTION_ERROR_REASONS];

const hashFingerprint = (anchor: SelectionAnchor): string => createHash('sha256').update(selectionFingerprintInput(anchor)).digest('hex');

type TargetLookup = 'PRESENT' | 'MISSING' | 'FOREIGN';

/**
 * 目标归属判定：
 * - PRESENT：目标就在本序列里；
 * - FOREIGN：目标存在于**同工作区的其他项目**（越权引用，永远拒绝）；
 * - MISSING：目标已不存在（删除/换源后），仅在锚点状态非 RESOLVED 时允许持久化（remap 需要记录失效）。
 */
const lookupTarget = async (
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
  sequenceId: string,
  target: { targetKind: string; targetRef: string },
): Promise<TargetLookup> => {
  switch (target.targetKind) {
    case 'CLIP': {
      const rows = await deps.db.select({ projectId: sequenceClips.projectId, sequenceId: sequenceClips.sequenceId }).from(sequenceClips).where(and(
        eq(sequenceClips.id, target.targetRef), eq(sequenceClips.workspaceId, input.workspaceId),
      ));
      if (rows.length === 0) return 'MISSING';
      return rows[0]!.projectId === input.projectId && rows[0]!.sequenceId === sequenceId ? 'PRESENT' : 'FOREIGN';
    }
    case 'TRACK': {
      const rows = await deps.db.select({ projectId: sequenceTracks.projectId, sequenceId: sequenceTracks.sequenceId }).from(sequenceTracks).where(and(
        eq(sequenceTracks.id, target.targetRef), eq(sequenceTracks.workspaceId, input.workspaceId),
      ));
      if (rows.length === 0) return 'MISSING';
      return rows[0]!.projectId === input.projectId && rows[0]!.sequenceId === sequenceId ? 'PRESENT' : 'FOREIGN';
    }
    case 'CAPTION': {
      const rows = await deps.db.select({ projectId: compositionCaptionSpans.projectId }).from(compositionCaptionSpans).where(and(
        eq(compositionCaptionSpans.id, target.targetRef), eq(compositionCaptionSpans.workspaceId, input.workspaceId),
      ));
      if (rows.length === 0) return 'MISSING';
      return rows[0]!.projectId === input.projectId ? 'PRESENT' : 'FOREIGN';
    }
    case 'VISUAL_OBJECT': {
      const rows = await deps.db.select({ projectId: compositionVisualObjects.projectId }).from(compositionVisualObjects).where(and(
        eq(compositionVisualObjects.id, target.targetRef), eq(compositionVisualObjects.workspaceId, input.workspaceId),
      ));
      if (rows.length === 0) return 'MISSING';
      return rows[0]!.projectId === input.projectId ? 'PRESENT' : 'FOREIGN';
    }
    default:
      // PIXEL_REGION 等纯几何目标没有对象身份（也不得把预览帧号/帧哈希当身份）：按存在处理，
      // 授权仍由服务端权限/锁/影响集判定（几何不构成授权）。
      return 'PRESENT';
  }
};

export async function saveSelectionAnchor(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  actorId?: string;
  anchor: SelectionAnchor;
  /** 旧 inline 选择（可选）：与 anchor 同时给出时以 anchor 为准，legacy 仅作兼容解析入口 */
  legacy?: LegacySelection;
}): Promise<SelectionAnchorRecord> {
  const sequenceRows = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
    eq(projectSequences.id, input.anchor.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  if (sequenceRows.length === 0) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'sequence not found', 404, { reason: SELECTION_ERROR_REASONS.ANCHOR_NOT_FOUND });
  }
  const resolved = input.legacy === undefined
    ? selectionAnchorSchema.parse(input.anchor)
    : selectionAnchorFromLegacySelection({
      anchorId: input.anchor.anchorId, workspaceId: input.workspaceId, projectId: input.projectId,
      sequenceId: input.anchor.sequenceId, revision: input.anchor.revision, legacy: input.legacy,
    });

  assertNotFrameHashIdentity(resolved.orderedTargetRefs);
  // 目标归属：越权（同工作区其他项目）永远拒绝；目标已消失只允许以非 RESOLVED 状态持久化（remap 记录失效）。
  for (const target of resolved.orderedTargetRefs) {
    const lookup = await lookupTarget(deps, input, resolved.sequenceId, target);
    if (lookup === 'FOREIGN' || (lookup === 'MISSING' && resolved.resolutionStatus === 'RESOLVED')) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'selection target does not belong to this sequence', 422, {
        reason: SELECTION_ERROR_REASONS.INVALID_TARGET, targetRef: target.targetRef, targetKind: target.targetKind, lookup,
      });
    }
  }

  const fingerprint = hashFingerprint(resolved);
  const normalized = selectionAnchorSchema.parse({ ...resolved, fingerprintInput: fingerprint });
  const existing = await deps.db.select({ revision: selectionAnchors.revision }).from(selectionAnchors).where(and(
    eq(selectionAnchors.id, normalized.anchorId),
    eq(selectionAnchors.workspaceId, input.workspaceId),
    eq(selectionAnchors.projectId, input.projectId),
  )).orderBy(desc(selectionAnchors.revision)).limit(1);
  const revision = existing[0] === undefined ? 1 : existing[0].revision + 1;
  const now = new Date();
  try {
    await deps.db.insert(selectionAnchors).values({
      id: normalized.anchorId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      sequenceId: normalized.sequenceId,
      revision,
      fingerprint,
      createdBy: input.actorId ?? null,
      anchor: normalized,
      createdAt: now,
      updatedAt: now,
    });
  } catch (error) {
    // 并发追加同一 (anchor, revision) → 主键冲突；按乐观并发冲突返回，绝不静默覆盖。
    if (isUniqueViolation(error)) {
      throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'selection anchor revision conflict', 409, {
        reason: SELECTION_ERROR_REASONS.CONCURRENT_UPDATE,
      });
    }
    throw error;
  }
  return selectionAnchorRecordSchema.parse({ anchor: { ...normalized, revision }, fingerprint, revision });
}

export async function getSelectionAnchor(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  anchorId: string;
}): Promise<SelectionAnchorRecord> {
  const rows = await deps.db.select().from(selectionAnchors).where(and(
    eq(selectionAnchors.id, input.anchorId),
    eq(selectionAnchors.workspaceId, input.workspaceId),
    eq(selectionAnchors.projectId, input.projectId),
  )).orderBy(desc(selectionAnchors.revision)).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'selection anchor not found', 404, { reason: SELECTION_ERROR_REASONS.ANCHOR_NOT_FOUND });
  }
  // 锚点载荷内的 revision 与存储修订同步（同一锚点的最新修订号），避免出现两份"当前修订"语义
  return selectionAnchorRecordSchema.parse({
    anchor: { ...selectionAnchorSchema.parse(row.anchor), revision: row.revision },
    revision: row.revision,
    fingerprint: row.fingerprint,
  });
}

/**
 * 把锚点重解析到当前工程状态（N04-10 的刷新/时序变更恢复的第一块）：
 * - 目标仍存在 → RESOLVED；
 * - 目标消失 → FAILED（全部消失）或 PARTIAL（部分消失），并逐条记录 remapHistory；
 * - 目标存在但对应素材被多个位置引用 → AMBIGUOUS（附候选证据）；
 * - 锚点的轨道/属性作用域不再有效 → PARTIAL。
 */
export async function remapSelectionAnchor(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  anchorId: string;
  reason: string;
}): Promise<SelectionAnchorRecord> {
  const record = await getSelectionAnchor(deps, input);
  const anchor = record.anchor;
  const clips = await deps.db.select().from(sequenceClips).where(and(
    eq(sequenceClips.sequenceId, anchor.sequenceId),
    eq(sequenceClips.workspaceId, input.workspaceId),
    eq(sequenceClips.projectId, input.projectId),
  ));
  const evidenceRefs: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  for (const target of anchor.orderedTargetRefs) {
    const lookup = await lookupTarget(deps, input, anchor.sequenceId, target);
    if (lookup !== 'PRESENT') {
      missing.push(target.targetRef);
      continue;
    }
    if (target.targetKind === 'CLIP') {
      const source = clips.find((clip) => clip.id === target.targetRef);
      // 版本过期：锚点记录的是当时的源版本，而片段已经换了源 → STALE（明确过期，不冒充仍然有效）
      if (source !== undefined && target.assetVersionId !== null && source.assetVersionId !== target.assetVersionId) {
        stale.push(target.targetRef);
      }
      if (source?.assetVersionId != null) {
        // 同一源版本被多个位置引用 → AMBIGUOUS（§4.3：不随机选一个）
        const duplicates = clips.filter((clip) => clip.assetVersionId === source.assetVersionId);
        if (duplicates.length > 1) {
          evidenceRefs.push(...duplicates.map((clip) => `clip:${clip.id}`));
        }
      }
    }
  }
  const trackRows = await deps.db.select({ id: sequenceTracks.id }).from(sequenceTracks).where(and(
    eq(sequenceTracks.sequenceId, anchor.sequenceId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
  ));
  const knownTrackIds = new Set(trackRows.map((row) => row.id));
  const trackScopeInvalid = anchor.trackScope.kind === 'TRACKS'
    && anchor.trackScope.trackIds.some((trackId) => !knownTrackIds.has(trackId));

  const nextStatus: (typeof SELECTION_RESOLUTION_STATUSES)[number] = evidenceRefs.length > 0
    ? 'AMBIGUOUS'
    : stale.length > 0
      ? 'STALE'
      : missing.length === 0 && !trackScopeInvalid
        ? 'RESOLVED'
        : missing.length === anchor.orderedTargetRefs.length && anchor.orderedTargetRefs.length > 0
          ? 'FAILED'
          : 'PARTIAL';

  const remapped = selectionAnchorSchema.parse({
    ...anchor,
    resolutionStatus: nextStatus,
    evidenceRefs: [...new Set([...anchor.evidenceRefs, ...evidenceRefs])].slice(0, 64),
    remapHistory: [...anchor.remapHistory, {
      fromRevision: anchor.revision,
      toRevision: anchor.revision + 1,
      reason: `${input.reason}${missing.length > 0 ? `（缺失目标：${missing.join(',')}）` : ''}${stale.length > 0 ? `（版本过期：${stale.join(',')}）` : ''}`.slice(0, 200),
      at: new Date().toISOString(),
    }].slice(-64),
  });
  return saveSelectionAnchor(deps, { workspaceId: input.workspaceId, projectId: input.projectId, anchor: remapped });
}

const ZERO_TIME: MediaTime = { ticks: '0', timebase: { num: 1, den: 1 } };

function sameRange(left: MediaRange | null, right: MediaRange | null): boolean {
  return left !== null && right !== null && compareMediaTime(left.start, right.start) === 0 && compareMediaTime(left.end, right.end) === 0;
}

function shiftTemporalSelection(selection: TemporalSelection, delta: MediaTime): TemporalSelection {
  if (selection.kind === 'POINT') return temporalSelectionSchema.parse({ ...selection, at: addMediaTime(selection.at, delta) });
  return temporalSelectionSchema.parse({
    ...selection,
    ranges: selection.ranges.map((range) => ({ start: addMediaTime(range.start, delta), end: addMediaTime(range.end, delta) })),
  });
}

/**
 * FOLLOW_SOURCE：把锚点的时间选择经基线映射到源时间，再映射到片段的**新**序列区间。
 * 映射失败（越界/坍缩）返回 null，由调用方标记 STALE/PARTIAL，不猜不近似。
 */
function reprojectTemporalViaSource(
  selection: TemporalSelection,
  oldSequence: MediaRange,
  oldSource: MediaRange,
  newSource: MediaRange,
  newSequence: MediaRange,
): TemporalSelection | null {
  try {
    if (selection.kind === 'POINT') {
      const pts = sequenceTimeToSourcePts(selection.at, oldSequence, oldSource, 'nearest');
      return temporalSelectionSchema.parse({ ...selection, at: sourcePtsToSequenceTime(pts, newSource, newSequence, 'nearest') });
    }
    const ranges = selection.ranges.map((range) => {
      const sourceStart = sequenceTimeToSourcePts(range.start, oldSequence, oldSource, 'nearest');
      const sourceEnd = sequenceTimeToSourcePts(range.end, oldSequence, oldSource, 'nearest');
      const nextStart = sourcePtsToSequenceTime(sourceStart, newSource, newSequence, 'nearest');
      const nextEnd = sourcePtsToSequenceTime(sourceEnd, newSource, newSequence, 'nearest');
      const ordered = compareMediaTime(nextStart, nextEnd) <= 0 ? [nextStart, nextEnd] : [nextEnd, nextStart];
      const start = ordered[0]!;
      const end = ordered[1]!;
      if (compareMediaTime(start, end) === 0) throw new RangeError('empty range after reprojection');
      return { start, end };
    });
    return temporalSelectionSchema.parse({ ...selection, ranges });
  } catch {
    return null;
  }
}

/**
 * N04-10：刷新/时序变更后的锚点自动恢复。
 *
 * - `expectedRevision` 与当前最新修订不符 → 409（旧回调/双请求不得覆盖新状态）；
 * - `FOLLOW_OBJECT`：片段在序列上移动后，时间选择**按位移跟随**，并更新基线；
 * - `FOLLOW_SOURCE`：片段修边/换源后，时间选择经基线映射到源时间再映射到**新**序列区间；映射失败标记 STALE；
 * - `SEQUENCE_FIXED`：不自动跟随（保持固定序列区间）；
 * - 目标消失/轨道作用域失效/嵌父序列缺失 → FAILED/PARTIAL；重复素材引用 → AMBIGUOUS；
 * - **刷新幂等**：没有实质变化时不追加新修订（changed=false），不制造噪音修订；
 * - 选择动作仍不改工程（只写锚点修订日志）。
 */
export async function recoverSelectionAnchor(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  anchorId: string;
  trigger: SelectionRecoveryTrigger;
  expectedRevision?: number;
  reason?: string;
}): Promise<SelectionRecoveryResult> {
  const record = await getSelectionAnchor(deps, input);
  const anchor = record.anchor;
  if (input.expectedRevision !== undefined && input.expectedRevision !== record.revision) {
    throw new ApiFailure(ERROR_CODES.VERSION_CONFLICT, 'selection anchor was updated concurrently', 409, {
      reason: SELECTION_ERROR_REASONS.CONCURRENT_UPDATE,
      expectedRevision: input.expectedRevision,
      actualRevision: record.revision,
    });
  }

  const clips = await deps.db.select().from(sequenceClips).where(and(
    eq(sequenceClips.sequenceId, anchor.sequenceId),
    eq(sequenceClips.workspaceId, input.workspaceId),
    eq(sequenceClips.projectId, input.projectId),
  ));
  const trackRows = await deps.db.select({ id: sequenceTracks.id }).from(sequenceTracks).where(and(
    eq(sequenceTracks.sequenceId, anchor.sequenceId),
    eq(sequenceTracks.workspaceId, input.workspaceId),
    eq(sequenceTracks.projectId, input.projectId),
  ));
  const knownTrackIds = new Set(trackRows.map((row) => row.id));

  const sequenceRows = await deps.db.select({ parentSequenceId: projectSequences.parentSequenceId }).from(projectSequences).where(and(
    eq(projectSequences.id, anchor.sequenceId),
    eq(projectSequences.workspaceId, input.workspaceId),
    eq(projectSequences.projectId, input.projectId),
  )).limit(1);
  const parentSequenceId = sequenceRows[0]?.parentSequenceId ?? null;
  let nestedInvalid = false;
  if (parentSequenceId !== null) {
    const parentRows = await deps.db.select({ id: projectSequences.id }).from(projectSequences).where(and(
      eq(projectSequences.id, parentSequenceId),
      eq(projectSequences.workspaceId, input.workspaceId),
      eq(projectSequences.projectId, input.projectId),
    )).limit(1);
    nestedInvalid = parentRows.length === 0;
  }

  const evidenceRefs: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const nextTargets: OrderedTargetRef[] = [];
  let temporal = anchor.temporalSelection;
  let temporalChanged = false;
  const clipTargets = anchor.orderedTargetRefs.filter((target) => target.targetKind === 'CLIP');
  const singleClipTarget = clipTargets.length === 1;

  for (const target of anchor.orderedTargetRefs) {
    const lookup = await lookupTarget(deps, input, anchor.sequenceId, target);
    if (lookup !== 'PRESENT') {
      missing.push(target.targetRef);
      nextTargets.push(target);
      continue;
    }
    let nextTarget = target;
    if (target.targetKind === 'CLIP') {
      const baseline = target.bindingBaseline ?? null;
      const source = clips.find((clip) => clip.id === target.targetRef);
      // jsonb 列在类型层是 unknown：显式按规范区间解析，既收窄类型也做合法性校验。
      const clipSequenceRange = source === undefined ? null : mediaRangeSchema.parse(source.sequenceRange);
      const clipSourceRange = source === undefined ? null : mediaRangeSchema.parse(source.sourceRange);
      if (source !== undefined && target.assetVersionId !== null && source.assetVersionId !== target.assetVersionId) {
        stale.push(target.targetRef);
      }
      if (source?.assetVersionId != null) {
        const duplicates = clips.filter((clip) => clip.assetVersionId === source.assetVersionId);
        if (duplicates.length > 1) evidenceRefs.push(...duplicates.map((clip) => `clip:${clip.id}`));
      }
      if (source !== undefined && clipSequenceRange !== null && clipSourceRange !== null && baseline !== null && singleClipTarget && temporal !== null) {
        if (anchor.timeBindingPolicy === 'FOLLOW_OBJECT' && baseline.sequenceRange !== null) {
          if (!sameRange(baseline.sequenceRange, clipSequenceRange)) {
            const delta = subtractMediaTime(clipSequenceRange.start, baseline.sequenceRange.start);
            if (compareMediaTime(delta, ZERO_TIME) !== 0) {
              temporal = shiftTemporalSelection(temporal, delta);
              temporalChanged = true;
            }
            nextTarget = { ...target, bindingBaseline: { sequenceRange: { start: clipSequenceRange.start, end: clipSequenceRange.end }, sourceRange: baseline.sourceRange } };
          }
        } else if (anchor.timeBindingPolicy === 'FOLLOW_SOURCE' && baseline.sequenceRange !== null && baseline.sourceRange !== null) {
          if (!sameRange(baseline.sourceRange, clipSourceRange) || !sameRange(baseline.sequenceRange, clipSequenceRange)) {
            const reprojected = reprojectTemporalViaSource(temporal, baseline.sequenceRange, baseline.sourceRange, clipSourceRange, clipSequenceRange);
            if (reprojected === null) stale.push(target.targetRef);
            else temporal = reprojected;
            temporalChanged = true;
            nextTarget = { ...target, bindingBaseline: { sequenceRange: { start: clipSequenceRange.start, end: clipSequenceRange.end }, sourceRange: { start: clipSourceRange.start, end: clipSourceRange.end } } };
          }
        }
      }
    }
    nextTargets.push(nextTarget);
  }

  const trackScopeInvalid = anchor.trackScope.kind === 'TRACKS' && anchor.trackScope.trackIds.some((trackId) => !knownTrackIds.has(trackId));
  const nextStatus: (typeof SELECTION_RESOLUTION_STATUSES)[number] = evidenceRefs.length > 0
    ? 'AMBIGUOUS'
    : stale.length > 0
      ? 'STALE'
      : missing.length === 0 && !trackScopeInvalid && !nestedInvalid
        ? 'RESOLVED'
        : missing.length === anchor.orderedTargetRefs.length && anchor.orderedTargetRefs.length > 0
          ? 'FAILED'
          : 'PARTIAL';

  const baselineChanged = nextTargets.some((target, index) => {
    const before = anchor.orderedTargetRefs[index]!.bindingBaseline ?? null;
    const after = target.bindingBaseline ?? null;
    if (before === null || after === null) return before !== after;
    return !sameRange(before.sequenceRange, after.sequenceRange) || !sameRange(before.sourceRange, after.sourceRange);
  });
  const newEvidence = evidenceRefs.some((ref) => !anchor.evidenceRefs.includes(ref));
  const changed = nextStatus !== anchor.resolutionStatus || temporalChanged || baselineChanged || newEvidence;

  if (!changed) {
    return selectionRecoveryResultSchema.parse({
      record,
      changed: false,
      previousStatus: anchor.resolutionStatus,
      previousRevision: record.revision,
      trigger: input.trigger,
    });
  }

  const details: string[] = [];
  if (missing.length > 0) details.push(`缺失目标：${missing.join(',')}`);
  if (stale.length > 0) details.push(`失效或过期：${stale.join(',')}`);
  if (nestedInvalid) details.push('父序列缺失');
  if (temporalChanged) details.push('时序重投影');
  if (trackScopeInvalid) details.push('轨道作用域失效');
  if (evidenceRefs.length > 0) details.push('存在歧义候选');
  const reason = `${input.reason ?? input.trigger}${details.length > 0 ? `（${details.join('；')}）` : ''}`.slice(0, 200);

  const remapped = selectionAnchorSchema.parse({
    ...anchor,
    orderedTargetRefs: nextTargets,
    temporalSelection: temporal,
    resolutionStatus: nextStatus,
    evidenceRefs: [...new Set([...anchor.evidenceRefs, ...evidenceRefs])].slice(0, 64),
    remapHistory: [...anchor.remapHistory, {
      fromRevision: record.revision,
      toRevision: record.revision + 1,
      reason,
      at: new Date().toISOString(),
    }].slice(-64),
  });
  const saved = await saveSelectionAnchor(deps, { workspaceId: input.workspaceId, projectId: input.projectId, anchor: remapped });
  return selectionRecoveryResultSchema.parse({
    record: saved,
    changed: true,
    previousStatus: anchor.resolutionStatus,
    previousRevision: record.revision,
    trigger: input.trigger,
  });
}

/** 帧号/帧哈希只能定位，不能当身份：用它做"目标引用"的请求必须被拒绝。 */
export function assertNotFrameHashIdentity(targetRefs: readonly { targetRef: string }[]): void {
  for (const target of targetRefs) {
    if (/^(?:frame|fh|hash|framehash)[_-]?[0-9a-f]{6,}$/i.test(target.targetRef)) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'frame hash is not a target identity', 422, {
        reason: SELECTION_ERROR_REASONS.FRAME_HASH_NOT_IDENTITY, targetRef: target.targetRef,
      });
    }
  }
}
