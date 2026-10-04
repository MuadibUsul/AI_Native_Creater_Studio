import type { ZodType } from 'zod';
import {
  channelStyleVersionSchema,
  channelWithStyleSchema,
  createChannelRequestSchema,
  createCreatorIdentityRequestSchema,
  createProjectRequestSchema,
  createSceneRequestSchema,
  createSceneResponseSchema,
  createSpeechProfileRequestSchema,
  createWorkspaceRequestSchema,
  creatorIdentitySchema,
  healthResponseSchema,
  nativeAuthorizeQuerySchema,
  pageResponseSchema,
  projectDetailSchema,
  projectSchema,
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
  type Project,
  type ProjectDetail,
  type SceneGraph,
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
    list(workspaceId: string): Promise<Project[]>;
    get(projectId: string): Promise<ProjectDetail>;
    /** 组装后的 SceneGraph（由服务端规范化状态生成并通过契约校验） */
    graph(projectId: string): Promise<SceneGraph>;
    addScene(projectId: string, input: Record<string, unknown>, options?: MutationOptions): Promise<CreateSceneResponse>;
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
      list: async (workspaceId) =>
        (await request('GET', `/api/v1/workspaces/${workspaceId}/projects`, listOf(projectSchema))).items,
      get: (projectId) => request('GET', `/api/v1/projects/${projectId}`, projectDetailSchema),
      graph: (projectId) => request('GET', `/api/v1/projects/${projectId}/graph`, sceneGraphSchema),
      addScene: (projectId, input, mutation) =>
        request('POST', `/api/v1/projects/${projectId}/scenes`, createSceneResponseSchema, {
          body: input,
          bodySchema: createSceneRequestSchema,
          idempotencyKey: mutation?.idempotencyKey,
        }),
    },
  };
}
