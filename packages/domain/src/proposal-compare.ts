import { and, eq } from 'drizzle-orm';
import {
  ApiFailure,
  COMPARE_ERROR_REASONS,
  ERROR_CODES,
  compareReportSchema,
  editOperationSchema,
  mediaRangeSchema,
  type CompareAlignment,
  type CompareChange,
  type CompareObjectDiff,
  type CompareReport,
  type CompareProposalRequest,
  type ObjectLockDimension,
} from '@ancs/contracts';
import { proposals, projects, sequenceClips } from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { clipDigestsOf } from './content-protection.js';
import { runEditTrial } from './edit-trial.js';

/**
 * N06-08：A/B 对照（服务端对照载荷）。
 *
 * - 右侧 = 候选试改后的**真实执行结果**（事务内跑完回滚采集），不是近似动画；
 * - 左侧 = 当前确认版（缺省）或另一个候选（A/B）；
 * - 时长/片段数不同时按**内容锚点**对齐（同一素材版本 + 同一源区间 = 同源），避免相同锚点错位；
 * - 对照**不改工程**。
 */

type ClipRow = typeof sequenceClips.$inferSelect;

const anchorKeyOf = (row: Pick<ClipRow, 'assetVersionId' | 'nestedSequenceId' | 'sourceRange'>): string =>
  `${row.assetVersionId ?? 'null'}|${row.nestedSequenceId ?? 'null'}|${JSON.stringify(mediaRangeSchema.parse(row.sourceRange))}`;

async function loadClipRows(deps: DomainDeps, workspaceId: string, projectId: string): Promise<ClipRow[]> {
  return deps.db.select().from(sequenceClips).where(and(
    eq(sequenceClips.workspaceId, workspaceId), eq(sequenceClips.projectId, projectId),
  ));
}

const loadProposalRow = async (deps: DomainDeps, input: { workspaceId: string; projectId: string; proposalId: string }) => {
  const rows = await deps.db.select().from(proposals).where(and(
    eq(proposals.id, input.proposalId), eq(proposals.workspaceId, input.workspaceId), eq(proposals.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'proposal not found', 404, { reason: COMPARE_ERROR_REASONS.NOT_FOUND });
  return row;
};

/** 跑一遍候选（试改引擎：内核内存执行或事务内回滚），返回试改后的片段集合。 */
async function trialClips(deps: DomainDeps, row: typeof proposals.$inferSelect, workspaceId: string, projectId: string): Promise<ClipRow[]> {
  const operations = editOperationSchema.array().parse(row.operations);
  try {
    const outcome = await runEditTrial(deps, {
      workspaceId, projectId, baseProjectRevision: row.baseProjectRevision, operations, actorId: 'proposal-compare',
    });
    return outcome.clips;
  } catch (error) {
    // 只有业务拒绝才是"候选不可对照"（422）；服务端故障原样抛出（V5-M2：与试改同一分类规则）
    if (error instanceof ApiFailure) {
      throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'proposal trial failed during compare', 422, {
        reason: COMPARE_ERROR_REASONS.INVALID, cause: error.message.slice(0, 200),
      });
    }
    throw error;
  }
}

const currentRevision = async (deps: DomainDeps, workspaceId: string, projectId: string): Promise<number> => {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects).where(and(
    eq(projects.id, projectId), eq(projects.workspaceId, workspaceId),
  )).limit(1);
  const revision = rows[0]?.revision;
  if (revision === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return revision;
};

interface SideClip { clipId: string; trackId: string; anchorKey: string; digests: ReturnType<typeof clipDigestsOf>; assetVersionId: string | null; sequenceRange: unknown }
const toSide = (rows: ClipRow[]): SideClip[] => rows.map((row) => ({
  clipId: row.id, trackId: row.trackId, anchorKey: anchorKeyOf(row), digests: clipDigestsOf(row), assetVersionId: row.assetVersionId ?? null, sequenceRange: row.sequenceRange,
}));

/** A/B 对照：右侧候选试改后的真实结果 vs 左侧（当前确认版或另一候选）。只读，不改工程。 */
export async function compareProposal(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  request: CompareProposalRequest;
}): Promise<CompareReport> {
  const row = await loadProposalRow(deps, input);
  const rightClips = toSide(await trialClips(deps, row, input.workspaceId, input.projectId));

  let leftClips: SideClip[];
  let leftLabel: string;
  let comparedAgainst: CompareReport['comparedAgainst'];
  if (input.request.againstProposalId === null) {
    leftClips = toSide(await loadClipRows(deps, input.workspaceId, input.projectId));
    leftLabel = `确认版 r${String(await currentRevision(deps, input.workspaceId, input.projectId))}`;
    comparedAgainst = { kind: 'CURRENT', ref: null };
  } else {
    const other = await loadProposalRow(deps, { ...input, proposalId: input.request.againstProposalId });
    leftClips = toSide(await trialClips(deps, other, input.workspaceId, input.projectId));
    leftLabel = `候选 ${other.id}（代际 ${String(other.generation)}）`;
    comparedAgainst = { kind: 'PROPOSAL', ref: other.id };
  }

  const enabledAxes: ObjectLockDimension[] = input.request.axes ?? ['CONTENT', 'POSITION', 'ASSET'];
  // 左侧按 clip id 与内容锚点双索引；右侧同 id 视为同一对象，否则靠锚点对齐。
  const leftById = new Map(leftClips.map((clip) => [clip.clipId, clip]));
  const leftByAnchor = new Map<string, SideClip[]>();
  for (const clip of leftClips) leftByAnchor.set(clip.anchorKey, [...(leftByAnchor.get(clip.anchorKey) ?? []), clip]);
  const rightByAnchor = new Map<string, SideClip[]>();
  for (const clip of rightClips) rightByAnchor.set(clip.anchorKey, [...(rightByAnchor.get(clip.anchorKey) ?? []), clip]);

  const diffs: CompareObjectDiff[] = [];
  const usedLeft = new Set<string>();
  const usedRight = new Set<string>();
  const unmatchedAnchors = new Set<string>();
  let anchorMatchedCount = 0;
  let unchangedCount = 0;
  let alignment: CompareAlignment = 'CLIP_ID';

  // 逐右侧片段找左侧对应（同 id → 同对象；否则内容锚点唯一匹配 → 靠锚点对齐）
  for (const clip of rightClips) {
    const same = leftById.get(clip.clipId);
    if (same !== undefined) {
      usedLeft.add(same.clipId); usedRight.add(clip.clipId);
      const axes = axesChanged(same, clip, enabledAxes);
      if (axes.length === 0) { unchangedCount += 1; continue; }
      diffs.push(buildDiff(clip, 'CHANGED', axes, same, clip, 'CLIP_ID'));
      continue;
    }
    const candidates = (leftByAnchor.get(clip.anchorKey) ?? []).filter((item) => !usedLeft.has(item.clipId));
    if (candidates.length === 1) {
      const matched = candidates[0]!;
      usedLeft.add(matched.clipId); usedRight.add(clip.clipId);
      anchorMatchedCount += 1; alignment = 'CONTENT_ANCHOR';
      const axes = axesChanged(matched, clip, enabledAxes);
      diffs.push(buildDiff(clip,
        axes.length === 0 ? 'UNCHANGED' : 'CHANGED',
        axes.length === 0 ? ['POSITION'] : axes, matched, clip, 'CONTENT_ANCHOR'));
      if (axes.length === 0) unchangedCount += 1;
      continue;
    }
    if (candidates.length > 1) unmatchedAnchors.add(clip.anchorKey);
    usedRight.add(clip.clipId);
    diffs.push(buildDiff(clip, 'ADDED', ['CONTENT', 'POSITION', 'ASSET'], null, clip, 'CLIP_ID'));
  }
  for (const clip of leftClips) {
    if (usedLeft.has(clip.clipId)) continue;
    diffs.push(buildDiff(clip, 'REMOVED', ['CONTENT', 'POSITION', 'ASSET'], clip, null, 'CLIP_ID'));
  }

  const assetVersionIds = [...new Set([
    ...leftClips.map((clip) => clip.assetVersionId), ...rightClips.map((clip) => clip.assetVersionId),
  ].filter((id): id is string => id !== null))].sort();
  return compareReportSchema.parse({
    proposalId: row.id,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    comparedAgainst,
    leftLabel,
    rightLabel: `候选 ${row.id}（代际 ${String(row.generation)}）`,
    alignment,
    diffs,
    unchangedCount,
    addedCount: diffs.filter((diff) => diff.change === 'ADDED').length,
    removedCount: diffs.filter((diff) => diff.change === 'REMOVED').length,
    changedCount: diffs.filter((diff) => diff.change === 'CHANGED').length,
    anchorMatchedCount,
    unmatchedAnchors: [...unmatchedAnchors],
    assetVersionIds,
  });
}

const axesChanged = (left: SideClip, right: SideClip, enabled: ObjectLockDimension[]): ObjectLockDimension[] => {
  const axes: ObjectLockDimension[] = [];
  if (enabled.includes('CONTENT') && left.digests.contentDigest !== right.digests.contentDigest) axes.push('CONTENT');
  if (enabled.includes('POSITION') && left.digests.positionDigest !== right.digests.positionDigest) axes.push('POSITION');
  if (enabled.includes('ASSET') && left.digests.assetDigest !== right.digests.assetDigest) axes.push('ASSET');
  return axes;
};

const buildDiff = (
  subject: SideClip, change: CompareChange, axes: ObjectLockDimension[], before: SideClip | null, after: SideClip | null, alignedBy: CompareAlignment,
): CompareObjectDiff => ({
  objectKind: 'CLIP',
  objectId: subject.clipId,
  label: null,
  change,
  axes,
  beforeAssetVersionId: before?.assetVersionId ?? null,
  afterAssetVersionId: after?.assetVersionId ?? null,
  beforeTrackId: before?.trackId ?? null,
  afterTrackId: after?.trackId ?? null,
  beforeSequenceRange: before === null ? null : mediaRangeSchema.parse(before.sequenceRange),
  afterSequenceRange: after === null ? null : mediaRangeSchema.parse(after.sequenceRange),
  alignedBy,
});
