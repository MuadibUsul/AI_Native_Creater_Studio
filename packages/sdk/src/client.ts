import { z, type ZodType } from 'zod';
import { jobSchema as jobSchemaForGeneration } from '@ancs/contracts';

/** 显式生成动作响应（P06-05；SDK 侧组合，避免为组合结构新增契约） */
const sceneGenerationResponseSchema = z.object({
  job: jobSchemaForGeneration,
  deduped: z.boolean(),
  providerRoute: z.object({ providerId: z.string(), modelId: z.string(), credentialMode: z.string(), reason: z.string() }),
});

import {
  channelStyleVersionSchema,
  channelWithStyleSchema,
  createChannelRequestSchema,
  createCreatorIdentityRequestSchema,
  assetDetailSchema,
  assetSchema,
  billingStatusSchema,
  catalogResponseSchema,
  chartBindingCheckSchema,
  claimRecordSchema,
  citationRecordSchema,
  contentDocumentRecordSchema,
  contentSourceSchema,
  createDatasetRequestSchema,
  datasetRecordSchema,
  extractionResultSchema,
  factVisualDecisionSchema,
  narrationBlockSchema,
  directorApplyRequestSchema,
  createEditPlanRequestSchema,
  createRenderRequestSchema,
  directorPlanSchema,
  renderRecordSchema,
  customMotionComponentSchema,
  qaReportSchema,
  renderApprovalSchema,
  exportPackageSchema,
  opsOverviewSchema,
  opsAuditEntrySchema,
  editPlanSchema,
  masterNarrationSchema,
  mixPlanRequestSchema,
  mixPlanSchema,
  subtitleOutputSchema,
  narrativeGenerationResultSchema,
  narrativePlanSchema,
  speechPlanSchema,
  visualPlanSchema,
  updateNarrationBlockRequestSchema,
  createContentRequestSchema,
  updateSourceRequestSchema,
  capabilitySelectionSchema,
  creditHoldSchema,
  ledgerEntrySchema,
  providerGenerationSchema,
  rebindExternalResultRequestSchema,
  topUpRequestSchema,
  upsertBudgetRequestSchema,
  workspaceBudgetSchema,
  createConnectionRequestSchema,
  providerConnectionSchema,
  providerRouteDecisionSchema,
  rotateConnectionRequestSchema,
  testConnectionResponseSchema,
  upsertWorkspaceProviderSettingRequestSchema,
  workspaceProviderSettingSchema,
  eventCursorSchema,
  jobSchema,
  notificationSchema,
  unreadCountResponseSchema,
  workspaceEventSchema,
  createProjectRequestSchema,
  createProjectVersionRequestSchema,
  createUploadIntentRequestSchema,
  confirmUploadRequestSchema,
  downloadUrlResponseSchema,
  uploadIntentResponseSchema,
  createSceneRequestSchema,
  createSceneResponseSchema,
  editRequestSchema,
  editResponseSchema,
  createSpeechProfileRequestSchema,
  createWorkspaceRequestSchema,
  creatorIdentitySchema,
  healthResponseSchema,
  nativeAuthorizeQuerySchema,
  pageResponseSchema,
  projectDetailSchema,
  projectSchema,
  projectVersionDetailSchema,
  projectVersionSchema,
  revokeTokenRequestSchema,
  sceneGraphSchema,
  sessionInfoSchema,
  signInRequestSchema,
  signInResponseSchema,
  speechProfileSchema,
  tokenRequestSchema,
  tokenResponseSchema,
  updateChannelRequestSchema,
  updateCreatorIdentityRequestSchema,
  updateSpeechProfileRequestSchema,
  updateWorkspaceMemberRoleRequestSchema,
  updateWorkspaceRequestSchema,
  addWorkspaceMemberRequestSchema,
  workspaceMemberSchema,
  workspaceWithRoleSchema,
  workspaceEntitlementSchema,
  planSchema,
  assignPlanRequestSchema,
  workspaceSubscriptionSchema,
  billingStateSchema,
  createCheckoutRequestSchema,
  creditPackSchema,
  creditStatementSchema,
  creditReconcileSchema,
  buyCreditsRequestSchema,
  grantCreditsRequestSchema,
  refundCreditRequestSchema,
  workspaceInvitationSchema,
  myInvitationSchema,
  voiceCloneSchema,
  voiceCloneSampleSchema,
  voiceCloneStateSchema,
  voiceConsentSchema,
  stockSearchResultSchema,
  stockAcquisitionResultSchema,
  searchResponseSchema,
  graphExportSchema,
  assetBundleExportSchema,
  contentCoreMigrationSchema,
  contentCoreStateSchema,
  contentAtomSchema,
  createAtomRequestSchema,
  workspacePackViewSchema,
  packAnalyzeResultSchema,
  packArtifactViewSchema,
  packArtifactListSchema,
  artifactValidationResultSchema,
  derivationListSchema,
  derivationListItemSchema,
  approveDerivationRequestSchema,
  channelRecipeSchema,
  channelFitSchema,
  renderOutputEnhancementsSchema,
  addVoiceSampleRequestSchema,
  confirmVoiceConsentRequestSchema,
  submitVoiceCloneRequestSchema,
  abuseFlagSchema,
  createAbuseFlagRequestSchema,
  resolveAbuseFlagRequestSchema,
  setWorkspaceAbuseStateRequestSchema,
  workspaceAbuseStateSchema,
  supportAccessGrantSchema,
  createSupportGrantRequestSchema,
  supportViewSchema,
  auditLogEntrySchema,
  adminUserSummarySchema,
  adminWorkspaceSummarySchema,
  adminProjectSummarySchema,
  adminProviderStatusSchema,
  adminStorageSummarySchema,
  createInvitationRequestSchema,
  setPrivacyTierRequestSchema,
  type ClientType,
  type HealthResponse,
  type SessionInfo,
  type SignInResponse,
  type SpeechProfile,
  type TokenResponse,
  type WorkspaceMember,
  type WorkspaceWithRole,
  type WorkspaceInvitation,
  type MyInvitation,
  type VoiceClone,
  type VoiceCloneSample,
  type VoiceCloneState,
  type VoiceConsent,
  type StockSearchResult,
  type StockAcquisitionResult,
  type SearchResponse,
  type GraphExport,
  type AssetBundleExport,
  type ContentCoreMigration,
  type ContentCoreState,
  type ContentAtom,
  type ChannelRecipe,
  type ChannelFit,
  type WorkspacePackView,
  type PackAnalyzeResult,
  type PackArtifactView,
  type ArtifactValidationResult,
  type DerivationList,
  type DerivationListItem,
  type RenderOutputEnhancements,
  type AbuseFlag,
  type WorkspaceAbuseState,
  type SupportAccessGrant,
  type SupportView,
  type AuditLogEntry,
  type AdminUserSummary,
  type AdminWorkspaceSummary,
  type AdminProjectSummary,
  type AdminProviderStatus,
  type AdminStorageSummary,
  type PrivacyTier,
  type ChannelWithStyle,
  type ChannelStyleVersion,
  type CreateSceneResponse,
  type CreatorIdentity,
  type EditRequest,
  type EditResponse,
  type Asset,
  type AssetDetail,
  type BillingStatus,
  type CatalogResponse,
  type ChartBindingCheck,
  type ClaimRecord,
  type CitationRecord,
  type ContentDocumentRecord,
  type ContentSource,
  type CreateDatasetRequest,
  type DatasetRecord,
  type ExtractionResult,
  type FactVisualDecision,
  type NarrationBlock,
  type NarrativeGenerationResult,
  type CreateRenderRequest,
  type DirectorPlan,
  type RenderRecord,
  type CustomMotionComponent,
  type QaReport,
  type Plan,
  type PlanKey,
  type WorkspaceEntitlement,
  type WorkspaceSubscription,
  type BillingState,
  type CreditPack,
  type CreditStatement,
  type CreditReconcile,
  type LedgerEntry,
  type RenderApproval,
  type ExportPackage,
  type OpsOverview,
  type OpsAuditEntry,
  type RenderStatus,
  type EditPlan,
  type DirectorPolicyInput,
  type MasterNarration,
  type MixPlan,
  type MixPlanRequest,
  type SubtitleFormat,
  type SubtitleOutput,
  type NarrativePlan,
  type SpeechPlan,
  type VisualPlan,
  type CreateContentRequest,
  type UpdateSourceRequest,
  type CapabilitySelection,
  type CreditHold,
  type ProviderGeneration,
  type RebindExternalResultRequest,
  type WorkspaceBudget,
  type ProviderConnection,
  type ProviderRouteDecision,
  type TestConnectionResponse,
  type WorkspaceProviderSetting,
  type EventCursor,
  type Job,
  type Notification,
  type WorkspaceEvent,
  type ConfirmUploadRequest,
  type CreateUploadIntentInput,
  type DownloadUrlResponse,
  type Project,
  type ProjectDetail,
  type ProjectVersion,
  type ProjectVersionDetail,
  type SceneGraph,
  type UploadIntentResponse,
} from '@ancs/contracts';

/**
 * ANCS SDK（P01-05 基线）：
 * - 与 API 共享同一份契约（REQ-29-04：不手写第二套类型）；
 * - 双认证模式：Web/桌面 Cookie 会话（credentials:'include'，非浏览器环境由内置
 *   cookie jar 承载）与原生 Access Token（getAccessToken → Authorization: Bearer）；
 * - 自动携带客户端标头 X-Client-Type / X-Client-Version（规范 §29.3）；
 * - 写操作支持 Idempotency-Key（§33 / §4.6）；
 * - 提供原生 PKCE 助手（generatePkcePair）与授权/令牌/撤销调用。
 */

export class AncsApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string;
  readonly details: Record<string, unknown>;

  constructor(params: {
    status: number;
    code: string;
    message: string;
    requestId: string;
    details: Record<string, unknown>;
  }) {
    super(params.message);
    this.name = 'AncsApiError';
    this.status = params.status;
    this.code = params.code;
    this.requestId = params.requestId;
    this.details = params.details;
  }
}

export interface ClientOptions {
  /** 例：https://api.example.com（自动去除尾斜杠） */
  baseUrl: string;
  /** 测试注入用；默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 规范 §29.3 的客户端类型；默认 'web' */
  clientType?: ClientType;
  clientVersion?: string;
  /** Cookie 模式（默认 'include'）；纯 Bearer 客户端建议 'omit' */
  credentials?: CredentialsMode;
  /** 原生/Bearer 模式：返回当前 Access Token（null 表示未登录） */
  getAccessToken?: () => string | null | Promise<string | null>;
}

/** fetch 凭据模式（避免依赖 DOM lib 类型；与运行时语义一致） */
export type CredentialsMode = 'include' | 'omit' | 'same-origin';

/** 写操作选项：幂等键（同键同请求返回原结果） */
export interface MutationOptions {
  idempotencyKey?: string;
}

export interface AuthorizeResult {
  /** 重定向地址（原样返回，便于客户端按环境打开浏览器） */
  location: string;
  code: string | null;
  state: string | null;
  error: string | null;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

const base64UrlEncode = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/** 生成 PKCE（S256）校验对（原生客户端第一步；Web 端亦可使用）。 */
export async function generatePkcePair(): Promise<PkcePair> {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const verifier = base64UrlEncode(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)), method: 'S256' };
}

export interface AncsClient {
  health(): Promise<HealthResponse>;
  auth: {
    signIn(input: { email: string; password: string }): Promise<SignInResponse>;
    signOut(): Promise<void>;
    session(): Promise<SessionInfo>;
    authorize(input: {
      clientId: string;
      redirectUri: string;
      codeChallenge: string;
      state: string;
    }): Promise<AuthorizeResult>;
    token(input: import('@ancs/contracts').TokenRequest): Promise<TokenResponse>;
    revoke(input: { clientId: string; refreshToken: string }): Promise<void>;
  };
  /** Pack 运行时（P11-03；安装→启用→绑定→analyze 四段；权益白名单强制） */
  packs: {
    list(workspaceId: string): Promise<WorkspacePackView[]>;
    enable(workspaceId: string, packId: string, options?: MutationOptions): Promise<{ packId: string; version: string; enabledAt: string }>;
    disable(workspaceId: string, packId: string, options?: MutationOptions): Promise<void>;
    bind(workspaceId: string, projectId: string, packId: string, options?: MutationOptions): Promise<{ projectId: string; packId: string; version: string; boundAt: string }>;
    analyze(workspaceId: string, projectId: string, packId: string, options?: MutationOptions): Promise<PackAnalyzeResult>;
    /** 生成派生产物（P12-01；须先 analyze——血缘锚；产物只追加，不写回源项目） */
    generate(workspaceId: string, projectId: string, packId: string, options?: MutationOptions): Promise<PackArtifactView>;
    artifacts: {
      list(workspaceId: string, projectId: string): Promise<PackArtifactView[]>;
      validate(workspaceId: string, projectId: string, artifactId: string, options?: MutationOptions): Promise<ArtifactValidationResult>;
    };
  };
  /** 工作区搜索（P10-06；租户内 + 排除软删；kinds 可选过滤） */
  search(workspaceId: string, input: { q: string; kinds?: string[]; limit?: number }): Promise<SearchResponse>;
  workspaces: {
    create(input: { name: string }, options?: MutationOptions): Promise<WorkspaceWithRole>;
    list(): Promise<WorkspaceWithRole[]>;
    get(workspaceId: string): Promise<WorkspaceWithRole>;
    /** 当前权益 + 实时用量（P09-01；成员可读） */
    entitlements(workspaceId: string): Promise<WorkspaceEntitlement>;
    /** Scene Graph 导出（P10-06；可移植 JSON，无 URL/Secret） */
    graphExport(workspaceId: string, projectId: string): Promise<GraphExport>;
    /** 原素材 Bundle（清单 + 逐件签名 URL；缺权素材明确列出） */
    assetBundle(workspaceId: string, projectId: string): Promise<AssetBundleExport>;
    /** 发起结账（P09-02；返回渠道结账页 URL——**成功页返回不代表入账**） */
    checkout(workspaceId: string, input: { planKey: PlanKey; successUrl?: string; cancelUrl?: string }, options?: MutationOptions): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }>;
    /** 收款状态与事件审计（含 DUPLICATE/OUT_OF_ORDER） */
    billing(workspaceId: string): Promise<{ state: BillingState; plan: Plan | null; events: { id: string; providerEventId: string; type: string; outcome: string; occurredAt: string; receivedAt: string }[] }>;
    /** 账单入口（渠道客户门户；未配置 → 501） */
    billingPortal(workspaceId: string): Promise<{ portalUrl: string }>;
    /** Credits 包目录（P09-03；版本化，价格为数据） */
    creditPacks(workspaceId: string): Promise<CreditPack[]>;
    /** 购买 Credits（返回渠道结账页 URL——**网页跳转不入账**） */
    buyCredits(workspaceId: string, input: { packCode: string }, options?: MutationOptions): Promise<{ checkoutUrl: string; providerSubscriptionRef: string | null }>;
    /** Credits 账单（余额 + 预扣 + 明细） */
    creditStatement(workspaceId: string): Promise<CreditStatement>;
    /** Credits 对账（收款事件 ↔ 账本；不一致 = 明确 false） */
    reconcileCredits(workspaceId: string): Promise<CreditReconcile>;
    update(workspaceId: string, input: { name: string }, options?: MutationOptions): Promise<WorkspaceWithRole>;
    members: {
      list(workspaceId: string): Promise<WorkspaceMember[]>;
      add(
        workspaceId: string,
        input: { email: string; role: WorkspaceMember['role'] },
        options?: MutationOptions,
      ): Promise<WorkspaceMember>;
      updateRole(
        workspaceId: string,
        userId: string,
        input: { role: WorkspaceMember['role'] },
        options?: MutationOptions,
      ): Promise<WorkspaceMember>;
      remove(workspaceId: string, userId: string, options?: MutationOptions): Promise<void>;
    };
    /** 邀请（P09-04；接受时邮箱匹配 + 权威席位检查） */
    invitations: {
      list(workspaceId: string): Promise<WorkspaceInvitation[]>;
      create(workspaceId: string, input: { email: string; role: WorkspaceMember['role'] }, options?: MutationOptions): Promise<WorkspaceInvitation>;
      revoke(workspaceId: string, invitationId: string, options?: MutationOptions): Promise<WorkspaceInvitation>;
    };
    /** 隐私档位（P09-04 / §20.4；非 STANDARD 需套餐权益 privacyMode） */
    setPrivacyTier(workspaceId: string, input: { privacyTier: PrivacyTier }, options?: MutationOptions): Promise<WorkspaceWithRole>;
  };
  /** 我的邀请（含接受的 Workspace 上下文） */
  invitations: {
    mine(): Promise<MyInvitation[]>;
    accept(invitationId: string, options?: MutationOptions): Promise<{ workspace: WorkspaceWithRole; invitation: WorkspaceInvitation }>;
  };
  channels: {
    create(workspaceId: string, input: Record<string, unknown>, options?: MutationOptions): Promise<ChannelWithStyle>;
    list(workspaceId: string): Promise<ChannelWithStyle[]>;
    get(workspaceId: string, channelId: string): Promise<ChannelWithStyle>;
    update(
      workspaceId: string,
      channelId: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ): Promise<ChannelWithStyle>;
    styleVersions(workspaceId: string, channelId: string): Promise<ChannelStyleVersion[]>;
  };
  creatorIdentities: {
    create(workspaceId: string, input: { displayName: string }, options?: MutationOptions): Promise<CreatorIdentity>;
    list(workspaceId: string): Promise<CreatorIdentity[]>;
    get(workspaceId: string, creatorIdentityId: string): Promise<CreatorIdentity>;
    update(
      workspaceId: string,
      creatorIdentityId: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ): Promise<CreatorIdentity>;
  };
  /** Voice Clone（P10-02 / §6.2）：样本→音质检测→Consent→提交→状态→三态生命周期 */
  voiceClone: {
    state(workspaceId: string, creatorIdentityId: string): Promise<VoiceCloneState>;
    consentStatement(workspaceId: string, creatorIdentityId: string): Promise<{ version: string; statement: string; statementHash: string }>;
    addSample(workspaceId: string, creatorIdentityId: string, input: { assetId: string; assetVersionId: string; kind?: 'INSTANT' | 'PROFESSIONAL' }, options?: MutationOptions): Promise<VoiceCloneSample>;
    samples(workspaceId: string, creatorIdentityId: string): Promise<VoiceCloneSample[]>;
    confirmConsent(
      workspaceId: string,
      creatorIdentityId: string,
      input: { subjectType: 'SELF' | 'AUTHORIZED_OTHER'; notes?: string },
      options?: MutationOptions,
    ): Promise<VoiceConsent>;
    revokeConsent(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceConsent>;
    submit(
      workspaceId: string,
      creatorIdentityId: string,
      input: { kind: 'INSTANT' | 'PROFESSIONAL'; provider: string; mode: 'MANAGED' | 'BYOK'; retentionPolicy?: string; ownershipMetadata?: Record<string, unknown> },
      options?: MutationOptions,
    ): Promise<VoiceClone>;
    refresh(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceClone>;
    retry(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceClone>;
    retire(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceClone>;
    unlink(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceClone>;
    deleteProviderVoice(workspaceId: string, creatorIdentityId: string, options?: MutationOptions): Promise<VoiceClone>;
  };
  /** 素材搜索/获取（P10-03 / §84；许可状态随结果返回；获取前服务端复核） */
  stock: {
    search(
      workspaceId: string,
      query?: { query?: string; kind?: 'IMAGE' | 'VIDEO' | 'MUSIC'; usableOnly?: boolean; limit?: number },
    ): Promise<{ providerId: string; items: StockSearchResult[] }>;
    acquire(workspaceId: string, input: { providerAssetId: string; projectId?: string }, options?: MutationOptions): Promise<StockAcquisitionResult>;
  };
  speechProfiles: {
    create(workspaceId: string, input: Record<string, unknown>, options?: MutationOptions): Promise<SpeechProfile>;
    list(workspaceId: string): Promise<SpeechProfile[]>;
    get(workspaceId: string, speechProfileId: string): Promise<SpeechProfile>;
    update(
      workspaceId: string,
      speechProfileId: string,
      input: Record<string, unknown>,
      options?: MutationOptions,
    ): Promise<SpeechProfile>;
  };
  projects: {
    create(
      workspaceId: string,
      input: { title: string; channelId: string; sourceType?: string; aspectRatio?: string; targetDurationMs?: number },
      options?: MutationOptions,
    ): Promise<ProjectDetail>;
    list(workspaceId: string, query?: { trashed?: boolean }): Promise<Project[]>;
    /** 软删除（Trash，保留 30 天；§27） */
    delete(projectId: string, options?: MutationOptions): Promise<Project>;
    /** 从 Trash 恢复（保留期内） */
    restore(projectId: string, options?: MutationOptions): Promise<Project>;
    get(projectId: string): Promise<ProjectDetail>;
    /** 组装后的 SceneGraph（由服务端规范化状态生成并通过契约校验） */
    graph(projectId: string): Promise<SceneGraph>;
    /** 渲染前预检（P07-05；项目当前状态，只读） */
    renderPrecheck(projectId: string): Promise<QaReport>;
    addScene(projectId: string, input: Record<string, unknown>, options?: MutationOptions): Promise<CreateSceneResponse>;
    /** 显式生成场景素材（P06-05）：去重键防双击；输入最小化；越界/能力缺失明确阻止 */
    generateScene(
      projectId: string,
      sceneId: string,
      input?: { capability?: string },
      options?: MutationOptions,
    ): Promise<{ job: Job; deduped: boolean; providerRoute: { providerId: string; modelId: string; credentialMode: string; reason: string } }>;
    /** 统一编辑协议（§4.6）：条件更新 + EditEvent/Outbox；冲突返回 409 VERSION_CONFLICT */
    edit(projectId: string, editRequest: EditRequest, options?: MutationOptions): Promise<EditResponse>;
    versions: {
      /** 建立不可变快照（MANUAL / AI_REDIRECT / FINAL_RENDER / PUBLISH） */
      create(
        projectId: string,
        input: { reason: 'MANUAL' | 'AI_REDIRECT' | 'FINAL_RENDER' | 'PUBLISH'; note?: string },
        options?: MutationOptions,
      ): Promise<ProjectVersion>;
      list(projectId: string): Promise<ProjectVersion[]>;
      /** 版本详情（含快照本体） */
      get(projectId: string, versionId: string): Promise<ProjectVersionDetail>;
    };
    /** 撤销最近一次编辑（补偿事件；恢复产生新 revision，历史不改写） */
    undo(projectId: string, options?: MutationOptions): Promise<EditResponse>;
    /** 重做最近一次撤销（LIFO；新编辑结束重做分支，§4.8） */
    redo(projectId: string, options?: MutationOptions): Promise<EditResponse>;
  };
  assets: {
    /** 上传意图：返回带作用域与 TTL 的直传 Signed URL（命中 workspace 哈希去重时为 deduped） */
    createUploadIntent(
      workspaceId: string,
      input: CreateUploadIntentInput,
      options?: MutationOptions,
    ): Promise<UploadIntentResponse>;
    /** 确认上传（服务端真实探测；重复确认幂等） */
    confirm(workspaceId: string, assetId: string, input: ConfirmUploadRequest, options?: MutationOptions): Promise<AssetDetail>;
    list(workspaceId: string, query?: { projectId?: string; assetType?: string; trashed?: boolean }): Promise<Asset[]>;
    /** 软删除资产（Trash，保留 30 天；引用保护由清理流程执行） */
    delete(workspaceId: string, assetId: string, options?: MutationOptions): Promise<Asset>;
    /** 从 Trash 恢复资产 */
    restore(workspaceId: string, assetId: string, options?: MutationOptions): Promise<Asset>;
    get(workspaceId: string, assetId: string): Promise<AssetDetail>;
    /** 下载 Signed URL（短 TTL；不经 API 流式代理） */
    downloadUrl(workspaceId: string, assetId: string): Promise<DownloadUrlResponse>;
    /**
     * 一体化上传：意图（客户端预计算 SHA-256 以支持去重）→ 直传 → 确认。
     * 命中去重时直接返回既有资产（不重复上传字节）。
     */
    upload(
      workspaceId: string,
      input: {
        assetType: CreateUploadIntentInput['assetType'];
        filename: string;
        contentType: string;
        data: Uint8Array;
        projectId?: string;
        sceneId?: string;
        license?: CreateUploadIntentInput['license'];
        /** 无法服务端解析的媒体元数据（可探测字段以服务端探测为准） */
        durationMs?: number;
        width?: number;
        height?: number;
      },
      options?: MutationOptions,
    ): Promise<AssetDetail>;
  };
  events: {
    /** 游标快照（headSeq；从 head 起仅收新事件） */
    cursor(workspaceId: string): Promise<EventCursor>;
    /** 按游标拉取事件（断线恢复原语；cursor=0 全量重放；超出 head → 409 CURSOR_AHEAD） */
    list(workspaceId: string, options?: { cursor?: number; limit?: number }): Promise<{ events: WorkspaceEvent[]; headSeq: number }>;
    /**
     * SSE 订阅（异步迭代器）：`for await (const event of client.events.subscribe(id, {cursor})) { … }`
     * 断线后可用最后收到的 seq 作为 cursor 重连续传。
     */
    subscribe(
      workspaceId: string,
      options?: { cursor?: number; signal?: AbortSignal },
    ): AsyncGenerator<WorkspaceEvent, void, unknown>;
  };
  /** 派生血缘（P11-04；只追加；stale 过期提示不覆盖已批准行；approve 可绑定产出项目版本） */
  derivations: {
    list(workspaceId: string, projectId: string): Promise<DerivationList>;
    approve(
      workspaceId: string,
      projectId: string,
      lineageId: string,
      options?: MutationOptions & { projectVersionId?: string | null },
    ): Promise<DerivationListItem>;
  };
  content: {
    /** 输入归一化：URL 文章 / 粘贴正文 / 手写脚本 → ContentDocument（API 路径含 workspace） */
    create(
      workspaceId: string,
      projectId: string,
      input: CreateContentRequest,
      options?: MutationOptions,
    ): Promise<ContentDocumentRecord>;
    /** 文档导入（P10-01）：Markdown/PDF/DOCX/EML/HTML 字节 → ContentDocument（服务端写入前扫描+解析） */
    importDocument(
      workspaceId: string,
      projectId: string,
      input: { filename: string; contentType: string; data: Uint8Array },
      options?: MutationOptions,
    ): Promise<ContentDocumentRecord>;
    list(workspaceId: string, projectId: string): Promise<ContentDocumentRecord[]>;
    get(workspaceId: string, projectId: string, documentId: string): Promise<ContentDocumentRecord>;
    sources(workspaceId: string, projectId: string): Promise<ContentSource[]>;
    /** Content Atom（P11-02）：可独立传播单元（来源引用强制可追溯） */
    atoms: {
      create(
        workspaceId: string,
        projectId: string,
        input: { kind: 'KEY_NUMBER' | 'CONCLUSION' | 'CAUSAL_RELATION' | 'QUESTION_ANSWER' | 'TIMELINE_SPAN' | 'IMPACT' | 'SUB_TOPIC'; title: string; text: string; sourceRefs: { claimId?: string | null; sourceId?: string | null }[]; payload?: Record<string, unknown> },
        options?: MutationOptions,
      ): Promise<ContentAtom>;
      list(workspaceId: string, projectId: string): Promise<ContentAtom[]>;
    };
    /** Channel Recipe 目录（版本化需求） */
    channelRecipes: {
      list(workspaceId: string): Promise<ChannelRecipe[]>;
    };
    /** Channel Fit（规则化评估；NOT_RECOMMENDED 为 200 正常结果 + 逐条原因） */
    channelFit(workspaceId: string, projectId: string, channelKey: string): Promise<ChannelFit>;
    /** Content Core（P11-01）：幂等迁移（1:1 派生；原文档保留）+ 状态（实时计数对照） */
    contentCore: {
      migrate(workspaceId: string, projectId: string, options?: MutationOptions): Promise<ContentCoreMigration>;
      state(workspaceId: string, projectId: string): Promise<ContentCoreState>;
    };
    /** Sources 编辑：仅元数据（内容与哈希是快照事实） */
    updateSource(
      workspaceId: string,
      projectId: string,
      sourceId: string,
      input: UpdateSourceRequest,
      options?: MutationOptions,
    ): Promise<ContentSource>;
  };
  narrative: {
    /** 生成叙事计划（结构化 + 有限修复 + 锁定保留 + 口语化门控） */
    generate(
      workspaceId: string,
      projectId: string,
      documentId: string,
      input: { targetDurationMs: number; tone?: string | null; audience?: string | null; platform?: string | null },
      options?: MutationOptions,
    ): Promise<NarrativeGenerationResult>;
    /** 当前计划（无则 null） */
    current(workspaceId: string, projectId: string): Promise<NarrativePlan | null>;
    /** 版本列表（revision 降序） */
    plans(workspaceId: string, projectId: string): Promise<NarrativePlan[]>;
    /** 视觉计划（§10 语义识别 + 场景映射 + §10.3 降级；纯投影可重复） */
    visualPlan(workspaceId: string, projectId: string, planId: string): Promise<VisualPlan>;
    /** SpeechPlan（§94：供应商无关的角色/语速/能量/停顿/强调/发音覆盖） */
    speechPlan(
      workspaceId: string,
      projectId: string,
      planId: string,
      options?: { identityId?: string; speechProfileId?: string },
    ): Promise<SpeechPlan>;
    /** 合成 Master Narration（P06-03）：逐段 TTS + 时间戳 → 拼接 + Alignment/cues；onlyBlockId = 局部重建 */
    synthesizeMasterNarration(
      workspaceId: string,
      projectId: string,
      planId: string,
      input?: { onlyBlockId?: string },
      options?: MutationOptions,
    ): Promise<MasterNarration>;
    /** 当前 Master Narration（含 Alignment；无则 null） */
    masterNarration(workspaceId: string, projectId: string, planId: string): Promise<MasterNarration | null>;
    /** 字幕输出（P06-06）：SRT/VTT（由 Alignment 派生；样式可覆盖） */
    subtitles(
      workspaceId: string,
      projectId: string,
      planId: string,
      options?: { format?: SubtitleFormat; style?: Record<string, unknown> },
    ): Promise<SubtitleOutput>;
    /** 混音计划（P06-06）：非旁白轨 + ducking/淡入淡出（纯计算，不调用 TTS） */
    mixPlan(workspaceId: string, projectId: string, planId: string, request: MixPlanRequest): Promise<MixPlan>;
    /** AI Edit 计划（P05-06）：自然语言 → 结构化 operation（不落库；Apply 走编辑协议） */
    aiEditPlan(
      workspaceId: string,
      projectId: string,
      input: { prompt: string },
      options?: MutationOptions,
    ): Promise<EditPlan>;
    /** Director 计划（§9：场景/资产/任务/成本/告警/决策摘要；不落库、需验证后应用） */
    directorPlan(workspaceId: string, projectId: string, planId: string, policy?: DirectorPolicyInput): Promise<DirectorPlan>;
    /** 应用 Director 计划（Schema/来源/Lock/预算验证 + 原子编辑；仅空项目）。
     *  idempotencyKey 必填：应用是写操作，重放必须可识别（编辑协议 §4.6）。 */
    applyDirectorPlan(
      workspaceId: string,
      projectId: string,
      planId: string,
      input: { idempotencyKey: string; policy?: DirectorPolicyInput; intent?: string },
    ): Promise<EditResponse>;
    /** 修订旁白块（锁定后改文本 → 409） */
    updateBlock(
      workspaceId: string,
      projectId: string,
      planId: string,
      blockId: string,
      input: { text?: string; locked?: boolean; status?: 'DRAFT' | 'NEEDS_REVIEW' | 'APPROVED' },
      options?: MutationOptions,
    ): Promise<NarrationBlock>;
  };
  evidence: {
    /** 确定性抽取（Claim/Citation/数值提及/时间线；可重入） */
    extract(workspaceId: string, projectId: string, documentId: string, options?: MutationOptions): Promise<ExtractionResult>;
    claims(workspaceId: string, projectId: string, query?: { documentId?: string }): Promise<ClaimRecord[]>;
    /** 手动创建 Claim（fact 必须带来源） */
    createClaim(
      workspaceId: string,
      projectId: string,
      input: { text: string; factuality: 'fact' | 'analysis' | 'opinion' | 'uncertain'; sourceIds?: string[]; locator?: string; quotedText?: string | null },
      options?: MutationOptions,
    ): Promise<{ claim: ClaimRecord; citations: CitationRecord[] }>;
    updateClaim(
      workspaceId: string,
      projectId: string,
      claimId: string,
      input: { text?: string; factuality?: 'fact' | 'analysis' | 'opinion' | 'uncertain'; locked?: boolean },
      options?: MutationOptions,
    ): Promise<ClaimRecord>;
    citations(workspaceId: string, projectId: string, claimId: string): Promise<CitationRecord[]>;
    /** 事实可视化策略（§10.3 降级阶梯） */
    factVisual(workspaceId: string, projectId: string, claimId: string, query?: { datasetId?: string }): Promise<FactVisualDecision>;
    datasets(workspaceId: string, projectId: string): Promise<DatasetRecord[]>;
    createDataset(workspaceId: string, projectId: string, input: CreateDatasetRequest, options?: MutationOptions): Promise<DatasetRecord>;
    getDataset(workspaceId: string, projectId: string, datasetId: string): Promise<DatasetRecord>;
    /** 图表绑定校验（不可绑定 → 422，附原因） */
    datasetBindingCheck(workspaceId: string, projectId: string, datasetId: string): Promise<ChartBindingCheck>;
  };
  billing: {
    /** 计费状态（余额/预算/周期消耗与预留） */
    status(workspaceId: string): Promise<BillingStatus>;
    /** 账本条目（只追加） */
    ledger(workspaceId: string, query?: { limit?: number }): Promise<LedgerEntry[]>;
    /** 设置预算（周期上限 + per-job 上限） */
    setBudget(
      workspaceId: string,
      input: { period?: 'DAILY' | 'MONTHLY'; limitCredits: number; perJobMaxCredits?: number },
      options?: MutationOptions,
    ): Promise<WorkspaceBudget>;
    /** 充值（CREDIT 条目） */
    topUp(
      workspaceId: string,
      input: { amountCredits: number; note?: string },
      options?: MutationOptions,
    ): Promise<{ entry: LedgerEntry; balanceCredits: number }>;
    /** 预留（原子；超限 402 BUDGET_EXCEEDED） */
    reserve(workspaceId: string, input: { jobId: string; estimatedCredits: number }, options?: MutationOptions): Promise<CreditHold>;
    generations(workspaceId: string, query?: { jobId?: string; limit?: number }): Promise<ProviderGeneration[]>;
    /** Provider 任务引用（Native Fallback 入口；onlyUnfulfilled 筛未回绑）（P06-07） */
    externalResults(workspaceId: string, query?: { onlyUnfulfilled?: boolean; limit?: number }): Promise<ProviderGeneration[]>;
    /** 回绑外部处理产物（READY 资产 → 任务引用；场景绑定仍走编辑协议） */
    rebindExternalResult(
      workspaceId: string,
      generationId: string,
      input: RebindExternalResultRequest,
      options?: MutationOptions,
    ): Promise<ProviderGeneration>;
  };
  providerConnections: {
    /** 创建 BYOK 连接（secret 只进不出；响应只含掩码） */
    create(
      workspaceId: string,
      input: { providerId: string; kind: string; label: string; secret: string },
      options?: MutationOptions,
    ): Promise<ProviderConnection>;
    list(workspaceId: string): Promise<ProviderConnection[]>;
    get(workspaceId: string, connectionId: string): Promise<ProviderConnection>;
    /** 连接测试（离线校验；注册钩子时执行真实测试） */
    test(workspaceId: string, connectionId: string, options?: MutationOptions): Promise<TestConnectionResponse>;
    /** 轮换凭据（新密文 + 新密钥版本） */
    rotate(workspaceId: string, connectionId: string, secret: string, options?: MutationOptions): Promise<ProviderConnection>;
    /** 撤销（立即从 Router 候选中消失） */
    revoke(workspaceId: string, connectionId: string, options?: MutationOptions): Promise<ProviderConnection>;
  };
  providerSettings: {
    list(workspaceId: string): Promise<WorkspaceProviderSetting[]>;
    set(
      workspaceId: string,
      kind: string,
      input: { selectionMode: 'AUTOMATIC' | 'PLATFORM_MANAGED' | 'BYOK'; connectionId?: string | null },
      options?: MutationOptions,
    ): Promise<WorkspaceProviderSetting>;
  };
  providerCatalog: {
    /** 当前 Provider Catalog（版本化配置 + 核验时间） */
    get(workspaceId: string): Promise<CatalogResponse>;
    /** Router 决策预览（能力 → Provider/模型/凭据模式；被拒原因可审计；无候选 → 501） */
    route(workspaceId: string, capability: string, query?: { region?: string }): Promise<ProviderRouteDecision>;
    /** Router 按能力筛选候选（含可用性判定；默认仅可调用） */
    capabilities(
      workspaceId: string,
      capability: string,
      query?: { region?: string; callableOnly?: boolean },
    ): Promise<CapabilitySelection>;
  };
  renders: {
    /** 创建渲染（P07-03：冻结输入快照；无版本则自动 FINAL_RENDER 快照） */
    create(workspaceId: string, projectId: string, input: CreateRenderRequest, options?: MutationOptions): Promise<RenderRecord>;
    list(workspaceId: string, projectId?: string): Promise<RenderRecord[]>;
    get(workspaceId: string, renderId: string): Promise<RenderRecord>;
    /** 输出增强包（P10-05；需已批准未失效；与正式版本一致性校验失败即 422） */
    outputEnhancements(workspaceId: string, renderId: string): Promise<RenderOutputEnhancements>;
    /** 状态推进（单向状态机；QUEUED→RENDERING→QA→READY/FAILED/CANCELLED） */
    transition(workspaceId: string, renderId: string, input: { to: RenderStatus; note?: string }, options?: MutationOptions): Promise<RenderRecord>;
    /** 触发 Final QA（P07-05；仅 QA 状态——自动入队窗口的恢复入口） */
    qa(workspaceId: string, renderId: string, options?: MutationOptions): Promise<{ jobId: string }>;
    /** 最新 QA 报告（未 QA 过 → null） */
    qaReport(workspaceId: string, renderId: string): Promise<QaReport | null>;
    /** 人工审批（P07-06 / §87；仅 READY 可审批；批准绑定 manifestHash 快照） */
    decideApproval(workspaceId: string, renderId: string, input: { decision: 'APPROVED' | 'REJECTED'; note?: string }, options?: MutationOptions): Promise<RenderApproval>;
    /** 最新审批记录（未审批 → null） */
    approval(workspaceId: string, renderId: string): Promise<RenderApproval | null>;
    /** 受控导出（未批准/批准失效 → 409；批准 → 逐产物签名下载入口） */
    exportPackage(workspaceId: string, renderId: string): Promise<ExportPackage>;
  };
  customMotion: {
    /** 发起 Custom Motion 生成（P07-02：LLM → 四道门禁 → 仅通过时版本化落库） */
    start(projectId: string, sceneId: string, input?: { brief?: string }, options?: MutationOptions): Promise<{ job: Job; dedupeKey: string; reused: boolean }>;
    list(projectId: string, query?: { sceneId?: string }): Promise<CustomMotionComponent[]>;
    get(projectId: string, componentId: string): Promise<CustomMotionComponent>;
  };
  jobs: {
    list(workspaceId: string, query?: { projectId?: string; status?: Job['status']; limit?: number }): Promise<Job[]>;
    get(workspaceId: string, jobId: string): Promise<Job>;
    /** 取消（QUEUED/等待依赖 → CANCELLED；执行中 → CANCEL_REQUESTED） */
    cancel(workspaceId: string, jobId: string, options?: MutationOptions): Promise<Job>;
    /** 人工重试（FAILED_* / CANCELLED → QUEUED） */
    retry(workspaceId: string, jobId: string, options?: MutationOptions): Promise<Job>;
  };
  /**
   * 最小运营（P08-02 / §67）：仅**平台管理员**可用（部署配置 ANCS_PLATFORM_ADMINS；
   * 非管理员调用 → 404 反枚举——与普通用户角色严格分离）。
   */
  admin: {
    overview(): Promise<OpsOverview>;
    jobs(query?: { status?: Job['status']; workspaceId?: string; limit?: number }): Promise<Job[]>;
    /** 人工重试（复用任务服务：预算/幂等/版本规则不变） */
    retryJob(jobId: string, input?: { reason?: string }, options?: MutationOptions): Promise<Job>;
    audit(query?: { limit?: number }): Promise<OpsAuditEntry[]>;
    /** 指标导出（P08-03；Prometheus 文本） */
    metricsText(): Promise<string>;
    /** 指派套餐（P09-01；append-only 订阅——修改套餐不篡改历史账单） */
    assignPlan(workspaceId: string, input: { planKey: PlanKey; note?: string }, options?: MutationOptions): Promise<WorkspaceSubscription>;
    /** 赠送 Credits（P09-03；admin 面，经账本只追加） */
    grantCredits(workspaceId: string, input: { amountCredits: number; reason: string }, options?: MutationOptions): Promise<{ entry: LedgerEntry; balanceCredits: number }>;
    /** 退款（对应原 CREDIT 条目的反向 REFUND；重复退款幂等） */
    refundCredit(workspaceId: string, input: { entryId: string; note?: string }, options?: MutationOptions): Promise<{ entry: LedgerEntry; balanceCredits: number; idempotent: boolean }>;
    /* ---------- P09-05 SaaS 安全运营 ---------- */
    /** 用户列表（查询邮箱/名称） */
    users(query?: { query?: string; limit?: number }): Promise<AdminUserSummary[]>;
    /** Workspace 列表（套餐/用量/积分/限制状态/未解决标记） */
    workspaces(query?: { query?: string; limit?: number }): Promise<AdminWorkspaceSummary[]>;
    /** Project 列表（查询标题/按 Workspace） */
    projects(query?: { query?: string; workspaceId?: string; limit?: number }): Promise<AdminProjectSummary[]>;
    /** Provider 状态（近 7 天聚合） */
    providerStatus(): Promise<AdminProviderStatus>;
    /** 存储用量（Top-N + 总量） */
    storage(query?: { limit?: number }): Promise<AdminStorageSummary>;
    /** 运营审计表（append-only） */
    auditLog(query?: { workspaceId?: string; action?: string; limit?: number }): Promise<AuditLogEntry[]>;
    /** 指定 Workspace 的 Credits 账单（平台视图） */
    workspaceCredits(workspaceId: string): Promise<CreditStatement>;
    /** 滥用标记（调查载体） */
    abuseFlags(query?: { workspaceId?: string; status?: 'OPEN' | 'RESOLVED'; limit?: number }): Promise<AbuseFlag[]>;
    createAbuseFlag(workspaceId: string, input: { category: AbuseFlag['category']; severity: AbuseFlag['severity']; note: string }, options?: MutationOptions): Promise<AbuseFlag>;
    resolveAbuseFlag(flagId: string, input: { resolutionNote: string }, options?: MutationOptions): Promise<AbuseFlag>;
    /** 工作区限制状态（RESTRICTED = 阻止新的成本性任务） */
    setAbuseState(workspaceId: string, input: { abuseState: WorkspaceAbuseState; note: string }, options?: MutationOptions): Promise<{ workspaceId: string; abuseState: WorkspaceAbuseState }>;
    /** 支持访问授权（时限 ≤ 24h；不可无痕：审计 + 工作区可见事件） */
    supportGrants(workspaceId: string): Promise<SupportAccessGrant[]>;
    createSupportGrant(workspaceId: string, input: { purpose: string; ttlHours?: number }, options?: MutationOptions): Promise<SupportAccessGrant>;
    revokeSupportGrant(grantId: string, options?: MutationOptions): Promise<SupportAccessGrant>;
    /** 支持视图（需有效授权；仅元数据摘要；每次访问留痕） */
    supportView(workspaceId: string): Promise<SupportView>;
  };
  /** 套餐目录（P09-01；版本化、价格为数据） */
  plans: {
    list(query?: { planKey?: PlanKey }): Promise<Plan[]>;
  };
  notifications: {
    list(options?: { workspaceId?: string; unreadOnly?: boolean; limit?: number }): Promise<Notification[]>;
    unreadCount(options?: { workspaceId?: string }): Promise<number>;
    markRead(notificationId: string, options?: MutationOptions): Promise<Notification>;
    markAllRead(options?: { workspaceId?: string } & MutationOptions): Promise<number>;
  };
}

export function createClient(options: ClientOptions): AncsClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const clientType: ClientType = options.clientType ?? 'web';
  const clientVersion = options.clientVersion ?? null;
  const credentials: CredentialsMode = options.credentials ?? 'include';

  // 非浏览器运行时的 Cookie 会话承载（浏览器由 credentials:'include' 处理，且 httpOnly Cookie 对 JS 不可见）
  const cookieJar = new Map<string, string>();
  const captureCookies = (response: Response): void => {
    const getSetCookie = response.headers.getSetCookie;
    const entries = typeof getSetCookie === 'function' ? getSetCookie.call(response.headers) : [];
    for (const entry of entries) {
      const pair = entry.split(';')[0] ?? '';
      const separator = pair.indexOf('=');
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const value = pair.slice(separator + 1).trim();
      if (value === '' || /max-age=0/i.test(entry)) cookieJar.delete(name);
      else cookieJar.set(name, value);
    }
  };
  const cookieHeader = (): string | null =>
    cookieJar.size === 0 ? null : [...cookieJar].map(([name, value]) => `${name}=${value}`).join('; ');

  const buildHeaders = async (hasBody: boolean, idempotencyKey?: string): Promise<Headers> => {
    const headers = new Headers();
    if (hasBody) headers.set('content-type', 'application/json');
    headers.set('x-client-type', clientType);
    if (clientVersion !== null) headers.set('x-client-version', clientVersion);
    if (options.getAccessToken) {
      const token = await options.getAccessToken();
      if (token !== null && token.length > 0) headers.set('authorization', `Bearer ${token}`);
    }
    if (idempotencyKey !== undefined) headers.set('idempotency-key', idempotencyKey);
    const cookies = cookieHeader();
    if (cookies !== null) headers.set('cookie', cookies);
    return headers;
  };

  const parseError = (status: number, payload: unknown): AncsApiError => {
    if (typeof payload === 'object' && payload !== null && 'error' in payload) {
      const envelope = (payload as { error: { code: string; message: string; requestId: string; details: Record<string, unknown> } }).error;
      return new AncsApiError({
        status,
        code: envelope.code,
        message: envelope.message,
        requestId: envelope.requestId,
        details: envelope.details ?? {},
      });
    }
    return new AncsApiError({
      status,
      code: 'UNPARSEABLE_ERROR',
      message: `HTTP ${String(status)}（响应不符合统一错误信封）`,
      requestId: '',
      details: {},
    });
  };

  async function request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: ZodType<T>,
    init?: { body?: unknown; bodySchema?: ZodType; idempotencyKey?: string },
  ): Promise<T> {
    // 请求体在异步边界内校验：非法输入以 rejection 呈现（而非同步抛出）
    const body = init?.body === undefined ? undefined : init.bodySchema ? init.bodySchema.parse(init.body) : init.body;
    const response = await doFetch(`${baseUrl}${path}`, {
      method,
      headers: await buildHeaders(body !== undefined, init?.idempotencyKey),
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials,
    });
    captureCookies(response);

    let payload: unknown;
    try {
      payload = response.status === 204 ? null : await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) throw parseError(response.status, payload);
    if (response.status === 204) return schema.parse(null);
    return schema.parse(payload);
  }

  /** 纯文本请求（指标导出等非 JSON 端点；会话/令牌与 JSON 请求同一路径） */
  async function requestText(method: 'GET' | 'POST', path: string): Promise<string> {
    const response = await doFetch(`${baseUrl}${path}`, { method, headers: await buildHeaders(false), credentials });
    captureCookies(response);
    const text = await response.text();
    if (!response.ok) {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        payload = undefined;
      }
      throw parseError(response.status, payload);
    }
    return text;
  }

  /** 204 响应的空 schema（delete/sign-out） */
  const emptySchema = {
    parse: (value: unknown): void => {
      void value;
    },
  } as unknown as ZodType<void>;

  const listOf = <T>(schema: ZodType<T>) => pageResponseSchema(schema);
  const eventListSchema = z.object({
    events: z.array(workspaceEventSchema),
    headSeq: z.number().int().nonnegative(),
  });

  /** 客户端预计算 SHA-256（用于 workspace 内去重与完整性校验；无 WebCrypto 环境返回 null） */
  const sha256Hex = async (data: Uint8Array): Promise<string | null> => {
    const subtle = globalThis.crypto?.subtle;
    if (subtle === undefined) return null;
    const view = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? data.buffer : data.slice().buffer;
    const digest = await subtle.digest('SHA-256', view as ArrayBuffer);
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  };

  return {
    health: () => request('GET', '/api/v1/health', healthResponseSchema),

    auth: {
      signIn: (input) =>
        request('POST', '/api/v1/auth/sign-in', signInResponseSchema, { body: input, bodySchema: signInRequestSchema }),
      signOut: async () => {
        await request('POST', '/api/v1/auth/sign-out', emptySchema);
        cookieJar.clear();
      },
      session: () => request('GET', '/api/v1/auth/session', sessionInfoSchema),
      authorize: async (input) => {
        const query = nativeAuthorizeQuerySchema.parse({
          responseType: 'code',
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge,
          codeChallengeMethod: 'S256',
          state: input.state,
        });
        const params = new URLSearchParams({
          responseType: query.responseType,
          clientId: query.clientId,
          redirectUri: query.redirectUri,
          codeChallenge: query.codeChallenge,
          codeChallengeMethod: query.codeChallengeMethod,
          state: query.state,
        });
        const response = await doFetch(`${baseUrl}/api/v1/auth/authorize?${params.toString()}`, {
          method: 'GET',
          headers: await buildHeaders(false),
          credentials,
          redirect: 'manual',
        });
        captureCookies(response);

        const location = response.headers.get('location');
        if (location === null) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            payload = undefined;
          }
          throw parseError(response.status, payload);
        }
        const redirectUrl = new URL(location);
        return {
          location,
          code: redirectUrl.searchParams.get('code'),
          state: redirectUrl.searchParams.get('state'),
          error: redirectUrl.searchParams.get('error'),
        };
      },
      token: (input) => request('POST', '/api/v1/auth/token', tokenResponseSchema, { body: input, bodySchema: tokenRequestSchema }),
      revoke: async (input) => {
        await request('POST', '/api/v1/auth/revoke', emptySchema, { body: input, bodySchema: revokeTokenRequestSchema });
      },
    },

    packs: {
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/packs`, z.object({ items: z.array(workspacePackViewSchema) }))).items,
      enable: (workspaceId, packId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/packs/${packId}/enable`, z.object({ packId: z.string(), version: z.string(), enabledAt: z.string() }), {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      disable: async (workspaceId, packId, mutation) => {
        await request('POST', `/api/v1/workspaces/${workspaceId}/packs/${packId}/disable`, emptySchema, {
          idempotencyKey: mutation?.idempotencyKey,
        });
      },
      bind: (workspaceId, projectId, packId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/packs/${packId}/bind`, z.object({ projectId: z.string(), packId: z.string(), version: z.string(), boundAt: z.string() }), {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      analyze: (workspaceId, projectId, packId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/packs/${packId}/analyze`, packAnalyzeResultSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      /** 生成派生产物（P12-01；须先 analyze——血缘锚；产物只追加，**不写回源项目**） */
      generate: (workspaceId, projectId, packId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/packs/${packId}/generate`, packArtifactViewSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      artifacts: {
        list: async (workspaceId, projectId) =>
          (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/artifacts`, packArtifactListSchema)).items,
        /** 产物校验（安全区/来源链/Hook/字幕/Recipe 窗口；结果只追加） */
        validate: (workspaceId, projectId, artifactId, mutation) =>
          request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/artifacts/${artifactId}/validate`, artifactValidationResultSchema, {
            idempotencyKey: mutation?.idempotencyKey,
          }),
      },
    },
    derivations: {
      list: async (workspaceId, projectId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/derivations`, derivationListSchema),
      approve: (workspaceId, projectId, lineageId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/derivations/${lineageId}/approve`, derivationListItemSchema, {
          body: { projectVersionId: mutation?.projectVersionId ?? null },
          bodySchema: approveDerivationRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },
    search: async (workspaceId, input) => {
      const search = new URLSearchParams({ q: input.q });
      if (input.kinds !== undefined && input.kinds.length > 0) search.set('kinds', input.kinds.join(','));
      if (input.limit !== undefined) search.set('limit', String(input.limit));
      return request('GET', `/api/v1/workspaces/${workspaceId}/search?${search.toString()}`, searchResponseSchema);
    },
    workspaces: {
      create: (input, mutation) =>
        request('POST', '/api/v1/workspaces', workspaceWithRoleSchema, {
          body: input, bodySchema: createWorkspaceRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async () =>
        (await request('GET', '/api/v1/workspaces', listOf(workspaceWithRoleSchema))).items,
      get: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}`, workspaceWithRoleSchema),
      entitlements: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/entitlements`, workspaceEntitlementSchema),
      graphExport: (workspaceId, projectId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/graph-export`, graphExportSchema),
      assetBundle: (workspaceId, projectId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/asset-bundle`, assetBundleExportSchema),
      checkout: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/billing/checkout`, z.object({ checkoutUrl: z.string(), providerSubscriptionRef: z.string().nullable() }), {
          body: input,
          bodySchema: createCheckoutRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      billing: (workspaceId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/billing`, z.object({
          state: billingStateSchema,
          plan: planSchema.nullable(),
          events: z.array(z.object({ id: z.string(), providerEventId: z.string(), type: z.string(), outcome: z.string(), occurredAt: z.string(), receivedAt: z.string() })),
        })),
      billingPortal: (workspaceId) => request('POST', `/api/v1/workspaces/${workspaceId}/billing/portal`, z.object({ portalUrl: z.string() })),
      creditPacks: async (workspaceId) => (await request('GET', `/api/v1/workspaces/${workspaceId}/billing/credit-packs`, z.object({ items: z.array(creditPackSchema) }))).items,
      buyCredits: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/billing/credits/checkout`, z.object({ checkoutUrl: z.string(), providerSubscriptionRef: z.string().nullable() }), {
          body: input,
          bodySchema: buyCreditsRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      creditStatement: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/billing/credits`, creditStatementSchema),
      reconcileCredits: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/billing/credits/reconcile`, creditReconcileSchema),
      invitations: {
        list: async (workspaceId) =>
          (await request('GET', `/api/v1/workspaces/${workspaceId}/invitations`, listOf(workspaceInvitationSchema))).items,
        create: (workspaceId, input, mutation) =>
          request('POST', `/api/v1/workspaces/${workspaceId}/invitations`, workspaceInvitationSchema, {
            body: input, bodySchema: createInvitationRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          }),
        revoke: (workspaceId, invitationId) =>
          request('DELETE', `/api/v1/workspaces/${workspaceId}/invitations/${invitationId}`, workspaceInvitationSchema),
      },
      setPrivacyTier: (workspaceId, input) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}/privacy`, workspaceWithRoleSchema, {
          body: input, bodySchema: setPrivacyTierRequestSchema,
        }),
      update: (workspaceId, input, mutation) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}`, workspaceWithRoleSchema, {
          body: input, bodySchema: updateWorkspaceRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      members: {
        list: async (workspaceId) =>
          (await request('GET', `/api/v1/workspaces/${workspaceId}/members`, listOf(workspaceMemberSchema))).items,
        add: (workspaceId, input, mutation) =>
          request('POST', `/api/v1/workspaces/${workspaceId}/members`, workspaceMemberSchema, {
            body: input, bodySchema: addWorkspaceMemberRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          }),
        updateRole: (workspaceId, userId, input, mutation) =>
          request('PATCH', `/api/v1/workspaces/${workspaceId}/members/${userId}`, workspaceMemberSchema, {
            body: input, bodySchema: updateWorkspaceMemberRoleRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          }),
        remove: (workspaceId, userId, mutation) =>
          request('DELETE', `/api/v1/workspaces/${workspaceId}/members/${userId}`, emptySchema, {
            idempotencyKey: mutation?.idempotencyKey,
          }),
      },
    },

    invitations: {
      mine: async () =>
        (await request('GET', '/api/v1/invitations', listOf(myInvitationSchema))).items,
      accept: (invitationId, mutation) =>
        request('POST', `/api/v1/invitations/${invitationId}/accept`, z.object({ workspace: workspaceWithRoleSchema, invitation: workspaceInvitationSchema }), {
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    channels: {
      create: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/channels`, channelWithStyleSchema, {
          body: input, bodySchema: createChannelRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/channels`, listOf(channelWithStyleSchema))).items,
      get: (workspaceId, channelId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/channels/${channelId}`, channelWithStyleSchema),
      update: (workspaceId, channelId, input, mutation) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}/channels/${channelId}`, channelWithStyleSchema, {
          body: input, bodySchema: updateChannelRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      styleVersions: async (workspaceId, channelId) =>
        (
          await request(
            'GET',
            `/api/v1/workspaces/${workspaceId}/channels/${channelId}/style-versions`,
            listOf(channelStyleVersionSchema),
          )
        ).items,
    },

    creatorIdentities: {
      create: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities`, creatorIdentitySchema, {
          body: input, bodySchema: createCreatorIdentityRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId) =>
        (
          await request(
            'GET',
            `/api/v1/workspaces/${workspaceId}/creator-identities`,
            listOf(creatorIdentitySchema),
          )
        ).items,
      get: (workspaceId, creatorIdentityId) =>
        request(
          'GET',
          `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}`,
          creatorIdentitySchema,
        ),
      update: (workspaceId, creatorIdentityId, input, mutation) =>
        request(
          'PATCH',
          `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}`,
          creatorIdentitySchema,
          { body: input, bodySchema: updateCreatorIdentityRequestSchema, idempotencyKey: mutation?.idempotencyKey },
        ),
    },

    voiceClone: {
      state: (workspaceId, creatorIdentityId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone`, voiceCloneStateSchema),
      consentStatement: (workspaceId, creatorIdentityId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/consent-statement`, z.object({ version: z.string(), statement: z.string(), statementHash: z.string() })),
      addSample: (workspaceId, creatorIdentityId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/samples`, voiceCloneSampleSchema, {
          body: input, bodySchema: addVoiceSampleRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      samples: async (workspaceId, creatorIdentityId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/samples`, z.object({ items: z.array(voiceCloneSampleSchema) }))).items,
      confirmConsent: (workspaceId, creatorIdentityId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/consent`, voiceConsentSchema, {
          body: input, bodySchema: confirmVoiceConsentRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      revokeConsent: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/consent/revoke`, voiceConsentSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      submit: (workspaceId, creatorIdentityId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/submit`, voiceCloneSchema, {
          body: input, bodySchema: submitVoiceCloneRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      refresh: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/refresh`, voiceCloneSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      retry: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/retry`, voiceCloneSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      retire: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/retire`, voiceCloneSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      unlink: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/unlink`, voiceCloneSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      deleteProviderVoice: (workspaceId, creatorIdentityId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/creator-identities/${creatorIdentityId}/voice-clone/delete-provider-voice`, voiceCloneSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    stock: {
      search: (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.query !== undefined) search.set('query', query.query);
        if (query?.kind !== undefined) search.set('kind', query.kind);
        if (query?.usableOnly !== undefined) search.set('usableOnly', String(query.usableOnly));
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return request('GET', `/api/v1/workspaces/${workspaceId}/stock/search${suffix}`, z.object({ providerId: z.string(), items: z.array(stockSearchResultSchema) }));
      },
      acquire: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/stock/acquire`, stockAcquisitionResultSchema, {
          body: input,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    speechProfiles: {
      create: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/speech-profiles`, speechProfileSchema, {
          body: input, bodySchema: createSpeechProfileRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/speech-profiles`, listOf(speechProfileSchema))).items,
      get: (workspaceId, speechProfileId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/speech-profiles/${speechProfileId}`, speechProfileSchema),
      update: (workspaceId, speechProfileId, input, mutation) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}/speech-profiles/${speechProfileId}`, speechProfileSchema, {
          body: input, bodySchema: updateSpeechProfileRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    projects: {
      create: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects`, projectDetailSchema, {
          body: input,
          bodySchema: createProjectRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId, query) => {
        const suffix = query?.trashed === true ? '?trashed=true' : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/projects${suffix}`, listOf(projectSchema))).items;
      },
      delete: (projectId, mutation) =>
        request('DELETE', `/api/v1/projects/${projectId}`, projectSchema, { idempotencyKey: mutation?.idempotencyKey }),
      restore: (projectId, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/restore`, projectSchema, { idempotencyKey: mutation?.idempotencyKey }),
      get: (projectId) => request('GET', `/api/v1/projects/${projectId}`, projectDetailSchema),
      graph: (projectId) => request('GET', `/api/v1/projects/${projectId}/graph`, sceneGraphSchema),
      /** 渲染前预检（P07-05；项目当前状态，只读） */
      renderPrecheck: (projectId: string) => request('GET', `/api/v1/projects/${projectId}/render-precheck`, qaReportSchema),
      addScene: (projectId, input, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/scenes`, createSceneResponseSchema, {
          body: input,
          bodySchema: createSceneRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      generateScene: (projectId, sceneId, input, mutation) => {
        // 注意：项目级路径（与既有 projects.* 方法一致，workspace 由服务端从项目反查鉴权）
        return request('POST', `/api/v1/projects/${projectId}/scenes/${sceneId}/generate`, sceneGenerationResponseSchema, {
          body: { capability: input?.capability ?? 'video.generate' },
          bodySchema: z.object({ capability: z.string().min(1).max(64) }),
          idempotencyKey: mutation?.idempotencyKey,
        });
      },
      edit: (projectId, editRequest, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/edits`, editResponseSchema, {
          body: editRequest,
          bodySchema: editRequestSchema,
          // §4.6 的幂等键位于请求信封；SDK 同时镜像到 Idempotency-Key 头
          idempotencyKey: mutation?.idempotencyKey ?? editRequest.idempotencyKey,
        }),
      versions: {
        create: (projectId, input, mutation) =>
          request('POST', `/api/v1/projects/${projectId}/versions`, projectVersionSchema, {
            body: input,
            bodySchema: createProjectVersionRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          }),
        list: async (projectId) =>
          (
            await request('GET', `/api/v1/projects/${projectId}/versions`, listOf(projectVersionSchema))
          ).items,
        get: (projectId, versionId) =>
          request('GET', `/api/v1/projects/${projectId}/versions/${versionId}`, projectVersionDetailSchema),
      },
      undo: (projectId, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/undo`, editResponseSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      redo: (projectId, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/redo`, editResponseSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    assets: {
      createUploadIntent: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/assets/upload-intents`, uploadIntentResponseSchema, {
          body: input,
          bodySchema: createUploadIntentRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      confirm: (workspaceId, assetId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/assets/${assetId}/confirm`, assetDetailSchema, {
          body: input,
          bodySchema: confirmUploadRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.projectId !== undefined) search.set('projectId', query.projectId);
        if (query?.assetType !== undefined) search.set('assetType', query.assetType);
        if (query?.trashed === true) search.set('trashed', 'true');
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/assets${suffix}`, listOf(assetSchema))).items;
      },
      delete: (workspaceId, assetId, mutation) =>
        request('DELETE', `/api/v1/workspaces/${workspaceId}/assets/${assetId}`, assetSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      restore: (workspaceId, assetId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/assets/${assetId}/restore`, assetSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      get: (workspaceId, assetId) => request('GET', `/api/v1/workspaces/${workspaceId}/assets/${assetId}`, assetDetailSchema),
      downloadUrl: (workspaceId, assetId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/assets/${assetId}/download-url`, downloadUrlResponseSchema),
      upload: async (workspaceId, input, mutation) => {
        const checksumSha256 = await sha256Hex(input.data);
        const intent = await request('POST', `/api/v1/workspaces/${workspaceId}/assets/upload-intents`, uploadIntentResponseSchema, {
          body: {
            assetType: input.assetType,
            filename: input.filename,
            contentType: input.contentType,
            sizeBytes: input.data.byteLength,
            ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
            ...(input.sceneId !== undefined ? { sceneId: input.sceneId } : {}),
            ...(checksumSha256 !== null ? { checksumSha256 } : {}),
            ...(input.license !== undefined ? { license: input.license } : {}),
          },
          bodySchema: createUploadIntentRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        });
        if (intent.deduped) {
          return request('GET', `/api/v1/workspaces/${workspaceId}/assets/${intent.asset.id}`, assetDetailSchema);
        }
        if (intent.upload === null) {
          throw new Error('上传意图缺少直传目标（协议不一致）');
        }
        // body 用 ArrayBuffer：跨 node/DOM 类型的 BodyInit 均兼容（Uint8Array<ArrayBufferLike> 在 DOM 类型下不被接受）
        const uploadBody = new Uint8Array(input.data).buffer;
        const uploadResponse = await doFetch(intent.upload.url, {
          method: intent.upload.method,
          headers: intent.upload.headers,
          body: uploadBody,
        });
        if (!uploadResponse.ok) {
          throw new Error(`直传失败：HTTP ${String(uploadResponse.status)}`);
        }
        return request('POST', `/api/v1/workspaces/${workspaceId}/assets/${intent.asset.id}/confirm`, assetDetailSchema, {
          body: {
            ...(checksumSha256 !== null ? { checksumSha256 } : {}),
            width: input.width ?? undefined,
            height: input.height ?? undefined,
            durationMs: input.durationMs ?? undefined,
          },
          bodySchema: confirmUploadRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        });
      },
    },

    events: {
      cursor: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/events/cursor`, eventCursorSchema),
      list: (workspaceId, options) => {
        const search = new URLSearchParams();
        if (options?.cursor !== undefined) search.set('cursor', String(options.cursor));
        if (options?.limit !== undefined) search.set('limit', String(options.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return request('GET', `/api/v1/workspaces/${workspaceId}/events${suffix}`, eventListSchema);
      },
      subscribe: async function* (workspaceId, options) {
        const headers = await buildHeaders(false);
        headers.set('accept', 'text/event-stream');
        if (options?.cursor !== undefined) headers.set('last-event-id', String(options.cursor));
        const init: RequestInit = { method: 'GET', headers };
        if (credentials === 'include') init.credentials = 'include';
        if (options?.signal !== undefined) init.signal = options.signal;
        const response = await doFetch(`${baseUrl}/api/v1/workspaces/${workspaceId}/events/stream`, init);
        if (!response.ok || response.body === null) {
          throw new Error(`事件流连接失败：HTTP ${String(response.status)}`);
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            let separatorIndex = buffer.indexOf('\n\n');
            while (separatorIndex >= 0) {
              const frame = buffer.slice(0, separatorIndex);
              buffer = buffer.slice(separatorIndex + 2);
              separatorIndex = buffer.indexOf('\n\n');
              const dataLines = frame
                .split('\n')
                .filter((line) => line.startsWith('data:'))
                .map((line) => line.slice(5).trim());
              if (dataLines.length === 0) continue; // 注释/心跳帧
              yield workspaceEventSchema.parse(JSON.parse(dataLines.join('\n')));
            }
          }
        } finally {
          await reader.cancel().catch(() => undefined);
        }
      },
    },

    content: {
      create: (workspaceId, projectId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content`, contentDocumentRecordSchema, {
          body: input,
          bodySchema: createContentRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      importDocument: async (workspaceId, projectId, input) => {
        // 注意：buildHeaders 返回 Headers 实例（展开 `{...headers}` 不会携带任何头）
        const headers = await buildHeaders(false);
        headers.set('content-type', input.contentType);
        const response = await doFetch(
          `${baseUrl}/api/v1/workspaces/${workspaceId}/projects/${projectId}/content/document?filename=${encodeURIComponent(input.filename)}`,
          {
            method: 'POST',
            headers,
            // Uint8Array 泛型在 DOM/Node 两套 BodyInit 定义下不完全兼容（运行时均接受二进制体）
            body: input.data as NonNullable<Parameters<typeof doFetch>[1]>['body'],
            credentials,
          },
        );
        captureCookies(response);
        const payload: unknown = await response.json().catch(() => undefined);
        if (!response.ok) throw parseError(response.status, payload);
        return contentDocumentRecordSchema.parse(payload);
      },
      list: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content`, listOf(contentDocumentRecordSchema))).items,
      get: (workspaceId, projectId, documentId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content/${documentId}`, contentDocumentRecordSchema),
      sources: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/sources`, listOf(contentSourceSchema))).items,
      contentCore: {
        migrate: (workspaceId, projectId, mutation) =>
          request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content-core/migrate`, contentCoreMigrationSchema, {
            idempotencyKey: mutation?.idempotencyKey,
          }),
        state: (workspaceId, projectId) =>
          request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content-core`, contentCoreStateSchema),
      },
      atoms: {
        create: (workspaceId, projectId, input, mutation) =>
          request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/atoms`, contentAtomSchema, {
            body: input,
            bodySchema: createAtomRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          }),
        list: async (workspaceId, projectId) =>
          (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/atoms`, z.object({ items: z.array(contentAtomSchema) }))).items,
      },
      channelRecipes: {
        list: async (workspaceId) =>
          (await request('GET', `/api/v1/workspaces/${workspaceId}/channel-recipes`, z.object({ items: z.array(channelRecipeSchema) }))).items,
      },
      channelFit: (workspaceId, projectId, channelKey) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/channel-fit?channelKey=${encodeURIComponent(channelKey)}`, channelFitSchema),
      updateSource: (workspaceId, projectId, sourceId, input, mutation) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/sources/${sourceId}`, contentSourceSchema, {
          body: input,
          bodySchema: updateSourceRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    narrative: {
      generate: (workspaceId, projectId, documentId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/generate`, narrativeGenerationResultSchema, {
          body: { documentId, ...input },
          bodySchema: z.object({
            documentId: z.string().min(1),
            targetDurationMs: z.number().int().positive(),
            tone: z.string().nullable().optional(),
            audience: z.string().nullable().optional(),
            platform: z.string().nullable().optional(),
          }),
          idempotencyKey: mutation?.idempotencyKey,
        }),
      current: (workspaceId, projectId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative`, narrativePlanSchema.nullable()),
      plans: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/plans`, listOf(narrativePlanSchema))).items,
      visualPlan: (workspaceId, projectId, planId) =>
        request(
          'GET',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/visual-plan`,
          visualPlanSchema,
        ),
      speechPlan: (workspaceId, projectId, planId, options) => {
        const query = new URLSearchParams();
        if (options?.identityId !== undefined) query.set('identityId', options.identityId);
        if (options?.speechProfileId !== undefined) query.set('speechProfileId', options.speechProfileId);
        const suffix = query.size > 0 ? `?${query.toString()}` : '';
        return request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/speech-plan${suffix}`, speechPlanSchema);
      },
      synthesizeMasterNarration: (workspaceId, projectId, planId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/master-narration`, masterNarrationSchema, {
          body: { ...(input?.onlyBlockId !== undefined ? { onlyBlockId: input.onlyBlockId } : {}) },
          idempotencyKey: mutation?.idempotencyKey,
        }),
      masterNarration: (workspaceId, projectId, planId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/master-narration`, masterNarrationSchema.nullable()),
      subtitles: (workspaceId, projectId, planId, options) => {
        const query = new URLSearchParams();
        if (options?.format !== undefined) query.set('format', options.format);
        if (options?.style !== undefined) query.set('style', JSON.stringify(options.style));
        const suffix = query.size > 0 ? `?${query.toString()}` : '';
        return request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/subtitles${suffix}`, subtitleOutputSchema);
      },
      mixPlan: (workspaceId, projectId, planId, body) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/mix-plan`, mixPlanSchema, {
          body,
          bodySchema: mixPlanRequestSchema,
        }),
      aiEditPlan: (workspaceId, projectId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/ai-edit/plan`, editPlanSchema, {
          body: input,
          bodySchema: createEditPlanRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      directorPlan: (workspaceId, projectId, planId, policy) =>
        request(
          'GET',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/director-plan${policy === undefined ? '' : `?policy=${encodeURIComponent(JSON.stringify(policy))}`}`,
          directorPlanSchema,
        ),
      applyDirectorPlan: (workspaceId, projectId, planId, input) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/director-plan/apply`, editResponseSchema, {
          body: {
            ...(input.policy !== undefined ? { policy: input.policy } : {}),
            ...(input.intent !== undefined ? { intent: input.intent } : {}),
            idempotencyKey: input.idempotencyKey,
          },
          bodySchema: directorApplyRequestSchema,
          idempotencyKey: input.idempotencyKey,
        }),
      updateBlock: (workspaceId, projectId, planId, blockId, input, mutation) =>
        request(
          'PATCH',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/narrative/${planId}/blocks/${blockId}`,
          narrationBlockSchema,
          {
            body: input,
            bodySchema: updateNarrationBlockRequestSchema,
            idempotencyKey: mutation?.idempotencyKey,
          },
        ),
    },

    evidence: {
      extract: (workspaceId, projectId, documentId, mutation) =>
        request(
          'POST',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content/${documentId}/extract`,
          extractionResultSchema,
          { idempotencyKey: mutation?.idempotencyKey },
        ),
      claims: async (workspaceId, projectId, query) => {
        const suffix = query?.documentId !== undefined ? `?documentId=${query.documentId}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/claims${suffix}`, listOf(claimRecordSchema))).items;
      },
      createClaim: (workspaceId, projectId, input, mutation) =>
        request(
          'POST',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/claims`,
          z.object({ claim: claimRecordSchema, citations: z.array(citationRecordSchema) }),
          {
            body: input,
            bodySchema: z.object({
              text: z.string().min(1),
              factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
              sourceIds: z.array(z.string()).optional(),
              locator: z.string().optional(),
              quotedText: z.string().nullable().optional(),
            }),
            idempotencyKey: mutation?.idempotencyKey,
          },
        ),
      updateClaim: (workspaceId, projectId, claimId, input, mutation) =>
        request('PATCH', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/claims/${claimId}`, claimRecordSchema, {
          body: input,
          bodySchema: z
            .object({
              text: z.string().min(1),
              factuality: z.enum(['fact', 'analysis', 'opinion', 'uncertain']),
              locked: z.boolean(),
            })
            .partial()
            .strict(),
          idempotencyKey: mutation?.idempotencyKey,
        }),
      citations: async (workspaceId, projectId, claimId) =>
        (
          await request(
            'GET',
            `/api/v1/workspaces/${workspaceId}/projects/${projectId}/claims/${claimId}/citations`,
            listOf(citationRecordSchema),
          )
        ).items,
      factVisual: (workspaceId, projectId, claimId, query) => {
        const suffix = query?.datasetId !== undefined ? `?datasetId=${query.datasetId}` : '';
        return request(
          'GET',
          `/api/v1/workspaces/${workspaceId}/projects/${projectId}/claims/${claimId}/fact-visual${suffix}`,
          factVisualDecisionSchema,
        );
      },
      datasets: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/datasets`, listOf(datasetRecordSchema))).items,
      createDataset: (workspaceId, projectId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/datasets`, datasetRecordSchema, {
          body: input,
          bodySchema: createDatasetRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      getDataset: (workspaceId, projectId, datasetId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/datasets/${datasetId}`, datasetRecordSchema),
      datasetBindingCheck: (workspaceId, projectId, datasetId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/datasets/${datasetId}/binding-check`, chartBindingCheckSchema),
    },

    billing: {
      status: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/billing/status`, billingStatusSchema),
      ledger: async (workspaceId, query) => {
        const suffix = query?.limit !== undefined ? `?limit=${String(query.limit)}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/billing/ledger${suffix}`, listOf(ledgerEntrySchema))).items;
      },
      setBudget: (workspaceId, input, mutation) =>
        request('PUT', `/api/v1/workspaces/${workspaceId}/billing/budget`, workspaceBudgetSchema, {
          body: input,
          bodySchema: upsertBudgetRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      topUp: (workspaceId, input, mutation) =>
        request(
          'POST',
          `/api/v1/workspaces/${workspaceId}/billing/credits`,
          z.object({ entry: ledgerEntrySchema, balanceCredits: z.number().int() }),
          { body: input, bodySchema: topUpRequestSchema, idempotencyKey: mutation?.idempotencyKey },
        ),
      reserve: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/billing/reservations`, creditHoldSchema, {
          body: input,
          bodySchema: z.object({ jobId: z.string().min(1), estimatedCredits: z.number().int().nonnegative() }),
          idempotencyKey: mutation?.idempotencyKey,
        }),
      externalResults: async (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.onlyUnfulfilled !== undefined) search.set('onlyUnfulfilled', String(query.onlyUnfulfilled));
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/external-results${suffix}`, listOf(providerGenerationSchema))).items;
      },
      rebindExternalResult: (workspaceId, generationId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/external-results/${generationId}/rebind`, providerGenerationSchema, {
          body: input,
          bodySchema: rebindExternalResultRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      generations: async (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.jobId !== undefined) search.set('jobId', query.jobId);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/provider-generations${suffix}`, listOf(providerGenerationSchema))).items;
      },
    },

    providerConnections: {
      create: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/provider-connections`, providerConnectionSchema, {
          body: input,
          bodySchema: createConnectionRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/provider-connections`, listOf(providerConnectionSchema))).items,
      get: (workspaceId, connectionId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/provider-connections/${connectionId}`, providerConnectionSchema),
      test: (workspaceId, connectionId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/provider-connections/${connectionId}/test`, testConnectionResponseSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      rotate: (workspaceId, connectionId, secret, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/provider-connections/${connectionId}/rotate`, providerConnectionSchema, {
          body: { secret },
          bodySchema: rotateConnectionRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      revoke: (workspaceId, connectionId, mutation) =>
        request('DELETE', `/api/v1/workspaces/${workspaceId}/provider-connections/${connectionId}`, providerConnectionSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    providerSettings: {
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/provider-settings`, listOf(workspaceProviderSettingSchema))).items,
      set: (workspaceId, kind, input, mutation) =>
        request('PUT', `/api/v1/workspaces/${workspaceId}/provider-settings/${kind}`, workspaceProviderSettingSchema, {
          body: input,
          bodySchema: upsertWorkspaceProviderSettingRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    providerCatalog: {
      get: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}/provider-catalog`, catalogResponseSchema),
      route: (workspaceId, capability, query) => {
        const search = new URLSearchParams({ capability });
        if (query?.region !== undefined) search.set('region', query.region);
        return request('GET', `/api/v1/workspaces/${workspaceId}/provider-route?${search.toString()}`, providerRouteDecisionSchema);
      },
      capabilities: (workspaceId, capability, query) => {
        const search = new URLSearchParams();
        if (query?.region !== undefined) search.set('region', query.region);
        if (query?.callableOnly === false) search.set('callableOnly', 'false');
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return request(
          'GET',
          `/api/v1/workspaces/${workspaceId}/provider-catalog/capabilities/${encodeURIComponent(capability)}${suffix}`,
          capabilitySelectionSchema,
        );
      },
    },

    renders: {
      create: (workspaceId, projectId, input, mutation) =>
        // 项目级路由（工作区由服务端从项目反查鉴权）
        request('POST', `/api/v1/projects/${projectId}/renders`, renderRecordSchema, {
          body: input,
          bodySchema: createRenderRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (workspaceId, projectId) => {
        if (projectId === undefined) return [];
        const payload = await request('GET', `/api/v1/projects/${projectId}/renders`, listOf(renderRecordSchema));
        return payload.items;
      },
      get: (workspaceId, renderId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/renders/${renderId}`, renderRecordSchema),
      outputEnhancements: (workspaceId, renderId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/outputs/enhancements`, renderOutputEnhancementsSchema),
      transition: (workspaceId, renderId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/transition`, renderRecordSchema, {
          body: input,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      qa: (workspaceId, renderId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/qa`, z.object({ jobId: z.string() }), { idempotencyKey: mutation?.idempotencyKey }),
      qaReport: async (workspaceId, renderId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/qa`, z.object({ report: qaReportSchema.nullable() }))).report,
      decideApproval: (workspaceId, renderId, input, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/approval`, renderApprovalSchema, {
          body: input,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      approval: async (workspaceId, renderId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/approval`, z.object({ approval: renderApprovalSchema.nullable() }))).approval,
      exportPackage: (workspaceId, renderId) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/renders/${renderId}/export`, exportPackageSchema),
    },
    customMotion: {
      start: (projectId, sceneId, input, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/scenes/${sceneId}/custom-motion`, z.object({ job: jobSchemaForGeneration, dedupeKey: z.string(), reused: z.boolean() }), {
          body: input ?? {},
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async (projectId, query) => {
        const suffix = query?.sceneId !== undefined ? `?sceneId=${query.sceneId}` : '';
        return (await request('GET', `/api/v1/projects/${projectId}/custom-motion${suffix}`, z.object({ items: z.array(customMotionComponentSchema) }))).items;
      },
      get: (projectId, componentId) => request('GET', `/api/v1/projects/${projectId}/custom-motion/${componentId}`, customMotionComponentSchema),
    },
    jobs: {
      list: async (workspaceId, query) => {
        const search = new URLSearchParams();
        if (query?.projectId !== undefined) search.set('projectId', query.projectId);
        if (query?.status !== undefined) search.set('status', query.status);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/workspaces/${workspaceId}/jobs${suffix}`, listOf(jobSchema))).items;
      },
      get: (workspaceId, jobId) => request('GET', `/api/v1/workspaces/${workspaceId}/jobs/${jobId}`, jobSchema),
      cancel: (workspaceId, jobId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/jobs/${jobId}/cancel`, jobSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      retry: (workspaceId, jobId, mutation) =>
        request('POST', `/api/v1/workspaces/${workspaceId}/jobs/${jobId}/retry`, jobSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },

    admin: {
      overview: () => request('GET', '/api/v1/admin/overview', opsOverviewSchema),
      jobs: async (query) => {
        const search = new URLSearchParams();
        if (query?.status !== undefined) search.set('status', query.status);
        if (query?.workspaceId !== undefined) search.set('workspaceId', query.workspaceId);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/jobs${suffix}`, z.object({ items: z.array(jobSchemaForGeneration) }))).items;
      },
      retryJob: (jobId, input, mutation) =>
        request('POST', `/api/v1/admin/jobs/${jobId}/retry`, jobSchemaForGeneration, {
          body: input ?? {},
          idempotencyKey: mutation?.idempotencyKey,
        }),
      audit: async (query) => {
        const suffix = query?.limit === undefined ? '' : `?limit=${String(query.limit)}`;
        return (await request('GET', `/api/v1/admin/audit${suffix}`, z.object({ items: z.array(opsAuditEntrySchema) }))).items;
      },
      metricsText: () => requestText('GET', '/api/v1/admin/metrics'),
      assignPlan: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/plan`, workspaceSubscriptionSchema, {
          body: input,
          bodySchema: assignPlanRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      grantCredits: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/credits/grant`, z.object({ entry: ledgerEntrySchema, balanceCredits: z.number().int() }), {
          body: input,
          bodySchema: grantCreditsRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      refundCredit: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/credits/refund`, z.object({ entry: ledgerEntrySchema, balanceCredits: z.number().int(), idempotent: z.boolean() }), {
          body: input,
          bodySchema: refundCreditRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      users: async (query) => {
        const search = new URLSearchParams();
        if (query?.query !== undefined) search.set('query', query.query);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/users${suffix}`, z.object({ items: z.array(adminUserSummarySchema) }))).items;
      },
      workspaces: async (query) => {
        const search = new URLSearchParams();
        if (query?.query !== undefined) search.set('query', query.query);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/workspaces${suffix}`, z.object({ items: z.array(adminWorkspaceSummarySchema) }))).items;
      },
      projects: async (query) => {
        const search = new URLSearchParams();
        if (query?.query !== undefined) search.set('query', query.query);
        if (query?.workspaceId !== undefined) search.set('workspaceId', query.workspaceId);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/projects${suffix}`, z.object({ items: z.array(adminProjectSummarySchema) }))).items;
      },
      providerStatus: () => request('GET', '/api/v1/admin/provider-status', adminProviderStatusSchema),
      storage: (query) => {
        const suffix = query?.limit === undefined ? '' : `?limit=${String(query.limit)}`;
        return request('GET', `/api/v1/admin/storage${suffix}`, adminStorageSummarySchema);
      },
      auditLog: async (query) => {
        const search = new URLSearchParams();
        if (query?.workspaceId !== undefined) search.set('workspaceId', query.workspaceId);
        if (query?.action !== undefined) search.set('action', query.action);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/audit-log${suffix}`, z.object({ items: z.array(auditLogEntrySchema) }))).items;
      },
      workspaceCredits: (workspaceId) => request('GET', `/api/v1/admin/workspaces/${workspaceId}/credits`, creditStatementSchema),
      abuseFlags: async (query) => {
        const search = new URLSearchParams();
        if (query?.workspaceId !== undefined) search.set('workspaceId', query.workspaceId);
        if (query?.status !== undefined) search.set('status', query.status);
        if (query?.limit !== undefined) search.set('limit', String(query.limit));
        const suffix = search.size === 0 ? '' : `?${search.toString()}`;
        return (await request('GET', `/api/v1/admin/abuse-flags${suffix}`, z.object({ items: z.array(abuseFlagSchema) }))).items;
      },
      createAbuseFlag: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/abuse-flags`, abuseFlagSchema, {
          body: input,
          bodySchema: createAbuseFlagRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      resolveAbuseFlag: (flagId, input, mutation) =>
        request('POST', `/api/v1/admin/abuse-flags/${flagId}/resolve`, abuseFlagSchema, {
          body: input,
          bodySchema: resolveAbuseFlagRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      setAbuseState: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/abuse-state`, z.object({ workspaceId: z.string(), abuseState: workspaceAbuseStateSchema }), {
          body: input,
          bodySchema: setWorkspaceAbuseStateRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      supportGrants: async (workspaceId) =>
        (await request('GET', `/api/v1/admin/workspaces/${workspaceId}/support-grants`, z.object({ items: z.array(supportAccessGrantSchema) }))).items,
      createSupportGrant: (workspaceId, input, mutation) =>
        request('POST', `/api/v1/admin/workspaces/${workspaceId}/support-grants`, supportAccessGrantSchema, {
          body: input,
          bodySchema: createSupportGrantRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      revokeSupportGrant: (grantId, mutation) =>
        request('POST', `/api/v1/admin/support-grants/${grantId}/revoke`, supportAccessGrantSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      supportView: (workspaceId) => request('GET', `/api/v1/admin/workspaces/${workspaceId}/support-view`, supportViewSchema),
    },
    plans: {
      list: async (query) => {
        const suffix = query?.planKey === undefined ? '' : `?planKey=${query.planKey}`;
        return (await request('GET', `/api/v1/plans${suffix}`, z.object({ items: z.array(planSchema) }))).items;
      },
    },
    notifications: {
      list: async (options) => {
        const search = new URLSearchParams();
        if (options?.workspaceId !== undefined) search.set('workspaceId', options.workspaceId);
        if (options?.unreadOnly === true) search.set('unreadOnly', 'true');
        if (options?.limit !== undefined) search.set('limit', String(options.limit));
        const suffix = search.size > 0 ? `?${search.toString()}` : '';
        return (await request('GET', `/api/v1/notifications${suffix}`, listOf(notificationSchema))).items;
      },
      unreadCount: async (options) => {
        const suffix = options?.workspaceId !== undefined ? `?workspaceId=${options.workspaceId}` : '';
        return (await request('GET', `/api/v1/notifications/unread-count${suffix}`, unreadCountResponseSchema)).unread;
      },
      markRead: (notificationId, mutation) =>
        request('POST', `/api/v1/notifications/${notificationId}/read`, notificationSchema, {
          idempotencyKey: mutation?.idempotencyKey,
        }),
      markAllRead: async (options) => {
        const suffix = options?.workspaceId !== undefined ? `?workspaceId=${options.workspaceId}` : '';
        const result = await request(
          'POST',
          `/api/v1/notifications/read-all${suffix}`,
          z.object({ updated: z.number().int().nonnegative() }),
          { idempotencyKey: options?.idempotencyKey },
        );
        return result.updated;
      },
    },
  };
}
