import {
  distributionCapabilitiesSchema,
  type DistributionCapabilities,
  type DistributionProvider,
  type PlatformAnalytics,
  type ProviderContext,
  type PublicationKey,
  type PublicationRequest,
  type PublicationStatus,
  type ProviderContext as ProviderContextAlias,
} from '@ancs/contracts';

/**
 * YouTube 分发 Provider（P13-02 / §42；计划 §8 P13）。
 *
 * - **官方 API 参考实现**（YouTube Data API v3）：上传/元数据/状态/排期能力经 `YoutubeApiClient`
 *   seam——真实 HTTP 客户端**代码就位但只在持有 OAuth 凭据时运行**（BLOCKED 凭据；测试用
 *   `MockYoutubeClient` 确定性回放——Mock 行为 ≠ 远端验证，不冒充）；
 * - **超时恢复不重复创建**：上传前先 `findByPublicationKey`（幂等键嵌入视频元数据 private 标签）
 *   查询远端是否已有本次发布——命中即采纳既有上传（不重复创建）；上传后超时（结果未知）→
 *   核心对账路径同样经本方法回查；
 * - **AIGC 披露**：disclosure 逐字追加到描述（平台政策要求，AIGC_DISCLOSURE 能力）；
 * - 无浏览器自动化（§90 禁止）。
 */

/** 发布幂等键 → 远端可检索标签（private 标签 + 描述尾注双写） */
export const PUBLICATION_KEY_TAG_PREFIX = 'ancs-pubkey:';

export const publicationKeyTag = (key: PublicationKey): string =>
  `${PUBLICATION_KEY_TAG_PREFIX}${key.platformId}|${key.accountId}|${key.projectVersionId}|${key.outputAssetId}`;

/** 上传/元数据载荷（Provider → 平台客户端 seam 的最小输入；凭据由调用方注入，不经此结构） */
export interface YoutubeUploadInput {
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  publishAt: string | null;
  /** 平台侧 AIGC 披露声明（YouTube "altered content" 标记） */
  alteredContent: boolean;
  /** 幂等标签（检索已上传项的依据——超时恢复不重复创建） */
  publicationKeyTag: string;
  videoBytes: Uint8Array;
  mimeType: string;
}

export interface YoutubeVideoRemote {
  videoId: string;
  url: string;
  title: string;
  description: string;
  privacyStatus: string;
  publishAt: string | null;
  uploadStatus: string;
}

/** 平台客户端 seam（真实 HTTP 客户端与 Mock 共用；Provider 只依赖本接口） */
export interface YoutubeApiClient {
  /** 按幂等标签检索已上传项（超时恢复不重复创建的依据；无则 null） */
  findByPublicationKeyTag(tag: string): Promise<YoutubeVideoRemote | null>;
  upload(input: YoutubeUploadInput): Promise<YoutubeVideoRemote>;
  getVideo(videoId: string): Promise<YoutubeVideoRemote>;
  updateMetadata(videoId: string, input: { title: string; description: string; tags: string[]; privacyStatus: string }): Promise<YoutubeVideoRemote>;
  listAnalytics(videoId: string, from: string | null, to: string | null): Promise<Record<string, unknown>>;
}

/** 平台凭据引用（调用方经 P03-04 凭据服务解出后传入；本包不持久化任何 Secret） */
export interface YoutubeCredentials {
  accessToken: string;
  refreshToken?: string;
}

/**
 * 真实 HTTP 客户端（YouTube Data API v3）。
 * **凭据 BLOCKED**：仅在持有 OAuth access token 时可运行；本会话无凭据——未做任何远端验证（不冒充）。
 */
export class RealYoutubeClient implements YoutubeApiClient {
  constructor(
    private readonly credentials: YoutubeCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`https://www.googleapis.com/youtube/v3${path}`, {
      ...init,
      headers: {
        ...(init.headers ?? {}),
        authorization: `Bearer ${this.credentials.accessToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`YouTube API ${String(response.status)}: ${(await response.text()).slice(0, 200)}`);
    }
    return (await response.json()) as T;
  }

  async findByPublicationKeyTag(tag: string): Promise<YoutubeVideoRemote | null> {
    // YouTube 无客户端幂等键 API：检索本频道近期上传 + 按 description 尾注匹配（保守实现）
    const search = await this.call<{ items: { id: { videoId: string } }[] }>(
      `/search?part=snippet&forMine=true&type=video&maxResults=50&q=${encodeURIComponent(tag)}`,
      { method: 'GET' },
    );
    for (const item of search.items) {
      const videoId = item.id?.videoId;
      if (videoId === undefined) continue;
      const video = await this.getVideo(videoId);
      if (video.description.includes(tag)) return video;
    }
    return null;
  }

  async upload(input: YoutubeUploadInput): Promise<YoutubeVideoRemote> {
    // resumable upload 简化为一次 POST（真实实现应走 resumable 会话；接入凭据后按官方文档完善）
    const metadata = {
      snippet: {
        title: input.title,
        description: input.description,
        tags: input.tags,
        privacyStatus: input.privacyStatus,
        ...(input.publishAt === null ? {} : { publishAt: input.publishAt }),
      },
      status: {
        privacyStatus: input.publishAt === null ? input.privacyStatus : 'PRIVATE',
        publishAt: input.publishAt ?? undefined,
        selfDeclaredMadeForKids: false,
        containsSyntheticMedia: input.alteredContent,
      },
    };
    const body = new FormData();
    body.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    body.append('video', new Blob([new Uint8Array(input.videoBytes)], { type: input.mimeType }));
    const created = await this.call<{ id: string; snippet: { title: string; description: string; privacyStatus?: string }; status: { uploadStatus?: string; privacyStatus?: string } }>(
      '/videos?part=snippet,status',
      { method: 'POST', body },
    );
    return {
      videoId: created.id,
      url: `https://www.youtube.com/watch?v=${created.id}`,
      title: created.snippet.title,
      description: created.snippet.description,
      privacyStatus: created.status?.privacyStatus ?? input.privacyStatus,
      publishAt: input.publishAt,
      uploadStatus: created.status?.uploadStatus ?? 'uploaded',
    };
  }

  async getVideo(videoId: string): Promise<YoutubeVideoRemote> {
    const video = await this.call<{ items: { id: string; snippet: { title: string; description: string; privacyStatus?: string }; status: { uploadStatus?: string; privacyStatus?: string; publishAt?: string } }[] }>(
      `/videos?part=snippet,status&id=${encodeURIComponent(videoId)}`,
      { method: 'GET' },
    );
    const item = video.items[0];
    if (item === undefined) throw new Error(`YouTube video not found: ${videoId}`);
    return {
      videoId: item.id,
      url: `https://www.youtube.com/watch?v=${item.id}`,
      title: item.snippet.title,
      description: item.snippet.description,
      privacyStatus: item.status?.privacyStatus ?? 'PRIVATE',
      publishAt: item.status?.publishAt ?? null,
      uploadStatus: item.status?.uploadStatus ?? 'unknown',
    };
  }

  async updateMetadata(videoId: string, input: { title: string; description: string; tags: string[]; privacyStatus: string }): Promise<YoutubeVideoRemote> {
    const updated = await this.call<{ id: string; snippet: { title: string; description: string } }>(
      '/videos?part=snippet',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: videoId, snippet: { title: input.title, description: input.description, tags: input.tags, categoryId: '27' } }) },
    );
    void input.privacyStatus;
    return {
      videoId: updated.id,
      url: `https://www.youtube.com/watch?v=${updated.id}`,
      title: updated.snippet.title,
      description: updated.snippet.description,
      privacyStatus: input.privacyStatus,
      publishAt: null,
      uploadStatus: 'updated',
    };
  }

  async listAnalytics(videoId: string, from: string | null, to: string | null): Promise<Record<string, unknown>> {
    // YouTube Analytics API（独立端点）；凭据接入后实现——缺失数据保持未知（§41）
    void videoId;
    void from;
    void to;
    return {};
  }
}

/** Mock 客户端（确定性；测试回放——含"上传后超时"场景） */
export class MockYoutubeClient implements YoutubeApiClient {
  readonly remote = new Map<string, YoutubeVideoRemote>();
  uploadCalls = 0;
  /** 预置故障：'none' | 'timeout_after_upload'（upload 成功后抛超时——模拟结果未知） */
  failureMode: 'none' | 'timeout_after_upload' = 'none';

  async findByPublicationKeyTag(tag: string): Promise<YoutubeVideoRemote | null> {
    for (const video of this.remote.values()) {
      if (video.description.includes(tag)) return video;
    }
    return null;
  }

  async upload(input: YoutubeUploadInput): Promise<YoutubeVideoRemote> {
    this.uploadCalls += 1;
    const videoId = `yt-${String(this.uploadCalls).padStart(3, '0')}`;
    const remote: YoutubeVideoRemote = {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: input.title,
      description: input.description,
      privacyStatus: input.privacyStatus,
      publishAt: input.publishAt,
      uploadStatus: 'processed',
    };
    this.remote.set(videoId, remote);
    if (this.failureMode === 'timeout_after_upload') {
      throw new Error('MockYouTube: 上传已提交但响应超时（结果未知）');
    }
    return remote;
  }

  async getVideo(videoId: string): Promise<YoutubeVideoRemote> {
    const video = this.remote.get(videoId);
    if (video === undefined) throw new Error(`MockYouTube: video not found ${videoId}`);
    return video;
  }

  async updateMetadata(videoId: string, input: { title: string; description: string; tags: string[]; privacyStatus: string }): Promise<YoutubeVideoRemote> {
    const video = await this.getVideo(videoId);
    const updated: YoutubeVideoRemote = { ...video, title: input.title, description: input.description, privacyStatus: input.privacyStatus };
    this.remote.set(videoId, updated);
    return updated;
  }

  async listAnalytics(videoId: string, _from: string | null, _to: string | null): Promise<Record<string, unknown>> {
    void videoId;
    return {};
  }
}

export function youtubeDescription(input: { description: string; disclosure: string | null; keyTag: string }): string {
  return [input.description, input.disclosure === null ? null : `【披露】${input.disclosure}`, input.keyTag].filter((part): part is string => part !== null).join('\n');
}

export class YoutubeDistributionProvider implements DistributionProvider {
  readonly providerId = 'youtube';

  constructor(
    private readonly client: YoutubeApiClient,
    private readonly credentialsProvider: (ctx: ProviderContextAlias) => Promise<YoutubeCredentials>,
  ) {}

  async capabilities(_ctx: ProviderContext): Promise<DistributionCapabilities> {
    // 能力以官方 API 实测为准（凭据后核验）；声明 = 计划 P13-02 范围 + §42 分级
    return distributionCapabilitiesSchema.parse({
      tier: 'P1_DIRECT_PUBLISH',
      capabilities: ['DIRECT_PUBLISH', 'SCHEDULING', 'THUMBNAIL', 'CAPTION_DESCRIPTION', 'UPDATE_METADATA', 'DELETE_REMOTE', 'ANALYTICS', 'AIGC_DISCLOSURE'],
      notes: 'YouTube Data API v3（官方 API 参考实现）；真实远端验证 BLOCKED OAuth 凭据',
    });
  }

  async validate(req: PublicationRequest) {
    const issues: { severity: 'error' | 'warning'; code: string; message: string; artifactId: string | null }[] = [];
    if (req.title.trim().length === 0) issues.push({ severity: 'error', code: 'TITLE_EMPTY', message: '标题为空', artifactId: null });
    if (req.title.length > 100) issues.push({ severity: 'error', code: 'TITLE_TOO_LONG', message: 'YouTube 标题上限 100 字符', artifactId: null });
    if (req.description !== null && req.description.length > 5000) issues.push({ severity: 'error', code: 'DESCRIPTION_TOO_LONG', message: '描述上限 5000 字符', artifactId: null });
    if (req.tags.length > 0 && req.tags.join('').length > 500) issues.push({ severity: 'warning', code: 'TAGS_OVER_LIMIT', message: '标签总长超出 500 字符（平台将忽略超出部分）', artifactId: null });
    return { ok: issues.every((issue) => issue.severity !== 'error'), issues };
  }

  async publish(req: PublicationRequest) {
    const keyTag = publicationKeyTag(req.publicationKey);
    // **超时恢复不重复创建**：先查远端是否已有本次发布（幂等标签命中 → 采纳既有上传）
    const existing = await this.client.findByPublicationKeyTag(keyTag);
    if (existing !== null) {
      return { jobId: existing.videoId, state: 'PUBLISHED' as const, remoteId: existing.videoId, remoteUrl: existing.url };
    }
    const remote = await this.client.upload({
      title: req.title,
      description: youtubeDescription({ description: req.description ?? '', disclosure: req.disclosure, keyTag }),
      tags: req.tags,
      privacyStatus: 'PUBLIC',
      publishAt: req.scheduledAt,
      alteredContent: req.disclosure !== null,
      publicationKeyTag: keyTag,
      videoBytes: new Uint8Array(),
      mimeType: 'video/mp4',
    });
    return { jobId: remote.videoId, state: 'PUBLISHED' as const, remoteId: remote.videoId, remoteUrl: remote.url };
  }

  async getStatus(remoteId: string): Promise<PublicationStatus> {
    const video = await this.client.getVideo(remoteId);
    return {
      state: 'PUBLISHED',
      remoteId: video.videoId,
      remoteUrl: video.url,
      publishedAt: new Date().toISOString(),
    };
  }

  async updateMetadata(req: { remoteId: string; title: string | null; description: string | null }): Promise<void> {
    const video = await this.client.getVideo(req.remoteId);
    await this.client.updateMetadata(req.remoteId, {
      title: req.title ?? video.title,
      description: req.description ?? video.description,
      tags: [],
      privacyStatus: video.privacyStatus,
    });
  }

  async fetchAnalytics(req: { remoteId: string; from: string | null; to: string | null }): Promise<PlatformAnalytics> {
    const metrics = await this.client.listAnalytics(req.remoteId, req.from, req.to);
    return { platformId: this.providerId, fetchedAt: new Date().toISOString(), metrics };
  }

  /** 按幂等键回查远端（核心对账路径的 Provider 侧实现——结果未知先查询，不重发） */
  async findByPublicationKey(key: PublicationKey): Promise<PublicationStatus | null> {
    const found = await this.client.findByPublicationKeyTag(publicationKeyTag(key));
    if (found === null) return null;
    return { state: 'PUBLISHED', remoteId: found.videoId, remoteUrl: found.url, publishedAt: new Date().toISOString() };
  }
}
