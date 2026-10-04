import type { ZodType } from 'zod';
import {
  channelStyleVersionSchema,
  channelWithStyleSchema,
  createChannelRequestSchema,
  createCreatorIdentityRequestSchema,
  assetDetailSchema,
  assetSchema,
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
      input: { title: string; channelId: string; sourceType?: string; aspectRatio?: string },
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
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
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
        const uploadResponse = await doFetch(intent.upload.url, {
          method: intent.upload.method,
          headers: intent.upload.headers,
          body: input.data,
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
  };
}
