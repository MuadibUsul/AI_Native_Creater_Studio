import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  ApiFailure,
  ERROR_CODES,
  MEDIA_ANALYSIS_ERROR_CODES,
  MEDIA_INDEX_PROCESSOR_VERSION,
  MEDIA_TRANSCRIPT_PROCESSOR_VERSION,
  MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION,
  createStudioProjectRequestSchema,
  effectLayerMetadataSchema,
  mediaTimeSchema,
  narrationMetadataSchema,
  projectBriefSchema,
  productionPolicySchema,
  mediaTimeToDisplaySecondsText,
  studioStateSchema,
  type CreateStudioProjectRequest,
  type StudioAnalysisState,
  type StudioEffect,
  type StudioFootage,
  type StudioNarration,
  type StudioProjectRef,
  type StudioState,
} from '@ancs/contracts';
import { agentSessions, assets, assetVersions, mediaIndexRuns, mediaTranscriptRuns, projectSequences, projects } from '@ancs/db';
import type { DomainDeps } from './deps.js';
import { createAgentSession, getAgentSession, projectAgentCost } from './agent-runtime.js';
import { createChannel, listChannels } from './channels.js';
import { createSequence, createTrack } from './composition.js';
import { createProject } from './projects.js';
import { articleParagraphs } from './agent-article.js';

/**
 * 共看片室（V6-1c）的服务端支撑：一步建好素材工程、读取工作台状态。
 * 工作台只读这里与既有的编辑/提案/预览/AI 接口，不维护第二套工程状态。
 */

/**
 * 新建：素材工程（FOOTAGE_EDIT）+ 主序列（30 fps 帧时基，初始 1 秒，由 AI 初剪或用户设定成片长度；带 V1/A1 两条轨）+ AI 会话。
 * V6-5 从文章开始：文章存进工程简报，工程为图文模式（HYBRID：允许程序化图解与字幕，不允许生成画面）；
 * 用户选择"AI 配音讲述"时同时允许合成语音（`allowGeneratedSpeech`）。没有选的能力仍由服务端按规则拦截。
 */
export async function createStudioProject(deps: DomainDeps, input: { workspaceId: string; request: CreateStudioProjectRequest; createdBy?: string | null }): Promise<StudioProjectRef> {
  const request = createStudioProjectRequestSchema.parse(input.request);
  return deps.db.transaction(async (tx) => {
    const scoped: DomainDeps = { ...deps, db: tx };
    // 栏目是旧模型的必填归属：沿用工作区第一个栏目，没有则建一个默认栏目
    const channels = await listChannels(scoped, { workspaceId: input.workspaceId });
    const channel = channels[0] ?? await createChannel(scoped, {
      workspaceId: input.workspaceId,
      ...(input.createdBy === null || input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      input: { name: request.locale === 'en' ? 'My videos' : '我的作品', language: request.locale === 'en' ? 'en' : 'zh' },
    });
    const project = await createProject(scoped, {
      workspaceId: input.workspaceId,
      ...(input.createdBy === null || input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
      input: request.article === undefined
        ? { title: request.title, channelId: channel.id, mode: 'FOOTAGE_EDIT', aspectRatio: request.aspectRatio, brief: {} }
        : {
          title: request.title, channelId: channel.id, mode: 'HYBRID', aspectRatio: request.aspectRatio,
          brief: { article: request.article, language: request.locale === 'en' ? 'en' : 'zh' },
          productionPolicy: { allowGeneratedSpeech: request.narration !== false, allowGeneratedVideo: false, allowGeneratedImage: false },
        },
    });
    const sequence = await createSequence(scoped, {
      workspaceId: input.workspaceId,
      projectId: project.id,
      input: { name: 'Main', frameRate: { num: 30, den: 1 }, duration: mediaTimeSchema.parse({ ticks: '30', timebase: { num: 1, den: 30 } }) },
    });
    for (const [position, kind, name] of [[0, 'VIDEO', 'V1'], [1, 'AUDIO', 'A1']] as const) {
      await createTrack(scoped, { workspaceId: input.workspaceId, projectId: project.id, sequenceId: sequence.id, input: { kind, position, name } });
    }
    const session = await createAgentSession(scoped, {
      workspaceId: input.workspaceId,
      projectId: project.id,
      request: { sequenceId: sequence.id, locale: request.locale },
      createdBy: input.createdBy ?? null,
    });
    return { projectId: project.id, sequenceId: sequence.id, sessionId: session.id };
  });
}

const analysisState = (run: { status: string; errorCode: string | null } | undefined): StudioAnalysisState => {
  switch (run?.status) {
    case undefined: return 'NONE';
    case 'QUEUED':
    case 'RUNNING': return 'WORKING';
    case 'READY':
    case 'PARTIAL': return 'READY';
    case 'EMPTY': return 'EMPTY';
    default: return run?.errorCode === MEDIA_ANALYSIS_ERROR_CODES.CAPABILITY_NOT_CONFIGURED ? 'NOT_CONFIGURED' : 'FAILED';
  }
};

export async function getStudioState(deps: DomainDeps, input: { workspaceId: string; projectId: string }): Promise<StudioState> {
  const projectRows = await deps.db.select().from(projects)
    .where(and(eq(projects.id, input.projectId), eq(projects.workspaceId, input.workspaceId), isNull(projects.deletedAt))).limit(1);
  const project = projectRows[0];
  if (project === undefined) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
  const sequence = (await deps.db.select({ id: projectSequences.id }).from(projectSequences)
    .where(and(eq(projectSequences.workspaceId, input.workspaceId), eq(projectSequences.projectId, input.projectId), isNull(projectSequences.parentSequenceId)))
    .orderBy(asc(projectSequences.createdAt)).limit(1))[0];
  if (sequence === undefined) throw new ApiFailure(ERROR_CODES.PRECONDITION_FAILED, 'this project has no sequence for the studio', 409, { reason: 'STUDIO_SEQUENCE_MISSING' });

  const sessionRow = (await deps.db.select({ id: agentSessions.id }).from(agentSessions)
    .where(and(eq(agentSessions.workspaceId, input.workspaceId), eq(agentSessions.projectId, input.projectId), eq(agentSessions.sequenceId, sequence.id)))
    .orderBy(desc(agentSessions.createdAt)).limit(1))[0];
  const session = sessionRow === undefined ? null : await getAgentSession(deps, { workspaceId: input.workspaceId, sessionId: sessionRow.id });

  // 用户的素材（系统生成的渲染产物、代理不在此列）
  const rows = await deps.db.select({ asset: assets, version: assetVersions }).from(assets)
    .leftJoin(assetVersions, eq(assetVersions.id, assets.currentVersionId))
    .where(and(
      eq(assets.workspaceId, input.workspaceId),
      eq(assets.projectId, input.projectId),
      isNull(assets.deletedAt),
      ne(assets.status, 'DELETED'),
      ne(assets.origin, 'SYSTEM_RENDER'),
    ))
    .orderBy(asc(assets.createdAt));
  // 特效图层（V6-3）是渲染产物：不在素材里，单独列出供时间带标名
  const effects: StudioEffect[] = rows.flatMap(({ asset, version }) => {
    if (asset.assetType !== 'CUSTOM_MOTION_RENDER' || version === null) return [];
    const parsed = effectLayerMetadataSchema.safeParse((asset.metadata as { effect?: unknown } | null)?.effect);
    return parsed.success ? [{ footageId: version.id, name: parsed.data.name, templateId: parsed.data.templateId, source: parsed.data.source, params: parsed.data.params }] : [];
  });
  // 讲述音频（V6-5）是 AI 合成的配音：不在素材里，单独列出供时间带标名
  const isNarration = (asset: typeof rows[number]['asset']): boolean => asset.assetType === 'VOICE_AUDIO' && asset.origin === 'GENERATED';
  const narration: StudioNarration[] = rows.flatMap(({ asset, version }) => {
    if (!isNarration(asset) || version === null) return [];
    const parsed = narrationMetadataSchema.safeParse((asset.metadata as { narration?: unknown } | null)?.narration);
    return parsed.success ? [{ footageId: version.id, text: parsed.data.text, voice: parsed.data.voice, engine: parsed.data.engine }] : [];
  });
  const footageRows = rows.filter(({ asset }) => asset.assetType !== 'CUSTOM_MOTION_RENDER' && !isNarration(asset));
  const versionIds = footageRows.map((row) => row.version?.id).filter((id): id is string => id !== undefined);
  // 镜头索引与视觉理解记在 media_index_runs，语音转写记在 media_transcript_runs
  const indexRuns = versionIds.length === 0 ? [] : await deps.db.select({ source: mediaIndexRuns.sourceAssetVersionId, processor: mediaIndexRuns.processorVersion, status: mediaIndexRuns.status, errorCode: mediaIndexRuns.errorCode })
    .from(mediaIndexRuns).where(and(eq(mediaIndexRuns.workspaceId, input.workspaceId), inArray(mediaIndexRuns.sourceAssetVersionId, versionIds)));
  const transcriptRuns = versionIds.length === 0 ? [] : await deps.db.select({ source: mediaTranscriptRuns.sourceAssetVersionId, processor: mediaTranscriptRuns.processorVersion, status: mediaTranscriptRuns.status, errorCode: mediaTranscriptRuns.errorCode })
    .from(mediaTranscriptRuns).where(and(eq(mediaTranscriptRuns.workspaceId, input.workspaceId), inArray(mediaTranscriptRuns.sourceAssetVersionId, versionIds)));
  const runOf = (versionId: string | undefined, processor: string) =>
    [...indexRuns, ...transcriptRuns].find((run) => run.source === versionId && run.processor === processor);

  const footage: StudioFootage[] = footageRows.map(({ asset, version }) => {
    const mime = version?.mimeType ?? String((asset.metadata as { mimeType?: unknown } | null)?.mimeType ?? '');
    const filename = (asset.metadata as { filename?: unknown } | null)?.filename;
    // 上传确认后还要等媒体探测（时长、音视频流）完成，才能放上时间线
    const probe = (version?.mediaProbe ?? null) as { status?: unknown } | null;
    const status: StudioFootage['status'] = asset.status === 'FAILED' || version?.status === 'FAILED' || (probe !== null && probe.status !== 'READY')
      ? 'FAILED'
      : asset.status === 'READY' && version?.status === 'READY' ? (probe === null ? 'PROCESSING' : 'READY') : asset.status === 'PROCESSING' ? 'PROCESSING' : 'UPLOADING';
    return {
      assetId: asset.id,
      footageId: status === 'READY' && version !== null ? version.id : null,
      name: typeof filename === 'string' && filename.length > 0 ? filename.slice(0, 200) : asset.id,
      kind: mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : mime.startsWith('image/') ? 'image' : 'other',
      status,
      duration: version?.durationMs === null || version?.durationMs === undefined ? null
        : mediaTimeToDisplaySecondsText(mediaTimeSchema.parse({ ticks: String(version.durationMs), timebase: { num: 1, den: 1000 } }), 1),
      understanding: {
        index: analysisState(runOf(version?.id, MEDIA_INDEX_PROCESSOR_VERSION)),
        transcript: analysisState(runOf(version?.id, MEDIA_TRANSCRIPT_PROCESSOR_VERSION)),
        visual: analysisState(runOf(version?.id, MEDIA_VISUAL_ANALYSIS_PROCESSOR_VERSION)),
      },
    };
  });

  const policy = productionPolicySchema.safeParse(project.productionPolicy).data;
  const article = projectBriefSchema.safeParse(project.brief ?? {}).data?.article ?? null;
  return studioStateSchema.parse({
    project: {
      id: project.id, title: project.title, aspectRatio: project.aspectRatio, revision: project.revision,
      allowEffects: policy?.allowProceduralGraphics === true,
      allowNarration: policy?.allowGeneratedSpeech === true,
      article: article === null ? null : { title: article.title, characters: article.text.length, paragraphs: articleParagraphs(article.text).length },
    },
    sequenceId: sequence.id,
    session,
    footage,
    effects,
    narration,
    cost: await projectAgentCost(deps, input),
  });
}
