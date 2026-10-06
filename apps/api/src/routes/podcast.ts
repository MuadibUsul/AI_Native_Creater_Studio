import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorEnvelopeSchema,
  generatePodcastRequestSchema,
  opaqueIdSchema,
  podcastEpisodeListSchema,
  podcastEpisodeSchema,
  podcastValidationResultSchema,
  type AlignmentProvider,
  type AudioSynthesisAdapter,
  type ObjectStorageAdapter,
} from '@ancs/contracts';
import { generatePodcastEpisode, listPodcastEpisodes, validatePodcastEpisode, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Podcast 路由（P12-05 / §4.2、§59）：
 * - POST   .../podcast/episodes —— 生成播客集（视觉指涉移除+披露 → PODCAST 变体重合成 → 章节/混音/元数据/署名）；
 * - GET    .../podcast/episodes —— 集列表（新→旧）；
 * - POST   .../podcast/episodes/:episodeId/validate —— 确定性校验（章节对账/元数据/授权/视觉指涉）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const episodeParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, episodeId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export interface PodcastRouteDeps {
  tts?: AudioSynthesisAdapter;
  aligner?: AlignmentProvider;
  storage?: ObjectStorageAdapter;
}

export function registerPodcastRoutes(app: FastifyInstance, deps: AuthDeps, provider: PodcastRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    ...(provider.tts !== undefined ? { tts: provider.tts } : {}),
    ...(provider.aligner !== undefined ? { aligner: provider.aligner } : {}),
    ...(provider.storage !== undefined ? { storage: provider.storage } : {}),
  };

  typed.post(
    '/workspaces/:id/projects/:projectId/podcast/episodes',
    {
      schema: {
        tags: ['podcast'],
        summary: '生成播客集（纯音频改写——视觉指涉移除并逐句披露；PODCAST 变体全新合成；章节=真实 cue）',
        params: projectParamsSchema,
        body: generatePodcastRequestSchema,
        response: { 200: podcastEpisodeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return generatePodcastEpisode(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.body.planId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/podcast/episodes',
    {
      schema: {
        tags: ['podcast'],
        summary: '播客集列表（新→旧；含脚本/章节/混音计划/元数据/署名）',
        params: projectParamsSchema,
        response: { 200: podcastEpisodeListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listPodcastEpisodes(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/podcast/episodes/:episodeId/validate',
    {
      schema: {
        tags: ['podcast'],
        summary: '校验播客集（视觉指涉/章节对账/元数据/授权/混音计划；error 阻止、warning 披露）',
        params: episodeParamsSchema,
        response: { 200: podcastValidationResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return validatePodcastEpisode(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        episodeId: request.params.episodeId,
      });
    },
  );
}
