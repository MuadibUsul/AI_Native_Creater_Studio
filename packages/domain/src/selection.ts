import { createHash } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  SELECTION_RESOLUTION_STATUSES,
  selectionAnchorFromLegacySelection,
  selectionAnchorRecordSchema,
  selectionAnchorSchema,
  selectionFingerprintInput,
  type LegacySelection,
  type SelectionAnchor,
  type SelectionAnchorRecord,
} from '@ancs/contracts';
import {
  compositionCaptionSpans,
  compositionVisualObjects,
  projectSequences,
  sequenceClips,
  sequenceTracks,
  selectionAnchors,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';

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
