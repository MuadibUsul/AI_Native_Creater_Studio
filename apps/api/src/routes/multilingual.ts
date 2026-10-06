import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorEnvelopeSchema,
  masterNarrationSchema,
  opaqueIdSchema,
  terminologyListSchema,
  terminologyEntrySchema,
  translationJobListSchema,
  translationJobSchema,
  translateNarrationRequestSchema,
  upsertTerminologyRequestSchema,
  type AlignmentProvider,
  type AudioSynthesisAdapter,
  type LlmAdapter,
  type ObjectStorageAdapter,
} from '@ancs/contracts';
import { listTerminology, listTranslationJobs, translateNarration, upsertTerminologyEntry, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 多语言路由（P12-04 / §5.1、§94）：
 * - PUT  .../terminology —— 术语词典 upsert（(projectId, sourceTerm, targetLanguage) 唯一）；
 * - GET  .../terminology —— 词典列表（可 ?language= 过滤）；
 * - POST .../narration/translations —— 翻译并重新合成（数字/实体 fail-closed 门；新语言全新时间戳）；
 * - GET  .../narration/translations —— 作业列表。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export interface MultilingualRouteDeps {
  llm?: LlmAdapter;
  tts?: AudioSynthesisAdapter;
  aligner?: AlignmentProvider;
  storage?: ObjectStorageAdapter;
}

export function registerMultilingualRoutes(app: FastifyInstance, deps: AuthDeps, provider: MultilingualRouteDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  // 翻译需要 LLM（seam）+ TTS/对齐/存储（重新合成为新语言时间戳）
  const domain: DomainDeps = {
    db: deps.db,
    ...(provider.llm !== undefined ? { llm: provider.llm } : {}),
    ...(provider.tts !== undefined ? { tts: provider.tts } : {}),
    ...(provider.aligner !== undefined ? { aligner: provider.aligner } : {}),
    ...(provider.storage !== undefined ? { storage: provider.storage } : {}),
  };

  typed.put(
    '/workspaces/:id/projects/:projectId/terminology',
    {
      schema: {
        tags: ['multilingual'],
        summary: '术语词典 upsert（翻译与 TTS 发音共用；(项目,源词,语言) 唯一）',
        params: projectParamsSchema,
        body: upsertTerminologyRequestSchema,
        response: { 200: terminologyEntrySchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return upsertTerminologyEntry(domain, { workspaceId: request.params.id, projectId: request.params.projectId, request: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/terminology',
    {
      schema: {
        tags: ['multilingual'],
        summary: '术语词典列表（可按语言过滤）',
        params: projectParamsSchema,
        querystring: z.object({ language: z.string().min(2).max(20).optional() }),
        response: { 200: terminologyListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listTerminology(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        language: request.query.language,
      });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/narration/translations',
    {
      schema: {
        tags: ['multilingual'],
        summary: '翻译旁白并重新合成（数字/实体 fail-closed；新语言全新时间戳——不复用原语言时间戳）',
        params: projectParamsSchema,
        body: translateNarrationRequestSchema,
        response: {
          200: z.object({ job: translationJobSchema, narration: masterNarrationSchema }),
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      const result = await translateNarration(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.body.planId,
        targetLanguage: request.body.targetLanguage,
      });
      return result;
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/narration/translations',
    {
      schema: {
        tags: ['multilingual'],
        summary: '翻译作业列表（新→旧；含数字/实体核对证据与派生 Master 引用）',
        params: projectParamsSchema,
        response: { 200: translationJobListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listTranslationJobs(domain, { workspaceId: request.params.id, projectId: request.params.projectId });
      return { items };
    },
  );
}
