import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { errorEnvelopeSchema, opaqueIdSchema, packAnalyzeResultSchema, workspacePackViewSchema } from '@ancs/contracts';
import { bindProjectPack, disablePackForWorkspace, enablePackForWorkspace, ensurePacksInstalled, listWorkspacePacks, runPackAnalyze, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Pack 路由（P11-03 / §92）：
 * - GET    /workspaces/:id/packs —— 安装清单 + 启用状态（首次访问幂等安装官方 Pack）；
 * - POST   /workspaces/:id/packs/:packId/enable|disable —— 启用/停用（**权益白名单强制**）；
 * - POST   /workspaces/:id/projects/:projectId/packs/:packId/bind —— 项目绑定（**版本锁定**）；
 * - POST   /workspaces/:id/projects/:projectId/packs/:packId/analyze —— 受限上下文运行（OutputPlan 供预览/批准）。
 */

const workspaceParamsSchema = z.object({ id: opaqueIdSchema });
const workspacePackParamsSchema = z.object({ id: opaqueIdSchema, packId: z.string().min(3).max(120) });
const projectPackParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema, packId: z.string().min(3).max(120) });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export interface PackRouteOptions {
  /** 启动时幂等安装的官方插件实例（默认：Shorts Analyzer） */
  plugins?: PackRoutePluginList;
}

type PackRoutePluginList = import('@ancs/contracts').PackPlugin[];

export function registerPackRoutes(app: FastifyInstance, deps: AuthDeps, _options: PackRouteOptions = {}, plugins: PackRoutePluginList = []): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, packPlugins: plugins };

  typed.get(
    '/workspaces/:id/packs',
    {
      schema: {
        tags: ['packs'],
        summary: 'Pack 清单（安装 + 启用状态；官方 Pack 随首次访问幂等安装）',
        params: workspaceParamsSchema,
        response: { 200: z.object({ items: z.array(workspacePackViewSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      await ensurePacksInstalled(domain);
      const items = await listWorkspacePacks(domain, { workspaceId: request.params.id });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/packs/:packId/enable',
    {
      schema: {
        tags: ['packs'],
        summary: '启用 Pack（**权益白名单强制**——套餐 packs 不含该 Pack → 403）',
        params: workspacePackParamsSchema,
        response: { 200: z.object({ packId: z.string(), version: z.string(), enabledAt: z.string() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:update');
      await ensurePacksInstalled(domain);
      const enablement = await enablePackForWorkspace(domain, { workspaceId: request.params.id, packId: request.params.packId });
      return { packId: enablement.packId, version: enablement.version, enabledAt: enablement.enabledAt };
    },
  );

  typed.post(
    '/workspaces/:id/packs/:packId/disable',
    {
      schema: {
        tags: ['packs'],
        summary: '停用 Pack（移除工作区启用记录；绑定保留但 analyze 将明确失败）',
        params: workspacePackParamsSchema,
        response: { 204: z.void(), ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:update');
      await disablePackForWorkspace(domain, { workspaceId: request.params.id, packId: request.params.packId });
      return reply.status(204).send();
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/packs/:packId/bind',
    {
      schema: {
        tags: ['packs'],
        summary: '绑定项目（**版本锁定**：绑定当时启用版本的 Pack；换版 = 重新绑定）',
        params: projectPackParamsSchema,
        response: { 200: z.object({ projectId: z.string(), packId: z.string(), version: z.string(), boundAt: z.string() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      await ensurePacksInstalled(domain);
      const binding = await bindProjectPack(domain, { workspaceId: request.params.id, projectId: request.params.projectId, packId: request.params.packId });
      return { projectId: binding.projectId, packId: binding.packId, version: binding.version, boundAt: binding.boundAt };
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/packs/:packId/analyze',
    {
      schema: {
        tags: ['packs'],
        summary: '受限上下文运行 analyze（安装→启用→权益→绑定四道闸门 + 能力门控数据面；产出 OutputPlan 供预览/批准）',
        params: projectPackParamsSchema,
        response: { 200: packAnalyzeResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      await ensurePacksInstalled(domain);
      return runPackAnalyze(domain, { workspaceId: request.params.id, projectId: request.params.projectId, packId: request.params.packId });
    },
  );
}
