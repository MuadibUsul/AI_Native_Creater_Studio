import { z, type ZodType } from 'zod';
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
  directorPlanSchema,
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
  type ClientType,
  type HealthResponse,
  type SessionInfo,
  type SignInResponse,
  type SpeechProfile,
  type TokenResponse,
  type WorkspaceMember,
  type WorkspaceWithRole,
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
  type DirectorPlan,
  type DirectorPolicyInput,
  type NarrativePlan,
  type SpeechPlan,
  type VisualPlan,
  type CreateContentRequest,
  type UpdateSourceRequest,
  type CapabilitySelection,
  type CreditHold,
  type LedgerEntry,
  type ProviderGeneration,
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
  workspaces: {
    create(input: { name: string }, options?: MutationOptions): Promise<WorkspaceWithRole>;
    list(): Promise<WorkspaceWithRole[]>;
    get(workspaceId: string): Promise<WorkspaceWithRole>;
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
    addScene(projectId: string, input: Record<string, unknown>, options?: MutationOptions): Promise<CreateSceneResponse>;
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
  content: {
    /** 输入归一化：URL 文章 / 粘贴正文 / 手写脚本 → ContentDocument（API 路径含 workspace） */
    create(
      workspaceId: string,
      projectId: string,
      input: CreateContentRequest,
      options?: MutationOptions,
    ): Promise<ContentDocumentRecord>;
    list(workspaceId: string, projectId: string): Promise<ContentDocumentRecord[]>;
    get(workspaceId: string, projectId: string, documentId: string): Promise<ContentDocumentRecord>;
    sources(workspaceId: string, projectId: string): Promise<ContentSource[]>;
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
  jobs: {
    list(workspaceId: string, query?: { projectId?: string; status?: Job['status']; limit?: number }): Promise<Job[]>;
    get(workspaceId: string, jobId: string): Promise<Job>;
    /** 取消（QUEUED/等待依赖 → CANCELLED；执行中 → CANCEL_REQUESTED） */
    cancel(workspaceId: string, jobId: string, options?: MutationOptions): Promise<Job>;
    /** 人工重试（FAILED_* / CANCELLED → QUEUED） */
    retry(workspaceId: string, jobId: string, options?: MutationOptions): Promise<Job>;
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

    workspaces: {
      create: (input, mutation) =>
        request('POST', '/api/v1/workspaces', workspaceWithRoleSchema, {
          body: input, bodySchema: createWorkspaceRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
      list: async () =>
        (await request('GET', '/api/v1/workspaces', listOf(workspaceWithRoleSchema))).items,
      get: (workspaceId) => request('GET', `/api/v1/workspaces/${workspaceId}`, workspaceWithRoleSchema),
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
      addScene: (projectId, input, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/scenes`, createSceneResponseSchema, {
          body: input,
          bodySchema: createSceneRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
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
      list: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content`, listOf(contentDocumentRecordSchema))).items,
      get: (workspaceId, projectId, documentId) =>
        request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/content/${documentId}`, contentDocumentRecordSchema),
      sources: async (workspaceId, projectId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects/${projectId}/sources`, listOf(contentSourceSchema))).items,
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
