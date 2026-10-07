import type { CredentialCipher, PlatformCredentialRegistry, ProviderTestHook } from '@ancs/contracts';
import { createCredentialVaultFromEnv, LocalCredentialVault } from '@ancs/providers-credential-vault-local';

/**
 * 凭据依赖注入（P03-04）。
 *
 * - 密文服务：本地 AES-256-GCM 驱动（providers/credential-vault-local）；生产用云 KMS 适配器；
 * - 平台托管凭据：运行时环境变量的**存在性**登记（不落库）；`resolve` 供服务端执行链路使用；
 * - 测试钩子：真实 Provider 适配器（P06）或 Mock Provider（P03-07）。
 *
 * 密钥纪律（§17.3/§75）：Secret 只在服务端内存中出现；**不得**写入日志、错误或响应。
 */

export interface CredentialDeps {
  cipher: CredentialCipher;
  platformCredentials?: PlatformCredentialRegistry;
  testHooks?: readonly ProviderTestHook[];
}

/**
 * 平台托管凭据登记表（环境变量驱动）：
 *   ANCS_PLATFORM_PROVIDER_KEYS="providerA:secretA,providerB:secretB"
 * 只用于**服务端**解析；`has()` 供 Router 判定可用性（不外泄具体值）。
 */
export function parsePlatformCredentials(raw: string | undefined): PlatformCredentialRegistry {
  const entries = new Map<string, string>();
  if (raw !== undefined && raw.trim() !== '') {
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const separator = trimmed.indexOf(':');
      if (separator <= 0) continue;
      entries.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return {
    has: (providerId) => entries.has(providerId),
    resolve: (providerId) => entries.get(providerId) ?? null,
  };
}

/** 便捷：默认凭据依赖（环境变量驱动；缺密钥即构造失败——fail-closed） */
export function createCredentialDeps(options: { localKeys: string; platformKeys?: string; testHooks?: readonly ProviderTestHook[] }): CredentialDeps {
  // 本地驱动为惰性 require 以避免在未配置密钥的进程中加载（该模块本身无副作用）
  const separatorIndex = options.localKeys.indexOf(':');
  if (separatorIndex <= 0) throw new Error('ANCS_CREDENTIAL_KEYS 未配置（fail-closed）');
  return {
    cipher: createLocalVault(options.localKeys),
    platformCredentials: parsePlatformCredentials(options.platformKeys),
    ...(options.testHooks !== undefined ? { testHooks: options.testHooks } : {}),
  };
}

// 说明：为避免 apps/api 直接依赖 providers/*（R7 允许，但此处保持轻度耦合），
// 由调用方（index.ts/测试）注入具体实现；createCredentialDeps 仅为便捷包装。
function createLocalVault(keys: string): CredentialCipher {
  return new LocalCredentialVault({ keys });
}

/** 便捷：从环境变量构造（服务端/Worker 启动路径使用） */
export function credentialDepsFromEnv(env: NodeJS.ProcessEnv = process.env): CredentialDeps {
  return {
    cipher: createCredentialVaultFromEnv(env),
    platformCredentials: parsePlatformCredentials(env['ANCS_PLATFORM_PROVIDER_KEYS']),
  };
}
