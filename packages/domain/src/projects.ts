import { randomUUID } from 'node:crypto';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  ApiFailure,
  channelStyleDefaultsSchema,
  createSceneRequestSchema,
  editRequestSchema,
  ERROR_CODES,
  sceneGraphSchema,
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
import { processEdits } from './edits.js';
import { toProjectDto, toSceneDto, type ProjectRow, type SceneRow } from './mappers.js';

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

export async function loadProjectRow(db: NodePgDatabase, workspaceId: string, projectId: string): Promise<ProjectRow> {
  const rows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.workspaceId, workspaceId), isNull(projects.deletedAt)))
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
  input: { workspaceId: string; trashed?: boolean },
): Promise<Project[]> {
  const rows = await deps.db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.workspaceId, input.workspaceId),
        input.trashed === true ? isNotNull(projects.deletedAt) : isNull(projects.deletedAt),
      ),
    )
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
 * 追加 Scene（P02-01 对外形态；P02-02 起经统一编辑协议实现）：
 * 构造单操作 insert_scene（afterSceneId = 末尾）走 processEdits ——
 * 保留"追加到末尾 + position/startMs 相接 + revision+1"语义，
 * 同时获得并发控制（base revision 精确匹配）、EditEvent 与 Outbox。
 */
export async function addScene(
  deps: DomainDeps,
  input: { workspaceId: string; projectId: string; input: CreateSceneRequest },
): Promise<{ project: Project; scene: Scene }> {
  const project = await getProject(deps, { workspaceId: input.workspaceId, projectId: input.projectId });
  const lastRows = await deps.db
    .select({ id: scenes.id })
    .from(scenes)
    .where(and(eq(scenes.projectId, input.projectId), eq(scenes.workspaceId, input.workspaceId)))
    .orderBy(desc(scenes.position))
    .limit(1);

  const request = editRequestSchema.parse({
    baseProjectRevision: project.revision,
    expectedSceneRevisions: {},
    operations: [
      {
        op: 'insert_scene',
        afterSceneId: lastRows[0]?.id ?? null,
        sceneDraft: createSceneRequestSchema.parse(input.input),
      },
    ],
    idempotencyKey: `idem_add_scene_${randomUUID()}`,
  });

  const result = await processEdits(deps, {
    workspaceId: input.workspaceId,
    projectId: input.projectId,
    actor: { type: 'SYSTEM', id: null },
    request,
  });

  const createdId = result.createdSceneIds[0];
  const createdScene = result.response.scenes.find((scene) => scene.id === createdId);
  if (!createdScene) throw new ApiFailure(ERROR_CODES.INTERNAL, 'insert_scene 结果缺失', 500);
  return { project: result.response.project, scene: createdScene };
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

  return buildSceneGraph({
    project: detail,
    channelStyleVersion: detail.channelSnapshot.styleVersion,
    speechProfile: speech ? { id: speech.id, version: speech.currentVersion } : null,
    identity: {
      avatar: avatar ? { id: avatar.id, version: avatar.version } : null,
      voice: voice ? { id: voice.id, version: voice.version } : null,
      brand: brand ? { id: brand.id, version: brand.version } : null,
    },
    sceneRows,
  });
}

export interface SceneGraphBuildParams {
  project: Pick<Project, 'id' | 'channelId' | 'revision' | 'aspectRatio' | 'resolution' | 'fps' | 'targetDurationMs'>;
  channelStyleVersion: number;
  speechProfile: { id: string; version: number } | null;
  identity: {
    avatar: { id: string; version: number } | null;
    voice: { id: string; version: number } | null;
    brand: { id: string; version: number } | null;
  };
  sceneRows: SceneRow[];
}

/** SceneGraph 构建器（组装端点与版本快照共用；出口一律经契约校验）。 */
export function buildSceneGraph(params: SceneGraphBuildParams): SceneGraph {
  const sceneDtos = params.sceneRows.map(toSceneDto);
  const totalMs = sceneDtos.reduce((sum, scene) => sum + scene.durationMs, 0);
  const { width, height } = parseResolution(params.project.resolution);

  return sceneGraphSchema.parse({
    schemaVersion: '0.1',
    projectId: params.project.id,
    projectRevision: params.project.revision,
    channelSnapshot: {
      channelId: params.project.channelId,
      channelStyleVersion: String(params.channelStyleVersion),
      speechProfileId: params.speechProfile?.id ?? null,
      speechProfileVersion: params.speechProfile ? String(params.speechProfile.version) : null,
    },
    identitySnapshot: {
      avatarIdentityId: params.identity.avatar?.id ?? null,
      avatarIdentityVersion: params.identity.avatar ? String(params.identity.avatar.version) : null,
      voiceIdentityId: params.identity.voice?.id ?? null,
      voiceIdentityVersion: params.identity.voice ? String(params.identity.voice.version) : null,
      brandIdentityId: params.identity.brand?.id ?? null,
      brandIdentityVersion: params.identity.brand ? String(params.identity.brand.version) : null,
    },
    format: { width, height, fps: params.project.fps, aspectRatio: params.project.aspectRatio },
    timeline: {
      durationMs: totalMs > 0 ? totalMs : (params.project.targetDurationMs ?? 60_000),
      masterAudioAssetId: null,
    },
    scenes: sceneDtos,
    captions: [],
    audioTracks: [],
    overlays: [],
    sourceReferences: [],
  });
}
