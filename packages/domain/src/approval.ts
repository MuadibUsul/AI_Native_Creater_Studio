import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  ApiFailure,
  APPROVAL_ERROR_REASONS,
  ERROR_CODES,
  exportPackageSchema,
  renderApprovalSchema,
  type DecideApprovalRequest,
  type ExportPackage,
  type RenderApproval,
} from '@ancs/contracts';
import { assetVersions, assets, projects, renderApprovals } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { getRender } from './render.js';

/**
 * 审批与受控导出（P07-06 / 规范 §87、§54；REQ-54-02、REQ-87-01）。
 *
 * 链路（§87）：QA 通过（Render=READY）→ **人工批准**（记录 + manifestHash 快照）→ **受控导出**
 * （签名下载 URL 逐产物，TTL 15 分钟）。
 *
 * 纪律：
 * - 批准绑定 **renderId + manifestHash + projectVersionId + projectRevision**：
 *   新编辑 → 新渲染 → **需重新审批**；批准后 Render 的 manifestHash 变化 → 批准失效（APPROVAL_STALE）；
 * - **未批准不能正式导出**（服务端 409；客户端不持存储凭据，URL 由服务端签发 §75）；
 * - 审批 append-only（每次决定一行；最新一行为当前决定）。
 */

const toApprovalDto = (row: typeof renderApprovals.$inferSelect): RenderApproval =>
  renderApprovalSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    renderId: row.renderId,
    decision: row.decision,
    manifestHashAtApproval: row.manifestHashAtApproval,
    projectVersionIdAtApproval: row.projectVersionIdAtApproval,
    projectRevisionAtApproval: row.projectRevisionAtApproval,
    note: row.note,
    decidedBy: row.decidedBy,
    createdAt: row.createdAt.toISOString(),
  });

/** 人工审批决定（仅 READY 可审批；批准记录 manifestHash 快照——"批准的是这一份产物"）。 */
export async function decideRenderApproval(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string; request: DecideApprovalRequest; decidedBy?: string | null },
): Promise<RenderApproval> {
  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status !== 'READY') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Render 不可审批（当前 ${render.status}）：仅 QA 通过的 READY 渲染可批准/驳回`, 409, {
      reason: APPROVAL_ERROR_REASONS.RENDER_NOT_READY,
      status: render.status,
    });
  }
  if (render.manifestHash === null) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'Render 缺 manifestHash（READY 必有——数据不一致）', 500, {
      reason: APPROVAL_ERROR_REASONS.MANIFEST_MISSING,
    });
  }
  const projectRows = await deps.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, render.projectId)).limit(1);
  const projectRevision = projectRows[0]?.revision ?? 0;

  const inserted = await deps.db
    .insert(renderApprovals)
    .values({
      id: `rap_${randomUUID()}`,
      workspaceId: render.workspaceId,
      projectId: render.projectId,
      renderId: render.id,
      decision: input.request.decision,
      manifestHashAtApproval: render.manifestHash,
      projectVersionIdAtApproval: render.input.projectVersionId,
      projectRevisionAtApproval: projectRevision,
      note: input.request.note ?? null,
      decidedBy: input.decidedBy ?? null,
    })
    .returning();
  const row = inserted[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.INTERNAL, 'approval insert failed', 500);
  return toApprovalDto(row);
}

/** 最新审批记录（未审批 → null）。 */
export async function getLatestRenderApproval(deps: DomainDeps, input: { workspaceId: string; renderId: string }): Promise<RenderApproval | null> {
  const rows = await deps.db
    .select()
    .from(renderApprovals)
    .where(and(eq(renderApprovals.workspaceId, input.workspaceId), eq(renderApprovals.renderId, input.renderId)))
    .orderBy(desc(renderApprovals.createdAt))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toApprovalDto(row);
}

/** 产物 mimeType → 导出条目 kind 与下载文件名（规范：MP4 + SRT + VTT + Manifest 四件） */
const EXPORT_KIND_BY_MIME: Readonly<Record<string, ExportPackage['entries'][number]['kind']>> = {
  'video/mp4': 'VIDEO',
  'application/x-subrip': 'SUBTITLE_SRT',
  'text/vtt': 'SUBTITLE_VTT',
  'application/json': 'MANIFEST',
};
const EXPORT_FILE_NAME: Readonly<Record<ExportPackage['entries'][number]['kind'], string>> = {
  VIDEO: 'final.mp4',
  SUBTITLE_SRT: 'subtitles.srt',
  SUBTITLE_VTT: 'subtitles.vtt',
  MANIFEST: 'manifest.json',
};

/**
 * 受控导出包（§87：**未批准不能正式导出**）。
 * 守卫顺序：READY → 最新决定为 APPROVED → manifestHash 一致（否则 STALE）→ 产物齐备 → 签发签名 URL。
 */
export async function buildRenderExportPackage(
  deps: DomainDeps,
  input: { workspaceId: string; renderId: string },
): Promise<ExportPackage> {
  const storage = deps.storage;
  if (storage === undefined) {
    throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：无法签发下载入口（fail-closed）', 501, {
      reason: APPROVAL_ERROR_REASONS.STORAGE_UNAVAILABLE,
    });
  }
  const render = await getRender(deps, { workspaceId: input.workspaceId, renderId: input.renderId });
  if (render.status !== 'READY' || render.manifestHash === null) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `Render 不可导出（当前 ${render.status}）`, 409, {
      reason: APPROVAL_ERROR_REASONS.RENDER_NOT_READY,
      status: render.status,
    });
  }
  const approval = await getLatestRenderApproval(deps, input);
  if (approval === null || approval.decision !== 'APPROVED') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '未批准不能正式导出（§87）：请先完成人工批准', 409, {
      reason: APPROVAL_ERROR_REASONS.NOT_APPROVED,
      decision: approval?.decision ?? null,
    });
  }
  if (approval.manifestHashAtApproval !== render.manifestHash) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '批准已失效（批准后 Render 的 manifest 变化）：需重新审批', 409, {
      reason: APPROVAL_ERROR_REASONS.APPROVAL_STALE,
      approvedHash: approval.manifestHashAtApproval,
      currentHash: render.manifestHash,
    });
  }

  // 产物（四件套）+ 逐产物签名下载 URL（TTL 由存储适配器决定）
  const versionRows =
    render.outputAssetIds.length === 0
      ? []
      : await deps.db
          .select()
          .from(assetVersions)
          .where(and(eq(assetVersions.workspaceId, render.workspaceId), inArray(assetVersions.assetId, render.outputAssetIds)));
  const assetRows = await deps.db
    .select({ id: assets.id, metadata: assets.metadata })
    .from(assets)
    .where(eq(assets.workspaceId, render.workspaceId));
  const kindByAssetId = new Map<string, ExportPackage['entries'][number]['kind']>();
  for (const row of assetRows) {
    const kind = (row.metadata as Record<string, unknown>)['kind'];
    if (kind === 'VIDEO' || kind === 'SUBTITLE_SRT' || kind === 'SUBTITLE_VTT' || kind === 'MANIFEST') kindByAssetId.set(row.id, kind);
  }

  const entries: ExportPackage['entries'] = [];
  for (const version of versionRows) {
    const kind = kindByAssetId.get(version.assetId) ?? EXPORT_KIND_BY_MIME[version.mimeType];
    if (kind === undefined) continue;
    const download = await storage.createDownloadUrl({ key: version.storageKey, downloadFilename: EXPORT_FILE_NAME[kind] });
    entries.push({ kind, assetId: version.assetId, download, sizeBytes: version.sizeBytes, mimeType: version.mimeType });
  }
  if (entries.length < 4) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, `导出产物不齐（${String(entries.length)}/4）`, 409, {
      reason: APPROVAL_ERROR_REASONS.EXPORT_ARTIFACT_MISSING,
      found: entries.map((entry) => entry.kind),
    });
  }

  // 批准后项目又有新编辑（提示；导出内容仍为已批准快照——"新编辑需重新审批"针对新渲染）
  const projectRows = await deps.db.select({ revision: projects.revision }).from(projects).where(eq(projects.id, render.projectId)).limit(1);
  const projectEditedSinceApproval = (projectRows[0]?.revision ?? approval.projectRevisionAtApproval) !== approval.projectRevisionAtApproval;

  return exportPackageSchema.parse({
    schemaVersion: 'render-export-v1',
    renderId: render.id,
    projectId: render.projectId,
    projectVersionId: render.input.projectVersionId,
    profile: render.profile,
    manifestHash: render.manifestHash,
    approvalId: approval.id,
    approvedAt: approval.createdAt,
    approvedBy: approval.decidedBy,
    projectEditedSinceApproval,
    entries,
  });
}
