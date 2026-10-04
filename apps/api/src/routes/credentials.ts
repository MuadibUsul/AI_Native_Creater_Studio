import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createConnectionRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  providerConnectionSchema,
  providerKindSchema,
  providerRouteDecisionSchema,
  rotateConnectionRequestSchema,
  testConnectionResponseSchema,
  upsertWorkspaceProviderSettingRequestSchema,
  workspaceProviderSettingSchema,
} from '@ancs/contracts';
import {
  createConnection,
  getConnection,
  listConnections,
  listWorkspaceProviderSettings,
  resolveProviderRoute,
  revokeConnection,
  rotateConnection,
  testConnection,
  upsertWorkspaceProviderSetting,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { CredentialDeps } from '../plugins/credentials.js';

/**
 * Provider 连接与路由路由（P03-04 / 规范 §17.2、§17.3）。
 *
 * 安全纪律：
 * - 所有端点要求 `provider:manage`（OWNER/ADMIN）——凭据是高权限资源；读取亦不例外
 *   （§17.3"只在后端使用"：连掩码列表也只对具备凭据管理能力者可见）；
 * - **响应体绝不含 Secret/密文**（创建/轮换请求的 secret 只进不出一）；错误信封同样如此；
 * - 路由决策端点（provider-route）要求 workspace:read（供 UI 展示"将使用哪个 Provider/凭据模式"）。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const connectionParamsSchema = z.object({ id: opaqueIdSchema, connectionId: opaqueIdSchema });
const settingParamsSchema = z.object({ id: opaqueIdSchema, kind: providerKindSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerCredentialRoutes(app: FastifyInstance, deps: AuthDeps, credentialDeps: CredentialDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = {
    db: deps.db,
    credentials: credentialDeps.cipher,
    ...(credentialDeps.platformCredentials !== undefined ? { platformCredentials: credentialDeps.platformCredentials } : {}),
    ...(credentialDeps.testHooks !== undefined ? { providerTestHooks: credentialDeps.testHooks } : {}),
  };

  typed.post(
    '/workspaces/:id/provider-connections',
    {
      schema: {
        tags: ['providers'],
        summary: '创建 BYOK 连接（服务端立即加密；响应只含掩码，Secret 绝不回显）',
        params: wsParamsSchema,
        body: createConnectionRequestSchema,
        response: { 201: providerConnectionSchema, 501: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'provider:manage');
      const connection = await createConnection(domain, {
        workspaceId: request.params.id,
        userId: context.userId,
        input: request.body,
      });
      return reply.status(201).send(connection);
    },
  );

  typed.get(
    '/workspaces/:id/provider-connections',
    {
      schema: {
        tags: ['providers'],
        summary: '连接列表（只含掩码与元数据：created/lastUsed/lastTested/revoked）',
        params: wsParamsSchema,
        response: { 200: pageResponseSchema(providerConnectionSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      const items = await listConnections(domain, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/provider-connections/:connectionId',
    {
      schema: {
        tags: ['providers'],
        summary: '连接详情（掩码与元数据；无 Secret/密文）',
        params: connectionParamsSchema,
        response: { 200: providerConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      return getConnection(domain, { workspaceId: request.params.id, connectionId: request.params.connectionId });
    },
  );

  typed.post(
    '/workspaces/:id/provider-connections/:connectionId/test',
    {
      schema: {
        tags: ['providers'],
        summary: '连接测试（离线校验恒执行；注册 Provider Test Hook 时执行真实连接测试）',
        params: connectionParamsSchema,
        response: { 200: testConnectionResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      return testConnection(domain, {
        workspaceId: request.params.id,
        connectionId: request.params.connectionId,
        ...(credentialDeps.testHooks !== undefined ? { testHooks: credentialDeps.testHooks } : {}),
      });
    },
  );

  typed.post(
    '/workspaces/:id/provider-connections/:connectionId/rotate',
    {
      schema: {
        tags: ['providers'],
        summary: '轮换凭据（新密文 + 新密钥版本；历史密钥仍可解密旧密文）',
        params: connectionParamsSchema,
        body: rotateConnectionRequestSchema,
        response: { 200: providerConnectionSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      return rotateConnection(domain, {
        workspaceId: request.params.id,
        connectionId: request.params.connectionId,
        newSecret: request.body.secret,
      });
    },
  );

  typed.delete(
    '/workspaces/:id/provider-connections/:connectionId',
    {
      schema: {
        tags: ['providers'],
        summary: '撤销连接（立即从 Router 候选中消失；记录 revoked_at）',
        params: connectionParamsSchema,
        response: { 200: providerConnectionSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      return revokeConnection(domain, { workspaceId: request.params.id, connectionId: request.params.connectionId });
    },
  );

  typed.get(
    '/workspaces/:id/provider-settings',
    {
      schema: {
        tags: ['providers'],
        summary: 'Workspace 级按类别的托管模式设置（AUTOMATIC/PLATFORM_MANAGED/BYOK）',
        params: wsParamsSchema,
        response: { 200: pageResponseSchema(workspaceProviderSettingSchema), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listWorkspaceProviderSettings(domain, { workspaceId: request.params.id });
      return { items, nextCursor: null };
    },
  );

  typed.put(
    '/workspaces/:id/provider-settings/:kind',
    {
      schema: {
        tags: ['providers'],
        summary: '设置某类别的托管模式（BYOK 需指定本 workspace 的 ACTIVE 连接）',
        params: settingParamsSchema,
        body: upsertWorkspaceProviderSettingRequestSchema,
        response: { 200: workspaceProviderSettingSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'provider:manage');
      return upsertWorkspaceProviderSetting(domain, {
        workspaceId: request.params.id,
        kind: request.params.kind,
        selectionMode: request.body.selectionMode,
        connectionId: request.body.connectionId,
      });
    },
  );

  typed.get(
    '/workspaces/:id/provider-route',
    {
      schema: {
        tags: ['providers'],
        summary: 'Router 决策（能力 → Provider/模型/凭据模式；候选被拒原因可审计；不含 Secret）',
        params: wsParamsSchema,
        querystring: z.object({
          capability: z.string().min(1).max(100),
          region: z.string().min(1).max(50).optional(),
        }),
        response: { 200: providerRouteDecisionSchema, 501: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return resolveProviderRoute(domain, {
        workspaceId: request.params.id,
        capability: request.query.capability,
        ...(request.query.region !== undefined ? { region: request.query.region } : {}),
      });
    },
  );
}
