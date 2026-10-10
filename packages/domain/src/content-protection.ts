import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  PROTECTION_ERROR_REASONS,
  confirmedContentRecordSchema,
  type CaptureConfirmedContentRequest,
  type ConfirmedContentObject,
  type ConfirmedContentRecord,
  type RegressionDiff,
  type RegressionReport,
  type RegressionStatus,
} from '@ancs/contracts';
import { contentProtections, projects, sequenceClips } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * N06-07：已确认内容保护与回归指纹。
 *
 * - 只支持 **CLIP**（视频与音频片段；声音属于音频片段）——字幕/视觉对象的保护属后续增量，见 verification；
 * - 指纹三轴：CONTENT（源区间/映射/参数/源流）、POSITION（轨道与序列区间）、ASSET（素材版本/嵌套序列）；
 * - `assertProtectedContentStable`：采用前用**真实执行器试跑**拿事件，凡是"碰了受保护对象但不在本批显式目标里"
 *   的**附带变化/意外移位**一律 fail-closed（阻止自动采用）；
 * - 保护指纹**不改工程**，也不是第二份作品状态。
 */

const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => JSON.stringify(value ?? null);

export interface ClipDigests { contentDigest: string | null; positionDigest: string | null; assetDigest: string | null }

/** 片段三轴指纹：CONTENT（源区间/映射/参数/源流）、POSITION（轨道与序列区间）、ASSET（素材版本/嵌套序列）。 */
export function clipDigestsOf(row: typeof sequenceClips.$inferSelect): ClipDigests {
  return {
    contentDigest: sha256(canonical({
      sourceRange: row.sourceRange, timeMapping: row.timeMapping, parameters: row.parameters, sourceStreamId: row.sourceStreamId,
    })),
    positionDigest: sha256(canonical({ trackId: row.trackId, sequenceRange: row.sequenceRange })),
    assetDigest: sha256(canonical({ assetVersionId: row.assetVersionId, nestedSequenceId: row.nestedSequenceId })),
  };
}

async function loadClipRows(deps: DomainDeps, input: { workspaceId: string; projectId: string; clipIds?: readonly string[] }) {
  const condition = input.clipIds === undefined
    ? and(eq(sequenceClips.workspaceId, input.workspaceId), eq(sequenceClips.projectId, input.projectId))
    : and(
      eq(sequenceClips.workspaceId, input.workspaceId),
      eq(sequenceClips.projectId, input.projectId),
      inArray(sequenceClips.id, [...input.clipIds]),
    );
  return deps.db.select().from(sequenceClips).where(condition);
}

const toRecord = (row: typeof contentProtections.$inferSelect): ConfirmedContentRecord => confirmedContentRecordSchema.parse({
  protectionId: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  label: row.label ?? null,
  capturedRevision: row.capturedRevision,
  objects: row.objects,
  fingerprint: row.fingerprint,
  createdAt: row.createdAt.toISOString(),
});

const loadProtectionRow = async (deps: DomainDeps, input: { workspaceId: string; projectId: string; protectionId: string }) => {
  const rows = await deps.db.select().from(contentProtections).where(and(
    eq(contentProtections.id, input.protectionId),
    eq(contentProtections.workspaceId, input.workspaceId),
    eq(contentProtections.projectId, input.projectId),
  )).limit(1);
  const row = rows[0];
  if (!row) {
    throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'content protection not found', 404, { reason: PROTECTION_ERROR_REASONS.NOT_FOUND });
  }
  return row;
};

const loadProjectRevision = async (deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<number> => {
  const rows = await deps.db.select({ revision: projects.revision }).from(projects).where(and(
    eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId),
  )).limit(1);
  const revision = rows[0]?.revision;
  if (revision === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return revision;
};

/** 采集"已确认内容"的三轴指纹（不改工程）。 */
export async function captureConfirmedContent(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  actorId?: string;
  request: CaptureConfirmedContentRequest;
}): Promise<ConfirmedContentRecord> {
  const requested = input.request.objects;
  if (requested !== undefined) {
    const unsupported = requested.filter((object) => object.objectKind !== 'CLIP');
    if (unsupported.length > 0) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, 'only CLIP protection is supported so far', 501, {
        reason: PROTECTION_ERROR_REASONS.UNSUPPORTED_OBJECT_KIND,
        unsupportedKinds: [...new Set(unsupported.map((object) => object.objectKind))],
      });
    }
  }
  const clipRows = await loadClipRows(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId,
    ...(requested === undefined ? {} : { clipIds: requested.map((object) => object.objectId) }),
  });
  const labelOf = new Map((requested ?? []).map((object) => [object.objectId, object.label ?? null]));
  const objects: ConfirmedContentObject[] = clipRows.map((row) => ({
    objectKind: 'CLIP' as const,
    objectId: row.id,
    label: labelOf.get(row.id) ?? null,
    ...clipDigestsOf(row),
  }));
  if (objects.length === 0) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, 'no clips matched the requested protection scope', 422, {
      reason: PROTECTION_ERROR_REASONS.INVALID_SCOPE,
    });
  }
  const capturedRevision = await loadProjectRevision(deps, input);
  const fingerprint = sha256(JSON.stringify(objects.map((object) => [object.objectKind, object.objectId, object.contentDigest, object.positionDigest, object.assetDigest]).sort()));
  const now = new Date();
  const protectionId = `prt_${randomUUID()}`;
  await deps.db.insert(contentProtections).values({
    id: protectionId,
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actorId: input.actorId ?? null,
    label: input.request.label ?? null,
    capturedRevision,
    scope: requested === undefined ? 'ALL' : 'SELECTED',
    objects,
    fingerprint,
    createdAt: now,
    updatedAt: now,
  });
  return toRecord(await loadProtectionRow(deps, { ...input, protectionId }));
}

/** 核对受保护内容是否仍引用相同资产与参数（只读）。 */
export async function checkConfirmedContent(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  protectionId: string;
  /** 本批采用的显式目标（这些对象的变化属预期内，不计入范围外变化） */
  explicitTargets?: readonly { objectKind: string; objectId: string }[];
}): Promise<RegressionReport> {
  const row = await loadProtectionRow(deps, input);
  const objects = confirmedContentRecordSchema.parse(toRecord(row)).objects;
  const currentRevision = await loadProjectRevision(deps, input);
  const targetKeys = new Set((input.explicitTargets ?? []).map((target) => `${target.objectKind}:${target.objectId}`));

  const currentRows = await loadClipRows(deps, {
    workspaceId: input.workspaceId, projectId: input.projectId, clipIds: objects.map((object) => object.objectId),
  });
  const byId = new Map(currentRows.map((clip) => [clip.id, clip]));

  const diffs: RegressionDiff[] = [];
  for (const object of objects) {
    const clip = byId.get(object.objectId);
    const explicitTarget = targetKeys.has(`${object.objectKind}:${object.objectId}`);
    if (clip === undefined) {
      diffs.push({
        objectKind: object.objectKind, objectId: object.objectId, label: object.label, axes: ['CONTENT', 'POSITION', 'ASSET'],
        explicitTarget, before: object.contentDigest, after: null,
      });
      continue;
    }
    const digests = clipDigestsOf(clip);
    const axes = (['CONTENT', 'POSITION', 'ASSET'] as const).filter((axis) => {
      const before = axis === 'CONTENT' ? object.contentDigest : axis === 'POSITION' ? object.positionDigest : object.assetDigest;
      const after = axis === 'CONTENT' ? digests.contentDigest : axis === 'POSITION' ? digests.positionDigest : digests.assetDigest;
      return before !== after;
    });
    if (axes.length === 0) continue;
    diffs.push({
      objectKind: object.objectKind, objectId: object.objectId, label: object.label, axes: [...axes], explicitTarget,
      before: object.contentDigest, after: digests.contentDigest,
    });
  }

  const status: RegressionStatus = diffs.length === 0
    ? 'UNCHANGED'
    : diffs.some((diff) => diff.after === null) ? 'OBJECT_MISSING'
      : diffs.some((diff) => diff.axes.includes('ASSET')) ? 'ASSET_CHANGED'
        : diffs.some((diff) => diff.axes.includes('CONTENT')) ? 'CONTENT_CHANGED'
          : 'POSITION_SHIFTED';
  const outOfScope = diffs.filter((diff) => !diff.explicitTarget);
  return {
    protectionId: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    capturedRevision: row.capturedRevision,
    currentRevision,
    status,
    intact: diffs.length === 0,
    diffs,
    outOfScope,
  };
}

/**
 * 采用前的保护门：拿**试改后的状态**（真实执行器在同一事务内跑完、回滚前采集）与已确认指纹比对，
 * 凡是"受保护对象被改动但不在本批显式目标里"的**附带变化/意外移位** → 409 `CONFIRMED_CONTENT_REGRESSION`
 * （阻止自动采用；零写入）。
 *
 * 关键：必须用**试改后状态**（而不是当前已提交状态）—— 附带移位发生在试改之后。
 */
export async function assertProtectedContentStable(deps: DomainDeps, input: {
  workspaceId: string;
  projectId: string;
  proposalId: string;
  protectionIds: readonly string[];
  /** 本批显式目标（`KIND:id`） */
  explicitTargetKeys: readonly string[];
  /** 试改后状态中每个片段的三轴指纹（被删除的片段不在表里） */
  postState: ReadonlyMap<string, ClipDigests>;
}): Promise<void> {
  const explicit = new Set(input.explicitTargetKeys);
  const violations: RegressionDiff[] = [];
  for (const protectionId of input.protectionIds) {
    const record = toRecord(await loadProtectionRow(deps, { ...input, protectionId }));
    for (const object of record.objects) {
      const key = `${object.objectKind}:${object.objectId}`;
      if (explicit.has(key)) continue;
      const after = input.postState.get(object.objectId);
      if (after === undefined) {
        violations.push({
          objectKind: object.objectKind, objectId: object.objectId, label: object.label,
          axes: ['CONTENT', 'POSITION', 'ASSET'], explicitTarget: false, before: object.contentDigest, after: null,
        });
        continue;
      }
      const axes = (['CONTENT', 'POSITION', 'ASSET'] as const).filter((axis) => {
        const before = axis === 'CONTENT' ? object.contentDigest : axis === 'POSITION' ? object.positionDigest : object.assetDigest;
        const now = axis === 'CONTENT' ? after.contentDigest : axis === 'POSITION' ? after.positionDigest : after.assetDigest;
        return before !== now;
      });
      if (axes.length === 0) continue;
      violations.push({
        objectKind: object.objectKind, objectId: object.objectId, label: object.label, axes: [...axes],
        explicitTarget: false, before: object.contentDigest, after: after.contentDigest,
      });
    }
  }
  if (violations.length > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'adoption would collaterally change confirmed content', 409, {
      reason: PROTECTION_ERROR_REASONS.REGRESSION_BLOCKED,
      proposalId: input.proposalId,
      protectionIds: [...input.protectionIds],
      violations,
    });
  }
}

/** 只读读取保护记录（GET 路径）。 */
export async function loadConfirmedContent(deps: DomainDeps, input: {
  workspaceId: string; projectId: string; protectionId: string;
}): Promise<ConfirmedContentRecord> {
  return toRecord(await loadProtectionRow(deps, input));
}

/** 列出工程的保护记录（运维/UI 用）。 */
export async function listConfirmedContents(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<ConfirmedContentRecord[]> {
  const rows = await deps.db.select().from(contentProtections).where(and(
    eq(contentProtections.workspaceId, input.workspaceId), eq(contentProtections.projectId, input.projectId),
  )).orderBy(desc(contentProtections.createdAt));
  return rows.map(toRecord);
}
