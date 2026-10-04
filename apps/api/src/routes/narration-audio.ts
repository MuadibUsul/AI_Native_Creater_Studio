import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, masterNarrationSchema, opaqueIdSchema, type AlignmentProvider, type AudioSynthesisAdapter, type ObjectStorageAdapter } from '@ancs/contracts';
import { getCurrentMasterNarration, synthesizeMasterNarration, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Master Narration 路由（P06-03 / 规范 §5.1）：
 * - POST .../master-narration：逐段合成（带时间戳）→ 拼接 → 全局 Alignment + cues（追加式落库）；
 *   body.onlyBlockId 提供时只重合成该段（其余段命中缓存 → 不重复付费调用）；
 * - GET .../master-narration：当前 Master（无则 null）。
 */

const planParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, planId: opaqueIdSchema });
const synthesizeBodySchema = z.object({ onlyBlockId: opaqueIdSchema.optional() });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerNarrationAudioRoutes(
  app: FastifyInstance,
  deps: AuthDeps,
  audio: { tts?: AudioSynthesisAdapter; aligner?: AlignmentProvider; storage?: ObjectStorageAdapter } | undefined,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    ...(audio?.tts !== undefined ? { tts: audio.tts } : {}),
    ...(audio?.aligner !== undefined ? { aligner: audio.aligner } : {}),
    ...(audio?.storage !== undefined ? { storage: audio.storage } : {}),
  };

  typed.post(
    '/workspaces/:id/projects/:projectId/narrative/:planId/master-narration',
    {
      schema: {
        tags: ['narrative'],
        summary: '合成 Master Narration（逐段 TTS + 时间戳 → 拼接 + 全局 Alignment/cues；局部重建复用缓存）',
        params: planParamsSchema,
        body: synthesizeBodySchema,
        response: { 200: masterNarrationSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return synthesizeMasterNarration(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        ...(request.body.onlyBlockId !== undefined ? { onlyBlockId: request.body.onlyBlockId } : {}),
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/:planId/master-narration',
    {
      schema: {
        tags: ['narrative'],
        summary: '当前 Master Narration（含 Alignment 与 cues；无则 null）',
        params: planParamsSchema,
        response: { 200: masterNarrationSchema.nullable(), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getCurrentMasterNarration(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
      });
    },
  );
}
