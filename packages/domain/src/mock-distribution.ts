import {
  distributionCapabilitiesSchema,
  type DistributionCapabilities,
  type DistributionProvider,
  type PublicationRequest,
  type ProviderContext,
} from '@ancs/contracts';

/**
 * Mock 分发 Provider（P13-01 / §42.2；同 Mock TTS/Payments 范式）。
 *
 * 定位：在**无真实平台凭据**时确定性重现发布链路（能力分级 → validate → publish → getStatus），
 * 证明发布核心的闸门与幂等语义可工作。**Mock 行为 ≠ 真实平台**——
 * 真实平台接入（YouTube 官方 API 等）随 P13-02/03，BLOCKED 于 OAuth 凭据（不冒充）。
 * 纯逻辑：无 DB、无 Secret、无浏览器自动化（§90 禁止以浏览器自动化冒充可靠发布）。
 */

export class MockDistributionProvider implements DistributionProvider {
  readonly providerId: string;

  constructor(options: { providerId?: string; capabilities?: DistributionCapabilities['capabilities']; analyticsMetrics?: Record<string, unknown> } = {}) {
    this.providerId = options.providerId ?? 'mock.platform';
    this.#capabilities = distributionCapabilitiesSchema.parse({
      tier: 'P1_DIRECT_PUBLISH',
      capabilities: options.capabilities ?? ['DIRECT_PUBLISH', 'UPLOAD_DRAFT', 'DELETE_REMOTE', 'UPDATE_METADATA', 'ANALYTICS'],
      notes: 'Mock 平台（确定性；真实平台接入 BLOCKED 凭据）',
    });
    this.#analyticsMetrics = options.analyticsMetrics ?? {};
  }

  #capabilities: DistributionCapabilities;
  #analyticsMetrics: Record<string, unknown>;

  async capabilities(_ctx: ProviderContext): Promise<DistributionCapabilities> {
    return this.#capabilities;
  }

  async validate(req: PublicationRequest) {
    // 确定性校验：标题非空即通过（契约已在 schema 层校验）；问题逐条返回
    return {
      ok: req.title.trim().length > 0,
      issues:
        req.title.trim().length === 0
          ? [{ severity: 'error' as const, code: 'TITLE_EMPTY', message: '标题为空', artifactId: null }]
          : [],
    };
  }

  async publish(req: PublicationRequest) {
    // 确定性"发布"：远端引用由幂等键派生（同键同远端——重放可对账）
    const remoteId = `mock-remote-${req.publicationKey.platformId}-${req.publicationKey.outputAssetId}`;
    return {
      jobId: `mock-job-${remoteId}`,
      state: 'PUBLISHED' as const,
      remoteId,
      remoteUrl: `https://mock.platform/watch/${remoteId}`,
    };
  }

  async uploadDraft(req: PublicationRequest) {
    // 确定性 Draft：transferId 由幂等键派生（Draft 不显示为 Published——状态由核心记 DRAFT）
    const transferId = `mock-draft-${req.publicationKey.platformId}-${req.publicationKey.outputAssetId}`;
    return {
      transferId,
      openUrl: `https://mock.platform/draft/${transferId}`,
      instructions: '已上传为平台草稿：请在平台内检查并手动发布。',
    };
  }

  async getStatus(remoteId: string) {
    return {
      state: 'PUBLISHED' as const,
      remoteId,
      remoteUrl: `https://mock.platform/watch/${remoteId}`,
      publishedAt: new Date().toISOString(),
    };
  }

  async fetchAnalytics(_req: { remoteId: string; from: string | null; to: string | null }) {
    return { platformId: this.providerId, fetchedAt: new Date().toISOString(), metrics: this.#analyticsMetrics };
  }
}

export function createMockDistributionProvider(options?: ConstructorParameters<typeof MockDistributionProvider>[0]): DistributionProvider {
  return new MockDistributionProvider(options);
}
