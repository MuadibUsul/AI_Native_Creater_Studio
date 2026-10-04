import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { ApiFailure, ERROR_CODES, errorEnvelopeSchema, jobSchema, opaqueIdSchema } from '@ancs/contracts';
import { projects } from '@ancs/db';
import { requestSceneGeneration, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { CredentialDeps } from '../plugins/credentials.js';

/**
 * 显式生成动作（P06-05 / §2.8、§14.4）：
 * POST /projects/:projectId/scenes/:sceneId/generate（项目级路径，与 SDK projects.* 约定一致）
 * - 仅用户显式发起；去重键 = (项目, 场景, 场景 revision, 能力) → **双击只提交一次**（deduped=true）；
 * - 输入最小化（只含该 Scene 所需数据）；AI Video 边界（数据/证据类 → 422）与能力缺失（501）在服务层门控。
 */

const paramsSchema = z.object({ projectId: opaqueIdSchema, sceneId: opaqueIdSchema });
const bodySchema = z.object({ capability: z.string().min(1).max(64).default('video.generate') });
const responseSchema = z.object({
  job: jobSchema,
  deduped: z.boolean(),
  providerRoute: z.object({ providerId: z.string(), modelId: z.string(), credentialMode: z.string(), reason: z.string() }),
});
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerSceneGenerationRoutes(app: FastifyInstance, deps: AuthDeps, credentialDeps: CredentialDeps | undefined): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  // Router（resolveProviderRoute）需要密文服务与平台托管凭据登记（fail-closed：未配置即 501）
  const domain: DomainDeps = {
    db: deps.db,
    ...(credentialDeps?.cipher !== undefined ? { credentials: credentialDeps.cipher } : {}),
    ...(credentialDeps?.platformCredentials !== undefined ? { platformCredentials: credentialDeps.platformCredentials } : {}),
  };

  typed.post(
    '/projects/:projectId/scenes/:sceneId/generate',
    {
      schema: {
        tags: ['jobs'],
        summary: '显式生成场景素材（去重键防双击重复提交；输入最小化；能力缺失/越界明确阻止）',
        params: paramsSchema,
        body: bodySchema,
        response: { 200: responseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const rows = await deps.db
        .select({ workspaceId: projects.workspaceId })
        .from(projects)
        .where(and(eq(projects.id, request.params.projectId), isNull(projects.deletedAt)))
        .limit(1);
      const project = rows[0];
      if (!project) throw new ApiFailure(ERROR_CODES.NOT_FOUND, 'project not found', 404);
      const { context } = await app.requireWorkspace(request, project.workspaceId, 'project:write');
      return requestSceneGeneration(domain, {
        workspaceId: project.workspaceId,
        projectId: request.params.projectId,
        sceneId: request.params.sceneId,
        capability: request.body.capability,
        actorId: context.userId,
      });
    },
  );
}
