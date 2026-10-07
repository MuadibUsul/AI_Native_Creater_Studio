import {
  PLATFORM_CAPABILITY_MATRIX,
  PUBLICATION_ERROR_REASONS,
  ApiFailure,
  ERROR_CODES,
  type DistributionCapabilities,
  type DistributionProvider,
  type PlatformCapabilityMatrixEntry,
  type PublicationJob,
  type PublicationRequest,
  type ProviderContext,
  type ValidationResult,
} from '@ancs/contracts';

/**
 * 平台 Stub Provider（P13-03 / §42.2；计划 §8 P13"独立 Adapter 或明确 P4"）。
 *
 * 定位：5 个平台（TikTok/抖音/Bilibili/LinkedIn/X）在**实测核验完成前**的 fail-closed 占位——
 * - capabilities() 返回**空生效集**（生效能力 = 声明 ∩ 已核验；核验全部 BLOCKED 平台账号）——
 *   核心闸门据此拒绝发布（UI 与真实 capability 一致：不显示"可发布"）；
 * - 声明矩阵（tier/declaredCapabilities）来自 PLATFORM_CAPABILITY_MATRIX（公开文档口径，逐平台不同），
 *   经 capabilities().notes 携带核验状态与依据；
 * - **不假设每个平台支持相同能力**：逐平台矩阵数据驱动；实测核验后由真实 Adapter 替换（独立 Adapter
 *   或维持 P4 分类——按实测结果定，不在本任务冒充）。
 * 纯 fail-closed：无任何远端调用、无浏览器自动化（§90）。
 */

export class PlatformStubProvider implements DistributionProvider {
  readonly providerId: string;
  readonly entry: PlatformCapabilityMatrixEntry;

  constructor(entry: PlatformCapabilityMatrixEntry) {
    this.entry = entry;
    this.providerId = entry.platformId;
  }

  async capabilities(_ctx: ProviderContext): Promise<DistributionCapabilities> {
    return {
      tier: this.entry.tier,
      // 生效能力 = 声明 ∩ 已核验；核验未完成 → 空（核心据此 fail-closed，不显示可发布）
      capabilities: [],
      notes: `${this.entry.notes}【核验状态：${this.entry.verification}】`,
    };
  }

  async validate(_req: PublicationRequest): Promise<ValidationResult> {
    throw new ApiFailure(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `平台 ${this.providerId} 未完成实测核验（${this.entry.verification}）：发布能力不可用`,
      501,
      { reason: PUBLICATION_ERROR_REASONS.CAPABILITY_MISSING, platformId: this.providerId, verification: this.entry.verification },
    );
  }

  async publish(_req: PublicationRequest): Promise<PublicationJob> {
    throw new ApiFailure(
      ERROR_CODES.CAPABILITY_UNAVAILABLE,
      `平台 ${this.providerId} 未完成实测核验（${this.entry.verification}）：发布能力不可用（fail-closed，不冒充）`,
      501,
      { reason: PUBLICATION_ERROR_REASONS.PLATFORM_NOT_VERIFIED, platformId: this.providerId, verification: this.entry.verification },
    );
  }
}

/** 按 PLATFORM_CAPABILITY_MATRIX 构建全部平台 Stub（数据驱动；逐平台 tier/能力不同）。 */
export function createPlatformStubProviders(): DistributionProvider[] {
  return PLATFORM_CAPABILITY_MATRIX.map((entry) => new PlatformStubProvider(entry));
}
