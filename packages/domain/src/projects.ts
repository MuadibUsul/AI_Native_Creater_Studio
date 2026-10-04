import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import {
  ApiFailure,
  channelStyleDefaultsSchema,
  ERROR_CODES,
  sceneGraphSchema,
  sceneSchema,
  V1_DEFAULT_FORMAT,
  type CreateProjectRequest,
  type CreateSceneRequest,
  type Project,
  type ProjectDetail,
  type Scene,
  type SceneGraph,
} from '@ancs/contracts';
import {
  avatarIdentities,
  brandIdentities,
  channelStyleVersions,
  channels,
  projects,
  scenes,
  speechProfiles,
  voiceIdentities,
} from '@ancs/db';
import type { DomainDeps } from './channels.js';

/**
 * Project / Scene 服务（P02-01）。
 *
 * 不变量（§4.3）：
 * 1. 所有记录归属 Workspace —— 一切查询/写入强制携带 workspace_id；
 * 2. 关联双方必须同 Workspace —— Channel/Project/Scene 交叉引用逐级校验；
 * 3. Scene 有独立记录与 revision；Project 为可编辑聚合，任何场景变更令其 revision +1；
 * 4. 创建 Project 冻结 Channel 样式快照（channelStyleVersionId）——旧项目不受后续 Channel 修改影响。
 *
 * 服务不做鉴权（由 API 统一授权入口保证）；SceneGraph 组装在出口处经契约校验（合法 Graph 的机器证据）。
 */

const newId = (prefix: string): string => `${prefix}_${randomUUID()}`;

/** 画幅 → 分辨率映射（V1 支持集，与契约 ASPECT_RATIOS 对齐） */
const RESOLUTION_BY_ASPECT: Readonly<Record<string, string>> = {
  '16:9': '1920x1080',
  '9:16': '1080x1920',
  '1:1': '1080x1080',
  '4:5': '1080x1350',
};

const resolutionForAspect = (aspectRatio: string): string => {
  const resolution = RESOLUTION_BY_ASPECT[aspectRatio];
  if (resolution === undefined) {
    throw new ApiFailure(ERROR_CODES.VALIDATION_FAILED, `不支持的画幅 "${aspectRatio}"`, 400);
  }
  return resolution;
};

const parseResolution = (resolution: string): { width: number; height: number } => {
  const [widthText, heightText] = resolution.split('x');
  return { width: Number(widthText), height: Number(heightText) };
};

type ProjectRow = typeof projects.$inferSelect;
type SceneRow = typeof scenes.$inferSelect;

const toProjectDto = (row: ProjectRow): Project => ({
  id: row.id,
  workspaceId: row.workspaceId,
  channelId: row.channelId,
  title: row.title,
  sourceType: row.sourceType as Project['sourceType'],
  status: row.status as Project['status'],
  revision: row.revision,
  aspectRatio: row.aspectRatio,
  resolution: row.resolution,
  fps: row.fps,
  targetDurationMs: row.targetDurationMs,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});

const toSceneDto = (row: SceneRow): Scene =>
  sceneSchema.parse({
    id: row.id,
    revision: row.revision,
    position: row.position,
    startMs: row.startMs,
    durationMs: row.durationMs,
    semanticType: row.semanticType,
    sceneType: row.sceneType,
    narrationBlockIds: row.narrationBlockIds,
    narration: row.narration,
    visualIntent: row.visualIntent,
    componentId: row.componentId,
    componentVersion: row.componentVersion,
    props: row.props,
    providerRequirement: row.providerRequirement,
    sourceBindings: row.sourceBindings,
    dataBindings: row.dataBindings,
    assetBindings: row.assetBindings,
    transition: row.transition,
    locked: row.locked,
    approved: row.approved,
    needsReview: row.needsReview,
    status: row.status,
  });

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

/**
 * 创建 Project：校验 Channel 属于同一 Workspace，冻结其当前样式版本为快照，
 * 画幅/时长等默认值从快照推导（Project 可用请求参数覆盖，§6）。
 */
export async function createProject(
  deps: DomainDeps,
  input: { workspaceId: string; createdBy?: string; input: CreateProjectRequest },
): Promise<ProjectDetail> {
  const channelRows = await deps.db
    .select()
    .from(channels)
    .where(and(eq(channels.id, input.input.channelId), eq(channels.workspaceId, input.workspaceId)))
    .limit(1);
  const channel = channelRows[0];
  if (!channel) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'channel not found', 404);

  const styleRows = await deps.db
    .select()
    .from(channelStyleVersions)
    .where(
      and(
        eq(channelStyleVersions.channelId, channel.id),
        eq(channelStyleVersions.version, channel.currentStyleVersion),
      ),
    )
    .limit(1);
  const styleRow = styleRows[0];
  if (!styleRow) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'channel style version missing（数据不一致）', 500);
  }
  const defaults = channelStyleDefaultsSchema.parse(styleRow.defaults);

  const aspectRatio = input.input.aspectRatio ?? defaults.defaultAspectRatio;
  const resolution = resolutionForAspect(aspectRatio);
  const targetDurationMs =
    input.input.targetDurationMs ??
    Math.round(((defaults.defaultDurationRangeSeconds.min + defaults.defaultDurationRangeSeconds.max) / 2) * 1000);

  const now = new Date();
  const projectId = newId('prj');
  await deps.db.insert(projects).values({
    id: projectId,
    workspaceId: input.workspaceId,
    channelId: channel.id,
    channelStyleVersionId: styleRow.id,
    title: input.input.title,
    sourceType: input.input.sourceType ?? 'MANUAL_SCRIPT',
    status: 'DRAFT',
    revision: 1,
    aspectRatio,
    resolution,
    fps: V1_DEFAULT_FORMAT.fps,
    targetDurationMs,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });

  return getProjectDetail(deps, { workspaceId: input.workspaceId, projectId });
}

export async function getProject(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<Project> {
  return toProjectDto(await loadProjectRow(deps.db, input.workspaceId, input.projectId));
}

export async function listProjects(
  deps: DomainDeps,
  input: { workspaceId: string },
): Promise<Project[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(eq(projects.workspaceId, input.workspaceId))
    .orderBy(projects.createdAt);
  return rows.map(toProjectDto);
}

/** Project 详情：附带创建时冻结的 Channel 样式快照（供展示与回归断言）。 */
export async function getProjectDetail(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<ProjectDetail> {
  const row = await loadProjectRow(deps.db, input.workspaceId, input.projectId);
  const styleRows = await deps.db
    .select()
    .from(channelStyleVersions)
    .where(eq(channelStyleVersions.id, row.channelStyleVersionId))
    .limit(1);
  const styleRow = styleRows[0];
  if (!styleRow) {
    throw new ApiFailure(ERROR_CODES.INTERNAL, 'project channel snapshot missing（数据不一致）', 500);
  }
  return {
    ...toProjectDto(row),
    channelSnapshot: {
      channelId: row.channelId,
      channelStyleVersionId: styleRow.id,
      styleVersion: styleRow.version,
      defaults: channelStyleDefaultsSchema.parse(styleRow.defaults),
    },
  };
}

/**
 * 追加 Scene（P02-01 基础形态）：
 * - position 追加到末尾；startMs 与前序场景**无间隙相接**（SceneGraph 时间线不变量）；
 * - Project 行锁保证并发追加的 position/startMs 不互相覆盖；
 * - Project 聚合 revision +1（§4.1）。统一操作协议与预期 revision 校验见 P02-02。
 */
export async function addScene(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateSceneRequest },
): Promise<{ project: Project; scene: Scene }> {
  await loadProjectRow(deps.db, input.workspaceId, input.projectId);

  let createdSceneId = '';
  const updatedProject = await deps.db.transaction(async (tx) => {
    await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);

    const freshRows = await tx
      .select()
      .from(projects)
      .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId)))
      .limit(1);
    const fresh = freshRows[0];
    if (!fresh) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);

    const aggregateRows = await tx
      .select({
        nextPosition: sql<number>`coalesce(max(${scenes.position}), -1) + 1`,
        endMs: sql<number>`coalesce(sum(${scenes.durationMs}), 0)`,
      })
      .from(scenes)
      .where(eq(scenes.projectId, input.projectId));
    const nextPosition = aggregateRows[0]?.nextPosition ?? 0;
    const startMs = aggregateRows[0]?.endMs ?? 0;

    createdSceneId = newId('scn');
    const now = new Date();
    await tx.insert(scenes).values({
      id: createdSceneId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      revision: 1,
      position: Number(nextPosition),
      startMs: Number(startMs),
      durationMs: input.input.durationMs,
      semanticType: input.input.semanticType,
      sceneType: input.input.sceneType,
      narrationBlockIds: [],
      narration: input.input.narration ?? '',
      visualIntent: input.input.visualIntent ?? '',
      componentId: input.input.componentId ?? null,
      componentVersion: input.input.componentVersion ?? null,
      props: input.input.props ?? {},
      providerRequirement: input.input.providerRequirement ?? null,
      sourceBindings: input.input.sourceBindings ?? [],
      dataBindings: input.input.dataBindings ?? [],
      assetBindings: [],
      transition: { in: null, out: null },
      locked: false,
      approved: false,
      needsReview: false,
      status: 'EMPTY',
      createdAt: now,
      updatedAt: now,
    });

    const bumped = await tx
      .update(projects)
      .set({ revision: fresh.revision + 1, updatedAt: now })
      .where(eq(projects.id, input.projectId))
      .returning();
    const bumpedRow = bumped[0];
    if (!bumpedRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'project update failed', 500);
    return bumpedRow;
  });

  const sceneRows = await deps.db.select().from(scenes).where(eq(scenes.id, createdSceneId)).limit(1);
  const sceneRow = sceneRows[0];
  if (!sceneRow) throw new ApiFailure(ERROR_CODES.INTERNAL, 'scene insert failed', 500);

  return { project: toProjectDto(updatedProject), scene: toSceneDto(sceneRow) };
}

/** 组装 SceneGraph：DB 规范化状态 → 契约校验通过的合法 Graph（P02-01 验收核心）。 */
export async function assembleSceneGraph(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string },
): Promise<SceneGraph> {
  const detail = await getProjectDetail(deps, input);
  const sceneRows = await deps.db
    .select()
    .from(scenes)
    .where(and(eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)))
    .orderBy(scenes.position);

  // 身份快照（§4.3 不变量 8：引用必须能确定具体版本；未绑定时为 null）
  const defaults = detail.channelSnapshot.defaults;
  const [avatarRows, voiceRows, brandRows, speechRows] = await Promise.all([
    defaults.avatarIdentityId === null
      ? Promise.resolve([])
      : deps.db
          .select()
          .from(avatarIdentities)
          .where(and(eq(avatarIdentities.id, defaults.avatarIdentityId), eq(avatarIdentities.workspaceId, input.workspaceId)))
          .limit(1),
    defaults.voiceIdentityId === null
      ? Promise.resolve([])
      : deps.db
          .select()
          .from(voiceIdentities)
          .where(and(eq(voiceIdentities.id, defaults.voiceIdentityId), eq(voiceIdentities.workspaceId, input.workspaceId)))
          .limit(1),
    defaults.brandIdentityId === null
      ? Promise.resolve([])
      : deps.db
          .select()
          .from(brandIdentities)
          .where(and(eq(brandIdentities.id, defaults.brandIdentityId), eq(brandIdentities.workspaceId, input.workspaceId)))
          .limit(1),
    defaults.speechProfileId === null
      ? Promise.resolve([])
      : deps.db
          .select()
          .from(speechProfiles)
          .where(and(eq(speechProfiles.id, defaults.speechProfileId), eq(speechProfiles.workspaceId, input.workspaceId)))
          .limit(1),
  ]);
  const avatar = avatarRows[0];
  const voice = voiceRows[0];
  const brand = brandRows[0];
  const speech = speechRows[0];

  const sceneDtos = sceneRows.map(toSceneDto);
  const totalMs = sceneDtos.reduce((sum, scene) => sum + scene.durationMs, 0);
  const { width, height } = parseResolution(detail.resolution);

  const graph: SceneGraph = sceneGraphSchema.parse({
    schemaVersion: '0.1',
    projectId: detail.id,
    projectRevision: detail.revision,
    channelSnapshot: {
      channelId: detail.channelId,
      channelStyleVersion: String(detail.channelSnapshot.styleVersion),
      speechProfileId: speech?.id ?? null,
      speechProfileVersion: speech ? String(speech.currentVersion) : null,
    },
    identitySnapshot: {
      avatarIdentityId: avatar?.id ?? null,
      avatarIdentityVersion: avatar ? String(avatar.version) : null,
      voiceIdentityId: voice?.id ?? null,
      voiceIdentityVersion: voice ? String(voice.version) : null,
      brandIdentityId: brand?.id ?? null,
      brandIdentityVersion: brand ? String(brand.version) : null,
    },
    format: { width, height, fps: detail.fps, aspectRatio: detail.aspectRatio },
    timeline: {
      durationMs: totalMs > 0 ? totalMs : (detail.targetDurationMs ?? 60_000),
      masterAudioAssetId: null,
    },
    scenes: sceneDtos,
    captions: [],
    audioTracks: [],
    overlays: [],
    sourceReferences: [],
  });

  return graph;
}
