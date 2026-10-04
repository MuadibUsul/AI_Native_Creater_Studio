import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ApiFailure,
  ERROR_CODES,
  decideApprovalRequestSchema,
  errorEnvelopeSchema,
  exportPackageSchema,
  opaqueIdSchema,
  renderApprovalSchema,
} from '@ancs/contracts';
import { buildRenderExportPackage, decideRenderApproval, getLatestRenderApproval, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { StorageDeps } from '../plugins/storage.js';

/**
 * 审批与受控导出路由（P07-06 / §87、§54）：
 * - POST /workspaces/:id/renders/:renderId/approval：人工批准/驳回（仅 READY；记录 manifestHash 快照）；
 * - GET  /workspaces/:id/renders/:renderId/approval：最新审批记录（未审批 → null）；
 * - POST /workspaces/:id/renders/:renderId/export：**受控导出**（未批准/批准失效 → 409；批准 → 逐产物签名 URL 包）。
 *
 * 说明：导出/审批需要对象存储（签名 URL）；未装配存储时明确 501（fail-closed，不返回假链接）。
 */

const paramsSchema = z.object({ id: opaqueIdSchema, renderId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export function registerApprovalRoutes(app: FastifyInstance, deps: AuthDeps, storage: StorageDeps | undefined): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const requireStorage = (): StorageDeps => {
    if (storage === undefined) {
      throw new ApiFailure(ERROR_CODES.CAPABILITY_UNAVAILABLE, '未配置对象存储：审批导出不可用（fail-closed）', 501);
    }
    return storage;
  };
  const domain = (): DomainDeps => ({ db: deps.db, storage: storage?.adapter });

  typed.post(
    '/workspaces/:id/renders/:renderId/approval',
    {
      schema: {
        tags: ['projects'],
        summary: '人工审批（§87：批准绑定固定 Render + manifestHash；仅 READY 可审批）',
        params: paramsSchema,
        body: decideApprovalRequestSchema,
        response: { 200: renderApprovalSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return decideRenderApproval(domain(), {
        workspaceId: request.params.id,
        renderId: request.params.renderId,
        request: request.body,
        decidedBy: context.userId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/renders/:renderId/approval',
    {
      schema: {
        tags: ['projects'],
        summary: '最新审批记录（未审批 → null）',
        params: paramsSchema,
        response: { 200: z.object({ approval: renderApprovalSchema.nullable() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const approval = await getLatestRenderApproval(domain(), { workspaceId: request.params.id, renderId: request.params.renderId });
      return { approval };
    },
  );

  typed.post(
    '/workspaces/:id/renders/:renderId/export',
    {
      schema: {
        tags: ['projects'],
        summary: '受控导出（§87：未批准不能正式导出；批准 → 逐产物签名下载入口，与 Manifest 一致）',
        params: paramsSchema,
        response: { 200: exportPackageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      requireStorage();
      return buildRenderExportPackage(domain(), { workspaceId: request.params.id, renderId: request.params.renderId });
    },
  );
}
