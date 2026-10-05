import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  contentDocumentRecordSchema,
  contentSourceSchema,
  createContentRequestSchema,
  errorEnvelope,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  updateSourceRequestSchema,
  type DocumentParser,
  type MalwareScanner,
} from '@ancs/contracts';
import {
  createContent,
  createContentFromDocument,
  getContentDocument,
  listContentDocuments,
  listProjectSources,
  updateSource,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { ArticleFetcher } from '@ancs/contracts';
import type { UploadRejectionAuditSink } from '../plugins/storage.js';

/**
 * 输入归一化路由（P04-01 / 规范 §7；P10-01 增文档导入）。
 *
 * - POST /workspaces/:id/projects/:projectId/content：URL / 粘贴正文 / 手写脚本 → ContentDocument
 *   （URL 抓取走注入的 ArticleFetcher；逐跳 SSRF 校验）；
 * - **POST .../content/document（P10-01）**：二进制文档（Markdown/PDF/DOCX/EML/HTML）→ ContentDocument
 *   （写入前扫描；解析失败/扫描件/缺页**明确处理**，不伪造提取成功）；
 * - GET .../content 列表、GET .../content/:documentId 详情（含块）；
 * - GET .../sources 列表、PATCH .../sources/:sourceId（Sources 编辑：仅元数据）。
 *
 * 能力：写入 project:write，读取 project:read（沿用"先定位 workspace → 统一授权入口"模式）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const documentParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, documentId: opaqueIdSchema });
const sourceParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, sourceId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

/** 文档导入依赖（P10-01；解析器未装配 → 501 fail-closed） */
export interface ContentDocumentDeps {
  parser?: DocumentParser;
  /** 与上传统一安全姿态：写入前扫描（§43.3） */
  scanner?: MalwareScanner;
  auditSink?: UploadRejectionAuditSink;
}

export function registerContentRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
  articleFetcher: ArticleFetcher | undefined,
  documents: ContentDocumentDeps = {},
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(articleFetcher !== undefined ? { articleFetcher } : {}) };

  // 二进制请求体（文档导入）：幂等注册（存储路由可能已注册通配解析器）
  if (!app.hasContentTypeParser('*')) {
    app.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
  }

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

  /**
   * 文档导入（P10-01）：二进制体 + `?filename=`；Content-Type 头部声明类型。
   * 写入前扫描（§43.3）；解析/扫描件/缺页等明确失败或逐条记入 normalization.notes。
   */
  app.post('/workspaces/:id/projects/:projectId/content/document', { schema: { hide: true } }, async (request, reply) => {
    const params = projectParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send(errorEnvelope('VALIDATION_FAILED', '路径参数非法', request.id));
    }
    const query = z.object({ filename: z.string().min(1).max(255) }).safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send(errorEnvelope('VALIDATION_FAILED', '缺少 filename 查询参数（文档文件名，用于类型识别）', request.id));
    }
    const { context } = await app.requireWorkspace(request, params.data.id, 'project:write');
    const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
    const contentType = typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '';
    const filename = query.data.filename;

    // 与上传统一安全姿态：写入前扫描
    if (documents.scanner !== undefined && bytes.length > 0) {
      const scan = await documents.scanner.scan({ bytes: new Uint8Array(bytes), filename, contentType });
      if (scan.status === 'INFECTED') {
        if (documents.auditSink !== undefined) {
          await documents.auditSink({
            action: 'upload.malware_rejected',
            workspaceId: params.data.id,
            key: `content-import:${filename}`,
            filename: filename.slice(0, 200),
            contentType: contentType.slice(0, 100),
            findings: scan.findings.map((finding) => ({ code: finding.code, message: finding.message })),
            scanner: scan.scanner,
          });
        }
        return reply.status(422).send(
          errorEnvelope('VALIDATION_FAILED', `文档被拒绝：${String(scan.findings.length)} 项安全检出（未解析）`, request.id, {
            reason: 'MALWARE_DETECTED',
            scanner: scan.scanner,
            findings: scan.findings,
          }),
        );
      }
    }

    const isHtml = /\.html?$/i.test(filename) || contentType.toLowerCase().includes('text/html');
    const record = await createContentFromDocument(domain, {
      workspaceId: params.data.id,
      projectId: params.data.projectId,
      createdBy: context.userId,
      filename,
      contentType,
      bytes: new Uint8Array(bytes),
      parser: documents.parser,
      ...(isHtml ? { html: bytes.toString('utf8') } : {}),
    });
    return reply.status(201).send(record);
  });

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
