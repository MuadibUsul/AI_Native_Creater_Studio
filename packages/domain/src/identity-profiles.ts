import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  IDENTITY_CONSENT_KINDS,
  IDENTITY_CONSENT_STATEMENTS,
  IDENTITY_CONSENT_STATEMENT_VERSION,
  IDENTITY_PROFILE_ERROR_REASONS,
  IDENTITY_REFERENCE_MIME_PREFIX,
  identityProfileSchema,
  type GrantIdentityConsentRequest,
  type IdentityConsentKind,
  type IdentityConsentRecord,
  type IdentityProfile,
  type IdentityReference,
} from '@ancs/contracts';
import { assets, assetVersions, creatorIdentities, identityConsentRecords, identityReferences } from '@ancs/db';
import { createCreatorIdentity } from './creator-identities.js';
import type { DomainDeps } from './deps.js';

/**
 * V6-7 我的形象与声音（V6 §4.3）：档案 = 创作者身份 + 参考照片 + 声音样本 + 授权记录。
 *
 * - 授权记录只追加（数据库触发器拒绝改写/删除）；有效 = 该类最近一条是授权，且授权针对的正是**当前**参考素材
 *   （换了照片或声音样本就需要重新授权：同意的是"这张照片里的人""这段声音"）。
 * - 报价、确认、执行三处都重新检查授权（撤回立即生效）。
 */

export function identityConsentStatementSha256(kind: IdentityConsentKind, locale: 'zh-CN' | 'en', version = IDENTITY_CONSENT_STATEMENT_VERSION): string {
  return createHash('sha256').update(`${version}\n${IDENTITY_CONSENT_STATEMENTS[kind][locale]}`).digest('hex');
}

type ReferenceRow = { id: string; creatorIdentityId: string; kind: string; assetId: string; footageId: string; createdAt: Date; filename: unknown; mimeType: string | null; durationMs: number | null; storageKey: string; status: string };
type ConsentRow = typeof identityConsentRecords.$inferSelect;

/** 生成要用到的一类参考（当前参考 + 针对它的有效授权）。 */
export interface IdentityPartForGeneration {
  footageId: string;
  storageKey: string;
  mimeType: string;
  consentRecordId: string;
}

async function loadReferences(deps: DomainDeps, workspaceId: string, identityIds: readonly string[]): Promise<ReferenceRow[]> {
  if (identityIds.length === 0) return [];
  return deps.db.select({
    id: identityReferences.id,
    creatorIdentityId: identityReferences.creatorIdentityId,
    kind: identityReferences.kind,
    assetId: identityReferences.assetId,
    footageId: identityReferences.footageId,
    createdAt: identityReferences.createdAt,
    filename: assets.metadata,
    mimeType: assetVersions.mimeType,
    durationMs: assetVersions.durationMs,
    storageKey: assetVersions.storageKey,
    status: assetVersions.status,
  }).from(identityReferences)
    .innerJoin(assets, eq(assets.id, identityReferences.assetId))
    .innerJoin(assetVersions, eq(assetVersions.id, identityReferences.footageId))
    .where(and(eq(identityReferences.workspaceId, workspaceId), inArray(identityReferences.creatorIdentityId, [...identityIds]), isNull(identityReferences.replacedAt)));
}

async function loadConsents(deps: DomainDeps, workspaceId: string, identityIds: readonly string[]): Promise<ConsentRow[]> {
  if (identityIds.length === 0) return [];
  return deps.db.select().from(identityConsentRecords)
    .where(and(eq(identityConsentRecords.workspaceId, workspaceId), inArray(identityConsentRecords.creatorIdentityId, [...identityIds])))
    .orderBy(desc(identityConsentRecords.createdAt), desc(identityConsentRecords.id));
}

const toRecord = (row: ConsentRow): IdentityConsentRecord => ({
  id: row.id,
  kind: row.kind as IdentityConsentKind,
  action: row.action as 'GRANT' | 'REVOKE',
  subject: row.subject as IdentityConsentRecord['subject'],
  statementVersion: row.statementVersion,
  locale: row.locale as IdentityConsentRecord['locale'],
  statementSha256: row.statementSha256,
  actorId: row.actorId,
  createdAt: row.createdAt.toISOString(),
});

const toReference = (row: ReferenceRow): IdentityReference => ({
  kind: row.kind as IdentityConsentKind,
  assetId: row.assetId,
  footageId: row.footageId,
  filename: typeof (row.filename as { filename?: unknown } | null)?.filename === 'string' ? String((row.filename as { filename: string }).filename) : row.assetId,
  mimeType: row.mimeType ?? 'application/octet-stream',
  durationMs: row.durationMs,
  addedAt: row.createdAt.toISOString(),
});

/** 有效授权：该类最近一条记录是授权，且针对当前参考素材。 */
function activeConsent(consents: readonly ConsentRow[], identityId: string, kind: IdentityConsentKind, reference: ReferenceRow | undefined): ConsentRow | null {
  const latest = consents.find((row) => row.creatorIdentityId === identityId && row.kind === kind);
  if (latest === undefined || latest.action !== 'GRANT' || reference === undefined || latest.referenceFootageId !== reference.footageId) return null;
  return latest;
}

function composeProfiles(identities: readonly (typeof creatorIdentities.$inferSelect)[], references: readonly ReferenceRow[], consents: readonly ConsentRow[]): IdentityProfile[] {
  return identities.map((identity) => {
    const part = (kind: IdentityConsentKind) => {
      const reference = references.find((row) => row.creatorIdentityId === identity.id && row.kind === kind);
      const consent = activeConsent(consents, identity.id, kind, reference);
      return {
        reference: reference === undefined ? null : toReference(reference),
        consent: consent === null ? null : { subject: consent.subject as 'SELF' | 'AUTHORIZED_OTHER', statementVersion: consent.statementVersion, grantedAt: consent.createdAt.toISOString() },
        ready: reference !== undefined && reference.status === 'READY' && consent !== null,
      };
    };
    return identityProfileSchema.parse({
      id: identity.id,
      name: identity.displayName,
      likeness: part('LIKENESS'),
      voice: part('VOICE'),
      history: consents.filter((row) => row.creatorIdentityId === identity.id).slice(0, 50).map(toRecord),
      createdAt: identity.createdAt.toISOString(),
    });
  });
}

export async function listIdentityProfiles(deps: DomainDeps, input: { workspaceId: string }): Promise<IdentityProfile[]> {
  const identities = await deps.db.select().from(creatorIdentities).where(eq(creatorIdentities.workspaceId, input.workspaceId)).orderBy(creatorIdentities.createdAt);
  const ids = identities.map((row) => row.id);
  return composeProfiles(identities, await loadReferences(deps, input.workspaceId, ids), await loadConsents(deps, input.workspaceId, ids));
}

export async function getIdentityProfile(deps: DomainDeps, input: { workspaceId: string; identityId: string }): Promise<IdentityProfile> {
  const identity = await deps.db.select().from(creatorIdentities)
    .where(and(eq(creatorIdentities.id, input.identityId), eq(creatorIdentities.workspaceId, input.workspaceId))).limit(1);
  if (identity[0] === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'identity profile not found', 404, { reason: IDENTITY_PROFILE_ERROR_REASONS.NOT_FOUND });
  const [profile] = composeProfiles(identity, await loadReferences(deps, input.workspaceId, [input.identityId]), await loadConsents(deps, input.workspaceId, [input.identityId]));
  return profile!;
}

export async function createIdentityProfile(deps: DomainDeps, input: { workspaceId: string; name: string }): Promise<IdentityProfile> {
  const created = await createCreatorIdentity(deps, { workspaceId: input.workspaceId, displayName: input.name });
  return getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: created.id });
}

/** 设定参考照片/声音样本（工作区里已就绪的图片/音频资产）。换参考 = 旧参考标记替换，授权需针对新参考重新确认。 */
export async function setIdentityReference(deps: DomainDeps, input: { workspaceId: string; identityId: string; kind: IdentityConsentKind; assetId: string; actorId: string | null }): Promise<IdentityProfile> {
  await getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
  const rows = await deps.db.select({ assetId: assets.id, footageId: assets.currentVersionId, status: assetVersions.status, mimeType: assetVersions.mimeType })
    .from(assets).innerJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(eq(assets.id, input.assetId), eq(assets.workspaceId, input.workspaceId), isNull(assets.deletedAt))).limit(1);
  const asset = rows[0];
  const prefix = IDENTITY_REFERENCE_MIME_PREFIX[input.kind];
  if (asset === undefined || asset.footageId === null || asset.status !== 'READY' || !(asset.mimeType ?? '').startsWith(prefix)) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, input.kind === 'LIKENESS' ? 'the likeness reference must be a ready photo' : 'the voice reference must be a ready audio file', 422, {
      reason: IDENTITY_PROFILE_ERROR_REASONS.REFERENCE_INVALID, kind: input.kind, expected: `${prefix}*`,
    });
  }
  const footageId = asset.footageId;
  await deps.db.transaction(async (tx) => {
    await tx.update(identityReferences).set({ replacedAt: new Date() })
      .where(and(eq(identityReferences.creatorIdentityId, input.identityId), eq(identityReferences.kind, input.kind), isNull(identityReferences.replacedAt)));
    await tx.insert(identityReferences).values({
      id: `idr_${randomUUID()}`, workspaceId: input.workspaceId, creatorIdentityId: input.identityId, kind: input.kind,
      assetId: asset.assetId, footageId, createdBy: input.actorId,
    });
  });
  return getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
}

/** 授权（追加一条 GRANT）：必须先有参考素材；声明必须是当前版本（界面展示的那一版）。 */
export async function grantIdentityConsent(deps: DomainDeps, input: { workspaceId: string; identityId: string; request: GrantIdentityConsentRequest; actorId: string | null }): Promise<IdentityProfile> {
  const { kind, subject, statementVersion, locale } = input.request;
  if (statementVersion !== IDENTITY_CONSENT_STATEMENT_VERSION) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'the consent statement has changed; read the current statement and confirm again', 409, {
      reason: IDENTITY_PROFILE_ERROR_REASONS.STATEMENT_OUTDATED, current: IDENTITY_CONSENT_STATEMENT_VERSION,
    });
  }
  const references = await loadReferences(deps, input.workspaceId, [input.identityId]);
  await getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
  const reference = references.find((row) => row.kind === kind);
  if (reference === undefined) {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, kind === 'LIKENESS' ? 'add a photo before granting likeness consent' : 'add a voice sample before granting voice consent', 409, {
      reason: IDENTITY_PROFILE_ERROR_REASONS.REFERENCE_INVALID, kind,
    });
  }
  await deps.db.insert(identityConsentRecords).values({
    id: `icr_${randomUUID()}`, workspaceId: input.workspaceId, creatorIdentityId: input.identityId, kind, action: 'GRANT', subject,
    statementVersion, locale, statementSha256: identityConsentStatementSha256(kind, locale, statementVersion), referenceFootageId: reference.footageId, actorId: input.actorId,
  });
  return getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
}

/** 撤回（追加一条 REVOKE）：立即生效；之后的报价、确认与执行都会被拒绝。 */
export async function revokeIdentityConsent(deps: DomainDeps, input: { workspaceId: string; identityId: string; kind: IdentityConsentKind; actorId: string | null }): Promise<IdentityProfile> {
  await getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
  const latest = (await loadConsents(deps, input.workspaceId, [input.identityId])).find((row) => row.kind === input.kind);
  if (latest === undefined || latest.action !== 'GRANT') {
    throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'there is no consent to withdraw', 409, { reason: IDENTITY_PROFILE_ERROR_REASONS.NOT_GRANTED, kind: input.kind });
  }
  await deps.db.insert(identityConsentRecords).values({
    id: `icr_${randomUUID()}`, workspaceId: input.workspaceId, creatorIdentityId: input.identityId, kind: input.kind, action: 'REVOKE',
    statementVersion: latest.statementVersion, actorId: input.actorId,
  });
  return getIdentityProfile(deps, { workspaceId: input.workspaceId, identityId: input.identityId });
}

/**
 * 生成用：返回身份档案与可用于生成的参考（参考就绪且授权有效）；缺哪一类就是 null（调用方按需要的类别判定）。
 */
export async function identityForGeneration(deps: DomainDeps, input: { workspaceId: string; identityId: string }): Promise<{
  profile: IdentityProfile;
  parts: Record<IdentityConsentKind, IdentityPartForGeneration | null>;
}> {
  const profile = await getIdentityProfile(deps, input);
  const references = await loadReferences(deps, input.workspaceId, [input.identityId]);
  const consents = await loadConsents(deps, input.workspaceId, [input.identityId]);
  const parts = Object.fromEntries(IDENTITY_CONSENT_KINDS.map((kind) => {
    const reference = references.find((row) => row.kind === kind);
    const consent = activeConsent(consents, input.identityId, kind, reference);
    return [kind, reference === undefined || consent === null || reference.status !== 'READY'
      ? null
      : { footageId: reference.footageId, storageKey: reference.storageKey, mimeType: reference.mimeType ?? 'application/octet-stream', consentRecordId: consent.id }];
  })) as Record<IdentityConsentKind, IdentityPartForGeneration | null>;
  return { profile, parts };
}
