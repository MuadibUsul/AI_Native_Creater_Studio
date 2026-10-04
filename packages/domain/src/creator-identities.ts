import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  type AvatarIdentity,
  type BrandIdentity,
  type CreatorIdentity,
  type UpdateCreatorIdentityRequest,
  type VoiceIdentity,
} from '@ancs/contracts';
import { avatarIdentities, brandIdentities, creatorIdentities, voiceIdentities } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * CreatorIdentity 服务（P01-04 / 规范 §6.1）。
 * 子身份（Avatar/Voice/Brand）独立版本化：更新对应子身份时 version+1，
 * 不影响其他子身份版本；历史 Manifest 以 id+version 记录引用。
 * 服务层不做鉴权；查询强制携带 workspace_id。
 */

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

type AvatarRow = typeof avatarIdentities.$inferSelect;
type VoiceRow = typeof voiceIdentities.$inferSelect;
type BrandRow = typeof brandIdentities.$inferSelect;
type CreatorRow = typeof creatorIdentities.$inferSelect;

const mapAvatar = (row: AvatarRow): AvatarIdentity => ({
  id: row.id,
  creatorIdentityId: row.creatorIdentityId,
  version: row.version,
  provider: row.provider,
  providerAvatarId: row.providerAvatarId,
  providerAccountScope: row.providerAccountScope,
  displayName: row.displayName,
  status: row.status as AvatarIdentity['status'],
  consentMetadata: (row.consentMetadata ?? {}) as Record<string, unknown>,
  defaultLook: (row.defaultLook ?? {}) as Record<string, unknown>,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  retiredAt: row.retiredAt?.toISOString() ?? null,
});

const mapVoice = (row: VoiceRow): VoiceIdentity => ({
  id: row.id,
  creatorIdentityId: row.creatorIdentityId,
  version: row.version,
  provider: row.provider,
  providerVoiceId: row.providerVoiceId,
  cloneType: row.cloneType as VoiceIdentity['cloneType'],
  ownershipType: row.ownershipType as VoiceIdentity['ownershipType'],
  verificationStatus: row.verificationStatus,
  managedMode: row.managedMode as VoiceIdentity['managedMode'],
  languageProfile: row.languageProfile,
  defaultSpeechProfileId: row.defaultSpeechProfileId,
  status: row.status as VoiceIdentity['status'],
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  retiredAt: row.retiredAt?.toISOString() ?? null,
});

const mapBrand = (row: BrandRow): BrandIdentity => ({
  id: row.id,
  creatorIdentityId: row.creatorIdentityId,
  version: row.version,
  name: row.name,
  themeTokens: row.themeTokens as BrandIdentity['themeTokens'],
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

async function loadCreatorRow(
  db: NodePgDatabase,
  workspaceId: string,
  creatorIdentityId: string,
): Promise<CreatorRow> {
  const rows = await db
    .select()
    .from(creatorIdentities)
    .where(and(eq(creatorIdentities.id, creatorIdentityId), eq(creatorIdentities.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'creator identity not found', 404);
  return row;
}

export async function composeCreatorIdentity(deps: DomainDeps, row: CreatorRow): Promise<CreatorIdentity> {
  const [avatarRows, voiceRows, brandRows] = await Promise.all([
    deps.db.select().from(avatarIdentities).where(eq(avatarIdentities.creatorIdentityId, row.id)).limit(1),
    deps.db.select().from(voiceIdentities).where(eq(voiceIdentities.creatorIdentityId, row.id)).limit(1),
    deps.db.select().from(brandIdentities).where(eq(brandIdentities.creatorIdentityId, row.id)).limit(1),
  ]);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    displayName: row.displayName,
    avatarIdentity: avatarRows[0] ? mapAvatar(avatarRows[0]) : null,
    voiceIdentity: voiceRows[0] ? mapVoice(voiceRows[0]) : null,
    brandIdentity: brandRows[0] ? mapBrand(brandRows[0]) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createCreatorIdentity(
  deps: DomainDeps,
  input: { workspaceId: string; displayName: string },
): Promise<CreatorIdentity> {
  const now = new Date();
  const id = newId('cid');
  await deps.db.insert(creatorIdentities).values({
    id,
    workspaceId: input.workspaceId,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  });
  return composeCreatorIdentity(deps, {
    id,
    workspaceId: input.workspaceId,
    displayName: input.displayName,
    createdAt: now,
    updatedAt: now,
  });
}

export async function getCreatorIdentity(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string },
): Promise<CreatorIdentity> {
  const row = await loadCreatorRow(deps.db, input.workspaceId, input.creatorIdentityId);
  return composeCreatorIdentity(deps, row);
}

export async function listCreatorIdentities(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<CreatorIdentity[]> {
  const rows = await deps.db
    .select()
    .from(creatorIdentities)
    .where(eq(creatorIdentities.workspaceId, input.workspaceId))
    .orderBy(creatorIdentities.createdAt);
  return Promise.all(rows.map((row) => composeCreatorIdentity(deps, row)));
}

/**
 * 更新 Creator Identity：displayName 与子身份 upsert 在同一事务内；
 * 锁定根行避免并发版本错乱；提供某子身份即整段替换该子身份并 version+1。
 */
export async function updateCreatorIdentity(
  deps: DomainDeps,
  input: { workspaceId: string; creatorIdentityId: string; input: UpdateCreatorIdentityRequest },
): Promise<CreatorIdentity> {
  await loadCreatorRow(deps.db, input.workspaceId, input.creatorIdentityId);

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from creator_identities where id = ${input.creatorIdentityId} for update`);
    const now = new Date();

    if (input.input.displayName !== undefined) {
      await tx
        .update(creatorIdentities)
        .set({ displayName: input.input.displayName, updatedAt: now })
        .where(eq(creatorIdentities.id, input.creatorIdentityId));
    }

    if (input.input.avatarIdentity !== undefined) {
      const payload = input.input.avatarIdentity;
      const existing = await tx
        .select({ id: avatarIdentities.id, version: avatarIdentities.version })
        .from(avatarIdentities)
        .where(eq(avatarIdentities.creatorIdentityId, input.creatorIdentityId))
        .limit(1);
      const values = {
        provider: payload.provider,
        providerAvatarId: payload.providerAvatarId,
        providerAccountScope: payload.providerAccountScope,
        displayName: payload.displayName,
        status: payload.status,
        consentMetadata: payload.consentMetadata,
        defaultLook: payload.defaultLook,
        updatedAt: now,
        retiredAt: payload.status === 'RETIRED' ? now : null,
      };
      if (existing[0]) {
        await tx
          .update(avatarIdentities)
          .set({ ...values, version: existing[0].version + 1 })
          .where(eq(avatarIdentities.id, existing[0].id));
      } else {
        await tx.insert(avatarIdentities).values({
          id: newId('ava'),
          workspaceId: input.workspaceId,
          creatorIdentityId: input.creatorIdentityId,
          version: 1,
          createdAt: now,
          ...values,
        });
      }
    }

    if (input.input.voiceIdentity !== undefined) {
      const payload = input.input.voiceIdentity;
      const existing = await tx
        .select({ id: voiceIdentities.id, version: voiceIdentities.version })
        .from(voiceIdentities)
        .where(eq(voiceIdentities.creatorIdentityId, input.creatorIdentityId))
        .limit(1);
      const values = {
        provider: payload.provider,
        providerVoiceId: payload.providerVoiceId,
        cloneType: payload.cloneType,
        ownershipType: payload.ownershipType,
        verificationStatus: payload.verificationStatus,
        managedMode: payload.managedMode,
        languageProfile: payload.languageProfile,
        defaultSpeechProfileId: payload.defaultSpeechProfileId,
        status: payload.status,
        updatedAt: now,
        retiredAt: payload.status === 'RETIRED' ? now : null,
      };
      if (existing[0]) {
        await tx
          .update(voiceIdentities)
          .set({ ...values, version: existing[0].version + 1 })
          .where(eq(voiceIdentities.id, existing[0].id));
      } else {
        await tx.insert(voiceIdentities).values({
          id: newId('voi'),
          workspaceId: input.workspaceId,
          creatorIdentityId: input.creatorIdentityId,
          version: 1,
          createdAt: now,
          ...values,
        });
      }
    }

    if (input.input.brandIdentity !== undefined) {
      const payload = input.input.brandIdentity;
      const existing = await tx
        .select({ id: brandIdentities.id, version: brandIdentities.version })
        .from(brandIdentities)
        .where(eq(brandIdentities.creatorIdentityId, input.creatorIdentityId))
        .limit(1);
      if (existing[0]) {
        await tx
          .update(brandIdentities)
          .set({ name: payload.name, themeTokens: payload.themeTokens, version: existing[0].version + 1, updatedAt: now })
          .where(eq(brandIdentities.id, existing[0].id));
      } else {
        await tx.insert(brandIdentities).values({
          id: newId('brd'),
          workspaceId: input.workspaceId,
          creatorIdentityId: input.creatorIdentityId,
          version: 1,
          name: payload.name,
          themeTokens: payload.themeTokens,
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  });

  return getCreatorIdentity(deps, input);
}
