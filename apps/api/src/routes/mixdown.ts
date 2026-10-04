import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  captionStyleSchema,
  errorEnvelopeSchema,
  mixPlanRequestSchema,
  mixPlanSchema,
  opaqueIdSchema,
  subtitleFormatSchema,
  subtitleOutputSchema,
} from '@ancs/contracts';
import { buildMixPlan, buildSubtitleOutput, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * 混音与字幕路由（P06-06 / §58、§59）：
 * - GET .../subtitles?format=SRT|VTT（+ style 覆盖）→ 字幕输出（由 Alignment 派生；越界只报 warning）；
 * - POST .../mix-plan → 混音计划（非旁白轨 + ducking；含 NARRATION 轨 → 422，无重叠双人声）；
 * 两者均为**纯计算**：不调用 TTS、不改数据库。
 */

const planParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, planId: opaqueIdSchema });
const subtitlesQuerySchema = z.object({
  format: subtitleFormatSchema.default('SRT'),
  /** JSON 覆盖（可选；缺省用契约默认样式） */
  style: z.string().max(2000).optional(),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

export function registerMixdownRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.get(
    '/workspaces/:id/projects/:projectId/narrative/:planId/subtitles',
    {
      schema: {
        tags: ['narrative'],
        summary: '字幕输出（SRT/VTT；由 Master Narration Alignment 派生，样式可覆盖）',
        params: planParamsSchema,
        querystring: subtitlesQuerySchema,
        response: { 200: subtitleOutputSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      let style: unknown;
      if (request.query.style !== undefined) {
        try {
          style = captionStyleSchema.partial().parse(JSON.parse(request.query.style));
        } catch {
          style = undefined;
        }
      }
      return buildSubtitleOutput(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        format: request.query.format,
        ...(style !== undefined ? { style } : {}),
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/narrative/:planId/mix-plan',
    {
      schema: {
        tags: ['narrative'],
        summary: '混音计划（非旁白轨 + ducking/淡入淡出；旁白唯一来源为 Alignment）',
        params: planParamsSchema,
        body: mixPlanRequestSchema,
        response: { 200: mixPlanSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return buildMixPlan(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        planId: request.params.planId,
        request: request.body,
      });
    },
  );
}
