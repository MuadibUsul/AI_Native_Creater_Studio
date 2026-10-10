import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  errorEnvelopeSchema,
  legacySelectionSchema,
  opaqueIdSchema,
  recoverSelectionAnchorRequestSchema,
  selectionAnchorRecordSchema,
  selectionAnchorSchema,
  selectionRecoveryResultSchema,
} from '@ancs/contracts';
import { getSelectionAnchor, recoverSelectionAnchor, remapSelectionAnchor, saveSelectionAnchor, type DomainDeps } from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * N04-09 SelectionAnchor 路由。
 *
 * - 保存/读取/重映射锚点：**只动选择状态**，不推进工程 revision、不写 edit_events；
 * - 归属过滤（跨租户 404）；目标必须属于本序列（越权/虚构目标 422）；
 * - `legacy` 字段：旧 inline 选择（分镜/片段/素材范围）经规范适配器解析一次成锚点（旧请求可读）。
 */

const projectParamsSchema = z.object({ id: opaqueIdSchema, projectId: opaqueIdSchema });
const anchorParamsSchema = projectParamsSchema.extend({ anchorId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema };

const saveAnchorBodySchema = z.object({
  anchor: selectionAnchorSchema,
  /** 旧格式兼容入口（与 anchor 同给时以 anchor 为准） */
  legacy: legacySelectionSchema.optional(),
}).strict();

const remapBodySchema = z.object({ reason: z.string().min(1).max(200) }).strict();

export function registerSelectionRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db };

  typed.post(
    '/workspaces/:id/projects/:projectId/selection-anchors',
    {
      schema: {
        tags: ['projects'],
        summary: '保存 SelectionAnchor（选择动作不改工程；旧 inline 选择经规范适配器解析一次）',
        params: projectParamsSchema,
        body: saveAnchorBodySchema,
        response: { 200: selectionAnchorRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return saveSelectionAnchor(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        actorId: context.userId,
        anchor: request.body.anchor,
        ...(request.body.legacy === undefined ? {} : { legacy: request.body.legacy }),
      });
    },
  );

  typed.get(
    '/workspaces/:id/projects/:projectId/selection-anchors/:anchorId',
    {
      schema: {
        tags: ['projects'],
        summary: '读取 SelectionAnchor（跨租户 404）',
        params: anchorParamsSchema,
        response: { 200: selectionAnchorRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getSelectionAnchor(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId, anchorId: request.params.anchorId,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/selection-anchors/:anchorId/remap',
    {
      schema: {
        tags: ['projects'],
        summary: '把锚点重解析到当前工程状态（目标消失 → FAILED/PARTIAL；重复素材引用 → AMBIGUOUS；版本过期 → STALE）',
        params: anchorParamsSchema,
        body: remapBodySchema,
        response: { 200: selectionAnchorRecordSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return remapSelectionAnchor(domain, {
        workspaceId: request.params.id, projectId: request.params.projectId,
        anchorId: request.params.anchorId, reason: request.body.reason,
      });
    },
  );

  typed.post(
    '/workspaces/:id/projects/:projectId/selection-anchors/:anchorId/recover',
    {
      schema: {
        tags: ['projects'],
        summary: '自动恢复锚点（刷新/时序变更）；期望修订不符 → 409；无变化时不追加修订',
        params: anchorParamsSchema,
        body: recoverSelectionAnchorRequestSchema,
        response: { 200: selectionRecoveryResultSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return recoverSelectionAnchor(domain, {
        workspaceId: request.params.id,
        projectId: request.params.projectId,
        anchorId: request.params.anchorId,
        trigger: request.body.trigger,
        ...(request.body.expectedRevision === undefined ? {} : { expectedRevision: request.body.expectedRevision }),
        ...(request.body.reason === undefined ? {} : { reason: request.body.reason }),
      });
    },
  );
}
