import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  assetDetailSchema,
  assetLifecycleSchema,
  assetPrivacyDeletionResultSchema,
  assetRelinkComparisonSchema,
  assetRelinkResultSchema,
  assetRelinkStateSchema,
  applyAssetRelinkRequestSchema,
  preflightAssetRelinkRequestSchema,
  requestAssetPrivacyDeletionSchema,
  updateAssetRightsRequestSchema,
  assetSchema,
  assetTypeSchema,
  confirmUploadRequestSchema,
  completeUploadPartRequestSchema,
  createUploadIntentRequestSchema,
  downloadUrlResponseSchema,
  mediaPlaybackResponseSchema,
  mediaIndexPageSchema,
  mediaIndexQuerySchema,
  unifiedMediaIndexPageSchema,
  unifiedMediaIndexQuerySchema,
  mediaAnalysisGraphSchema,
  mediaAnalysisStageNameSchema,
  rebuildMediaAnalysisStageRequestSchema,
  mediaRangeTagListSchema,
  mediaRangeTagSchema,
  mediaSegmentSearchQuerySchema,
  mediaSegmentSearchResponseSchema,
  mediaTranscriptSchema,
  createMediaRangeTagRequestSchema,
  correctTranscriptSegmentRequestSchema,
  updateTranscriptTerminologyRequestSchema,
  errorEnvelopeSchema,
  opaqueIdSchema,
  pageResponseSchema,
  uploadIntentResponseSchema,
  uploadIntentStatusSchema,
  uploadPartTargetResponseSchema,
} from '@ancs/contracts';
import {
  confirmUpload,
  cancelUploadIntent,
  completeUploadPart,
  createUploadPartTarget,
  createAssetDownloadUrl,
  createAssetPlaybackUrl,
  createUploadIntent,
  applyAssetRelink,
  getAssetRelinkState,
  preflightAssetRelink,
  getAsset,
  getAssetLifecycle,
  getUploadIntentStatus,
  listAssets,
  restoreAsset,
  rebuildMediaProxy,
  listMediaIndex,
  listUnifiedMediaIndex,
  getMediaAnalysisGraph,
  rebuildMediaAnalysisStage,
  cancelMediaAnalysisStage,
  listMediaRangeTags,
  createMediaRangeTag,
  deleteMediaRangeTag,
  searchMediaSegments,
  rebuildMediaIndex,
  getMediaTranscript,
  retryMediaTranscript,
  correctTranscriptSegment,
  updateTranscriptTerminology,
  softDeleteAsset,
  requestAssetPrivacyDeletion,
  updateAssetRights,
  type DomainDeps,
} from '@ancs/domain';
import type { AuthDeps } from '../plugins/auth.js';
import type { StorageDeps } from '../plugins/storage.js';

/**
 * 资产路由（P02-04 / 规范 §26、§51）。
 *
 * 授权：读取（列表/详情/下载 URL）需 workspace:read；写（上传意图/确认）需 asset:manage
 * （EDITOR 及以上）。所有服务层查询再强制 workspace_id（§4.3 不变量 1/2）。
 */

const wsParamsSchema = z.object({ id: opaqueIdSchema });
const assetParamsSchema = z.object({ id: opaqueIdSchema, assetId: opaqueIdSchema });
const analysisStageParamsSchema = assetParamsSchema.extend({ stage: mediaAnalysisStageNameSchema });
const rangeTagParamsSchema = assetParamsSchema.extend({ tagId: opaqueIdSchema });
const intentParamsSchema = z.object({ id: opaqueIdSchema, intentId: opaqueIdSchema });
const partParamsSchema = intentParamsSchema.extend({ partNumber: z.coerce.number().int().positive() });
const assetListQuerySchema = z.object({
  projectId: opaqueIdSchema.optional(),
  assetType: assetTypeSchema.optional(),
  /** Trash 视图（默认排除已软删资产） */
  trashed: z.enum(['true', 'false']).optional(),
});
const assetListSchema = pageResponseSchema(assetSchema);
const ERROR_RESPONSES = { 401: errorEnvelopeSchema, 403: errorEnvelopeSchema, 404: errorEnvelopeSchema };

export function registerAssetRoutes(app: FastifyInstance, deps: AuthDeps, storage: StorageDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const domain: DomainDeps = { db: deps.db, storage: storage.adapter };

  typed.post(
    '/workspaces/:id/assets/upload-intents',
    {
      schema: {
        tags: ['assets'],
        summary: '创建上传意图（返回带作用域与 TTL 的直传 Signed URL；命中 workspace 哈希去重时不创建对象）',
        params: wsParamsSchema,
        body: createUploadIntentRequestSchema,
        response: {
          201: uploadIntentResponseSchema,
          415: errorEnvelopeSchema,
          501: errorEnvelopeSchema,
          ...ERROR_RESPONSES,
        },
      },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      const result = await createUploadIntent(domain, {
        workspaceId: request.params.id,
        userId: context.userId,
        input: request.body,
      });
      return reply.status(201).send(result);
    },
  );

  typed.get(
    '/workspaces/:id/assets/segment-search',
    {
      schema: {
        tags: ['assets'],
        summary: '按视觉、音频、转写和用户标签检索可播放的真实源片段',
        params: wsParamsSchema,
        querystring: mediaSegmentSearchQuerySchema,
        response: { 200: mediaSegmentSearchResponseSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return searchMediaSegments(domain, { workspaceId: request.params.id, query: request.query.q, limit: request.query.limit });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/range-tags',
    {
      schema: { tags: ['assets'], summary: '读取当前源版本的片段标签', params: assetParamsSchema, response: { 200: mediaRangeTagListSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return listMediaRangeTags(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/range-tags',
    {
      schema: { tags: ['assets'], summary: '为当前源版本添加精确时间片段标签', params: assetParamsSchema, body: createMediaRangeTagRequestSchema, response: { 201: mediaRangeTagSchema, ...ERROR_RESPONSES } },
    },
    async (request, reply) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      const tag = await createMediaRangeTag(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
      return reply.status(201).send(tag);
    },
  );

  typed.delete(
    '/workspaces/:id/assets/:assetId/range-tags/:tagId',
    {
      schema: { tags: ['assets'], summary: '删除当前素材的片段标签', params: rangeTagParamsSchema, response: { 204: z.void(), ...ERROR_RESPONSES } },
    },
    async (request, reply) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      await deleteMediaRangeTag(domain, { workspaceId: request.params.id, assetId: request.params.assetId, tagId: request.params.tagId });
      return reply.status(204).send();
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/transcript',
    {
      schema: { tags: ['assets'], summary: '读取源媒体机器转写及当前校正版本', params: assetParamsSchema, response: { 200: mediaTranscriptSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getMediaTranscript(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/transcript/retry',
    {
      schema: { tags: ['assets'], summary: '为既有音频开始转写，或重试失败/过期的转写；原音不变', params: assetParamsSchema, response: { 200: mediaTranscriptSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return retryMediaTranscript(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.patch(
    '/workspaces/:id/assets/:assetId/transcript/segments',
    {
      schema: { tags: ['assets'], summary: '校正一个转写句段并创建不可变新版本', params: assetParamsSchema, body: correctTranscriptSegmentRequestSchema, response: { 200: mediaTranscriptSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return correctTranscriptSegment(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
    },
  );

  typed.put(
    '/workspaces/:id/assets/:assetId/transcript/terminology',
    {
      schema: { tags: ['assets'], summary: '更新该转写的版本化术语字典', params: assetParamsSchema, body: updateTranscriptTerminologyRequestSchema, response: { 200: mediaTranscriptSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return updateTranscriptTerminology(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/media-index',
    {
      schema: {
        tags: ['assets'],
        summary: '分页读取绑定源 AssetVersion 的缩略、波形、镜头和质量索引',
        params: assetParamsSchema,
        querystring: mediaIndexQuerySchema,
        response: { 200: mediaIndexPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return listMediaIndex(domain, { workspaceId: request.params.id, assetId: request.params.assetId, ...request.query });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/media-index-records',
    {
      schema: {
        tags: ['assets'],
        summary: '统一读取带来源证据、能力覆盖与源时间范围的媒体索引记录',
        params: assetParamsSchema,
        querystring: unifiedMediaIndexQuerySchema,
        response: { 200: unifiedMediaIndexPageSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return listUnifiedMediaIndex(domain, {
        workspaceId: request.params.id,
        assetId: request.params.assetId,
        query: request.query,
      });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/analysis-stages',
    { schema: { tags: ['assets'], summary: '读取素材渐进分析 DAG、检查点和可用性', params: assetParamsSchema, response: { 200: mediaAnalysisGraphSchema, ...ERROR_RESPONSES } } },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getMediaAnalysisGraph(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/analysis-stages/:stage/rebuild',
    { schema: { tags: ['assets'], summary: '仅失效并重建选定分析阶段及其依赖下游', params: analysisStageParamsSchema, body: rebuildMediaAnalysisStageRequestSchema, response: { 200: mediaAnalysisGraphSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES } } },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return rebuildMediaAnalysisStage(domain, { workspaceId: request.params.id, assetId: request.params.assetId, stage: request.params.stage, request: request.body });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/analysis-stages/:stage/cancel',
    { schema: { tags: ['assets'], summary: '协作式取消单个媒体分析阶段', params: analysisStageParamsSchema, response: { 200: mediaAnalysisGraphSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES } } },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return cancelMediaAnalysisStage(domain, { workspaceId: request.params.id, assetId: request.params.assetId, stage: request.params.stage });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/relink-state',
    {
      schema: { tags: ['assets'], summary: '探测素材各版本是否在线及其活动剪辑引用', params: assetParamsSchema, response: { 200: assetRelinkStateSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getAssetRelinkState(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/relink-preflight',
    {
      schema: { tags: ['assets'], summary: '比对缺失版本与候选文件的校验和、时长和轨道', params: assetParamsSchema, body: preflightAssetRelinkRequestSchema, response: { 200: assetRelinkComparisonSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return preflightAssetRelink(domain, { workspaceId: request.params.id, assetId: request.params.assetId, request: request.body });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/relink',
    {
      schema: { tags: ['assets'], summary: '确认恢复精确原件或建立显式替代版本', params: assetParamsSchema, body: applyAssetRelinkRequestSchema, response: { 200: assetRelinkResultSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, 501: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return applyAssetRelink(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/media-index/rebuild',
    {
      schema: {
        tags: ['assets'],
        summary: '重新生成失败、过期或已完成的源媒体索引；不修改原件和代理',
        params: assetParamsSchema,
        response: { 200: mediaIndexPageSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return rebuildMediaIndex(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/upload-intents/:intentId',
    {
      schema: {
        tags: ['assets'],
        summary: '读取可恢复上传意图与已确认分片',
        params: intentParamsSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return getUploadIntentStatus(domain, { workspaceId: request.params.id, intentId: request.params.intentId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/upload-intents/:intentId/parts/:partNumber',
    {
      schema: {
        tags: ['assets'],
        summary: '为单个未确认分片签发短期直传地址',
        params: partParamsSchema,
        response: { 200: uploadPartTargetResponseSchema, 409: errorEnvelopeSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return createUploadPartTarget(domain, {
        workspaceId: request.params.id,
        intentId: request.params.intentId,
        partNumber: request.params.partNumber,
      });
    },
  );

  typed.post(
    '/workspaces/:id/assets/upload-intents/:intentId/parts/:partNumber/complete',
    {
      schema: {
        tags: ['assets'],
        summary: '校验并确认一个上传分片',
        params: partParamsSchema,
        body: completeUploadPartRequestSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return completeUploadPart(domain, {
        workspaceId: request.params.id,
        intentId: request.params.intentId,
        partNumber: request.params.partNumber,
        input: request.body,
      });
    },
  );

  typed.delete(
    '/workspaces/:id/assets/upload-intents/:intentId',
    {
      schema: {
        tags: ['assets'],
        summary: '取消未完成上传并清理已上传分片',
        params: intentParamsSchema,
        response: { 200: uploadIntentStatusSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return cancelUploadIntent(domain, { workspaceId: request.params.id, intentId: request.params.intentId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/confirm',
    {
      schema: {
        tags: ['assets'],
        summary: '确认上传（服务端真实探测：存在性/大小/SHA-256/内容嗅探；重复确认幂等）',
        params: assetParamsSchema,
        body: confirmUploadRequestSchema,
        response: { 200: assetDetailSchema, 409: errorEnvelopeSchema, 415: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return confirmUpload(domain, { workspaceId: request.params.id, assetId: request.params.assetId, input: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/assets',
    {
      schema: {
        tags: ['assets'],
        summary: '资产列表（workspace 内，可按 projectId / assetType 过滤）',
        params: wsParamsSchema,
        querystring: assetListQuerySchema,
        response: { 200: assetListSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      const items = await listAssets(domain, {
        workspaceId: request.params.id,
        projectId: request.query.projectId,
        assetType: request.query.assetType,
        trashed: request.query.trashed === 'true',
      });
      return { items, nextCursor: null };
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: '资产详情（含版本历史；只存 storage_key，不含任何对象 URL）',
        params: assetParamsSchema,
        response: { 200: assetDetailSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/lifecycle',
    {
      schema: { tags: ['assets'], summary: '读取素材权利、引用保护与派生血缘', params: assetParamsSchema, response: { 200: assetLifecycleSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return getAssetLifecycle(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.put(
    '/workspaces/:id/assets/:assetId/rights',
    {
      schema: { tags: ['assets'], summary: '确认来源、允许用途、署名、敏感级别与许可期限', params: assetParamsSchema, body: updateAssetRightsRequestSchema, response: { 200: assetLifecycleSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return updateAssetRights(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/privacy-deletion',
    {
      schema: { tags: ['assets'], summary: '请求隐私删除；存在场景或冻结版本依赖时返回逐项缺失依赖', params: assetParamsSchema, body: requestAssetPrivacyDeletionSchema, response: { 200: assetPrivacyDeletionResultSchema, 422: errorEnvelopeSchema, ...ERROR_RESPONSES } },
    },
    async (request) => {
      const { context } = await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return requestAssetPrivacyDeletion(domain, { workspaceId: request.params.id, assetId: request.params.assetId, userId: context.userId, request: request.body });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/download-url',
    {
      schema: {
        tags: ['assets'],
        summary: '签发下载 Signed URL（短 TTL；不经 API 流式代理大文件，§26.2）',
        params: assetParamsSchema,
        response: { 200: downloadUrlResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return createAssetDownloadUrl(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.get(
    '/workspaces/:id/assets/:assetId/playback-url',
    {
      schema: {
        tags: ['assets'],
        summary: '签发当前可用播放地址（优先标准代理；代理未就绪时仅在原件可直接预览时回退）',
        params: assetParamsSchema,
        response: { 200: mediaPlaybackResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'workspace:read');
      return createAssetPlaybackUrl(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/proxy/rebuild',
    {
      schema: {
        tags: ['assets'],
        summary: '重新生成失败或丢失的编辑代理（原件与 checksum 保持不变）',
        params: assetParamsSchema,
        response: { 200: mediaPlaybackResponseSchema, 409: errorEnvelopeSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return rebuildMediaProxy(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.delete(
    '/workspaces/:id/assets/:assetId',
    {
      schema: {
        tags: ['assets'],
        summary: '软删除资产（Trash，保留 30 天；引用保护由清理流程执行，§27）',
        params: assetParamsSchema,
        response: { 200: assetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return softDeleteAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );

  typed.post(
    '/workspaces/:id/assets/:assetId/restore',
    {
      schema: {
        tags: ['assets'],
        summary: '从 Trash 恢复资产（保留期内）',
        params: assetParamsSchema,
        response: { 200: assetSchema, ...ERROR_RESPONSES },
      },
    },
    async (request) => {
      await app.requireWorkspace(request, request.params.id, 'asset:manage');
      return restoreAsset(domain, { workspaceId: request.params.id, assetId: request.params.assetId });
    },
  );
}
