import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  collectPublicationAnalyticsRequestSchema,
  createExportPackageRequestSchema,
  errorEnvelopeSchema,
  exportPackageListSchema,
  exportPackageRecordSchema,
  opaqueIdSchema,
  publicationListSchema,
  publicationRecordSchema,
  publicationRequestSchema,
  publicationResponseSchema,
  videoPerformanceListSchema,
  videoPerformanceRecordSchema,
  scenePerformanceListSchema,
  creatorLearningActionSchema,
  creatorLearningListSchema,
  creatorLearningSchema,
  type DistributionProvider,
} from '@ancs/contracts';
import {
  collectPublicationAnalytics,
  attributeScenePerformance,
  createExportPackage,
  getPublication,
  listExportPackages,
  listProjectPublications,
  listPublicationAnalytics,
  listScenePerformance,
  actOnCreatorLearning,
  generateCreatorLearnings,
  listCreatorLearnings,
  reconcilePublication,
  requestPublication,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 发布路由（P13-01 / §90）：
 * - POST .../publications —— 请求发布（批准闸门 + 能力分级 + 幂等四元组；重复请求返回既有逻辑发布）；
 * - GET  .../publications —— 状态查询（新→旧）；
 * - GET  .../publications/:publicationId —— 单条状态；
 * - POST .../publications/:publicationId/reconcile —— 对账（结果未知先查询；以 Provider 为准，不自动重发）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const publicationParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, publicationId: opaqueIdSchema });
const performanceParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, performanceId: opaqueIdSchema });
const learningParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, learningId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema, 502: errorEnvelopeSchema };

export interface PublicationRouteDeps {
  distributionProviders?: readonly DistributionProvider[];
}

export function registerPublicationRoutes(app: FastifyInstance, deps: AuthDeps, provider: PublicationRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    ...(provider.distributionProviders !== undefined ? { distributionProviders: provider.distributionProviders } : {}),
  };

  typed.post(
    '/workspaces/:id/projects/:projectId/analytics/learnings/generate',
    {
      schema: { tags: ['analytics'], summary: '生成可解释、可撤销的 Creator 学习建议（不改写 Channel）', params: projectParamsSchema, response: { 200: creatorLearningListSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return { items: await generateCreatorLearnings(domain, { workspaceId: request.params.id, projectId: request.params.projectId }) };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/analytics/learnings',
    {
      schema: { tags: ['analytics'], summary: '读取 Creator 学习建议', params: projectParamsSchema, response: { 200: creatorLearningListSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return { items: await listCreatorLearnings(domain, { workspaceId: request.params.id, projectId: request.params.projectId }) };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/analytics/learnings/:learningId/action',
    {
      schema: { tags: ['analytics'], summary: '停用、接受或恢复学习建议；不会静默修改 Channel', params: learningParamsSchema, body: creatorLearningActionSchema, response: { 200: creatorLearningSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return actOnCreatorLearning(domain, { workspaceId: request.params.id, projectId: request.params.projectId, learningId: request.params.learningId, action: request.body.action });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/analytics/performance/:performanceId/attribute-scenes',
    {
      schema: { tags: ['analytics'], summary: '将留存时间映射到发布时冻结 Scene Graph（仅相关性）', params: performanceParamsSchema, response: { 200: scenePerformanceListSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return { items: await attributeScenePerformance(domain, { workspaceId: request.params.id, projectId: request.params.projectId, videoPerformanceId: request.params.performanceId }) };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/analytics/performance/:performanceId/scenes',
    {
      schema: { tags: ['analytics'], summary: '读取 Scene 表现归因（仅相关性）', params: performanceParamsSchema, response: { 200: scenePerformanceListSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return { items: await listScenePerformance(domain, { workspaceId: request.params.id, projectId: request.params.projectId, videoPerformanceId: request.params.performanceId }) };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/publications/:publicationId/analytics/collect',
    {
      schema: {
        tags: ['analytics'],
        summary: '采集发布表现（缺失指标保持 unknown/null；授权撤销后停止）',
        params: publicationParamsSchema,
        body: collectPublicationAnalyticsRequestSchema,
        response: { 200: videoPerformanceRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return collectPublicationAnalytics(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        publicationId: request.params.publicationId,
        request: request.body,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/publications/:publicationId/analytics',
    {
      schema: {
        tags: ['analytics'],
        summary: '读取发布表现采样（含平台与采样口径）',
        params: publicationParamsSchema,
        response: { 200: videoPerformanceListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return {
        items: await listPublicationAnalytics(domain, {
          workspaceId: request.params.id,
          projectId: request.params.projectId,
          publicationId: request.params.publicationId,
        }),
      };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/publications',
    {
      schema: {
        tags: ['publications'],
        summary: '请求发布（未批准版本不能发布；幂等键四元组——重复请求只形成一个逻辑发布）',
        params: projectParamsSchema,
        body: publicationRequestSchema,
        response: { 200: publicationResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return requestPublication(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        request: request.body,
        createdBy: context.userId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/publications',
    {
      schema: {
        tags: ['publications'],
        summary: '发布状态查询（新→旧）',
        params: projectParamsSchema,
        response: { 200: publicationListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjectPublications(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/publications/:publicationId',
    {
      schema: {
        tags: ['publications'],
        summary: '单条发布状态',
        params: publicationParamsSchema,
        response: { 200: publicationRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getPublication(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        publicationId: request.params.publicationId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/export-packages',
    {
      schema: {
        tags: ['publications'],
        summary: '创建 P4 导出包（视频+封面+文案+披露+平台手工清单；**最后一步由用户完成**——本系统不代发）',
        params: projectParamsSchema,
        body: createExportPackageRequestSchema,
        response: { 200: exportPackageRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return createExportPackage(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        platformId: request.body.platformId,
        projectVersionId: request.body.projectVersionId,
        outputAssetId: request.body.outputAssetId,
        coverAssetId: request.body.coverAssetId,
        title: request.body.title,
        description: request.body.description,
        tags: request.body.tags,
        disclosure: request.body.disclosure,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/export-packages',
    {
      schema: {
        tags: ['publications'],
        summary: '导出包列表（新→旧；P4 平台包——绝不显示为 Published）',
        params: projectParamsSchema,
        response: { 200: exportPackageListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listExportPackages(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/publications/:publicationId/reconcile',
    {
      schema: {
        tags: ['publications'],
        summary: '对账（结果未知时先查询；以 Provider getStatus 为准回填——不自动重发）',
        params: publicationParamsSchema,
        response: { 200: publicationRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return reconcilePublication(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        publicationId: request.params.publicationId,
      });
    },
  );
}
