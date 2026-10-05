import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addVoiceSampleRequestSchema,
  confirmVoiceConsentRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  submitVoiceCloneRequestSchema,
  voiceCloneSampleSchema,
  voiceCloneSchema,
  voiceCloneStateSchema,
  voiceConsentSchema,
  type VoiceCloneProvider,
} from '@ancs/contracts';
import {
  addVoiceSample,
  confirmVoiceConsent,
  deleteVoiceCloneAtProvider,
  getVoiceCloneState,
  listVoiceSamples,
  refreshVoiceClone,
  retireVoiceClone,
  retryVoiceClone,
  revokeVoiceConsent,
  submitVoiceClone,
  unlinkVoiceClone,
  VOICE_CONSENT_STATEMENT,
  VOICE_CONSENT_STATEMENT_VERSION,
  voiceConsentStatementHash,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';

/**
 * Voice Clone 路由（P10-02 / §6.2、§14.3、§20.x、§95）。
 *
 * 流程（与规范 §6.2 一致）：录制/上传样本（经资产链路）→ 音质检测 → **Consent** → 提交（Instant/Professional）
 * → 状态刷新（训练）→ READY（绑定 VoiceIdentity）→ 试听/默认 Speech Profile（既有链路）。
 * 生命周期三态：retire（本地）/ unlink（平台解绑）/ delete-provider-voice（Provider 删除）——**可区分**。
 *
 * 能力：写入 project:write（样本/Consent/提交），读取 project:read。全部经统一授权入口。
 */

const identityParamsSchema = z.object({ id: opaqueIdSchema, creatorIdentityId: opaqueIdSchema });
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema };

export interface VoiceCloneRouteDeps {
  /** 声音克隆适配器（未配置 → 提交/刷新/删除 501 fail-closed；Mock 同构用于验收） */
  provider?: VoiceCloneProvider;
  /** 对象存储（读取样本字节做质量检测；未配置 → 样本登记 500 明确失败） */
  storage?: import('@ancs/contracts').ObjectStorageAdapter;
}

export function registerVoiceCloneRoutes(app: FastifyInstance, deps: AuthDeps, voiceDeps: VoiceCloneRouteDeps = {}): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, ...(voiceDeps.storage !== undefined ? { storage: voiceDeps.storage } : {}) };

  typed.get(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '克隆状态（clone + 样本 + Consent + 是否绑定 VoiceIdentity）',
        params: identityParamsSchema,
        response: { 200: voiceCloneStateSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return getVoiceCloneState(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId });
    },
  );

  typed.get(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/consent-statement',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '授权声明文本与版本/哈希（Consent 确认前展示；可核对）',
        params: identityParamsSchema,
        response: { 200: z.object({ version: z.string(), statement: z.string(), statementHash: z.string() }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      return { version: VOICE_CONSENT_STATEMENT_VERSION, statement: VOICE_CONSENT_STATEMENT, statementHash: voiceConsentStatementHash() };
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/samples',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '登记样本（引用已上传资产版本；WAV PCM16）→ 音质检测（时长/静音/削波/有效语音）',
        params: identityParamsSchema,
        body: addVoiceSampleRequestSchema,
        response: { 201: voiceCloneSampleSchema, ...ERROR_RESPONSES },
      },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      const sample = await addVoiceSample(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, request: request.body });
      return reply.status(201).send(sample);
    },
  );

  typed.get(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/samples',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '样本列表（含质量报告；不合格样本保留可复核）',
        params: identityParamsSchema,
        response: { 200: z.object({ items: z.array(voiceCloneSampleSchema) }), ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:read');
      const items = await listVoiceSamples(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId });
      return { items };
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/consent',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '确认授权声明（SELF / AUTHORIZED_OTHER；记录版本 + 文本哈希）——未授权不提交的凭据',
        params: identityParamsSchema,
        body: confirmVoiceConsentRequestSchema,
        response: { 200: voiceConsentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return confirmVoiceConsent(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, request: request.body, actorUserId: context.userId });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/consent/revoke',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '撤销授权（此后不再发起新的克隆/训练；历史保留可审计引用）',
        params: identityParamsSchema,
        response: { 200: voiceConsentSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return revokeVoiceConsent(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/submit',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '提交克隆（INSTANT → READY；PROFESSIONAL → SUBMITTED→TRAINING）；**未授权/无合格样本 422**',
        params: identityParamsSchema,
        body: submitVoiceCloneRequestSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'project:write');
      return submitVoiceClone(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, request: request.body, actorUserId: context.userId, provider: voiceDeps.provider });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/refresh',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '刷新训练状态（SUBMITTED/TRAINING → TRAINING/READY/FAILED(retryable)）',
        params: identityParamsSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return refreshVoiceClone(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, provider: voiceDeps.provider });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/retry',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '重试（仅 FAILED 且 retryable；样本与 Consent 保留）——训练失败可恢复',
        params: identityParamsSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return retryVoiceClone(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, provider: voiceDeps.provider });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/retire',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '本地退休（不再作为默认；**Provider 侧声音保留**——与解绑/删除可区分）',
        params: identityParamsSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return retireVoiceClone(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/unlink',
    {
      schema: {
        tags: ['voice-clone'],
        summary: '平台解绑（断开与 Creator Identity 的关联；Provider 侧声音保留）',
        params: identityParamsSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return unlinkVoiceClone(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId });
    },
  );

  typed.post(
    '/workspaces/:id/creator-identities/:creatorIdentityId/voice-clone/delete-provider-voice',
    {
      schema: {
        tags: ['voice-clone'],
        summary: 'Provider 侧删除（不可恢复；与本地退休/解绑可区分）',
        params: identityParamsSchema,
        response: { 200: voiceCloneSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'project:write');
      return deleteVoiceCloneAtProvider(domain, { workspaceId: request.params.id, creatorIdentityId: request.params.creatorIdentityId, provider: voiceDeps.provider });
    },
  );
}
