import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  channelStyleDefaultsSchema,
  ERROR_CODES,
  projectVersionDetailSchema,
  projectVersionSnapshotSchema,
  projectVersionSchema,
  type ProjectVersion,
  type ProjectVersionDetail,
  type ProjectVersionSnapshot,
} from '@ancs/contracts';
import {
  avatarIdentities,
  brandIdentities,
  channelStyleVersions,
  editEvents,
  projectVersions,
  projects,
  scenes,
  speechProfiles,
  voiceIdentities,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';
import { buildSceneGraph } from './projects.js';
import { toProjectDto, type ProjectRow, type SceneRow } from './mappers.js';

/**
 * 项目版本快照（P02-03 / §23.2）：版本行不可变；Restore/Publish/Final 等场景按 versionId 解析。
 * 快照内容 = SceneGraph 快照 + meta（脚本/身份的独立快照随 P04/P06 增补字段）。
 */

export const AUTO_SNAPSHOT_INTERVAL = 50;

const toVersionDto = (row: typeof projectVersions.$inferSelect): ProjectVersion => {
  const snapshot = projectVersionSnapshotSchema.parse(row.snapshot);
  return projectVersionSchema.parse({
    id: row.id,
    workspaceId: row.workspaceId,
    projectId: row.projectId,
    versionNumber: row.versionNumber,
    reason: row.reason,
    note: row.note,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    sceneCount: snapshot.graph.scenes.length,
  });
};

/** 由当前状态（行数据）构建快照负载；身份/风格按项目 workspace 解析并记录版本。 */
export async function buildSnapshotPayload(
  db: NodePgDatabase,
  project: ProjectRow,
  sceneRows: SceneRow[],
  extraMeta: Record<string, unknown> = {},
): Promise<ProjectVersionSnapshot> {
  const styleRows = await db
    .select()
    .from(channelStyleVersions)
    .where(eq(channelStyleVersions.id, project.channelStyleVersionId))
    .limit(1);
  const styleRow = styleRows[0];
  if (!styleRow) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'project channel snapshot missing（数据不一致）', 500);
  }
  const defaults = channelStyleDefaultsSchema.parse(styleRow.defaults);

  const [avatarRows, voiceRows, brandRows, speechRows] = await Promise.all([
    defaults.avatarIdentityId === null
      ? Promise.resolve([])
      : db
          .select()
          .from(avatarIdentities)
          .where(and(eq(avatarIdentities.id, defaults.avatarIdentityId), eq(avatarIdentities.workspaceId, project.workspaceId)))
          .limit(1),
    defaults.voiceIdentityId === null
      ? Promise.resolve([])
      : db
          .select()
          .from(voiceIdentities)
          .where(and(eq(voiceIdentities.id, defaults.voiceIdentityId), eq(voiceIdentities.workspaceId, project.workspaceId)))
          .limit(1),
    defaults.brandIdentityId === null
      ? Promise.resolve([])
      : db
          .select()
          .from(brandIdentities)
          .where(and(eq(brandIdentities.id, defaults.brandIdentityId), eq(brandIdentities.workspaceId, project.workspaceId)))
          .limit(1),
    defaults.speechProfileId === null
      ? Promise.resolve([])
      : db
          .select()
          .from(speechProfiles)
          .where(and(eq(speechProfiles.id, defaults.speechProfileId), eq(speechProfiles.workspaceId, project.workspaceId)))
          .limit(1),
  ]);
  const avatar = avatarRows[0];
  const voice = voiceRows[0];
  const brand = brandRows[0];
  const speech = speechRows[0];

  const graph = buildSceneGraph({
    project: toProjectDto(project),
    channelStyleVersion: styleRow.version,
    speechProfile: speech ? { id: speech.id, version: speech.currentVersion } : null,
    identity: {
      avatar: avatar ? { id: avatar.id, version: avatar.version } : null,
      voice: voice ? { id: voice.id, version: voice.version } : null,
      brand: brand ? { id: brand.id, version: brand.version } : null,
    },
    sceneRows,
  });

  return projectVersionSnapshotSchema.parse({ schemaVersion: '0.1', graph, meta: extraMeta });
}

/** 当前项目的事件 seq 水位线（"每 N 事件自动快照"的计数基准，避免时间戳并列歧义）。 */
export async function currentEventSeq(db: NodePgDatabase, projectId: string): Promise<number> {
  const rows = await db
    .select({ max: sql<number>`coalesce(max(${editEvents.seq}), 0)` })
    .from(editEvents)
    .where(eq(editEvents.projectId, projectId));
  return Number(rows[0]?.max ?? 0);
}

async function loadProjectRow(db: NodePgDatabase, workspaceId: string, projectId: string): Promise<ProjectRow> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  return row;
}

export async function loadSceneRows(db: NodePgDatabase, projectId: string): Promise<SceneRow[]> {
  return db.select().from(scenes).where(eq(scenes.projectId, projectId)).orderBy(scenes.position);
}

/** 建立版本（自动/手动共用）：版本号在 Project 行锁下递增；成功后指向 currentVersionId。 */
export async function createProjectVersion(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; reason: ProjectVersion['reason']; note?: string; createdBy?: string | null },
): Promise<ProjectVersion> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);

  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
    const freshRows = await tx
      .select()
      .from(projects)
      .where(eq(projects.id, input.projectId))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

    const sceneRows = await tx.select().from(scenes).where(eq(scenes.projectId, input.projectId)).orderBy(scenes.position);
    const eventSeq = await currentEventSeq(tx as unknown as NodePgDatabase, input.projectId);
    const snapshot = await buildSnapshotPayload(tx as unknown as NodePgDatabase, fresh, sceneRows, { eventSeq });
    const versionRows = await tx
      .select({ max: sql<number>`coalesce(max(${projectVersions.versionNumber}), 0)` })
      .from(projectVersions)
      .where(eq(projectVersions.projectId, input.projectId));
    const versionNumber = Number(versionRows[0]?.max ?? 0) + 1;

    const inserted = await tx
      .insert(projectVersions)
      .values({
        id: `pv_${randomUUID()}`,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        versionNumber,
        snapshot,
        reason: input.reason,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new ApiFailure(ERROR_CODES.INTERNAL, 'version insert failed', 500);

    await tx.update(projects).set({ currentVersionId: row.id }).where(eq(projects.id, input.projectId));
    return toVersionDto(row);
  });
}

export async function listProjectVersions(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ProjectVersion[]> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const rows = await deps.db
    .select()
    .from(projectVersions)
    .where(and(eq(projectVersions.projectId, input.projectId), eq(projectVersions.workspaceId, input.workspaceId)))
    .orderBy(desc(projectVersions.versionNumber));
  return rows.map(toVersionDto);
}

export async function getProjectVersion(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; versionId: string },
): Promise<ProjectVersionDetail> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const rows = await deps.db
    .select()
    .from(projectVersions)
    .where(
      and(
        eq(projectVersions.id, input.versionId),
        eq(projectVersions.projectId, input.projectId),
        eq(projectVersions.workspaceId, input.workspaceId),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project version not found', 404);
  return projectVersionDetailSchema.parse({
    ...toVersionDto(row),
    snapshot: projectVersionSnapshotSchema.parse(row.snapshot),
  });
}
