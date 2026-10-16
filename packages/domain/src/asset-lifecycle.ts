import { randomUUID } from 'node:crypto';
import { and, eq, or } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  assetLifecycleSchema,
  assetPrivacyDeletionResultSchema,
  assetSchema,
  licenseMetadataSchema,
  type Asset,
  type AssetLifecycle,
  type AssetReference,
  type RequestAssetPrivacyDeletion,
  type UpdateAssetRightsRequest,
} from '@ancs/contracts';
import {
  assetDerivationEdges,
  assetVersions,
  assets,
  auditLog,
  projectVersions,
  projects,
  scenes,
} from '@ancs/db';
import type { DomainDeps } from './deps.js';

const toAssetDto = (row: typeof assets.$inferSelect): Asset => assetSchema.parse({
  id: row.id,
  workspaceId: row.workspaceId,
  projectId: row.projectId,
  sceneId: row.sceneId,
  assetType: row.assetType,
  origin: row.origin,
  provider: row.provider,
  providerAssetId: row.providerAssetId,
  status: row.status,
  retentionClass: row.retentionClass,
  license: licenseMetadataSchema.parse(row.license),
  sensitivityClass: row.sensitivityClass,
  privacyDeletionRequestedAt: row.privacyDeletionRequestedAt?.toISOString() ?? null,
  metadata: row.metadata,
  currentVersionId: row.currentVersionId,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function requireAsset(deps: DomainDeps, workspaceId: string, assetId: string): Promise<typeof assets.$inferSelect> {
  const rows = await deps.db.select().from(assets).where(and(eq(assets.id, assetId), eq(assets.workspaceId, workspaceId))).limit(1);
  const row = rows[0];
  if (row === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '素材不存在', 404);
  return row;
}

export async function listAssetReferences(deps: DomainDeps, input: { workspaceId: string; assetId: string }): Promise<AssetReference[]> {
  await requireAsset(deps, input.workspaceId, input.assetId);
  const [projectRows, sceneRows, versionRows] = await Promise.all([
    deps.db.select({ id: projects.id, title: projects.title, revision: projects.revision }).from(projects).where(eq(projects.workspaceId, input.workspaceId)),
    deps.db.select({ id: scenes.id, projectId: scenes.projectId, revision: scenes.revision, assetBindings: scenes.assetBindings }).from(scenes).where(eq(scenes.workspaceId, input.workspaceId)),
    deps.db.select({ id: projectVersions.id, projectId: projectVersions.projectId, versionNumber: projectVersions.versionNumber, reason: projectVersions.reason, snapshot: projectVersions.snapshot }).from(projectVersions).where(eq(projectVersions.workspaceId, input.workspaceId)),
  ]);
  const titleByProject = new Map(projectRows.map((project) => [project.id, project.title]));
  const revisionByProject = new Map(projectRows.map((project) => [project.id, project.revision]));
  const result: AssetReference[] = [];
  for (const scene of sceneRows) {
    for (const binding of scene.assetBindings as { assetId: string; role: string }[]) {
      if (binding.assetId !== input.assetId) continue;
      result.push({
        kind: 'SCENE', projectId: scene.projectId, projectTitle: titleByProject.get(scene.projectId) ?? scene.projectId, projectRevision: revisionByProject.get(scene.projectId) ?? 0,
        sceneId: scene.id, sceneRevision: scene.revision, role: binding.role as AssetReference['role'],
        projectVersionId: null, versionNumber: null, versionReason: null,
      });
    }
  }
  for (const version of versionRows) {
    if (!JSON.stringify(version.snapshot).includes(input.assetId)) continue;
    result.push({
      kind: 'PROJECT_VERSION', projectId: version.projectId, projectTitle: titleByProject.get(version.projectId) ?? version.projectId, projectRevision: revisionByProject.get(version.projectId) ?? 0,
      sceneId: null, sceneRevision: null, role: null, projectVersionId: version.id,
      versionNumber: version.versionNumber, versionReason: version.reason,
    });
  }
  return result;
}

function licenseState(asset: Asset, now: Date): AssetLifecycle['licenseState'] {
  if (asset.license.type === 'UNKNOWN' || asset.license.confirmedAt === null || (asset.license.type === 'USER_OWNED' && !asset.license.userOwnedDeclared)) return 'UNCONFIRMED';
  if (asset.license.expiresAt !== null && new Date(asset.license.expiresAt).getTime() <= now.getTime()) return 'EXPIRED';
  if (!asset.license.permittedUses.includes('PUBLISH')) return 'PUBLISH_NOT_PERMITTED';
  return 'ACTIVE';
}

export async function getAssetLifecycle(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; now?: Date },
): Promise<AssetLifecycle> {
  const row = await requireAsset(deps, input.workspaceId, input.assetId);
  const [references, edges] = await Promise.all([
    listAssetReferences(deps, input),
    deps.db.select().from(assetDerivationEdges).where(and(
      eq(assetDerivationEdges.workspaceId, input.workspaceId),
      or(eq(assetDerivationEdges.sourceAssetId, input.assetId), eq(assetDerivationEdges.derivedAssetId, input.assetId)),
    )),
  ]);
  const derivations = edges.map((edge) => edge.sourceAssetId === input.assetId ? {
    direction: 'DERIVED' as const,
    kind: edge.kind,
    assetId: edge.sourceAssetId,
    assetVersionId: edge.sourceAssetVersionId,
    relatedAssetId: edge.derivedAssetId,
    relatedAssetVersionId: edge.derivedAssetVersionId,
    createdAt: edge.createdAt.toISOString(),
  } : {
    direction: 'SOURCE' as const,
    kind: edge.kind,
    assetId: edge.derivedAssetId,
    assetVersionId: edge.derivedAssetVersionId,
    relatedAssetId: edge.sourceAssetId,
    relatedAssetVersionId: edge.sourceAssetVersionId,
    createdAt: edge.createdAt.toISOString(),
  });
  const reasons = [
    ...(references.some((reference) => reference.kind === 'SCENE') ? ['ACTIVE_SCENE_REFERENCE' as const] : []),
    ...(references.some((reference) => reference.kind === 'PROJECT_VERSION') ? ['FROZEN_VERSION_REFERENCE' as const] : []),
    ...(derivations.length > 0 ? ['DERIVATION_REFERENCE' as const] : []),
  ];
  const asset = toAssetDto(row);
  return assetLifecycleSchema.parse({
    asset,
    licenseState: licenseState(asset, input.now ?? new Date()),
    references,
    derivations,
    gcProtected: reasons.length > 0,
    gcProtectionReasons: reasons,
  });
}

export async function updateAssetRights(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; userId: string; request: UpdateAssetRightsRequest; now?: Date },
): Promise<AssetLifecycle> {
  await requireAsset(deps, input.workspaceId, input.assetId);
  const now = input.now ?? new Date();
  const license = licenseMetadataSchema.parse({
    type: input.request.type,
    holder: input.request.holder,
    attribution: input.request.attribution,
    sourceUrl: input.request.sourceUrl,
    termsUrl: input.request.termsUrl,
    notes: input.request.notes,
    userOwnedDeclared: input.request.userOwnedDeclared,
    permittedUses: [...new Set(input.request.permittedUses)],
    expiresAt: input.request.expiresAt,
    confirmedBy: input.userId,
    confirmedAt: now.toISOString(),
  });
  await deps.db.transaction(async (tx) => {
    await tx.update(assets).set({ license, sensitivityClass: input.request.sensitivityClass, updatedAt: now }).where(and(
      eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId),
    ));
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID()}`, actorKind: 'USER', actorUserId: input.userId,
      action: 'asset.rights.updated', targetType: 'ASSET', targetId: input.assetId, workspaceId: input.workspaceId,
      details: { type: license.type, permittedUses: license.permittedUses, expiresAt: license.expiresAt, sensitivityClass: input.request.sensitivityClass },
      occurredAt: now,
    });
  });
  return getAssetLifecycle(deps, { workspaceId: input.workspaceId, assetId: input.assetId, now });
}

export async function requestAssetPrivacyDeletion(
  deps: DomainDeps,
  input: { workspaceId: string; assetId: string; userId: string; request: RequestAssetPrivacyDeletion; now?: Date },
) {
  if (input.request.confirmationAssetId !== input.assetId) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, '确认素材 ID 不匹配', 422, { reason: 'ASSET_CONFIRMATION_MISMATCH' });
  }
  await requireAsset(deps, input.workspaceId, input.assetId);
  const references = await listAssetReferences(deps, input);
  const now = input.now ?? new Date();
  const deferred = references.length > 0;
  await deps.db.transaction(async (tx) => {
    await tx.update(assets).set({
      privacyDeletionRequestedAt: now,
      privacyDeletionRequestedBy: input.userId,
      ...(deferred ? {} : { deletedAt: now }),
      updatedAt: now,
    }).where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId)));
    if (!deferred) await tx.update(assetVersions).set({ deletedAt: now }).where(and(eq(assetVersions.assetId, input.assetId), eq(assetVersions.workspaceId, input.workspaceId)));
    await tx.insert(auditLog).values({
      id: `aud_${randomUUID()}`, actorKind: 'USER', actorUserId: input.userId,
      action: 'asset.privacy_delete_requested', targetType: 'ASSET', targetId: input.assetId, workspaceId: input.workspaceId,
      details: { reasonProvided: true, status: deferred ? 'DEFERRED_BY_REFERENCES' : 'SCHEDULED', dependencyCount: references.length },
      occurredAt: now,
    });
  });
  return assetPrivacyDeletionResultSchema.parse({
    assetId: input.assetId,
    status: deferred ? 'DEFERRED_BY_REFERENCES' : 'SCHEDULED',
    requestedAt: now.toISOString(),
    missingDependencies: references,
  });
}

export async function assertProjectVersionAssetRights(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; projectVersionId: string; now?: Date },
): Promise<void> {
  const versionRows = await deps.db.select({ snapshot: projectVersions.snapshot }).from(projectVersions).where(and(
    eq(projectVersions.id, input.projectVersionId), eq(projectVersions.workspaceId, input.workspaceId), eq(projectVersions.projectId, input.projectId),
  )).limit(1);
  const version = versionRows[0];
  if (version === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, '项目版本不存在', 404);
  const snapshot = version.snapshot as { graph?: { scenes?: { assetBindings?: { assetId: string }[] }[] } };
  const ids = [...new Set((snapshot.graph?.scenes ?? []).flatMap((scene) => (scene.assetBindings ?? []).map((binding) => binding.assetId)))];
  if (ids.length === 0) return;
  const rows = await deps.db.select().from(assets).where(eq(assets.workspaceId, input.workspaceId));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const blocked = ids.flatMap((id) => {
    const row = byId.get(id);
    if (row === undefined) return [{ assetId: id, reason: 'ASSET_MISSING' }];
    if (row.deletedAt !== null) return [{ assetId: id, reason: 'ASSET_DELETED' }];
    if (row.privacyDeletionRequestedAt !== null) return [{ assetId: id, reason: 'PRIVACY_DELETION_REQUESTED' }];
    const state = licenseState(toAssetDto(row), input.now ?? new Date());
    return state === 'ACTIVE' ? [] : [{ assetId: id, reason: state }];
  });
  if (blocked.length > 0) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, '素材许可已过期、未确认或不允许发布', 409, {
      reason: 'ASSET_RIGHTS_BLOCK_PUBLICATION', blocked,
    });
  }
}
