import {
  ApiFailure,
  capabilitySnapshotSchema,
  ERROR_CODES,
  packManifestSchema,
  type CapabilityAvailability,
  type CapabilitySnapshot,
  type DistributionProviderRegistration,
  type PackManifest,
  type PluginCapability,
} from '@ancs/contracts';

/**
 * 扩展注册表（P01-06 / 规范 §92.3：V1 先定义 contracts 和 registry）。
 *
 * 诚实语义：
 * - 未安装的能力**明确返回不支持**（`requireOutputFormat` 抛 CAPABILITY_UNAVAILABLE / 501；
 *   `/capabilities` 端点对查询的格式返回 available:false + 原因），而不是静默缺失；
 * - 注册是进程内状态（V1）；持久化、版本生命周期、签名校验与撤销属 P11-03/P16-01—03；
 * - Core 不感知任何具体输出类型（禁止 outputType 硬编码分支，§92.1）。
 */

export class ExtensionRegistry {
  readonly #packs = new Map<string, PackManifest>();
  readonly #distributionProviders = new Map<string, DistributionProviderRegistration>();

  registerPack(manifest: PackManifest): PackManifest {
    const parsed = packManifestSchema.parse(manifest);
    if (this.#packs.has(parsed.packId)) {
      throw new ApiFailure(
        ERROR_CODES.ALREADY_EXISTS,
        `pack "${parsed.packId}" 已注册（升级/回滚属 P16-03 插件生命周期）`,
        409,
      );
    }
    this.#packs.set(parsed.packId, parsed);
    return parsed;
  }

  registerDistributionProvider(registration: DistributionProviderRegistration): void {
    if (this.#distributionProviders.has(registration.providerId)) {
      throw new ApiFailure(
        ERROR_CODES.ALREADY_EXISTS,
        `distribution provider "${registration.providerId}" 已注册`,
        409,
      );
    }
    this.#distributionProviders.set(registration.providerId, registration);
  }

  listPacks(): PackManifest[] {
    return [...this.#packs.values()];
  }

  listDistributionProviders(): DistributionProviderRegistration[] {
    return [...this.#distributionProviders.values()];
  }

  /** 已安装 Pack 提供的输出格式（去重、稳定排序） */
  outputFormats(): string[] {
    const formats = new Set<string>();
    for (const pack of this.#packs.values()) {
      for (const format of pack.outputFormats) formats.add(format);
    }
    return [...formats].sort();
  }

  hasOutputFormat(format: string): boolean {
    return this.outputFormats().includes(format);
  }

  /** 未安装该格式的 Pack 时抛 CAPABILITY_UNAVAILABLE（501），供输出类路由统一守卫。 */
  requireOutputFormat(format: string): void {
    if (!this.hasOutputFormat(format)) {
      throw new ApiFailure(
        ERROR_CODES.CAPABILITY_UNAVAILABLE,
        `输出格式 "${format}" 不可用：未安装提供该格式的 Pack`,
        501,
        { outputFormat: format },
      );
    }
  }

  /** 是否有任一 Pack 声明了该插件能力（§92.2 能力词汇表） */
  hasCapability(capability: PluginCapability): boolean {
    for (const pack of this.#packs.values()) {
      if (pack.capabilities.includes(capability)) return true;
    }
    return false;
  }

  availability(format: string): CapabilityAvailability {
    return this.hasOutputFormat(format)
      ? { format, available: true, reason: null }
      : { format, available: false, reason: '未安装提供该输出格式的 Pack' };
  }

  snapshot(): CapabilitySnapshot {
    return capabilitySnapshotSchema.parse({
      packs: this.listPacks(),
      distributionProviders: this.listDistributionProviders(),
      outputFormats: this.outputFormats(),
    });
  }
}

/**
 * 内置注册表（V1）：无内置 Pack —— 这是诚实状态而非占位：
 * 官方 Pack（Shorts/Publishing/...）自 P11—P14 逐项落地；第三方 Pack 自 P16。
 */
export function createBuiltInRegistry(): ExtensionRegistry {
  return new ExtensionRegistry();
}
