import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  contentDocumentRecordSchema,
  contentSourceSchema,
  createContentRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateSourceRequestSchema,
} from '@ancs/contracts';
import {
  createContent,
  getContentDocument,
  listContentDocuments,
  listProjectSources,
  updateSource,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { ArticleFetcher } from '@ancs/contracts';

/**
 * 输入归一化路由（P04-01 / 规范 §7）。
 *
 * - POST /workspaces/:id/projects/:projectId/content：URL / 粘贴正文 / 手写脚本 → ContentDocument
 *   （URL 抓取走注入的 ArticleFetcher；逐跳 SSRF 校验）；
 * - GET .../content 列表、GET .../content/:documentId 详情（含块）；
 * - GET .../sources 列表、PATCH .../sources/:sourceId（Sources 编辑：仅元数据）。
 *
 * 能力：写入 project:write，读取 project:read（沿用"先定位 workspace → 统一授权入口"模式）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const documentParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, documentId: opaqueIdSchema });
const sourceParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, sourceId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerContentRoutes(app: FastifyInstance, deps: AuthDeps, articleFetcher: ArticleFetcher | undefined): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(articleFetcher !== undefined ? { articleFetcher } : {}) };

  typed.post(
    '/workspaces/:id/projects/:projectId/content',
    {
      schema: {
        tags: ['content'],
        summary: '输入归一化：URL 文章 / 粘贴正文 / 手写脚本 → ContentDocument（明确失败原因）',
        params: projectParamsSchema,
        body: createContentRequestSchema,
        response: {
          201: contentDocumentRecordSchema,
          400: errorEnvelopeSchema,
          415: errorEnvelopeSchema,
          422: errorEnvelopeSchema,
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      const record = await createContent(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        createdBy: context.userId,
        input: request.body,
      });
      return reply.status(201).send(record);
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/content',
    {
      schema: {
        tags: ['content'],
        summary: '项目的 ContentDocument 列表（含块；最近优先）',
        params: projectParamsSchema,
        response: { 200: pageResponseSchema(contentDocumentRecordSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listContentDocuments(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/content/:documentId',
    {
      schema: {
        tags: ['content'],
        summary: 'ContentDocument 详情（统一结构；任何输入都先归一化到这里，不直接发 LLM）',
        params: documentParamsSchema,
        response: { 200: contentDocumentRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getContentDocument(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        documentId: request.params.documentId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/sources',
    {
      schema: {
        tags: ['content'],
        summary: '来源列表（SourceSnapshot 持久化形态：URL/标题/发布方/内容哈希/摘录）',
        params: projectParamsSchema,
        response: { 200: pageResponseSchema(contentSourceSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listProjectSources(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items, nextCursor: null };
    },
  );

  typed.patch(
    '/workspaces/:id/projects/:projectId/sources/:sourceId',
    {
      schema: {
        tags: ['content'],
        summary: 'Sources 编辑：仅元数据（标题/作者/发布方/发布时间/备注）；内容与哈希是快照事实',
        params: sourceParamsSchema,
        body: updateSourceRequestSchema,
        response: { 200: contentSourceSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return updateSource(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        sourceId: request.params.sourceId,
        input: request.body,
      });
    },
  );
}
