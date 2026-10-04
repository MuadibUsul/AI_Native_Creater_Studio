import { randomUUID } from 'node:crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  mergeSpeechProfileFields,
  speechProfileFieldsSchema,
  type SpeechProfile,
  type SpeechProfileVersion,
} from '@ancs/contracts';
import { speechProfileVersions, speechProfiles } from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * SpeechProfile 服务（P01-04 / 规范 §6.4）。
 * 版本不可变：更新 fields 产生新版本（发音词典随版本保存，§95）；
 * P04-06 Speech Director 消费当前版本生成 SpeechPlan。
 */

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

const toVersionDto = (row: typeof speechProfileVersions.$inferSelect): SpeechProfileVersion => ({
  id: row.id,
  speechProfileId: row.speechProfileId,
  version: row.version,
  fields: speechProfileFieldsSchema.parse(row.fields),
  createdAt: row.createdAt.toISOString(),
});

async function loadProfileRow(deps: DomainDeps, workspaceId: string, speechProfileId: string) {
  const rows = await deps.db
    .select()
    .from(speechProfiles)
    .where(and(eq(speechProfiles.id, speechProfileId), eq(speechProfiles.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'speech profile not found', 404);
  return row;
}

async function loadVersion(deps: DomainDeps, speechProfileId: string, version: number): Promise<SpeechProfileVersion> {
  const rows = await deps.db
    .select()
    .from(speechProfileVersions)
    .where(and(eq(speechProfileVersions.speechProfileId, speechProfileId), eq(speechProfileVersions.version, version)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'speech profile version not found', 404);
  return toVersionDto(row);
}

async function compose(deps: DomainDeps, row: typeof speechProfiles.$inferSelect): Promise<SpeechProfile> {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    currentVersion: row.currentVersion,
    latest: await loadVersion(deps, row.id, row.currentVersion),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function createSpeechProfile(
  deps: DomainDeps,
  input: { workspaceId: string; name: string; fields?: Record<string, unknown> },
): Promise<SpeechProfile> {
  const fields = speechProfileFieldsSchema.parse(mergeSpeechProfileFields(input.fields));
  const now = new Date();
  const id = newId('sp');
  await deps.db.transaction(async (tx) => {
    await tx.insert(speechProfiles).values({
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(speechProfileVersions).values({
      id: newId('spv'),
      workspaceId: input.workspaceId,
      speechProfileId: id,
      version: 1,
      fields,
      createdAt: now,
    });
  });
  return compose(deps, { id, workspaceId: input.workspaceId, name: input.name, currentVersion: 1, createdAt: now, updatedAt: now });
}

export async function getSpeechProfile(
  deps: DomainDeps,
  input: { workspaceId: string; speechProfileId: string },
): Promise<SpeechProfile> {
  return compose(deps, await loadProfileRow(deps, input.workspaceId, input.speechProfileId));
}

export async function listSpeechProfiles(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<SpeechProfile[]> {
  const rows = await deps.db
    .select()
    .from(speechProfiles)
    .where(eq(speechProfiles.workspaceId, input.workspaceId))
    .orderBy(speechProfiles.createdAt);
  return Promise.all(rows.map((row) => compose(deps, row)));
}

export async function listSpeechProfileVersions(
  deps: DomainDeps,
  input: { workspaceId: string; speechProfileId: string },
): Promise<SpeechProfileVersion[]> {
  await loadProfileRow(deps, input.workspaceId, input.speechProfileId);
  const rows = await deps.db
    .select()
    .from(speechProfileVersions)
    .where(eq(speechProfileVersions.speechProfileId, input.speechProfileId))
    .orderBy(desc(speechProfileVersions.version));
  return rows.map(toVersionDto);
}

/** 更新：提供 fields 产生新版本（基于当前版本浅合并）；仅改名不产生新版本。 */
export async function updateSpeechProfile(
  deps: DomainDeps,
  input: { workspaceId: string; speechProfileId: string; name?: string; fields?: Record<string, unknown> },
): Promise<SpeechProfile> {
  await loadProfileRow(deps, input.workspaceId, input.speechProfileId);

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from speech_profiles where id = ${input.speechProfileId} for update`);
    const freshRows = await tx
      .select()
      .from(speechProfiles)
      .where(eq(speechProfiles.id, input.speechProfileId))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'speech profile not found', 404);

    const now = new Date();
    let nextVersion = fresh.currentVersion;

    if (input.fields !== undefined) {
      const currentFields = speechProfileFieldsSchema.parse(
        (
          await tx
            .select({ fields: speechProfileVersions.fields })
            .from(speechProfileVersions)
            .where(
              and(
                eq(speechProfileVersions.speechProfileId, input.speechProfileId),
                eq(speechProfileVersions.version, fresh.currentVersion),
              ),
            )
            .limit(1)
        )[0]?.fields,
      );
      const merged = speechProfileFieldsSchema.parse({ ...currentFields, ...input.fields });
      nextVersion = fresh.currentVersion + 1;
      await tx.insert(speechProfileVersions).values({
        id: newId('spv'),
        workspaceId: input.workspaceId,
        speechProfileId: input.speechProfileId,
        version: nextVersion,
        fields: merged,
        createdAt: now,
      });
    }

    await tx
      .update(speechProfiles)
      .set({ name: input.name ?? fresh.name, currentVersion: nextVersion, updatedAt: now })
      .where(eq(speechProfiles.id, input.speechProfileId));
  });

  return getSpeechProfile(deps, input);
}
